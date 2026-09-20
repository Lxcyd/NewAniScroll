/**
 * Shared client-side cache for prefetched episode sources.
 *
 * The anime info page warms the source for the "Watch" target (megaplay,
 * resume episode) in the background. When the user then opens the watch page,
 * it reads the already-resolved source from here instead of re-issuing the
 * /api/v2/source request + waiting on extraction — so playback starts almost
 * immediately.
 *
 * Keyed by `${aniId}:${episode}:${server}:${sub|dub}`. Entries are short-lived
 * (source URLs carry rotating tokens) — we expire them after a few minutes so
 * a stale token never reaches the player.
 */

import { requestSource } from "./sourceRequest";
import { peekWarmVidmoly } from "../clientVidmoly";
import { bandwidthKey, pickStartVariant } from "./hlsBandwidth";
import { playbackUrl, preconnectOrigin, proxied } from "./streamUrl";

type CacheEntry = { data: any; at: number };

const TTL_MS = 5 * 60 * 1000; // 5 minutes — well under typical token lifetimes.
const store = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any>>();

export function sourceKey(
  aniId: number | string,
  episode: number | string,
  server: string,
  sub: "sub" | "dub",
): string {
  return `${aniId}:${episode}:${server}:${sub}`;
}

/** Read a fresh prefetched source, or null if absent/expired. */
export function getPrefetchedSource(key: string): any | null {
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return e.data;
}

export function setPrefetchedSource(key: string, data: any) {
  store.set(key, { data, at: Date.now() });
}

/**
 * Drop every cached source for an anime. Called when the user leaves the info
 * page that warmed them — we don't want a watch page reached later (with a
 * possibly rotated token) reading a stale entry, and there's no reason to keep
 * the memory around once the page that prefetched them is gone.
 *
 * Keys are `${aniId}:${episode}:${server}:${sub}`, so a prefix match on
 * `${aniId}:` covers every episode/server/sub combo we warmed for it.
 */
export function clearPrefetchedSourcesFor(aniId: number | string): void {
  const prefix = `${aniId}:`;
  Array.from(store.keys()).forEach((key) => {
    if (key.startsWith(prefix)) store.delete(key);
  });
  planned.delete(String(aniId));
}

/**
 * Le serveur que la page info a decide de prechauffer pour cet anime.
 *
 * Les deux pages resolvent le meme serveur avec les memes fonctions, sauf que la
 * page info affine son choix avec l'instantane de disponibilite — un GET qu'on
 * ne veut PAS mettre devant le premier chargement de la page de lecture. Sans ce
 * relais, les deux pages pouvaient donc choisir deux hotes differents de la meme
 * langue, et le prechauffage (lourd) etait perdu : la page de lecture attendait
 * une extraction a froid alors qu'une source resolue dormait a cote.
 *
 * En memoire, meme onglet, meme duree de vie que les sources prechauffees
 * (purge en quittant la page info sans aller regarder).
 */
/* Ce relais porte un VERDICT, pas un pari.
 *
 * Il ne transportait qu'un nom de serveur, ecrit AVANT le moindre test — la
 * page de lecture l'ouvrait donc sur parole. Cas signale le 20/09/2026 : dix
 * secondes passees sur la page info, clic, frembed demarre, echoue, vidmoly
 * prend le relais. On avait tout le temps de savoir, et on le savait peut-etre
 * deja : l'information etait simplement jetee.
 *
 * Trois champs, donc :
 *   planned  — le candidat ;
 *   verifie  — a-t-il ete PROUVE jouable (manifeste ET segment) ;
 *   recales  — ceux que la chaine a prouves morts, pour que la page de lecture
 *              ne les ouvre pas a son tour.
 * Un candidat non verifie reste un indice utile (clic en deux secondes), il
 * cesse seulement d'etre presente comme une certitude.
 */
type Pari = { planned: string; verifie: boolean; recales: Set<string> };

