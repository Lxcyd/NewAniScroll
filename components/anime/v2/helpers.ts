import { AniListInfoTypes, Edge } from "types/info/AnilistInfoTypes";
import type { TFunction } from "i18next";

/**
 * i18n-aware variants of the pretty* display helpers. The plain pretty*
 * functions still exist for non-React / logic callers; these take the
 * translation function `t` and return the localized label. AniList status /
 * country / list values are stable English keys mapped to the status.*,
 * country.*, list.* namespaces.
 */
export function statusLabel(t: TFunction, status: string | null): string {
  switch (status) {
    case "RELEASING":
      return t("status.airing");
    case "FINISHED":
      return t("status.finished");
    case "NOT_YET_RELEASED":
      return t("status.notYetReleased");
    case "CANCELLED":
      return t("status.cancelled");
    case "HIATUS":
      return t("status.hiatus");
    default:
      return status || t("status.na");
  }
}

/**
 * Sous-titre d'une ligne de saison dans un selecteur : "2024 · 12 EP", le
 * format seul quand ni l'annee ni le compte ne sont connus, et "Pas encore
 * sortie" pour une saison qui n'a pas commence — auquel cas l'annee annoncee
 * et un compte previsionnel diraient moins que le statut.
 *
 * Deux selecteurs le rendent : celui de la page d'info (v2/Episodes) et celui
 * du panneau du lecteur (watch/secondary/episodeLists). Ils affichaient la
 * meme ligne, ecrite deux fois.
 */
export function seasonSubtitle(
  t: TFunction,
  s: {
    year?: number | null;
    episodes?: number | null;
    format?: string | null;
    status?: string | null;
  },
): string {
  if (s.status === "NOT_YET_RELEASED") return t("anime.notYetReleased");
  return (
    [s.year, s.episodes ? `${s.episodes} EP` : null].filter(Boolean).join(" · ") ||
    (s.format ?? "")
  );
}

export function countryLabel(t: TFunction, c: string | null): string {
  switch (c) {
    case "JP":
      return t("country.JP");
    case "KR":
      return t("country.KR");
    case "CN":
      return t("country.CN");
    case "TW":
      return t("country.TW");
    default:
      return c || t("status.na");
  }
}

/** Translate a STATUS_TO_LIST value ("Watching", "Completed", …) or the
 *  "Add to List" fallback. */
export function listLabel(t: TFunction, list: string): string {
  const KEY: Record<string, string> = {
    "Add to List": "list.addToList",
    Watching: "list.watching",
    Rewatching: "list.rewatching",
    Completed: "list.completed",
    Planning: "list.planning",
    Paused: "list.paused",
    Dropped: "list.dropped",
  };
  const k = KEY[list];
  return k ? t(k) : list;
}

export const LIST_COLORS: Record<string, string> = {
  Watching: "#22c55e",
  Rewatching: "#06b6d4",
  Completed: "#3b82f6",
  Planning: "#a855f7",
  Paused: "#f97316",
  Dropped: "#ef4444",
};

export const STATUS_TO_LIST: Record<string, string> = {
  CURRENT: "Watching",
  REPEATING: "Rewatching",
  COMPLETED: "Completed",
  PLANNING: "Planning",
  PAUSED: "Paused",
  DROPPED: "Dropped",
};

export const LIST_TO_STATUS: Record<string, string> = {
  Watching: "CURRENT",
  Rewatching: "REPEATING",
  Completed: "COMPLETED",
  Planning: "PLANNING",
  Paused: "PAUSED",
  Dropped: "DROPPED",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatFuzzyDate(d: {
  year: number | null;
  month: number | null;
  day?: number | null;
} | null): string | null {
  if (!d?.year) return null;
  const m = d.month ? MONTHS[d.month - 1] : null;
  if (m && d.day) return `${m} ${d.day}, ${d.year}`;
  if (m) return `${m} ${d.year}`;
  return String(d.year);
}

export function formatAiredRange(info: AniListInfoTypes): string | null {
  const start = formatFuzzyDate(info.startDate);
  const end = info.endDate ? formatFuzzyDate(info.endDate) : null;
  if (!start) return null;
  if (info.status === "RELEASING") return `${start} – Present`;
  if (end && end !== start) return `${start} – ${end}`;
  return start;
}

export function prettySeason(info: AniListInfoTypes): string | null {
  if (info.season && info.seasonYear) {
    return `${capitalize(info.season)} ${info.seasonYear}`;
  }
  if (info.seasonYear) return String(info.seasonYear);
  return null;
}

export function prettyStatus(status: string | null): string {
  switch (status) {
    case "RELEASING":
      return "Airing";
    case "FINISHED":
      return "Finished";
    case "NOT_YET_RELEASED":
      return "Not yet released";
    case "CANCELLED":
      return "Cancelled";
    case "HIATUS":
      return "Hiatus";
    default:
      return status || "N/A";
  }
}

export function prettyFormat(fmt: string | null): string {
  if (!fmt) return "N/A";
  return fmt
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Tv/g, "TV")
    .replace(/Ova/g, "OVA")
    .replace(/Ona/g, "ONA");
}

