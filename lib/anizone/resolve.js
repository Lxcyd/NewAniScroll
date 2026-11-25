/**
 * Anizone (anizone.to) — ajoute le 25/11/2026 a la demande de Luc.
 *
 * CE QUE SERT L'HOTE. Une page d'episode `https://anizone.to/anime/<id>/<ep>`
 * (Laravel Livewire, pas de defi Cloudflare) porte dans son `x-data` un objet
 * `vidstackPlayer(JSON.parse('…'))` :
 *   { src: ".../master.m3u8", subtitles: [{title, format:"ass", language,
 *     default, forced, file}], storyboard, snapshot, … }
 * Le master (CDN seiryuu.vid-cdn.xyz) contient TOUTES les pistes son en
 * `#EXT-X-MEDIA:TYPE=AUDIO` (Frieren ep. 1 : ja, fr, en, de, es, es-419,
 * pt-BR, hi, ta) ; les sous-titres sont des .ass a part (~15, dont 2 fr).
 * Le CDN repond sans referer mais son CORS ne laisse passer que
 * `https://anizone.to` : le flux est donc lu par le lecteur HLS NATIF du
 * navigateur, cf. `native` plus bas.
 *
 * LE SITE NE PEUT PAS LIRE ANIZONE (25/11/2026). anizone.to et son CDN
 * repondent 403 aux IP de Vercel et du Worker. Ce que le site sert vient donc
 * de la table `anizone_ep`, remplie par un cron GitHub horaire
 * (tools/anizone/seed.mjs --auto, cf. lib/anizone/core.mjs). Un episode
 * demande et absent part dans la file `anizone_demande`, videe au passage
 * suivant. La lecture en direct n'est qu'un repli, qui marche en local et
 * remplit la table au passage.
 *
 * TROIS CHIPS, UN FICHIER (cf. lib/servers.js). Toutes les pistes son et tous
 * les sous-titres sont servis aux trois ; seul le defaut change, et chaque chip
 * ne s'allume que s'il a quelque chose a offrir :
 *   anizone        VF    : piste son `fr` exigee ; son fr, sous-titres eteints ;
 *   anizone-vo     VO    : sous-titres `fr` exiges ; son ja, sous-titres fr ;
 *   anizone-multi  MULTI : toujours ; son ja, sous-titres selon la preference.
 *
 * PAS D'ID ANILIST CHEZ EUX : appariement par titre + annee (core.mjs
 * `trouve`), retenu dans `anizone_map` (lib/db/anizoneMap.ts).
 *
 * Contrat de retour : `{ data }` | `{ absent: raison }` | `{ transient: raison }`.
 */

import { getAnizoneMap, setAnizoneMap } from "@/lib/db/anizoneMap";
import { getTursoClient } from "@/lib/db/turso";
import {
  Bloque,
  Passager,
  capture,
  demandeEpisode,
  ecrisEpisode,
  langCourte,
  lisEpisode,
  trouve,
} from "./core.mjs";

export const ANIZONE_SERVERS = {
  anizone: { audioLang: "fr", subtitlePref: "none", exige: "son-fr" },
  "anizone-vo": { audioLang: "ja", subtitlePref: "full", exige: "st-fr" },
  "anizone-multi": { audioLang: "ja", subtitlePref: "full", exige: null },
};

const enVolCarte = new Map();

/** aniId -> slug anizone (ou null). Retenu en base ; recherche une fois. */
async function slugPour(aniId, media) {
  const ligne = await getAnizoneMap(aniId);
  if (ligne && !ligne.expired) return ligne.slug;
  const k = String(aniId);
  if (enVolCarte.has(k)) return enVolCarte.get(k);
  const p = (async () => {
    let t;
    try {
      t = await trouve(media);
    } catch (e) {
      /* Une correspondance perimee reste la meilleure reponse quand la
         recherche est impossible d'ici (403 sur Vercel). */
      if (ligne?.slug) return ligne.slug;
      throw e;
    }
    await setAnizoneMap(aniId, t?.slug ?? null, t?.title ?? null);
    return t?.slug ?? null;
  })();
  enVolCarte.set(k, p);
  try {
    return await p;
  } finally {
    enVolCarte.delete(k);
  }
}

/* Les trois chips d'un meme episode partent en meme temps : une seule lecture
   pour les trois. */
const memoEp = new Map();
const MEMO_EP_MS = 5 * 60 * 1000;

async function episode(slug, ep) {
  const k = `${slug}/${ep}`;
  const hit = memoEp.get(k);
  if (hit && (hit.p || Date.now() - hit.at < MEMO_EP_MS)) return hit.p || hit.v;
  const p = (async () => {
    const db = getTursoClient();
    if (db) {
      const stocke = await lisEpisode(db, slug, ep).catch(() => null);
      if (stocke) return stocke;
    }
    // Repli en direct : ne marche que d'une IP acceptee (local).
    const cap = await capture(slug, ep);
    if (cap.absent) return { absent: cap.absent };
    if (db) await ecrisEpisode(db, slug, ep, cap).catch(() => {});
    return cap.ep;
  })();
  memoEp.set(k, { p });
  try {
    const v = await p;
    memoEp.set(k, { v, at: Date.now() });
    if (memoEp.size > 500) memoEp.clear();
    return v;
  } catch (e) {
    memoEp.delete(k);
    throw e;
  }
}