const planned = new Map<string, Pari>();

function pari(aniId: number | string): Pari {
  const k = String(aniId);
  let p = planned.get(k);
  if (!p) {
    p = { planned: "", verifie: false, recales: new Set() };
    planned.set(k, p);
  }
  return p;
}

/** Le candidat sur lequel on mise, sans preuve encore. */
export function setPlannedServer(aniId: number | string, server: string): void {
  if (!server) return;
  const p = pari(aniId);
  // Un candidat VERIFIE ne se fait pas deloger par un simple pari.
  if (p.verifie) return;
  p.planned = server;
}

/** Ce lecteur a rendu un flux reellement jouable pour cet anime. */
export function setVerifiedServer(aniId: number | string, server: string): void {
  if (!server) return;
  const p = pari(aniId);
  p.planned = server;
  p.verifie = true;
  p.recales.delete(server);
}

/** Ce lecteur a ete prouve mort : la page de lecture ne doit pas l'ouvrir. */
export function markPlannedFailed(aniId: number | string, server: string): void {
  if (!server) return;
  const p = pari(aniId);
  p.recales.add(server);
  if (p.planned === server && !p.verifie) p.planned = "";
}

export function getPlannedServer(aniId: number | string | null | undefined): string {
  if (aniId == null) return "";
  return planned.get(String(aniId))?.planned || "";
}

/** `true` seulement si le serveur annonce a ete prouve jouable. */
export function isPlannedVerified(aniId: number | string | null | undefined): boolean {
  if (aniId == null) return false;
  return planned.get(String(aniId))?.verifie === true;
}

/** Les lecteurs que la page info a prouves morts pour cet anime. */
export function getPlannedFailures(
  aniId: number | string | null | undefined,
): string[] {
  if (aniId == null) return [];
  return Array.from(planned.get(String(aniId))?.recales || []);
}

/**
 * Resolve a source via /api/v2/source and cache it. Deduplicates concurrent
 * calls for the same key (the prefetch + the watch page can race). Returns the
 * source payload, or null on failure (caller falls back to its own fetch).
 *
 * `priority: "low"` keeps the prefetch from competing with the info page's own
 * above-the-fold requests (images, metadata) for the connection pool.
 */
