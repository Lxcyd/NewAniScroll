// Génère lib/badges/icons.ts : chaque glyphe est téléchargé une fois chez
// Google (Material Symbols ROUNDED, contour, graisse 400, 24 px) et son tracé
// est écrit en dur dans le fichier. Aucune webfont, aucun appel au runtime.
//   node tools/badges/gen-icons.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const url = (name) =>
  `https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsrounded/${name}/default/24px.svg`;

/* clé du catalogue -> glyphe Material Symbols. Substitutions par rapport à la
   maquette d'origine : skull -> dangerous, neurology -> psychology_alt,
   event_upcoming -> upcoming (choix gardés de l'ancien jeu Material Icons). */
const MI = {
  screen1: "play_circle", screen2: "video_library", screen3: "subscriptions", screenPlus: "smart_display",
  screenTwin: "groups", screenBroken: "broken_image", pauseOff: "motion_photos_on",
  dial: "schedule", dialPlain: "watch_later", dialTicks: "timer", dialMoon: "bedtime", dialDouble: "av_timer",
  hourglass: "hourglass_top", weekend: "weekend",
  question: "question_mark", copyLink: "content_copy", gear: "settings", resume: "play_circle",
  spotlight: "lightbulb", curious: "manage_search", skullNight: "dangerous", fishHook: "phishing",
  partnerHeart: "favorite_border", knightPiece: "psychology_alt", history: "history",
  again3: "published_with_changes", cinema: "movie", genresAll: "category", noPause: "timelapse",
  burst: "bolt", cutlery: "restaurant",
  flag: "flag", three: "looks_3", loop3: "repeat_on", dayD: "event", theaters: "theaters",
  fish: "phishing", fist: "sports_mma", hearts: "diversity_1", horror: "sentiment_very_dissatisfied",
  reborn: "autorenew", laugh: "sentiment_very_satisfied", volley: "sports_volleyball", brainAlt: "psychology_alt",
  bookmark: "bookmark", bookmarkCheck: "bookmark_added", layers: "layers",
  calendar: "calendar_month", calendarCheck: "event_available", calendarHalf: "date_range",
  calendarPlus: "upcoming", calendarPlay: "today",
  wheel10: "donut_small", wheelFull: "donut_large", rings: "all_inclusive", link: "link",
  shieldCheck: "verified_user", film: "description", dpad: "gamepad", skipOff: "skip_next",
  starList: "reviews", loop: "replay", shuffle: "shuffle", clapper: "movie_filter", gem: "diamond",
  magnifier: "search", timeline: "timeline", broadcast: "podcasts", speech: "translate",
  sword: "sports_kabaddi", heart: "favorite", ghost: "mood_bad", robot: "smart_toy", leaf: "local_cafe",
  portal: "explore", castle: "castle", rocket: "rocket_launch", teardrop: "theater_comedy", smile: "mood",
  ball: "sports_soccer", note: "music_note", mic: "mic", brain: "psychology", eye: "visibility",
  wand: "auto_fix_high", torii: "temple_buddhist", school: "school", mask: "masks", chef: "ramen_dining",
  moon: "dark_mode", sun: "light_mode", flame: "local_fire_department", hexCluster: "workspace_premium",
  gridFull: "grid_view", cake: "cake", listPlus: "playlist_add", trophy: "emoji_events", movies: "local_movies",
  queueMusic: "queue_music", speed: "speed", twilight: "wb_twilight", recap: "summarize",
  translate: "translate", oldest: "restore", selfie: "account_circle", showcase: "push_pin",
  console: "terminal", gavel: "gavel", loupeSelf: "manage_search", noEntry: "block",
  players: "cast", tagsAll: "sell", longTitle: "text_fields", compass: "explore", ninja: "visibility_off",
  aura: "bolt", wall: "shield_moon", blade: "content_cut", sleuth: "travel_explore",
  crown: "military_tech", scroll: "history_edu", skull: "dangerous", pen: "edit_note",
  gearHeart: "favorite_border", spiral: "blur_on", card: "style", hoop: "sports_basketball",
  bike: "directions_bike", pot: "soup_kitchen", titan: "fitness_center", spell: "auto_awesome",
  slime: "bubble_chart", guild: "diversity_3", gun: "my_location", mechaG: "precision_manufacturing",
  space: "rocket_launch", bounty: "paid", tape: "album", chain: "link", diary: "menu_book",
  teapot: "emoji_food_beverage", cat: "pets", sunflower: "local_florist", clockRed: "alarm",
  dropSweep: "delete_sweep", swap: "swap_vert", longSeries: "format_list_numbered",
  alphabet: "sort_by_alpha",
};

/* Tracés fournis par Luc (déjà au style Rounded, viewBox 24) : billet à étoile
   (10/11/2026, bingo), viseur (23/11/2026, « D'un coup »). */