/* L'ORDRE EST LE CONTRAT (cf. frembedSubtitles) : le lecteur prend la premiere
   piste de la langue voulue. Francais d'abord, puis anglais, puis le reste dans
   l'ordre de l'hote ; dans une langue, la piste complete avant « (CC) » et
   avant une piste forcee. */
function sousTitres(liste, def) {
  const rangLang = (l) => (l === "fr" ? 0 : l === "en" ? 1 : 2);
  const pistes = (Array.isArray(liste) ? liste : [])
    .filter((s) => typeof s?.file === "string" && s.file)
    .map((s, i) => ({
      i,
      file: s.file,
      label: s.title || s.language || "Subtitle",
      language: String(s.language || ""),
      court: langCourte(s.language),
      type: /^(ass|ssa|srt|vtt)$/i.test(s.format || "") ? s.format.toLowerCase() : "ass",
      secondaire: /\(CC\)/i.test(s.title || "") || String(s.forced) === "yes" || s.forced === true,
    }))
    .sort(
      (a, b) =>
        rangLang(a.court) - rangLang(b.court) ||
        (a.court === b.court ? a.secondaire - b.secondaire : 0) ||
        a.i - b.i,
    );
  let allume = false;
  return pistes.map((p) => {
    const parDefaut = def.exige === "st-fr" && !allume && p.court === "fr";
    if (parDefaut) allume = true;
    return {
      // Le CDN refuse le navigateur (CORS) et nos serveurs (403) : le .ass est
      // servi depuis la table anizone_sub (pages/api/v2/anizone/sub).
      file: `/api/v2/anizone/sub?u=${encodeURIComponent(p.file)}`,
      label: p.label,
      // Le lecteur retient la langue en code court (« fr »), anizone ecrit
      // parfois « pt-BR » / « es-419 » : on garde la region, elle distingue
      // deux pistes que le menu doit montrer toutes les deux.
      language: p.court === "fr" || p.court === "en" ? p.court : p.language || p.court,
      kind: "subtitles",
      type: p.type,
      default: parDefaut,
    };
  });
}

/**
 * Un chip anizone pour un episode.
 * @returns {Promise<{data?:object, absent?:string, transient?:string, bloque?:boolean}>}
 */
export async function resolveAnizone(serverKey, aniId, ep, media) {
  const def = ANIZONE_SERVERS[serverKey];
  if (!def) return { absent: "chip inconnu" };
  try {
    if (!media) return { transient: "anizone : fiche AniList indisponible" };
    const slug = await slugPour(Number(aniId), media);
    if (!slug) return { absent: `anizone : ${aniId} introuvable` };
    const e = await episode(slug, Number(ep));
    if (e.absent) return { absent: e.absent };

    const { src, subtitles, natif, son } = e;
    const stFr = (subtitles || []).some((s) => langCourte(s?.language) === "fr");
    if (def.exige === "son-fr" && !son.includes("fr"))
      return { absent: `anizone ${slug} : pas de piste son fr` };
    if (def.exige === "st-fr" && !stFr)
      return { absent: `anizone ${slug} : pas de sous-titres fr` };
    // Un VO qui ne serait pas japonais n'est pas une VOSTFR.
    if (def.exige === "st-fr" && son.length && !son.includes("ja"))
      return { absent: `anizone ${slug} : pas de piste son ja` };

    return {
      data: {
        streams: [
          {
            url: src,
            quality: "1080p",
            isM3U8: true,
            // Un master sans piste ja (doublage seul) garde sa piste par defaut.
            audioLang: son.includes(def.audioLang) ? def.audioLang : undefined,
            subtitlePref: def.subtitlePref,
            /* LECTURE NATIVE (25/11/2026). Le CDN n'accepte le XHR que depuis
               anizone.to (CORS sur master, segments, cles, sous-titres) et
               refuse le Worker : hls.js ne peut rien lire, et un proxy hors
               Cloudflare paierait chaque octet. Le lecteur HLS NATIF du
               navigateur (Chrome recent, Safari, Android) charge en no-cors et
               lit tout directement — mesure sous Chrome 158 : video, cles AES
               et son jouent depuis une autre origine. Le client remonte donc un
               master d'UNE piste son (Chrome n'expose pas `audioTracks`) en
               blob:, et change de langue en le remontant. Zero octet chez nous. */
            native: natif,
            // Rien ne passe par le Worker (il est refuse) : URL jouee telle quelle.
            directUrl: true,
            // Un <video crossorigin> referait des requetes CORS — refusees.
            noCors: true,
          },
        ],
        subtitles: sousTitres(subtitles, def),
      },
    };
  } catch (err) {
    /* Pas dans la table et anizone refuse cette machine : rien a servir d'ici,
       mais ce n'est pas une absence de l'episode — on ne la retient pas. */
    if (err instanceof Bloque) {
      /* Le cron horaire (.github/workflows/anizone-seed.yml) le rangera. */
      const db = getTursoClient();
      if (db) await demandeEpisode(db, Number(aniId), Number(ep)).catch(() => {});
      return { absent: err.message, bloque: true };
    }
    if (err instanceof Passager) return { transient: err.message };
    throw err;
  }
}
