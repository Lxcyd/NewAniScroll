/**
 * Les œuvres nommées par les badges secrets — ids AniList.
 *
 * ── POURQUOI UNE TABLE, ET POURQUOI ELLE EST VÉRIFIÉE ────────────────────────
 * Soixante badges disent « Terminer X ». Il faut donc savoir ce qu'est X, et un
 * id est la seule identité stable (un titre change de graphie, de langue et de
 * romanisation ; un id AniList ne bouge jamais).
 *
 * Un id FAUX est le pire défaut possible pour ce système : le badge ne se
 * débloque jamais, et rien dans l'interface ne le distingue d'un badge
 * simplement difficile. Chaque entrée porte donc le titre ATTENDU à côté de son
 * id, et `tools/badges/check-works.mjs` confronte les deux à AniList. Le titre
 * n'est pas de la documentation : c'est l'assertion.
 *
 * ── LES DEUX MODES ───────────────────────────────────────────────────────────
 *   all  (défaut) — il faut TOUTES les entrées terminées. « Terminer Naruto et
 *                   Naruto Shippuden » ne se donne pas à moitié.
 *   any           — n'importe laquelle suffit (« un anime du big 3 »).
 *
 * ── CE QUI N'EST PAS DANS CETTE TABLE ────────────────────────────────────────
 * Ghibli n'y est pas : « un film du studio Ghibli » se lit dans le studio déjà
 * mis en cache sur l'entrée de liste, ce qui reste juste quand le studio sort
 * un film de plus. Une liste d'ids, elle, aurait vieilli dès la sortie
 * suivante. Voir la métrique `studioWorks` dans lib/badges/evaluate.ts.
 */

