/**
 * Normalise les apostrophes des titres venus des sources.
 *
 * Les mappings d'episodes arrivent avec des accents graves ASCII a la place des
 * apostrophes ("I`m Used to It", "It`s Like a Game") : l'accent penche dans le
 * mauvais sens et se lit comme une coquille. Le probleme vient des donnees, pas
 * de l'affichage — on le corrige donc au dernier moment, a l'affichage, plutot
 * que de reecrire les caches de mapping.
 *
 * Ne touche qu'aux caracteres qui ne sont JAMAIS legitimes en plein milieu d'un
 * mot : l'accent grave (`) et l'accent aigu (´). Les guillemets droits (') sont
 * laisses tels quels — ils sont corrects, juste moins jolis, et les convertir
 * casserait un titre qui contient reellement un guillemet simple.
 */
export function fixApostrophes(text: string): string;
export function fixApostrophes(text: null | undefined): "";
export function fixApostrophes(text: string | null | undefined): string;
export function fixApostrophes(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/[`´]/g, "’");
}
