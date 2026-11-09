/**
 * Les œuvres nommées par les badges secrets, par id AniList.
 *
 * FICHIER GÉNÉRÉ — ne pas éditer à la main.
 * Source : tools/badges/works.data.mjs, qui porte aussi le TITRE attendu de
 * chaque id. `node tools/badges/check-works.mjs` confronte les deux à AniList :
 * c'est là, et nulle part ailleurs, qu'un id faux se rattrape — un badge dont
 * l'id est faux ne se débloque jamais et ressemble à un badge difficile.
 *
 * Vérifié le 2026-11-09 : 74 ids, tous conformes.
 */

export type WorkDef = {
  /** "all" : toutes les entrées doivent être terminées. "any" : une suffit. */
  mode: "all" | "any";
  ids: number[];
  /** Le titre de chaque id, dans le même ordre : le DÉTAIL du badge nomme
   *  ce qui manque, même quand l'œuvre n'est pas dans la liste. */
  titles: string[];
};

export const WORKS: Record<string, WorkDef> = {
  bigThree: { mode: "any", ids: [21, 20, 269], titles: ["One Piece","Naruto","Bleach"] },
  onePiece: { mode: "all", ids: [21], titles: ["One Piece"] },
  naruto: { mode: "all", ids: [20, 1735], titles: ["Naruto","Naruto: Shippuden"] },
  boruto: { mode: "all", ids: [97938], titles: ["Boruto: Naruto Next Generations"] },
  dragonBall: { mode: "all", ids: [223, 813, 21745], titles: ["Dragon Ball","Dragon Ball Z","Dragon Ball Super"] },
  demonSlayer: { mode: "all", ids: [101922], titles: ["Kimetsu no Yaiba"] },
  aot: { mode: "all", ids: [16498], titles: ["Shingeki no Kyojin"] },
  hxh: { mode: "all", ids: [11061], titles: ["Hunter x Hunter (2011)"] },
  bleach: { mode: "all", ids: [269, 116674], titles: ["Bleach","Bleach: Sennen Kessen-hen"] },
  fmab: { mode: "all", ids: [5114], titles: ["Fullmetal Alchemist: Brotherhood"] },
  conan: { mode: "all", ids: [235], titles: ["Meitantei Conan"] },
  pokemon: { mode: "all", ids: [527], titles: ["Pocket Monsters"] },
  mha: { mode: "all", ids: [21459], titles: ["Boku no Hero Academia"] },
  deathNote: { mode: "all", ids: [1535], titles: ["Death Note"] },
  jjk: { mode: "all", ids: [113415], titles: ["Jujutsu Kaisen"] },
  chainsawMan: { mode: "all", ids: [127230], titles: ["Chainsaw Man"] },
  opm: { mode: "all", ids: [21087], titles: ["One Punch-Man"] },
  blackClover: { mode: "all", ids: [97940], titles: ["Black Clover"] },
  steinsGate: { mode: "all", ids: [9253], titles: ["Steins;Gate"] },
  reZero: { mode: "all", ids: [21355], titles: ["Re:Zero kara Hajimeru Isekai Seikatsu"] },
  sao: { mode: "all", ids: [11757], titles: ["Sword Art Online"] },
  slime: { mode: "all", ids: [101280], titles: ["Tensei shitara Slime Datta Ken"] },
  shieldHero: { mode: "all", ids: [99263], titles: ["Tate no Yuusha no Nariagari"] },
  mushoku: { mode: "all", ids: [108465], titles: ["Mushoku Tensei: Isekai Ittara Honki Dasu"] },
  overlord: { mode: "all", ids: [20832], titles: ["Overlord"] },
  konosuba: { mode: "all", ids: [21202], titles: ["Kono Subarashii Sekai ni Shukufuku wo!"] },
  frieren: { mode: "all", ids: [154587], titles: ["Sousou no Frieren"] },
  soloLeveling: { mode: "all", ids: [151807], titles: ["Ore dake Level Up na Ken"] },
  codeGeass: { mode: "all", ids: [1575], titles: ["Code Geass: Hangyaku no Lelouch"] },
  evangelion: { mode: "all", ids: [30], titles: ["Shinseiki Evangelion"] },
  bebop: { mode: "all", ids: [1], titles: ["Cowboy Bebop"] },
  champloo: { mode: "all", ids: [205], titles: ["Samurai Champloo"] },
  gits: { mode: "all", ids: [467], titles: ["Koukaku Kidoutai: Stand Alone Complex"] },
  trigun: { mode: "all", ids: [6], titles: ["Trigun"] },
  berserk: { mode: "all", ids: [33], titles: ["Berserk"] },
  monster: { mode: "all", ids: [19], titles: ["Monster"] },
  vinland: { mode: "all", ids: [101348], titles: ["Vinland Saga"] },
  kingdom: { mode: "all", ids: [10033], titles: ["Kingdom"] },
  ngnl: { mode: "all", ids: [19815], titles: ["No Game No Life"] },
  yugioh: { mode: "all", ids: [481], titles: ["Yu☆Gi☆Oh! Duel Monsters"] },
  haikyu: { mode: "all", ids: [20464], titles: ["Haikyuu!!"] },
  kuroko: { mode: "all", ids: [11771], titles: ["Kuroko no Basket"] },
  blueLock: { mode: "all", ids: [137822], titles: ["Blue Lock"] },
  yowamushi: { mode: "all", ids: [18179], titles: ["Yowamushi Pedal"] },
  slamDunk: { mode: "all", ids: [170], titles: ["Slam Dunk"] },
  foodWars: { mode: "all", ids: [20923], titles: ["Shokugeki no Souma"] },
  ansatsu: { mode: "all", ids: [20755], titles: ["Ansatsu Kyoushitsu"] },
  fruitsBasket: { mode: "all", ids: [105334], titles: ["Fruits Basket (2019)"] },
  toradora: { mode: "all", ids: [4224], titles: ["Toradora!"] },
  clannad: { mode: "all", ids: [2167, 4181], titles: ["Clannad","Clannad: After Story"] },
  yourLie: { mode: "all", ids: [20665], titles: ["Shigatsu wa Kimi no Uso"] },
  gintama: { mode: "all", ids: [918], titles: ["Gintama"] },
  miraiNikki: { mode: "all", ids: [10620], titles: ["Mirai Nikki (TV)"] },
  spyFamily: { mode: "all", ids: [140960], titles: ["SPY×FAMILY"] },
  drStone: { mode: "all", ids: [105333], titles: ["Dr. STONE"] },
  tokyoGhoul: { mode: "all", ids: [20605], titles: ["Tokyo Ghoul"] },
  parasyte: { mode: "all", ids: [20623], titles: ["Kiseijuu: Sei no Kakuritsu"] },
  neverland: { mode: "all", ids: [101759], titles: ["Yakusoku no Neverland"] },
  jojo: { mode: "all", ids: [14719, 20474, 20799, 21450, 102883, 131942, 146722], titles: ["JoJo no Kimyou na Bouken (TV)","JoJo no Kimyou na Bouken: Stardust Crusaders","JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen","JoJo no Kimyou na Bouken: Diamond wa Kudakenai","JoJo no Kimyou na Bouken: Ougon no Kaze","JoJo no Kimyou na Bouken: Stone Ocean","JoJo no Kimyou na Bouken: Stone Ocean Part 2"] },
  shinkai: { mode: "all", ids: [1689, 21519, 106286, 16782, 8815], titles: ["Byousoku 5 Centimeter","Kimi no Na wa.","Tenki no Ko","Koto no Ha no Niwa","Hoshi wo Ou Kodomo"] },
};
