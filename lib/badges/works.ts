/**
 * Les œuvres nommées par les badges secrets, par id AniList.
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Source : tools/badges/works.data.mjs, qui porte aussi le TITRE attendu de
 * chaque id. `node tools/badges/check-works.mjs` confronte les deux à AniList :
 * c'est là, et nulle part ailleurs, qu'un id faux se rattrape — un badge dont
 * l'id est faux ne se débloque jamais et ressemble à un badge difficile.
 *
 * Vérifié le 2026-09-16 : 74 ids, tous conformes.
 */

export type WorkDef = {
  /** "all" : toutes les entrées doivent être terminées. "any" : une suffit. */
  mode: "all" | "any";
  ids: number[];
};

export const WORKS: Record<string, WorkDef> = {
  bigThree: { mode: "any", ids: [21, 20, 269] },
  onePiece: { mode: "all", ids: [21] },
  naruto: { mode: "all", ids: [20, 1735] },
  boruto: { mode: "all", ids: [97938] },
  dragonBall: { mode: "all", ids: [223, 813, 21745] },
  demonSlayer: { mode: "all", ids: [101922] },
  aot: { mode: "all", ids: [16498] },
  hxh: { mode: "all", ids: [11061] },
  bleach: { mode: "all", ids: [269, 116674] },
  fmab: { mode: "all", ids: [5114] },
  conan: { mode: "all", ids: [235] },
  pokemon: { mode: "all", ids: [527] },
  mha: { mode: "all", ids: [21459] },
  deathNote: { mode: "all", ids: [1535] },
  jjk: { mode: "all", ids: [113415] },
  chainsawMan: { mode: "all", ids: [127230] },
  opm: { mode: "all", ids: [21087] },
  blackClover: { mode: "all", ids: [97940] },
  steinsGate: { mode: "all", ids: [9253] },
  reZero: { mode: "all", ids: [21355] },
  sao: { mode: "all", ids: [11757] },
  slime: { mode: "all", ids: [101280] },
  shieldHero: { mode: "all", ids: [99263] },
  mushoku: { mode: "all", ids: [108465] },
  overlord: { mode: "all", ids: [20832] },
  konosuba: { mode: "all", ids: [21202] },
  frieren: { mode: "all", ids: [154587] },
  soloLeveling: { mode: "all", ids: [151807] },
  codeGeass: { mode: "all", ids: [1575] },
  evangelion: { mode: "all", ids: [30] },
  bebop: { mode: "all", ids: [1] },
  champloo: { mode: "all", ids: [205] },
  gits: { mode: "all", ids: [467] },
  trigun: { mode: "all", ids: [6] },
  berserk: { mode: "all", ids: [33] },
  monster: { mode: "all", ids: [19] },
  vinland: { mode: "all", ids: [101348] },
  kingdom: { mode: "all", ids: [10033] },
  ngnl: { mode: "all", ids: [19815] },
  yugioh: { mode: "all", ids: [481] },
  haikyu: { mode: "all", ids: [20464] },
  kuroko: { mode: "all", ids: [11771] },
  blueLock: { mode: "all", ids: [137822] },
  yowamushi: { mode: "all", ids: [18179] },
  slamDunk: { mode: "all", ids: [170] },
  foodWars: { mode: "all", ids: [20923] },
  ansatsu: { mode: "all", ids: [20755] },
  fruitsBasket: { mode: "all", ids: [105334] },
  toradora: { mode: "all", ids: [4224] },
  clannad: { mode: "all", ids: [2167, 4181] },
  yourLie: { mode: "all", ids: [20665] },
  gintama: { mode: "all", ids: [918] },
  miraiNikki: { mode: "all", ids: [10620] },
  spyFamily: { mode: "all", ids: [140960] },
  drStone: { mode: "all", ids: [105333] },
  tokyoGhoul: { mode: "all", ids: [20605] },
  parasyte: { mode: "all", ids: [20623] },
  neverland: { mode: "all", ids: [101759] },
  jojo: { mode: "all", ids: [14719, 20474, 20799, 21450, 102883, 131942, 146722] },
  shinkai: { mode: "all", ids: [1689, 21519, 106286, 16782, 8815] },
};