/** @type {Record<string, { mode?: "all"|"any", ids: [number, string][] }>} */
export const WORKS = {
  bigThree: {
    mode: "any",
    ids: [
      [21, "One Piece"],
      [20, "Naruto"],
      [269, "Bleach"],
    ],
  },

  onePiece: { ids: [[21, "One Piece"]] },
  naruto: { ids: [[20, "Naruto"], [1735, "Naruto: Shippuden"]] },
  boruto: { ids: [[97938, "Boruto: Naruto Next Generations"]] },
  dragonBall: {
    ids: [
      [223, "Dragon Ball"],
      [813, "Dragon Ball Z"],
      [21745, "Dragon Ball Super"],
    ],
  },
  demonSlayer: { ids: [[101922, "Kimetsu no Yaiba"]] },
  aot: { ids: [[16498, "Shingeki no Kyojin"]] },
  hxh: { ids: [[11061, "Hunter x Hunter (2011)"]] },
  bleach: { ids: [[269, "Bleach"], [116674, "Bleach: Sennen Kessen-hen"]] },
  fmab: { ids: [[5114, "Fullmetal Alchemist: Brotherhood"]] },
  conan: { ids: [[235, "Meitantei Conan"]] },
  pokemon: { ids: [[527, "Pocket Monsters"]] },
  mha: { ids: [[21459, "Boku no Hero Academia"]] },
  deathNote: { ids: [[1535, "Death Note"]] },
  jjk: { ids: [[113415, "Jujutsu Kaisen"]] },
  chainsawMan: { ids: [[127230, "Chainsaw Man"]] },
  opm: { ids: [[21087, "One Punch-Man"]] },
  blackClover: { ids: [[97940, "Black Clover"]] },
  steinsGate: { ids: [[9253, "Steins;Gate"]] },
  reZero: { ids: [[21355, "Re:Zero kara Hajimeru Isekai Seikatsu"]] },
  sao: { ids: [[11757, "Sword Art Online"]] },
  slime: { ids: [[101280, "Tensei shitara Slime Datta Ken"]] },
  shieldHero: { ids: [[99263, "Tate no Yuusha no Nariagari"]] },
  mushoku: { ids: [[108465, "Mushoku Tensei: Isekai Ittara Honki Dasu"]] },
  overlord: { ids: [[20832, "Overlord"]] },
  konosuba: { ids: [[21202, "Kono Subarashii Sekai ni Shukufuku wo!"]] },
  frieren: { ids: [[154587, "Sousou no Frieren"]] },
  soloLeveling: { ids: [[151807, "Ore dake Level Up na Ken"]] },
  codeGeass: { ids: [[1575, "Code Geass: Hangyaku no Lelouch"]] },
  evangelion: { ids: [[30, "Shinseiki Evangelion"]] },
  bebop: { ids: [[1, "Cowboy Bebop"]] },
  champloo: { ids: [[205, "Samurai Champloo"]] },
  gits: { ids: [[467, "Koukaku Kidoutai: Stand Alone Complex"]] },
  trigun: { ids: [[6, "Trigun"]] },
  berserk: { ids: [[33, "Berserk"]] },
  monster: { ids: [[19, "Monster"]] },
  vinland: { ids: [[101348, "Vinland Saga"]] },
  kingdom: { ids: [[10033, "Kingdom"]] },
  ngnl: { ids: [[19815, "No Game No Life"]] },
  yugioh: { ids: [[481, "Yu☆Gi☆Oh! Duel Monsters"]] },
  haikyu: { ids: [[20464, "Haikyuu!!"]] },
  kuroko: { ids: [[11771, "Kuroko no Basket"]] },
  blueLock: { ids: [[137822, "Blue Lock"]] },
  yowamushi: { ids: [[18179, "Yowamushi Pedal"]] },
  slamDunk: { ids: [[170, "Slam Dunk"]] },
  foodWars: { ids: [[20923, "Shokugeki no Souma"]] },
  ansatsu: { ids: [[20755, "Ansatsu Kyoushitsu"]] },
  fruitsBasket: { ids: [[105334, "Fruits Basket (2019)"]] },
  toradora: { ids: [[4224, "Toradora!"]] },
  clannad: { ids: [[2167, "Clannad"], [4181, "Clannad: After Story"]] },
  yourLie: { ids: [[20665, "Shigatsu wa Kimi no Uso"]] },
  gintama: { ids: [[918, "Gintama"]] },
  miraiNikki: { ids: [[10620, "Mirai Nikki (TV)"]] },
  spyFamily: { ids: [[140960, "SPY×FAMILY"]] },
  drStone: { ids: [[105333, "Dr. STONE"]] },
  tokyoGhoul: { ids: [[20605, "Tokyo Ghoul"]] },
  parasyte: { ids: [[20623, "Kiseijuu: Sei no Kakuritsu"]] },
  neverland: { ids: [[101759, "Yakusoku no Neverland"]] },

  /* JoJo : « toutes les parties ». Chaque saison est une entrée distincte chez
     AniList, et une partie manquante doit refuser le badge — d'où le mode
     `all`, qui est ici le sujet même du badge. */
  jojo: {
    ids: [
      [14719, "JoJo no Kimyou na Bouken (TV)"],
      /* La partie 3 et la partie 6 sont chacune découpées en deux entrées
         AniList : le badge les demande toutes, puisqu'il demande la partie. */
      [20474, "JoJo no Kimyou na Bouken: Stardust Crusaders"],
      [20799, "JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen"],
      [21450, "JoJo no Kimyou na Bouken: Diamond wa Kudakenai"],
      [102883, "JoJo no Kimyou na Bouken: Ougon no Kaze"],
      [131942, "JoJo no Kimyou na Bouken: Stone Ocean"],
      [146722, "JoJo no Kimyou na Bouken: Stone Ocean Part 2"],
    ],
  },

  /* Makoto Shinkai : ses longs métrages. AniList ne nous donne pas le
     réalisateur dans la requête de liste (seulement le studio), donc c'est une
     liste d'ids — et le studio CoMix Wave Films ne conviendrait pas, il produit
     aussi des films qui ne sont pas de lui. */
  shinkai: {
    ids: [
      [1689, "Byousoku 5 Centimeter"],
      [21519, "Kimi no Na wa."],
      [106286, "Tenki no Ko"],
      [16782, "Koto no Ha no Niwa"],
      [8815, "Hoshi wo Ou Kodomo"],
    ],
  },
};
