/**
 * L'historique de lecture de CET appareil, tel que le lecteur l'écrit.
 *
 * La même source que le carrousel « Repris récemment » de l'accueil et que la
 * page /en/anime/recently-watched : la clé localStorage `artplayer_settings`,
 * une ligne par anime (la dernière vue), écrite par le lecteur — cf.
 * pages/en/anime/watch/[...info].js. On la LIT ici, on n'y écrit jamais.
 *
 * Pourquoi elle plutôt que `aniscroll:progress` : elle porte de quoi
 * reconstruire un lien de lecture (`provider` + `watchId` + `num`), la vignette
 * de l'épisode et le titre. La table de progression, elle, ne connaît qu'une
 * position — c'est elle qu'on interroge ensuite, épisode par épisode, pour le
 * pourcentage. Les deux ensemble donnent la carte ET l'avancement.
 *
 * Rien n'est deviné : une ligne sans identifiant d'anime ou sans épisode est
 * ignorée, et une ligne sans `provider`/`watchId` renvoie vers la fiche plutôt
 * que vers une URL de lecture qui n'ouvrirait rien.
 */

const KEY = "artplayer_settings";

/**
 * « L'historique de cet appareil a changé. »
 *
 * LA CATÉGORIE QUI NE SE SYNCHRONISAIT JAMAIS. `cloudSync` marque une catégorie
 * sale sur un événement, et il n'en existait aucun pour ce store : `recent`
 * n'était donc poussé que par un `pushAll()` complet — à l'inscription, ou en
 * répondant « garder cet appareil » à la fenêtre de conflit. Entre deux, la
 * copie du compte était gelée, pendant que `progress` (qui a son
 * `aniscroll:progress-tick`) restait à jour. Mesuré le 01/09/2026 sur un profil
 * de dev : « Regarde en ce moment » annonçait un épisode vieux de six jours,
 * avec une progression fraîche appliquée dessus.
 *
 * Invisible tant que ce store ne servait qu'à l'appareil qui l'écrit. Il nourrit
 * maintenant le profil public (lib/profile/activity.ts), donc son retard se voit
 * — et il faut aussi que retirer une ligne de son historique la retire chez les
 * visiteurs, faute de quoi « je l'enlève » ne veut rien dire.
 *
 * À appeler après CHAQUE écriture de `artplayer_settings`, y compris les
 * suppressions. Le coût est nul : `mark()` est débounce à 5 s et `pushKinds`
 * envoie toutes les catégories sales dans une seule requête.
 */
export const HISTORY_EVENT = "aniscroll:history:change";

export function touchHistory(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HISTORY_EVENT));
}

export type HistoryRow = {
  aniId: number;
  episode: number;
  /** Identifiant d'épisode chez le lecteur, requis pour rouvrir la lecture. */
  watchId: string | null;
  provider: string | null;
  dub: boolean;
  /** Titre de l'anime tel que le lecteur l'a enregistré. */
  animeTitle: string | null;
  /** Titre de l'épisode. */
  episodeTitle: string | null;
  /** Vignette 16:9 de l'épisode, quand le lecteur en avait une. */
  image: string | null;
  /** Couverture verticale. */
  cover: string | null;
  /** Epoch ms de la dernière ouverture. */
  at: number;
};

/**
 * Le suffixe de format qu'AniList colle à un titre, retiré.
 *
 * « Kimetsu no Yaiba: Mugen Ressha-hen (TV) » : le « (TV) » n'est pas dans le
 * nom de l'œuvre, c'est la désambiguïsation d'AniList entre l'arc télévisé et
 * le film du même nom. Il a du sens dans un catalogue où les deux se suivent ;
 * sur une carte qui montre UNE lecture en cours, il ne distingue rien de rien
 * et ne fait qu'allonger un titre déjà coupé à trois lignes.
 *
 * Retiré ICI plutôt que dans chaque widget : c'est la mise en forme commune aux
 * deux vues de l'historique (cf. `rowsFromRaw`), et deux nettoyages séparés
 * finiraient par diverger. Seul un suffixe EN FIN de titre est touché, et
 * seulement s'il nomme un format — « (2019) », « (Dub) » ou une parenthèse qui
 * fait partie du nom sont laissés tranquilles.
 */
const FORMAT_SUFFIX = /\s*\((TV|TV Short|Movie|OVA|ONA|Special|Music)\)\s*$/i;

export function stripFormatSuffix(title: string | null): string | null {
  if (!title) return title;
  const clean = title.replace(FORMAT_SUFFIX, "").trim();
  // Un titre qui n'est QUE son format (« (OVA) ») vaut mieux entier que vide.
  return clean || title;
}

function parseDate(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * Le contenu du store, mis en forme — du plus récent au plus ancien.
 *
 * Séparé de `readHistory` parce que cette moitié-là ne connaît pas le
 * navigateur : le même store, sauvegardé sur le compte par cloudSync sous la
 * catégorie `recent`, est relu au rendu serveur pour peindre l'activité du
 * propriétaire d'un profil (lib/profile/activity.ts). Une seule mise en forme
 * pour les deux, sinon les deux vues du même historique divergent.
 */
export function rowsFromRaw(raw: unknown, limit = 12): HistoryRow[] {
  if (!raw || typeof raw !== "object") return [];
  const rows: HistoryRow[] = [];
  for (const item of Object.values(raw as Record<string, any>)) {
    if (!item || typeof item !== "object") continue;
    const aniId = Number((item as any).aniId);
    const episode = Number((item as any).episode);
    if (!Number.isFinite(aniId) || !Number.isFinite(episode)) continue;
    rows.push({
      aniId,
      episode,
      watchId: typeof (item as any).watchId === "string" ? (item as any).watchId : null,
      provider: typeof (item as any).provider === "string" ? (item as any).provider : null,
      dub: !!(item as any).dub,
      animeTitle: stripFormatSuffix((item as any).aniTitle || null),
      episodeTitle: (item as any).title || null,
      image: (item as any).image || null,
      cover: (item as any).cover || null,
      at: parseDate((item as any).createdAt),
    });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

/** L'historique de CET appareil, du plus récent au plus ancien. */
export function readHistory(limit = 12): HistoryRow[] {
  if (typeof window === "undefined") return [];
  try {
    return rowsFromRaw(JSON.parse(window.localStorage.getItem(KEY) || "{}"), limit);
  } catch {
    return [];
  }
}

/** L'adresse à ouvrir pour reprendre cette ligne. */
export function watchHref(row: HistoryRow): string {
  if (!row.provider || !row.watchId) return `/en/anime/${row.aniId}`;
  return (
    `/en/anime/watch/${row.aniId}/${row.provider}` +
    `?id=${encodeURIComponent(row.watchId)}&num=${row.episode}` +
    (row.dub ? "&dub=true" : "")
  );
}
