/**
 * LE CHEMIN DE LA NOTIFICATION VERS L'ONGLET — un badge annoncé mène quelque
 * part.
 *
 * L'animation appelait déjà le geste : un jeton qui surgit au centre de l'écran
 * avec son nom se clique. Il ne menait nulle part, et l'onglet Badges (176
 * lignes) ne dit pas tout seul lequel vient de tomber.
 *
 * ── POURQUOI UN FRAGMENT D'URL, ET PAS UN STORE ──────────────────────────────
 * L'onglet actif du profil est un `useState` local, pas une route — on aurait
 * donc pu pousser l'id dans un magasin maison et le lire à l'arrivée. Trois
 * raisons de passer par `#badge-<id>` :
 *
 *   - il SURVIT au changement de page. La notification vit sur la page de
 *     visionnage, la cible est le profil : entre les deux il y a une navigation
 *     Next, et un magasin en mémoire tiendrait — mais pas un rechargement, ni
 *     un lien ouvert dans un nouvel onglet, ni un retour arrière ;
 *   - il est PARTAGEABLE et rejouable : coller l'URL rouvre exactement la même
 *     vue, ce qu'aucun état interne ne donne gratuitement ;
 *   - il ne demande RIEN à `pages/en/profile/[user].tsx` ni à `LocalProfile` que
 *     `location.hash` ne donne déjà — pas de prop à faire descendre, pas de
 *     contexte à monter.
 *
 * ── L'ADRESSE EST TOUJOURS `/en/profile/me` ──────────────────────────────────
 * Et jamais l'URL finale. `me` est une redirection qui sait, elle, si le
 * visiteur a un compte (→ son profil) ou non (→ `/en/my-list`) ; la
 * notification, elle, ne le sait pas et n'a pas à le savoir. Elle ne connaît
 * pas la session — la faire dépendre de `useSession()` la rendrait dépendante
 * d'un contexte pour un simple lien.
 */

const PREFIXE = "badge-";

/** Le lien vers l'onglet Badges, ouvert sur ce badge-là. */
export function revealHref(id: string): string {
  return `/en/profile/me#${PREFIXE}${encodeURIComponent(id)}`;
}

/** Recompose le fragment sur une autre adresse — utilisé par la redirection de
 *  `/en/profile/me`, qui doit le faire suivre. Sans ça, `router.replace()`
 *  arrive sur la bonne page avec le fragment perdu en route. */
export function withReveal(href: string, hash: string): string {
  return hash && hash.startsWith(`#${PREFIXE}`) ? `${href}${hash}` : href;
}

/**
 * Vrai quand l'adresse demande l'onglet Badges — avec ou SANS badge précis.
 *
 * Les deux cas existent et ne se confondent pas : la notification d'un badge
 * envoie `#badge-<id>` (ouvrir l'onglet ET montrer celui-là), la pastille des
 * non-vus de la navbar envoie `#badge-` tout court (ouvrir l'onglet, il y en a
 * plusieurs à découvrir et aucun à élire). C'est pour ça que la question de
 * l'onglet et celle du badge sont deux fonctions et pas une.
 */
export function wantsBadgesTab(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hash.startsWith(`#${PREFIXE}`);
}

/**
 * L'id à révéler, lu dans l'adresse courante. `null` si le fragment n'en est
 * pas un, ou s'il ne désigne aucun badge en particulier.
 *
 * Lu à la demande et jamais mémorisé : il n'y a pas d'abonnement à un fragment,
 * et les deux seuls moments qui comptent (le montage de la page, l'ouverture de
 * l'onglet) sont des instants précis.
 */
export function revealTarget(): string | null {
  if (!wantsBadgesTab()) return null;
  try {
    return decodeURIComponent(window.location.hash.slice(PREFIXE.length + 1)) || null;
  } catch {
    return null;
  }
}

/** L'ancre posée sur la ligne du badge dans l'onglet. */
export function revealAnchor(id: string): string {
  return `${PREFIXE}${id}`;
}
