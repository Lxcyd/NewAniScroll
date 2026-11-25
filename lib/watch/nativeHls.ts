/* Lecture HLS NATIVE (anizone, 25/11/2026).
 *
 * Certains CDN ne laissent lire leurs fichiers en XHR qu'a leur propre site
 * (CORS) et refusent notre Worker : hls.js n'y peut rien. Le lecteur HLS natif
 * du navigateur, lui, charge en no-cors — comme une <img> — et lit tout
 * directement, sans un octet chez nous. Chrome recent, Edge, Safari et Android
 * l'ont ; Firefox non.
 *
 * Chrome n'expose pas `audioTracks` : impossible de changer de langue dans un
 * master multi-pistes. On remonte donc cote navigateur un master qui ne porte
 * QU'UNE piste son (celle choisie) et toutes les variantes video, en blob:
 * (un data: est refuse par Chrome, mesure). Changer de langue = remonter. */

export type NativeAudio = {
  lang: string;
  language: string;
  name: string;
  channels?: string;
  uri: string;
};
export type NativeMaster = {
  audios: NativeAudio[];
  variants: { inf: string; uri: string }[];
};

let natif: boolean | null = null;
/** Le navigateur lit-il l'HLS sans hls.js ? (false cote serveur) */
export function peutLireHlsNatif(): boolean {
  if (natif !== null) return natif;
  if (typeof document === "undefined") return false;
  try {
    natif = document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";
  } catch {
    natif = false;
  }
  return natif;
}

/** La piste son de depart : celle de la langue du chip, sinon japonais, sinon la premiere. */
export function audioDeDepart(m: NativeMaster, lang?: string | null): string | null {
  const a =
    (lang && m.audios.find((x) => x.lang === lang)) ||
    m.audios.find((x) => x.lang === "ja") ||
    m.audios[0];
  return a ? a.language : null;
}

const q = (s: string) => String(s).replace(/"/g, "'");

/** Le texte d'un master a une seule piste son (`language` = code complet). */
export function masterUnePiste(m: NativeMaster, language: string | null): string {
  const a = m.audios.find((x) => x.language === language) || m.audios[0];
  const out = ["#EXTM3U", "#EXT-X-VERSION:3"];
  if (a) {
    out.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${q(a.name)}",DEFAULT=YES,AUTOSELECT=YES,` +
        `LANGUAGE="${q(a.language)}",CHANNELS="${q(a.channels || "2")}",URI="${a.uri}"`,
    );
  }
  /* Chrome natif DEMARRE sur la plus basse variante, quel que soit l'ordre
     (verifie : 1080p en tete, il part quand meme en 360p) et y restait ~15 s
     — mesure du 25/11/2026. On retire donc ce qui est sous 720p des qu'il
     existe mieux ; plus haut debit en tete. Prix : une connexion sous
     ~2,4 Mbit/s ne peut plus descendre en 360p. */
  const debit = (inf: string) => Number((inf.match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
  const hauteur = (inf: string) => Number((inf.match(/RESOLUTION=\d+x(\d+)/) || [])[1]) || 0;
  const hd = m.variants.filter((v) => hauteur(v.inf) >= 720);
  const variantes = (hd.length ? hd : [...m.variants]).sort((x, y) => debit(y.inf) - debit(x.inf));
  for (const v of variantes) {
    let inf = v.inf;
    if (a) inf = /AUDIO="[^"]*"/.test(inf) ? inf.replace(/AUDIO="[^"]*"/, 'AUDIO="a"') : `${inf},AUDIO="a"`;
    else inf = inf.replace(/,AUDIO="[^"]*"/, "");
    out.push(inf, v.uri);
  }
  return out.join("\n") + "\n";
}

/* Une URL blob par master, gardee tant qu'on la lit : la revoquer pendant la
   lecture couperait le chargement des variantes. On ne garde que la derniere. */
let dernier: { cle: string; url: string } | null = null;
export function blobMaster(m: NativeMaster, language: string | null): string {
  const texte = masterUnePiste(m, language);
  if (dernier?.cle === texte) return dernier.url;
  const url = URL.createObjectURL(new Blob([texte], { type: "application/vnd.apple.mpegurl" }));
  const ancien = dernier;
  dernier = { cle: texte, url };
  // L'ancien master n'est plus lu une fois le nouveau charge.
  if (ancien) setTimeout(() => URL.revokeObjectURL(ancien.url), 30_000);
  return url;
}
