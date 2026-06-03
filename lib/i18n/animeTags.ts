/**
 * French translations for AniList media tags.
 *
 * AniList's API does NOT localise tag names — it only ever returns the English
 * label (e.g. "Female Protagonist"). This dictionary covers the most common
 * tags so the Tags panel reads in French; any tag not listed falls back to its
 * original English name (better an English word than a missing one).
 *
 * Keep keys EXACTLY as AniList spells them (case + punctuation sensitive).
 */
const FR_TAGS: Record<string, string> = {
  // Cast / demographics
  "Female Protagonist": "Protagoniste féminine",
  "Male Protagonist": "Protagoniste masculin",
  "Primarily Female Cast": "Casting majoritairement féminin",
  "Primarily Male Cast": "Casting majoritairement masculin",
  "Primarily Child Cast": "Casting majoritairement enfant",
  "Primarily Adult Cast": "Casting majoritairement adulte",
  "Primarily Teen Cast": "Casting majoritairement adolescent",
  "Ensemble Cast": "Casting choral",
  "Large Ensemble": "Grand casting",
  "Found Family": "Famille de cœur",
  "Anti-Hero": "Anti-héros",
  "Elderly Protagonist": "Protagoniste âgé",
  "Estranged Family": "Famille désunie",

  // Setting / themes
  "Magic": "Magie",
  "Witch": "Sorcière",
  "Drawing": "Dessin",
  "Coming of Age": "Passage à l'âge adulte",
  "Philosophy": "Philosophie",
  "Medieval": "Médiéval",
  "Historical": "Historique",
  "Military": "Militaire",
  "School": "École",
  "University": "Université",
  "Work": "Monde du travail",
  "Urban": "Urbain",
  "Rural": "Rural",
  "Nature": "Nature",
  "Travel": "Voyage",
  "Survival": "Survie",
  "Tragedy": "Tragédie",
  "Revenge": "Vengeance",
  "Politics": "Politique",
  "Crime": "Crime",
  "Detective": "Détective",
  "Conspiracy": "Complot",
  "War": "Guerre",
  "Coming of Age Story": "Récit d'apprentissage",
  "Iyashikei": "Iyashikei",
  "Slice of Life": "Tranche de vie",

  // Genres / sub-genres
  "Isekai": "Isekai",
  "Fantasy": "Fantastique",
  "Dark Fantasy": "Dark fantasy",
  "High Fantasy": "Fantasy épique",
  "Urban Fantasy": "Fantasy urbaine",
  "Science Fiction": "Science-fiction",
  "Space": "Espace",
  "Mecha": "Mecha",
  "Cyberpunk": "Cyberpunk",
  "Post-Apocalyptic": "Post-apocalyptique",
  "Dystopian": "Dystopie",
  "Time Manipulation": "Manipulation du temps",
  "Time Skip": "Saut dans le temps",
  "Super Power": "Super-pouvoirs",
  "Superhero": "Super-héros",
  "Martial Arts": "Arts martiaux",
  "Swordplay": "Combat à l'épée",
  "Gore": "Gore",
  "Horror": "Horreur",
  "Psychological": "Psychologique",
  "Thriller": "Thriller",
  "Mystery": "Mystère",
  "Romance": "Romance",
  "Love Triangle": "Triangle amoureux",
  "Harem": "Harem",
  "Reverse Harem": "Harem inversé",
  "Comedy": "Comédie",
  "Parody": "Parodie",
  "Satire": "Satire",
  "Gag Humor": "Humour absurde",
  "Drama": "Drame",
  "Sports": "Sport",
  "Team Sports": "Sport d'équipe",
  "Cooking": "Cuisine",
  "Music": "Musique",
  "Idol": "Idole",
  "Adventure": "Aventure",
  "Ecchi": "Ecchi",

  // Demographics / format-ish
  "Shounen": "Shōnen",
  "Shoujo": "Shōjo",
  "Seinen": "Seinen",
  "Josei": "Josei",
  "Kids": "Enfants",

  // Misc common
  "Demons": "Démons",
  "Vampire": "Vampire",
  "Zombie": "Zombie",
  "Ghost": "Fantôme",
  "Gods": "Dieux",
  "Mythology": "Mythologie",
  "Henshin": "Henshin",
  "Monster Girl": "Fille-monstre",
  "Anthropomorphism": "Anthropomorphisme",
  "Animals": "Animaux",
  "CGI": "Images de synthèse",
  "Episodic": "Épisodique",
  "Ensemble": "Choral",
  "Tournament": "Tournoi",
  "Guns": "Armes à feu",
  "Cute Girls Doing Cute Things": "Filles mignonnes au quotidien",
  "Boys' Love": "Boys' Love",
  "Girls' Love": "Girls' Love",
  "Tomboy": "Garçon manqué",
  "Body Horror": "Body horror",
  "Memory Manipulation": "Manipulation de la mémoire",
};

/**
 * Translate an AniList tag name for the given language. Only French is
 * localised; any other language (and any unknown tag) returns the original
 * English name unchanged.
 */
export function translateTag(name: string, lang?: string | null): string {
  if (!name) return name;
  if (lang && lang.toLowerCase().startsWith("fr")) {
    return FR_TAGS[name] || name;
  }
  return name;
}
