/**
 * Le choix de lecteur, mis en cache pour le prochain chargement.
 *
 * ── Le probleme ─────────────────────────────────────────────────────────────
 * Le script pose dans le `<head>` (lib/watch/earlySource.ts) tire
 * `/api/v2/source` pendant l'analyse du HTML, avant tout React. Mais il ne peut
 * le faire que s'il sait QUEL lecteur demander, et il s'abstient des qu'un ordre
 * de langues est regle — c'est-a-dire dans le cas courant. La requete attend
 * alors le bundle entier, l'hydratation et deux tours d'effet.
 *
 * Il s'abstient pour une bonne raison : la regle de resolution vit en TypeScript
 * (prefs, catalogue frembed, classement mesure de serverPerf), et la retranscrire
 * en vanilla dans le `<head>` serait une seconde implementation qui derive au
 * premier changement.
 *
 * ── Ce qu'on fait a la place ────────────────────────────────────────────────
 * On ne copie pas la regle : on retient sa SORTIE. La page de lecture, une fois
 * qu'elle a resolu son ordre de lecteurs — par la vraie regle, celle qui vient
 * de s'executer — l'ecrit ici. Le prochain chargement n'a plus qu'a le relire.
 *
 * La difference est tout l'interet : une copie de la regle peut la contredire,
 * un cache de sa sortie ne le peut pas. Si la regle change, la premiere page
 * ecrit simplement une valeur differente.
 *
 * ── Ce qui l'invalide ───────────────────────────────────────────────────────
 * L'ordre depend de l'ordre de LANGUES et de rien d'autre qui soit propre a une
 * serie (le classement mesure est fige au chargement, cf. serverPerfRankFrozen).
 * On memorise donc la signature de l'ordre de langues avec lui : si elle ne
 * correspond plus a `lang_pref_order`, le script s'abstient comme avant.
 *
 * Ce qui est propre a la serie — frembed absent du catalogue — est applique par
 * le script a la lecture, pas ici : la liste memorisee vaut pour toutes les
 * series, et c'est ce qui permet d'en garder UNE seule.
 */

const KEY = "aniscroll:earlyPick";

type Store = { order: string[]; lang: string; at: number };

/**
 * La signature d'un ordre de langues : la chaine BRUTE de `lang_pref_order`,
 * pas une re-serialisation de l'ordre effectif.
 *
 * Le script du `<head>` compare avec ce que `localStorage.getItem` lui rend, au
 * caractere pres. Re-serialiser ici un tableau deja parse rendrait la meme
 * chose dans le cas simple et quelque chose de different des que l'ordre
 * EFFECTIF n'est pas l'ordre STOCKE — `getEffectiveLangOrder` rend un ordre par
 * defaut quand rien n'est regle. La comparaison echouerait alors toujours, et
 * le script s'abstiendrait sans que rien ne casse : une lenteur silencieuse,
 * exactement le genre de panne qu'on ne remarque pas. On lit donc la meme
 * source que lui.
 */
function signatureLangues(): string {
  try {
    return window.localStorage.getItem("lang_pref_order") || "null";
  } catch {
    return "null";
  }
}

/**
 * Retient l'ordre que la regle vient de produire. Sans effet si la liste est
 * vide — on ne veut pas qu'une resolution ratee efface une bonne reponse.
 */
export function memoriseChoix(order: string[]): void {
  if (typeof window === "undefined" || !order?.length) return;
  const val: Store = { order, lang: signatureLangues(), at: Date.now() };
  try {
    const ancien = window.localStorage.getItem(KEY);
    const neuf = JSON.stringify(val);
    // Rien de neuf, rien a ecrire : `setItem` est synchrone sur le thread
    // principal, et ceci tourne au montage de CHAQUE page de lecture.
    if (ancien && JSON.parse(ancien)?.order?.join() === order.join()) return;
    window.localStorage.setItem(KEY, neuf);
  } catch {
    /* stockage refuse (mode prive, quota) : le script s'abstiendra, c'est tout */
  }
}