const CUSTOM = {
  ticketStar: "M12,13.9l1.5,1.15q0.28,0.23 0.6,0.01t0.2-0.56l-0.6-1.9l1.67-1.3q0.28-0.22 0.15-0.56T15.05,10.4H13.1L12.48,8.48Q12.35,8.13 12,8.13T11.53,8.48L10.9,10.4H8.93q-0.35,0-0.46,0.34T8.63,11.3l1.63,1.3l-0.6,1.93q-0.13,0.35 0.18,0.56t0.6-0.01L12,13.9ZM4,20q-0.82,0-1.41-0.59T2,18V14.63q0-0.28 0.18-0.48T2.63,13.9q0.6-0.2 0.99-0.72T4,12T3.61,10.83T2.63,10.1Q2.35,10.05 2.18,9.85T2,9.38V6Q2,5.18 2.59,4.59T4,4H20q0.83,0 1.41,0.59Q22,5.18 22,6V9.38q0,0.27-0.17,0.47T21.38,10.1q-0.6,0.2-0.99,0.72T20,12t0.39,1.17t0.99,0.72q0.28,0.05 0.45,0.25T22,14.63V18q0,0.82-0.59,1.41T20,20H4Zm0-2H20V15.45q-0.93-0.55-1.46-1.46Q18,13.08 18,12t0.54-1.99T20,8.55V6H4V8.55Q4.93,9.1 5.46,10.01T6,12T5.46,13.99T4,15.45V18Zm8-6Z",
  crosshair: "M11,21.95v-1Q7.88,20.6 5.64,18.36T3.05,13h-1q-0.43,0-0.71-0.29Q1.05,12.43 1.05,12t0.29-0.71T2.05,11h1Q3.4,7.88 5.64,5.64T11,3.05v-1q0-0.42 0.29-0.71T12,1.05t0.71,0.29T13,2.05v1q3.13,0.35 5.36,2.59T20.95,11h1q0.42,0 0.71,0.29T22.95,12t-0.29,0.71T21.95,13h-1q-0.35,3.13-2.59,5.36T13,20.95v1q0,0.43-0.29,0.71T12,22.95t-0.71-0.29T11,21.95Zm5.95-5Q19,14.9 19,12T16.95,7.05T12,5T7.05,7.05T5,12t2.05,4.95T12,19t4.95-2.05ZM9.18,14.83Q8,13.65 8,12T9.18,9.17T12,8t2.83,1.17T16,12t-1.17,2.82T12,16T9.18,14.83Zm4.24-1.41Q14,12.83 14,12t-0.59-1.41T12,10t-1.41,0.59Q10,11.18 10,12t0.59,1.41T12,14t1.41-0.59ZM12,12Z",
};

/* Hors Material : fantôme d'Halloween (24/09/2026), pris dans Tabler (déjà
   arrondi) ; `ghost` ci-dessus n'est qu'un visage. */
const OTHER = { phantom: ["tb", "TbGhost"] };

const glyphs = [...new Set(Object.values(MI))].sort();
const paths = {};
const bad = [];
await Promise.all(
  glyphs.map(async (g) => {
    const res = await fetch(url(g));
    const svg = res.ok ? await res.text() : "";
    const ds = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
    if (!ds.length || !svg.includes('viewBox="0 -960 960 960"')) bad.push(`${g} (HTTP ${res.status})`);
    else paths[g] = ds;
  }),
);
if (bad.length) {
  console.error("Glyphes introuvables chez Google (Material Symbols Rounded) :\n  " + bad.join("\n  "));
  process.exit(1);
}

const ident = (g) => "S_" + g;
const defs = glyphs
  .map((g) => `const ${ident(g)} = sym(${paths[g].map((d) => JSON.stringify(d)).join(", ")});`)
  .join("\n");
const customDefs = Object.entries(CUSTOM)
  .map(([key, d]) => `const C_${key} = sym24(${JSON.stringify(d)});`)
  .join("\n");
const rows = [
  ...Object.entries(CUSTOM).map(([key]) => `  ${key}: C_${key},`),
  ...Object.entries(MI).map(([key, g]) => `  ${key}: ${ident(g)},`),
  ...Object.entries(OTHER).map(([key, [, name]]) => `  ${key}: ${name},`),
].join("\n");
const otherImports = Object.entries(
  Object.values(OTHER).reduce((acc, [set, name]) => ((acc[set] ??= new Set()).add(name), acc), {}),
).map(([set, names]) => `import { ${[...names].sort().join(", ")} } from "react-icons/${set}";`).join("\n");

const out = `/**
 * Les icônes des badges — Material Symbols ROUNDED (contour, graisse 400), les
 * glyphes de fonts.google.com/icons aux angles arrondis.
 *
 * PAS DE WEBFONT : la notification d'achievement peut surgir sur n'importe
 * quelle page et ne peut pas attendre une police d'icônes. Les tracés SVG sont
 * donc copiés ici une fois pour toutes et dessinés par GenIcon (react-icons).
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main. La table vit dans
 * tools/badges/gen-icons.mjs, qui télécharge chaque glyphe chez Google et
 * échoue si l'un manque.
 */

import type { IconType } from "react-icons";
import { GenIcon } from "react-icons/lib";
${otherImports}

const sym = (...d: string[]): IconType =>
  GenIcon({
    tag: "svg",
    attr: { viewBox: "0 -960 960 960" },
    child: d.map((p) => ({ tag: "path", attr: { d: p }, child: [] })),
  }) as IconType;

const sym24 = (d: string): IconType =>
  GenIcon({ tag: "svg", attr: { viewBox: "0 0 24 24" }, child: [{ tag: "path", attr: { d }, child: [] }] }) as IconType;

${defs}
${customDefs}

export const BADGE_ICONS: Record<string, IconType> = {
${rows}
};

/** L'icône d'un badge, ou le trophée par défaut si la clé est inconnue. */
export function iconFor(key: string): IconType {
  return BADGE_ICONS[key] ?? BADGE_ICONS.trophy;
}

/** Le point d'interrogation des badges secrets non débloqués. */
export const SECRET_ICON: IconType = BADGE_ICONS.question;
`;

writeFileSync(join(ROOT, "lib", "badges", "icons.ts"), out);
console.log(`icons.ts écrit : ${Object.keys(MI).length} clés, ${glyphs.length} glyphes distincts.`);
