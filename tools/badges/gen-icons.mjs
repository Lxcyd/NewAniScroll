// Génère lib/badges/icons.ts à partir de la table du catalogue, en vérifiant
// que chaque composant existe vraiment dans react-icons/md avant de l'écrire.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* Racine du depot, deduite de l emplacement du script : le generateur doit
   pouvoir tourner depuis n importe quel repertoire courant. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = createRequire(join(ROOT, "package.json"));
const Md = req("react-icons/md");

/* clé du catalogue -> glyphe Material. Trois substitutions par rapport à la
   maquette, faute d'équivalent dans le jeu Material Icons :
     skull      -> dangerous       (Material n'a pas de crâne)
     neurology  -> psychology_alt
     event_upcoming -> upcoming                                              */
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

const comp = (glyph) =>
  "MdOutline" + glyph.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join("");

const bad = [];
for (const [key, glyph] of Object.entries(MI)) {
  if (typeof Md[comp(glyph)] !== "function") bad.push(`${key} (${glyph} -> ${comp(glyph)})`);
}
if (bad.length) {
  console.error("Composants introuvables dans react-icons/md :\n  " + bad.join("\n  "));
  process.exit(1);
}

const used = [...new Set(Object.values(MI).map(comp))].sort();
const rows = Object.entries(MI)
  .map(([key, glyph]) => `  ${key}: ${comp(glyph)},`)
  .join("\n");

const out = `/**
 * Les icônes des badges — Material Icons, en contour, dessinées par
 * react-icons/md.
 *
 * PAS DE WEBFONT. La maquette du catalogue pose les glyphes avec la police
 * « Material Symbols Rounded » de Google ; le site, lui, dessine ses Material
 * Symbols en SVG inline partout ailleurs (components/anime/v2/RelationsGraph.tsx,
 * components/watch/primary/LangPreferenceModal.tsx) parce qu'« aller chercher la
 * police d'icônes pour six glyphes coûterait une webfont sur une vue que la
 * plupart des visiteurs n'ouvrent jamais ». La même raison vaut ici, en plus
 * fort : la notification d'achievement peut surgir sur n'importe quelle page, et
 * elle ne peut pas attendre le chargement d'une police pour montrer son jeton.
 *
 * react-icons est DÉJÀ une dépendance du projet et porte les 4341 Material
 * Icons avec leur géométrie exacte. On y prend les variantes \`MdOutline*\`,
 * parce que le catalogue demande des icônes « en contour ».
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main. La table de correspondance vit dans
 * tools/badges/gen-icons.mjs, qui vérifie l'existence de chaque composant avant
 * d'écrire. Trois glyphes de la maquette n'existent pas dans le jeu Material
 * Icons et sont remplacés : \`skull\` -> \`dangerous\`, \`neurology\` ->
 * \`psychology_alt\`, \`event_upcoming\` -> \`upcoming\`.
 */

import type { IconType } from "react-icons";
import {
${used.map((n) => `  ${n},`).join("\n")}
} from "react-icons/md";

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
console.log(`icons.ts écrit : ${Object.keys(MI).length} clés, ${used.length} composants distincts.`);