export function prettySource(src: string | null): string {
  if (!src) return "N/A";
  return src
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function prettyCountry(c: string | null): string {
  switch (c) {
    case "JP":
      return "Japan";
    case "KR":
      return "Korea";
    case "CN":
      return "China";
    case "TW":
      return "Taiwan";
    default:
      return c || "N/A";
  }
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "";
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>(\s*)/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/* Parse an AniList description into (clean text, attribution).
   AniList stores source attribution as a literal "(Source: Crunchyroll)"
   suffix inside the description HTML, plus often a trailing italicized
   "Note: …" with a streaming caveat. We surface the source separately
   under the synopsis and strip both fragments from the body text. */
export function parseDescription(
  html: string | null | undefined
): { text: string; source: string | null } {
  const raw = stripHtml(html);
  if (!raw) return { text: "", source: null };

  // Last "(Source: XXX)" wins — some descriptions have multiple (rare,
  // but happens for merged entries) and the trailing one is the
  // canonical attribution.
  const sourceMatches = Array.from(raw.matchAll(/\(Source:\s*([^)]+)\)/gi));
  const source = sourceMatches.length
    ? sourceMatches[sourceMatches.length - 1][1].trim()
    : null;

  const text = raw
    // Drop every "(Source: …)" occurrence.
    .replace(/\(Source:\s*[^)]+\)/gi, "")
    // Drop the trailing "Note: …" caveat — usually a streaming-schedule
    // disclaimer that doesn't belong in the synopsis body.
    .replace(/\bNote:\s*[^]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { text, source };
}

/* URL-safe slug from any title. Used to decorate anime URLs
   (`/en/anime/123/solo-leveling`). Returns "" if nothing usable;
   callers should fall back to omitting the slug segment in that case.
   - lowercases, strips diacritics, drops anything that isn't [a-z0-9]
   - collapses runs of separators into a single dash
   Le titre est rendu ENTIER. Il etait coupe a 60 caracteres, ce qui tronquait
   les titres longs en pleine phrase — "…second-reincarnation-of-a" — et donnait
   une adresse qui a l'air cassee la ou elle devait justement se lire. Les 60
   caracteres economisaient d'ailleurs peu : la limite qui compte est celle de
   l'URL entiere, tres loin au-dessus. */
export function slugifyTitle(
  title:
    | { english?: string | null; romaji?: string | null; userPreferred?: string | null }
    | null
    | undefined
): string {
  if (!title) return "";
  const source =
    title.english || title.romaji || title.userPreferred || "";
  if (!source) return "";
  const ascii = source
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  return ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function pickRandom<T>(arr: T[]): T | null {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/* Language filter used for clearart / logo selection on the hero.
   The user requested EN + textless ("00") only — keeps the central image
   readable regardless of UI language while excluding Japanese / other
   localizations. */
export function isAcceptableLang(lang: string | null | undefined): boolean {
  if (!lang) return true; // textless
  const l = lang.toLowerCase();
  return l === "en" || l === "eng" || l === "00";
}

export type FanartItem = {
  url: string;
  language: string | null;
  likes: number;
  season: number | null;
  /* Both are server-side only: the NSFW decision is made by the WHERE clause in
     lib/db/fanarts.loadFanarts, and slimFanartsForSsr strips them before the
     payload is serialised into __NEXT_DATA__. No component reads either — they
     stay declared (optional) so a payload straight from /api/v2/fanarts, which
     still carries them, also type-checks. */
  label?: string;
  nsfwScore?: number | null;
};

export type FanartResponse = {
  animeId: number;
  includeNsfw: boolean;
  total: number;
  types: Record<string, FanartItem[]>;
};

/* What the SSR ships INSTEAD of the FanartResponse above.

   The rows themselves were 24 KB of every info-page HTML response (208 of them
   on One Piece) even though only two tab bodies read them, and <Tabs> mounts a
   body only once its tab is clicked. The tab bar still has to render its count
   badges on first paint, though — and a count is all it needs. So the payload
   collapses to these two numbers and lib/hooks/useFanarts fetches the rows from
   /api/v2/fanarts on demand. */
export type FanartsMeta = {
  /** Every row the query returned — drives the mobile "Artworks" badge. */
  total: number;
  /** Rows that collectArtworks would actually surface in the gallery
      (gallery-eligible types, acceptable language). Precomputed at SSR so the
      desktop badge is right without the rows being present. */
  artworkCount: number;
};

export type TitleImage = {
  url: string;
  kind: "clearart" | "logo";
  /** Optional queue of additional clearart URLs the client can cycle
   *  through on click. Always empty for logos (single image). */
  queue: string[];
};

/* Pick the info page's hero title image, in the order requested by the user
   (2026-08-08):
   1. random `clearart` (transparent character art) from fanart.tv, EN/textless
   2. TMDB logo
   3. most-liked fanart.tv `logo` (stylized title text), EN/textless
   4. null (caller falls back to plain title text)

   TMDB sits BETWEEN the two fanart.tv types rather than after both. The split
   is on kind, not on provider: clearart is the art this hero was designed
   around (and the only type that cycles), so it stays first whatever else
   exists — but between two *logos*, TMDB's library is the better and far more
   complete one, so a fanart.tv logo is now what fills TMDB's gaps rather than
   the other way round.

   When multiple clearart candidates exist, we ship the full list as a
   shuffled queue so the Hero can cycle through them on click without a
   second fanart fetch — same Turso read covers both the initial paint
   and every subsequent click.

   `tmdbLogo` is a plain URL because this file is bundled to the client and
   lib/tmdb/* is server-only; the SSR call site does the fetch. */
export function pickTitleImage(
  fanarts: FanartResponse | null,
  tmdbLogo?: string | null,
): TitleImage | null {
  const clearart = (fanarts?.types.clearart || []).filter((a) =>
    isAcceptableLang(a.language)
  );
  if (clearart.length > 0) {
    // Shuffle once at SSR. The result is the cycle order: index 0 paints
    // first, click goes to 1, 2, …, wraps back to 0.
    const urls = shuffle(clearart.map((c) => c.url));
    return { url: urls[0], kind: "clearart", queue: urls };
  }

  const fromTmdb = tmdbTitleImage(tmdbLogo);
  if (fromTmdb) return fromTmdb;

  return pickHeroLogo(fanarts);
}

/* fanart.tv logo only. The home hero wants the stylised title TEXT
   (HD ClearLogo) and never the transparent character art (clearart), which
   fights the banner background behind it; the info page uses it as the last
   image resort, after TMDB. Returns the most-liked acceptable-language logo,
   or null to fall back to text. */
export function pickHeroLogo(fanarts: FanartResponse | null): TitleImage | null {
  if (!fanarts) return null;
  const logos = (fanarts.types.logo || []).filter((a) =>
    isAcceptableLang(a.language)
  );
  if (logos.length > 0) {
    return { url: logos[0].url, kind: "logo", queue: [] };
  }
  return null;
}

/* Wrap a TMDB logo URL (lib/tmdb/animeImages.getTmdbAnimeImages().logo) as a
   TitleImage.

   Pure and provider-agnostic on purpose: this file is bundled to the client,
   and lib/tmdb/* is server-only (it reads TMDB_API_KEY and hits Turso). The
   fetch happens at the SSR call site; only the resulting URL crosses over.

   PRECEDENCE DIFFERS BY SURFACE, and it is a deliberate call each time:

   - Home hero (pages/en/index.tsx): TMDB FIRST. That carousel is a copy of
     Hayase's and renders the same logo they do.

     I originally had fanart.tv ahead of it and gave two reasons, only one of
     which survives. The NSFW filtering does NOT: a logo is title typography,
     there is nothing to filter, and TMDB's logo library carries no such risk
     in the first place. Our NSFW pipeline (lib/db/fanarts.ts) exists for
     BACKGROUNDS and CLEARART — character art, where it is genuinely needed —
     and citing it for logos was borrowing a justification from the wrong
     category. The edge-cache advantage is real (fanart-proxy.aniscroll.com,
     1-year cache, ~50 ms worldwide, versus an uncached hotlink to
     image.tmdb.org) but it is about the PIPE, not the image, and on a surface
     built to match theirs the image decides. Overruled 2026-08-08.
   - Info page (pages/en/anime/[...id].tsx): fanart.tv CLEARART first, then
     TMDB, then the fanart.tv logo (see pickTitleImage). The clearart cycle is
     a feature TMDB has no equivalent for, so it keeps the top slot; between
     two logos TMDB wins on coverage.

   Either way TMDB only ever fills what fanart.tv doesn't cover, or vice versa
   — fanart.tv covers a fraction of the catalogue, so both orderings leave the
   other provider plenty to do.

   `queue` is always empty: a logo is single-image, only clearart cycles. */
export function tmdbTitleImage(url: string | null | undefined): TitleImage | null {
  if (!url) return null;
  return { url, kind: "logo", queue: [] };
}

/* Fisher-Yates shuffle. Used to randomise the clearart cycle order at
   SSR so two visitors see different sequences. */
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* Flatten the fanart payload into a single artwork list for the Artworks tab.
   Drops anything outside the English/textless bucket; NSFW labels are already
   filtered server-side by /api/v2/fanarts.

   EVERY TYPE fanart.tv actually stores is galleried. The list below is not a
   guess — it is the distinct `type` values present in `anime_fanarts`, counted
   2026-08-08: logo 26350, poster 19031, background 18523, clearart 15999,
   character 12259, thumb 10391, banner 8678, seasonposter 7515, seasonthumb
   1771, seasonbanner 1526, disc 467.

   `logo`, `clearart`, `character` and `disc` used to be excluded on the
   grounds that "logos and clearart belong to the hero". That stopped holding
   the moment TMDB logos started appearing in this same gallery: the tab showed
   a TMDB logo while hiding fanart.tv's, and hid 28,000 clearart/character
   images that exist for no other surface. Character art in particular has no
   home anywhere else in the app. */
export function collectArtworks(
  fanarts: FanartResponse | null
): Array<FanartItem & { type: string }> {
  if (!fanarts) return [];
  const KEEP = new Set([
    "background",
    "poster",
    "banner",
    "thumb",
    "seasonposter",
    "seasonbanner",
    "seasonthumb",
    "logo",
    "clearart",
    "character",
    "disc",
  ]);
  const out: Array<FanartItem & { type: string }> = [];
  for (const [type, items] of Object.entries(fanarts.types)) {
    if (!KEEP.has(type)) continue;
    for (const it of items) {
      if (!isAcceptableLang(it.language)) continue;
      out.push({ ...it, type });
    }
  }
  return out.sort((a, b) => b.likes - a.likes);
}

/* Decide whether a related anime node should count as a "season" in the
   user-facing S1/S2/S3 numbering. We only count animated formats that
   actually look like seasons of a serial — movies, OVAs, specials and
   shorts get their own labelling in the Relations row but they don't
   bump the season counter on the Watch button. */
const SEASON_LIKE_FORMATS = new Set([
  "TV",
  "TV_SHORT",
  "ONA",
  // Some long-running properties (esp. shounen sequels released as ONA
  // continuation cours) live under ONA — count them. MOVIE / OVA / SPECIAL
  // deliberately excluded.
]);

/* Formats we're willing to walk *through* when chaining PREQUEL/SEQUEL,
   even though they don't count as seasons themselves. AniList sometimes
   inserts an OVA spin-off between two TV seasons (e.g. Slime S2's only
   PREQUEL is the "Visions of Coleus" OVA, not Slime S1) — we have to
   transit them or we'd stop the walk and mis-label S2 as S1. */
const WALKABLE_FORMATS = new Set([
  "TV",
  "TV_SHORT",
  "ONA",
  "OVA",
  "SPECIAL",
]);

export function isSeasonLike(
  node: { type?: string | null; format?: string | null } | null
): boolean {
  if (!node) return false;
  if (node.type && node.type !== "ANIME") return false;
  return SEASON_LIKE_FORMATS.has(node.format || "");
}

/* ── Season-chain guards ──────────────────────────────────────────────────
   These live here (not in lib/anilist/seasonDetection.ts) because that module
   re-exports FROM this file; keeping the primitives here avoids an import
   cycle. seasonDetection.ts re-exports them so non-React callers reach them
   through one path. */

/** Best available air year for a node (seasonYear, else startDate.year). */
export function yearOf(
  node:
    | { seasonYear?: number | null; startDate?: { year?: number | null } | null }
    | null
    | undefined
): number | null {
  if (!node) return null;
  if (typeof node.seasonYear === "number") return node.seasonYear;
  const y = node.startDate?.year;
  return typeof y === "number" ? y : null;
}

/** PREQUEL/SEQUEL only — ALTERNATIVE / PARENT link remakes / alternate
 *  versions / compilations, which must NOT chain as consecutive seasons
 *  (Gundam Origin ↔ Gundam 1979 is an ALTERNATIVE remake). */
export function isChainableRelation(relationType: string | null | undefined): boolean {
  return relationType === "PREQUEL" || relationType === "SEQUEL";
}

/** Air-year monotonicity guard — the key fix for the Gundam inversion. A
 *  SEQUEL edge must point no earlier than the current node; a PREQUEL edge no
 *  later. AniList mis-tags these (1979 Gundam tagged SEQUEL of the 2019
 *  remake); this rejects the bad edge. Unknown years → don't reject. */
export function edgeYearMonotonic(
  relationType: "PREQUEL" | "SEQUEL",
  currentNode:
    | { seasonYear?: number | null; startDate?: { year?: number | null } | null }
    | null
    | undefined,
  targetNode:
    | { seasonYear?: number | null; startDate?: { year?: number | null } | null }
    | null
    | undefined,
  toleranceYears = 1
): boolean {
  const cur = yearOf(currentNode);
  const tgt = yearOf(targetNode);
  if (cur == null || tgt == null) return true;
  if (relationType === "SEQUEL") return tgt >= cur - toleranceYears;
  return tgt <= cur + toleranceYears;
}

// Latin recap markers + Japanese ones:
//   総集編 (soushuuhen) — "recap/digest"; also its romaji "soushuuhen".
//   特別編集版 / 編集版 (…henshuu-ban) — a "specially re-edited edition", i.e. a
//     recompilation movie (JUJUTSU KAISEN: … Tokubetsu Henshuu-ban …). The
//     romaji "henshuu-ban" is the reliable signal these carry.
const RECAP_TITLE_RE =
  /\b(recap|digest|r[ée]sum[ée]|compilation|specials?)\b|総集編|特別編集版|編集版|soushuuhen|henshuu-?ban/i;

/** Title reads like a recap / digest / specials compilation → never a real
 *  numbered season. */
export function isRecapTitle(
  node: {
    title?: {
      english?: string | null;
      romaji?: string | null;
      native?: string | null;
      userPreferred?: string | null;
    } | null;
  } | null | undefined
): boolean {
  if (!node?.title) return false;
  const parts = [
    node.title.english,
    node.title.romaji,
    node.title.native,
    node.title.userPreferred,
  ].filter(Boolean) as string[];
  return parts.some((t) => RECAP_TITLE_RE.test(t));
}

function isWalkable(node: { type?: string; format?: string } | null): boolean {
  if (!node) return false;
  if (node.type && node.type !== "ANIME") return false;
  return WALKABLE_FORMATS.has(node.format || "");
}

/* Pick the best edge to follow when chaining a relation. AniList often
   returns several edges of the same type — favour a season-like (TV/ONA)
   node so we don't dead-end on a spin-off OVA when a real TV prequel is
   also linked. Falls back to any walkable anime node.

   When `currentTitle` is provided, only accept edges whose target title
   appears to belong to the same franchise. This catches the case where
   AniList tags a thematic / narrative prequel (One Piece → MONSTERS,
   the Ryuma one-shot) as PREQUEL — it's an ONA so it'd otherwise count
   as a prior season. */
function pickChainEdge(
  edges: Array<{ relationType: string; node: any }>,
  relationType: "PREQUEL" | "SEQUEL",
  currentTitle?: AnyTitle | null,
  currentNode?: { seasonYear?: number | null; startDate?: { year?: number | null } | null } | null
): { node: any } | null {
  // Chainable relation type + air-year monotonicity: reject ALTERNATIVE/PARENT
  // remakes and edges that jump the wrong way in time (Gundam 1979 mis-tagged
  // as a SEQUEL of the 2019 remake).
  const sameType = edges.filter(
    (e) =>
      e.relationType === relationType &&
      isChainableRelation(e.relationType) &&
      edgeYearMonotonic(relationType, currentNode, e.node)
  );
  if (sameType.length === 0) return null;

  // Narrow to edges that share at least one significant token with the
  // current title — i.e. likely belong to the same franchise. If none
  // do, refuse the edge entirely: better to under-count seasons than
  // to label One Piece as S2 because of the MONSTERS one-shot, which
  // AniList tags as PREQUEL but isn't part of the same series.
  if (currentTitle) {
    const sameFranchise = sameType.filter((e) =>
      sharesFranchise(currentTitle, e.node?.title)
    );
    if (sameFranchise.length === 0) return null;
    const seasonal = sameFranchise.find((e) => isSeasonLike(e.node));
    if (seasonal) return seasonal;
    return sameFranchise.find((e) => isWalkable(e.node)) || null;
  }

  // No title to compare against → fall back to the original logic.
  const seasonal = sameType.find((e) => isSeasonLike(e.node));
  if (seasonal) return seasonal;
  return sameType.find((e) => isWalkable(e.node)) || null;
}

type AnyTitle = {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
  userPreferred?: string | null;
} | null | undefined;

/* Heuristic: two titles belong to the same franchise if they share at
   least one significant token. We strip subtitles after ":", lowercase,
   tokenise on non-letters, then drop short / generic words. */
const STOPWORDS = new Set([
  "the","of","and","a","an","to","in","on","for","with","is","it","at",
  "by","be","as","or","season","part","movie","film","tv","ova","ona",
  "special","episode","story","saga","arc","new","final","first","second",
  "third","2nd","3rd","4th","5th","i","ii","iii","iv","v","vi","vii",
  "viii","ix","x",
]);

function tokenize(title: string): string[] {
  const base = title.split(":")[0].toLowerCase();
  const toks = base.split(/[^a-z0-9぀-ヿ一-鿿]+/i).filter(Boolean);
  const out: string[] = [];
  for (const t of toks) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

export function sharesFranchise(a: AnyTitle, b: AnyTitle): boolean {
  if (!a || !b) return true; // can't compare → don't filter out
  const aTitles = [a.english, a.romaji, a.userPreferred, a.native].filter(Boolean) as string[];
  const bTitles = [b.english, b.romaji, b.userPreferred, b.native].filter(Boolean) as string[];
  if (aTitles.length === 0 || bTitles.length === 0) return true;

  // Build a token set from `a` and look for any overlap in `b`'s
  // tokens. Sets are used as plain hash lookups; iteration stays on
  // arrays to keep older TS targets (no downlevelIteration) happy.
  const aTokens: Record<string, true> = {};
  for (const t of aTitles) {
    const toks = tokenize(t);
    for (let i = 0; i < toks.length; i++) aTokens[toks[i]] = true;
  }
  for (const t of bTitles) {
    const toks = tokenize(t);
    for (let i = 0; i < toks.length; i++) {
      if (aTokens[toks[i]]) return true;
    }
  }
  return false;
}

export type SeasonInfo = {
  /** 1-based season index of the current anime, or null if it isn't
   *  obviously part of a multi-season series. */
  number: number | null;
  /** Total seasons in the chain (if computable), else null. */
  total: number | null;
};

const ROMAN: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/* Pull a season number directly out of a title. Many AniList titles
   spell it out: "… Season 2", "2nd Season", "S2", "III". This is far
   more reliable than walking PREQUEL/SEQUEL edges because:
   - it handles "Part 2" entries that share a season with "Part 1"
     (e.g. "Slime Season 2 Part 2" → S2, not S3 like a naive walk
     would compute by counting two siblings)
   - it works on stand-alone titles AniList didn't bother linking
   We try each title (english, romaji, native) and return the first hit. */
export function extractSeasonFromTitle(
  title:
    | { english?: string | null; romaji?: string | null; native?: string | null }
    | null
    | undefined
): number | null {
  if (!title) return null;
  const candidates = [title.english, title.romaji, title.native].filter(
    Boolean
  ) as string[];

  for (const raw of candidates) {
    const t = raw.trim();

    // "Season 2" / "Season II" — explicit, most common form.
    let m = t.match(/\bSeason\s+(\d+|[IVX]+)\b/i);
    if (m) {
      const n = parseRomanOrInt(m[1]);
      if (n) return n;
    }

    // "2nd Season" / "Second Season"
    m = t.match(/\b(\d+)(?:st|nd|rd|th)\s+Season\b/i);
    if (m) return Number(m[1]);
    m = t.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+Season\b/i);
    if (m) {
      const n = ORDINAL_WORDS[m[1].toLowerCase()];
      if (n) return n;
    }

    // Japanese "2期" / "第2期" — common in romaji titles.
    m = t.match(/(?:第)?\s*(\d+)\s*期/);
    if (m) return Number(m[1]);

    // Trailing standalone "S2" — only when bordered by space/start,
    // to avoid matching arbitrary substrings.
    m = t.match(/(?:^|\s)S(\d+)(?:\s|$)/);
    if (m) return Number(m[1]);

    // "<Title> IV Part 2" / "<Title> IV: Subtitle" — Roman season marker
    // followed by a "Part N" cour split or a ":" subtitle. DanMachi,
    // OreGairu, etc. follow this convention. Constraint: the roman
    // numeral must come *after* a non-roman word (so we don't false-
    // positive on a title that simply ends in roman digits referencing
    // something else).
    m = t.match(/\s([IVX]+)\s+(?:Part\s+\d+|Part\s+[IVX]+|[A-Z][a-z])/);
    if (m) {
      const n = parseRomanOrInt(m[1]);
      if (n && n > 1) return n;
    }
    m = t.match(/\s([IVX]+):/);
    if (m) {
      const n = parseRomanOrInt(m[1]);
      if (n && n > 1) return n;
    }

    // Trailing Roman numeral as a season marker, e.g. "Bleach III".
    // Conservative: only when it's the LAST whitespace-separated token
    // and isn't preceded by "Part" (those are cours, not seasons —
    // they're handled by the Part suffix code in Hero.tsx).
    m = t.match(/\s([IVX]+)$/i);
    if (m && !/\bPart\s+[IVX]+$/i.test(t)) {
      const n = parseRomanOrInt(m[1]);
      if (n && n > 1) return n;
    }
  }

  return null;
}

function parseRomanOrInt(s: string): number | null {
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  const r = ROMAN[s.toLowerCase()];
  return r || null;
}

/**
 * The title with every season/part marker stripped — what's left is the work
 * itself. Used to tell a continuation of the SAME work from a new one.
 *
 * A number in a title only means "franchise season N" when the entry is a new
 * work. When it continues the previous one, the number counts within THAT
 * work, and trusting it corrupts the whole chain: the native title of
 * "Alicization - War of Underworld Part 2" is "… War of Underworld (2nd
 * Season)" — the second season *of War of Underworld* — which reset the
 * franchise counter from 4 back to 2 and labelled the entry "Season 2 Part 2",
 * after "Season 4". Comparing the stripped titles catches it: both entries
 * reduce to the same work, so the second one continues the first.
 */
export function seasonTitleBase(
  title:
    | { english?: string | null; romaji?: string | null; native?: string | null }
    | null
    | undefined
): string {
  const raw = String(title?.english || title?.romaji || "").trim();
  return raw
    .replace(/\b(?:Part|Cour)\s+(?:\d+|[IVX]+)\b/gi, "")
    .replace(/\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth)\s+Season\b/gi, "")
    .replace(/\bSeason\s+(?:\d+|[IVX]+)\b/gi, "")
    .replace(/\bFinal\s+(?:Season|Chapters?)\b/gi, "")
    .replace(/[\s:\-–—,.]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
}

/** Do two entries reduce to the same work, one continuing the other? */
export function continuesSameWork(
  prev: Parameters<typeof seasonTitleBase>[0],
  next: Parameters<typeof seasonTitleBase>[0]
): boolean {
  const a = seasonTitleBase(prev);
  const b = seasonTitleBase(next);
  // Short bases collide too easily ("SAO" vs "SAO"); require some substance.
  return a.length >= 6 && a === b;
}

/* Does a title read like a *continuation* of the previous season rather than
   a brand-new one? "Part 2", "Cour 2", "2nd Cour", "The Final Chapters", and a
   trailing "Part N" all denote a split of one season across multiple broadcast
   runs (AoT "The Final Season Part 2", Slime "Season 2 Part 2"). Such an entry
   must inherit the previous entry's season number, not bump it. */
export function isSeasonContinuation(
  title:
    | { english?: string | null; romaji?: string | null; native?: string | null }
    | null
    | undefined
): boolean {
  if (!title) return false;
  const candidates = [title.english, title.romaji, title.native].filter(
    Boolean
  ) as string[];
  for (const raw of candidates) {
    const t = raw.trim();
    // "Part 2" / "Part II" / "Cour 2" / "2nd Cour" — but NOT "Part 1" (a
    // first part starts a season, it doesn't continue one).
    if (/\bPart\s+(?:[2-9]\d*|I{2,}|IV|VI*|IX|X)\b/i.test(t)) return true;
    if (/\bCour\s+(?:[2-9]\d*)\b/i.test(t)) return true;
    if (/\b(?:[2-9]\d*)(?:nd|rd|th)\s+Cour\b/i.test(t)) return true;
    // "The Final Chapters" — AoT's continuation of "The Final Season".
    if (/\bFinal\s+Chapter/i.test(t)) return true;
  }
  return false;
}

/* Compute season position by walking PREQUEL / SEQUEL relations.
   Inputs are AniList "Media" payloads keyed by id (the SSR caller hydrates
   the map via getMediaMeta() for every ancestor / descendant on demand).
   Capped at MAX_HOPS to bail out on cyclic franchises (Pokémon-style).

   Two-pass approach:
   1. Walk the chain through OVA/SPECIAL bridges (don't dead-end on
      AniList quirks like Slime → "Visions of Coleus" OVA → Slime S1).
   2. Count only TV/season-like nodes in the final numbering. */
const MAX_HOPS = 12;

export function computeSeasonInfo(
  currentId: number,
  /** map of id → AniList Media payload (must include relations.edges) */
  mediaById: Map<number, any>
): SeasonInfo {
  const currentMedia = mediaById.get(currentId);
  // If the current anime isn't even season-like (it's a movie/OVA/special
  // spin-off), the S<n> label would be misleading — bail out.
  if (!currentMedia || !isSeasonLike(currentMedia)) {
    return { number: null, total: null };
  }

  // Walk back through PREQUEL chain (transit through OVAs if needed).
  // We resolve each hop to its full Media so we can read the title and
  // try extractSeasonFromTitle on each ancestor.
  //
  // The franchise check uses the *starting* anime's title throughout the
  // walk, not the current cursor's. Otherwise an off-franchise hop
  // through a side-story would shift the baseline and let the next hop
  // wander further off.
  const prequelChain: any[] = [];
  let cursor = currentId;
  const visitedBack = new Set<number>([currentId]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const media = mediaById.get(cursor);
    if (!media) break;
    const edge = pickChainEdge(
      media.relations?.edges || [],
      "PREQUEL",
      currentMedia.title,
      media
    );
    if (!edge) break;
    const nextId = Number(edge.node.id);
    if (!Number.isFinite(nextId) || visitedBack.has(nextId)) break;
    visitedBack.add(nextId);
    // Prefer the full Media payload (has all title variants); fall back
    // to the edge node when the walker didn't pre-load this hop.
    const fullNode = mediaById.get(nextId) || edge.node;
    prequelChain.push(fullNode);
    cursor = nextId;
  }

  // Walk forward through SEQUEL chain.
  const sequelChain: any[] = [];
  cursor = currentId;
  const visitedFwd = new Set<number>([currentId]);
  for (let i = 0; i < MAX_HOPS; i++) {
    const media = mediaById.get(cursor);
    if (!media) break;
    const edge = pickChainEdge(
      media.relations?.edges || [],
      "SEQUEL",
      currentMedia.title,
      media
    );
    if (!edge) break;
    const nextId = Number(edge.node.id);
    if (!Number.isFinite(nextId) || visitedFwd.has(nextId)) break;
    visitedFwd.add(nextId);
    const fullNode = mediaById.get(nextId) || edge.node;
    sequelChain.push(fullNode);
    cursor = nextId;
  }

  // === PRIMARY SIGNAL: title-based season extraction ===
  // If any node in the chain spells out its season ("Season 4", "IV Part 2",
  // "S5"), trust that number and derive the current season from it.
  // The walk above gives us a *position* in the chain, the titles give
  // us *absolute* season numbers — combine them.
  //
  // For each node we know (a) its season-like-or-not (b) its season
  // number from the title, if any. Walk forward through each chain
  // looking for the first node with a known number, then anchor on it.

  // Try the current anime itself first.
  const currentTitleSeason = extractSeasonFromTitle(currentMedia.title);
  if (currentTitleSeason != null) {
    return computeFromAnchor(currentTitleSeason, prequelChain, sequelChain);
  }

  // Then try the nearest prequel with a numbered title.
  for (let i = 0; i < prequelChain.length; i++) {
    const node = prequelChain[i];
    const n = extractSeasonFromTitle(node?.title);
    if (n != null) {
      // The node is `i + 1` steps back from current, but we only count
      // *season-like* hops between them. Count how many season-like
      // nodes sit between the anchor (exclusive) and current.
      const seasonsAhead = countSeasons(prequelChain.slice(0, i));
      const currentNumber = n + seasonsAhead + (isSeasonLike(node) ? 1 : 0);
      return computeFromAnchor(currentNumber, prequelChain, sequelChain);
    }
  }

  // Then try the nearest sequel with a numbered title.
  for (let i = 0; i < sequelChain.length; i++) {
    const node = sequelChain[i];
    const n = extractSeasonFromTitle(node?.title);
    if (n != null) {
      const seasonsBehind = countSeasons(sequelChain.slice(0, i));
      const currentNumber = n - seasonsBehind - (isSeasonLike(node) ? 1 : 0);
      if (currentNumber > 0) {
        return computeFromAnchor(currentNumber, prequelChain, sequelChain);
      }
    }
  }

  // === FALLBACK: pure count of season-like nodes in the prequel chain ===
  const prequelSeasons = countSeasons(prequelChain);
  const sequelSeasons = countSeasons(sequelChain);
  if (prequelSeasons === 0 && sequelSeasons === 0) {
    return { number: null, total: null };
  }
  return {
    number: prequelSeasons + 1,
    total: prequelSeasons + 1 + sequelSeasons,
  };
}

function countSeasons(nodes: any[]): number {
  return nodes.filter((n) => isSeasonLike(n)).length;
}

function computeFromAnchor(
  currentNumber: number,
  prequelChain: any[],
  sequelChain: any[]
): SeasonInfo {
  const sequelSeasons = countSeasons(sequelChain);
  // Total = current + how many seasons come after. We don't subtract
  // from prequels because currentNumber already encodes that information.
  return {
    number: currentNumber,
    total: currentNumber + sequelSeasons,
  };
}