export async function resolveSource(
  params: {
    aniId: number;
    episode: number;
    server: string;
    sub: "sub" | "dub";
    title?: string;
    mediaMeta?: any;
  },
  opts: { priority?: "high" | "low" | "auto"; signal?: AbortSignal } = {},
): Promise<any | null> {
  const key = sourceKey(params.aniId, params.episode, params.server, params.sub);
  const cached = getPrefetchedSource(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = requestSource(
    {
      server: params.server,
      aniId: params.aniId,
      episode: params.episode,
      sub: params.sub,
      title: params.title,
      malId: params.mediaMeta?.idMal ?? null,
    },
    { signal: opts.signal, priority: opts.priority || "auto" },
  )
    .then((out) => {
      if (out.kind !== "ok") return null;
      setPrefetchedSource(key, out.data);
      return out.data;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/**
 * Chauffe le lecteur qu'on va ouvrir — et seulement lui, tant qu'il tient.
 *
 * La page info n'en prechauffait qu'UN : s'il ne repondait pas, personne ne
 * prenait le relais et la page de lecture repartait a froid, sur le lecteur le
 * plus lent du lot. Prechauffer les huit, a l'inverse, c'etait huit scrapes
 * (le poste le plus cher du site) par visite d'une page que la plupart des
 * gens quittent sans rien regarder.
 *
 * Entre les deux : une chaine. Le candidat n°1 part seul ; le n°2 ne part que
 * si le n°1 est MORT (absence, hote a terre, flux injouable) ou DOUTEUX (rien
 * au bout de DOUTE_MS) — et dans ce dernier cas les deux courent ensemble,
 * parce qu'un candidat lent n'est pas forcement perdu.
 *
 * `onPlanned` recoit le meilleur candidat SAIN connu a cet instant, et peut
 * donc etre appele deux fois : le n°2 s'annonce, puis le n°1 finit par
 * repondre et reprend la main — il etait mieux classe, c'est lui qu'on veut.
 */
const DOUTE_MS = 2500;

export async function warmChain(
  candidats: string[],
  params: { aniId: number; episode: number; sub: "sub" | "dub"; title?: string; mediaMeta?: any },
  opts: {
    signal?: AbortSignal;
    onPlanned?: (server: string) => void;
    onFailed?: (server: string) => void;
    onStream?: (server: string, data: any) => void;
    max?: number;
  } = {},
): Promise<void> {
  const liste = candidats.filter(Boolean).slice(0, opts.max ?? 3);
  let meilleurRang = Infinity;
  const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const tenter = async (server: string, rang: number): Promise<boolean> => {
    const data = await resolveSource({ ...params, server }, { priority: "high", signal: opts.signal });
    if (opts.signal?.aborted) return false;
    if (!data) {
      opts.onFailed?.(server);
      return false;
    }
    // Le flux lui-meme, pas seulement sa resolution : une source qui pointe sur
    // un manifeste mort est un lecteur mort, et on a de quoi le savoir ici.
    opts.onStream?.(server, data);
    /* Y COMPRIS pour l'extraction navigateur, qu'on tenait pour saine sans rien
       verifier : on attend son master (l'extraction est deja lancee par
       `onStream`, on ne fait que lire son resultat) puis on le traite comme
       n'importe quel flux direct. Sans ca, le seul lecteur qu'on ne validait
       pas etait celui par defaut. */
    let ok: boolean;
    const ce = data.clientExtract;
    if (ce?.type === "vidmoly" && ce.embedUrl) {
      const master = await peekWarmVidmoly(ce.embedUrl);
      ok = master
        ? await warmStream(
            { streams: [{ url: master, isM3U8: true, directUrl: true }] },
            opts.signal,
          )
        : false;
    } else if (ce) {
      // Multipart : on ne prechauffe pas, mais on ne le declare pas mort non plus.
      ok = true;
    } else {
      ok = await warmStream(data, opts.signal);
    }
    if (opts.signal?.aborted) return false;
    if (!ok) {
      opts.onFailed?.(server);
      return false;
    }
    if (rang < meilleurRang) {
      meilleurRang = rang;
      opts.onPlanned?.(server);
    }
    return true;
  };

  const enCours: Promise<boolean>[] = [];
  for (let i = 0; i < liste.length; i++) {
    const essai = tenter(liste[i], i);
    enCours.push(essai);
    // Mort tout de suite, ou muet passe le delai : on lance le suivant. Un
    // `race` contre une minuterie, pour ne pas attendre un candidat qui ne
    // repondra peut-etre jamais.
    const verdict = await Promise.race([
      essai.then((ok) => (ok ? "ok" : "mort")),
      attendre(DOUTE_MS).then(() => "doute" as const),
    ]);
    if (verdict === "ok" || opts.signal?.aborted) return;
  }
  await Promise.allSettled(enCours);
}

/**
 * Chauffe un flux ET dit s'il est SAIN. Deux usages, un seul aller-retour : on
 * lisait deja le manifeste, il suffisait d'en retenir le verdict.
 *
 * `true`  — manifeste lu (et, si c'est un master, sa variante de depart).
 * `false` — l'hote a refuse ou n'a rien rendu d'exploitable : l'appelant passe
 *           au lecteur suivant SANS attendre que le lecteur monte et echoue.
 *
 * Deux corrections par rapport a la version d'origine :
 *   - la premiere URI d'un MASTER est une playlist de VARIANTE, pas un
 *     segment : on descendait donc « les 256 Ko du premier segment » sur un
 *     fichier texte de 300 octets, et rien n'etait chauffe. On descend
 *     maintenant jusqu'au vrai segment, par la variante qu'hls.js demandera
 *     (cf. pickStartVariant) ;
 *   - un flux proxifie se chauffe par le Worker quand on le demande
 *     explicitement (`viaProxy`), puisque c'est le seul chemin que la lecture
 *     lit. Par defaut on s'en abstient : 256 Ko de video tires par le Worker
 *     sur une page info que le visiteur peut ne jamais quitter, ce serait un
 *     cout pour rien. Au moment du doute, en revanche, la personne regarde
 *     deja — et la bascule doit etre instantanee.
 */
export async function warmStream(
  streamData: any,
  signal?: AbortSignal,
  opts: { viaProxy?: boolean } = {},
): Promise<boolean> {
  const source = streamData?.sources?.[0] ?? streamData?.streams?.[0];
  if (!source?.url) return false;
  const direct = source.directUrl === true;
  if (!direct && !opts.viaProxy) return false;
  const depart = playbackUrl(source, streamData?.referer);
  if (!depart) return false;
  // On ouvre la connexion tout de suite : elle servira a la lecture elle-meme.
  preconnectOrigin(depart);
  /* Dans les MEMES conditions que la lecture. Le lecteur pose
     `referrerPolicy = "no-referrer"` sur le <video> d'un flux direct
     (cf. `directPlaybackRef` dans UniversalPlayer) parce que plusieurs CDN
     refusent un Referer ; valider avec le notre reviendrait a prouver un
     chemin que personne n'emprunte. */
  const commeLeLecteur = (extra: any = {}) => ({
    priority: "low",
    signal,
    ...(direct ? { referrerPolicy: "no-referrer" as const } : null),
    ...extra,
  });
  if (!/\.m3u8(\?|$)/i.test(source.url)) {
    // MP4 progressif (sibnet) : un bout du fichier suffit a dire s'il repond.
    try {
      const res = await fetch(
        depart,
        commeLeLecteur({ headers: { Range: "bytes=0-262143" } }) as any,
      );
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(depart, commeLeLecteur() as any);
    if (!res.ok) return false;
    const text = await res.text();
    if (!/^#EXTM3U/.test(text.trimStart())) return false;
    const absolu = (uri: string) =>
      uri.startsWith("http") ? uri : new URL(uri, source.url).toString();
    // Master : on descend par la variante qu'hls.js demandera en premier.
    const variante = pickStartVariant(text, bandwidthKey(source.url, direct));
    let playlist = text;
    let baseUrl = source.url;
    if (variante) {
      const url = absolu(variante);
      baseUrl = url;
      const r = await fetch(
        direct ? url : proxied(url, source.referer || streamData?.referer, source.voeCookie),
        commeLeLecteur() as any,
      );
      if (!r.ok) return false;
      playlist = await r.text();
    }
    const premier = playlist
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (!premier) return false;
    const segUrl = premier.startsWith("http")
      ? premier
      : new URL(premier, baseUrl).toString();
    /* 256 Ko : de quoi amorcer le cache d'edge sur l'ouverture de la lecture,
       sans tirer le segment entier. Et on JUGE cette reponse : elle etait
       avalee par un `.catch(() => {})` suivi d'un `return true`, si bien qu'un
       hote dont le manifeste repond et dont les SEGMENTS sont refuses (403 du
       CDN) passait pour sain. C'est exactement la panne frembed du 20/09 : la
       page info donnait son feu vert a un lecteur qui ne pouvait pas jouer. */
    try {
      const seg = await fetch(
        direct ? segUrl : proxied(segUrl, source.referer || streamData?.referer, source.voeCookie),
        commeLeLecteur({ headers: { Range: "bytes=0-262143" } }) as any,
      );
      return seg.ok || seg.status === 206;
    } catch {
      return false;
    }
  } catch {
    // Annulation (depart de la page) comprise : rien a conclure sur l'hote,
    // mais rien a chauffer non plus.
    return false;
  }
}
