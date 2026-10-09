/**
 * Le GENRE d'une collection de cadres, pour le tri « Par genre » du studio.
 *
 * Aucune source n'en donne : itemshop.gg ne publie que le nom de la collection,
 * le prix et la rareté, et la boutique de Discord ne range que par collection.
 * La table est donc tenue À LA MAIN, à partir des noms (état du 09/10/2026 :
 * 90 collections). Une collection qui n'y figure pas encore (sortie de la nuit)
 * tombe dans « Autres » jusqu'à ce qu'on l'ajoute ici.
 */

export const FRAME_GENRES = [
  "anime",
  "games",
  "movies",
  "fantasy",
  "dark",
  "space",
  "seasons",
  "nature",
  "cute",
  "style",
  "other",
] as const;
export type FrameGenre = (typeof FRAME_GENRES)[number];

const GENRE_OF: Record<string, FrameGenre> = {
  /* Anime & manga */
  Anime: "anime",
  "Jujutsu Kaisen": "anime",
  "My Hero Academia": "anime",
  Dojo: "anime",
  /* Jeux vidéo & jeux de rôle */
  Palworld: "games",
  "Call of Duty: Black Ops 7": "games",
  "Borderlands 4": "games",
  "Civilization VII": "games",
  "Street Fighter 6": "games",
  "VALORANT Champions": "games",
  Arcane: "games",
  "Spirit Blossom Beyond": "games",
  "Dungeons & Dragons": "games",
  "Magic: The Gathering": "games",
  GGEZ: "games",
  "It's Gametime": "games",
  Arcade: "games",
  /* Films, séries & licences */
  "Toy Story": "movies",
  "The Mandalorian and Grogu": "movies",
  "Spider-Man vs. Venom": "movies",
  "Mickey & Friends": "movies",
  Avatar: "movies",
  TRON: "movies",
  "Fantastic 4": "movies",
  "Star Wars™": "movies",
  "Skibidi Toilet": "movies",
  "It's Showtime": "movies",
  /* Fantasy & magie */
  "Starlight Magic": "fantasy",
  Fantasy: "fantasy",
  "Mythical Creatures": "fantasy",
  Tarot: "fantasy",
  "Cauldron Chaos": "fantasy",
  "Mermaid Melodies": "fantasy",
  Pirates: "fantasy",
  Steampunk: "fantasy",
  Elements: "fantasy",
  Orbs: "fantasy",
  /* Sombre & horreur */
  "Dark Folklore": "dark",
  "Dark Fantasy": "dark",
  "Creepy Crawlers": "dark",
  Underworld: "dark",
  "Night Terrors": "dark",
  Gothica: "dark",
  "Spooky Night": "dark",
  Insomnia: "dark",
  "Pale Reverie": "dark",
  /* Espace & science-fiction */
  "Solar Eclipse": "space",
  "Lunar Eclipse": "space",
  Cosmos: "space",
  Galaxy: "space",
  Zodiac: "space",
  Cyberpunk: "space",
  "Zen Protocol": "space",
  Flux: "space",
  "Flux Vol. 2": "space",
  /* Saisons & fêtes */
  "Fall Foragers": "seasons",
  Sunkissed: "seasons",
  "Summer Bliss": "seasons",
  "Year of the Horse": "seasons",
  "Lunar New Year": "seasons",
  Valentines: "seasons",
  "LOVE XP": "seasons",
  "Winter Wonderland": "seasons",
  "Autumn Equinox": "seasons",
  Fall: "seasons",
  Springtoons: "seasons",
  "Gooooal!": "seasons",
  /* Nature & animaux */
  "All Ears": "nature",
  "Smol Bugs": "nature",
  "Woodland Friends": "nature",
  Fruitables: "nature",
  "Twilight Seas": "nature",
  "Secret Garden": "nature",
  "Cozy Valley": "nature",
  "Rawr xD": "nature",
  /* Mignon & cosy */
  "Cozy Getaway": "cute",
  "Slumber Party": "cute",
  Daydreaming: "cute",
  "Chibi Cafe": "cute",
  "Kawaii Mode": "cute",
  "Hello Kitty and Friends": "cute",
  "Lofi Girl": "cute",
  "Lofi Vibes": "cute",
  Mood: "cute",
  "Feeling Lucky": "cute",
  /* Style, rétro & internet */
  "Neon Graffiti": "style",
  "Fin.": "style",
  Shenanigans: "style",
  "Feelin' Retro": "style",
  DISXCORE: "style",
};

export function frameGenre(collection: string): FrameGenre {
  return GENRE_OF[collection] ?? "other";
}

