/**
 * LES FONDS ANIMÉS (23/10/2026, Luc) : des boucles vidéo prêtes à porter en
 * fond de profil, rangées par anime dans l'onglet Vidéo du studio.
 *
 * Les fichiers ne sont PAS dans le dépôt : 331 Mo recopiés à chaque
 * déploiement Vercel, c'est le quota de stockage qui saute (cf. CLAUDE.md). Ils
 * vivent sur le projet Cloudflare Pages `aniscroll-fonds`, servi sous
 * `FONDS_HOST` (gratuit sans carte bancaire, contrairement à R2 ; bande
 * passante illimitée, en cache au bord ; 25 Mio max par fichier). Ce module
 * n'en garde que le catalogue (`fonds.json`).
 *
 * Ajouter un fond : déposer `<anime>/<id>.webm` + `.jpg` + `-thumb.webp` dans
 * le dossier source, sa ligne dans fonds.json, puis
 * `node scripts/fonds/deploy-pages.mjs <dossier>`. Une vidéo se garde ENTIÈRE :
 * pour l'alléger, on recompresse, on ne coupe jamais.
 */
import catalogue from "./fonds.json";

/** Le domaine du bucket — aussi dans la liste blanche de lib/profile/dressing.ts. */
export const FONDS_HOST = "fonds.aniscroll.com";
/* En DÉVELOPPEMENT, la copie locale `public/fonds/` (gitignorée, donc jamais
   dans un déploiement) : le studio se teste sans dépendre de Pages. La liste
   blanche n'accepte ce chemin relatif qu'en développement (dressing.ts). */
export const FONDS_LOCAL = "/fonds/";
const BASE =
  process.env.NODE_ENV === "development" ? FONDS_LOCAL.slice(0, -1) : `https://${FONDS_HOST}`;

export type Fond = {
  id: string;
  anime: string;
  title: string;
  /** La fiche AniList de l'anime, quand elle est certaine. */
  anilistId: number | null;
  /** Adresse complète de la vidéo (webm). */
  url: string;
  /** Adresse complète de l'image d'aperçu (jpg 640×360) : la case vidéo du profil. */
  poster: string;
  /** La vignette de la tuile du studio (webp 384×216, ~8 Ko au lieu de ~30). */
  thumb: string;
  /** Un aperçu flou de 24×14 en data: URL (~230 caractères), montré AVANT que
      la vignette n'arrive : la tuile n'est jamais un rectangle vide. */
  lqip: string | null;
  /** La boucle porte une piste son. */
  audio: boolean;
};

export const FONDS: Fond[] = (catalogue as any[]).map((f) => ({
  id: f.id,
  anime: f.anime,
  title: f.title,
  anilistId: f.anilistId ?? null,
  url: `${BASE}/${f.file}`,
  poster: `${BASE}/${f.poster}`,
  thumb: `${BASE}/${f.thumb ?? f.poster}`,
  lqip: typeof f.lqip === "string" ? f.lqip : null,
  audio: !!f.audio,
}));

/** L'affiche d'un fond du catalogue (la case vidéo du profil), ou `null`.
    Lue ici plutôt que dans `videoCover`, que la validation du profil vide
    pour une adresse relative — celles du dev local (case noire, 24/10/2026). */
export function fondPoster(url: string | null | undefined): string | null {
  return fondOf(url)?.poster ?? null;
}

/* LE FOND D'UNE ADRESSE, quel que soit l'hôte (24/10/2026, Luc : « petit bug
   en bas », une case musique noire avec un égaliseur). L'adresse d'un fond
   dépend de l'endroit : `/fonds/…` en local, `https://fonds.aniscroll.com/…`
   ailleurs. Un fond posé sur dev et revu en local ne se retrouvait pas à
   l'adresse exacte : ni affiche (case noire), ni « muet » (barres affichées).
   On compare donc le CHEMIN du fichier. */
const fondPath = (url: string) =>
  url.replace(new RegExp(`^https?://${FONDS_HOST.replace(/\./g, "\\.")}/`), "").replace(/^\/fonds\//, "");
export function fondOf(url: string | null | undefined): Fond | null {
  if (!url) return null;
  const p = fondPath(url);
  return FONDS.find((f) => fondPath(f.url) === p) ?? null;
}

/** Un fond du catalogue SANS piste son : sa case n'a ni égaliseur ni volume. */
export function isFondMuet(url: string | null | undefined): boolean {
  const f = fondOf(url);
  return !!f && !f.audio;
}

/** Les fonds groupés par anime, dans l'ordre du catalogue (déjà trié). */
export function fondsParAnime(): { anime: string; fonds: Fond[] }[] {
  const out: { anime: string; fonds: Fond[] }[] = [];
  for (const f of FONDS) {
    const last = out[out.length - 1];
    if (last && last.anime === f.anime) last.fonds.push(f);
    else out.push({ anime: f.anime, fonds: [f] });
  }
  return out;
}
