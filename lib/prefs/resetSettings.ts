/**
 * "Restore default settings" — wipe every local preference this app stores so
 * the next render falls back to the built-in defaults.
 *
 * We clear all `aniscroll:*` keys plus the few legacy/un-prefixed keys the
 * player uses (`preferred_server`, `view`, `artplayer_settings`, volume/muted).
 * This is local-only: it never touches the AniList account. The LOCAL LIST
 * (`aniscroll:localList`) is intentionally KEPT — wiping a user's whole anime
 * list under "restore settings" would be a nasty surprise; the dedicated
 * "Delete list" action owns that.
 *
 * Attention aux prefs qui gardent un MIROIR EN MEMOIRE : effacer leur cle ne
 * suffit pas, le miroir la reecrirait au prochain flush. Elles doivent etre
 * remises a zero par leur propre module — voir `clearServerPerf` plus bas.
 */

import { clearServerPerf } from "@/lib/watch/serverPerf";
import { clearAllProgress } from "@/lib/watch/progress";
import { pushKinds } from "@/lib/list/cloudSync";

const KEEP = new Set(["aniscroll:localList"]);
const EXTRA_KEYS = [
  "preferred_server",
  // Classement des langues (cf. lib/prefs/langPref.ts) : le remettre a zero
  // re-affiche la popup au prochain episode, ce qui est bien le sens de
  // « reglages par defaut ».
  "lang_pref_order",
  "lang_pref_enabled",
  "view",
  "artplayer_settings",
  "aniscroll:volume",
  "aniscroll:muted",
];

/** Rend une promesse pour que l'appelant puisse attendre que l'effacement soit
 *  ARRIVE au compte avant de recharger : un rechargement a 600 ms peut couper
 *  la requete en vol, et la page reviendrait alors chercher au compte ce qu'on
 *  vient d'effacer. Ignorer la promesse reste licite (rien ne casse). */
export async function restoreDefaultSettings(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("aniscroll:") && !KEEP.has(key)) toRemove.push(key);
    }
    for (const k of [...toRemove, ...EXTRA_KEYS]) {
      try {
        localStorage.removeItem(k);
      } catch {}
    }
  } catch {
    /* best-effort */
  }
  // Le balayage ci-dessus a bien retire `aniscroll:serverPerf`, mais le module
  // en garde un miroir vivant : sans ceci, la premiere mesure suivante le
  // reecrirait entier et les scores « effaces » seraient de retour.
  clearServerPerf();

  /* La position de lecture, VIDEE et non SUPPRIMEE — et repoussee au compte
     dans la foulee.
     Le balayage ci-dessus emportait bien `aniscroll:progress` et
     `artplayer_settings`, mais par `removeItem`. Or `readKind` de cloudSync
     rend `null` quand toutes les cles d'une categorie sont ABSENTES, et
     `pullAll` lit ce null comme « cet appareil n'a encore rien » : au
     rechargement suivant il reecrivait la copie du compte. On revenait donc a
     12:42 sur chaque episode. C'est exactement le defaut deja corrige dans
     `clearAllProgress` (dont le commentaire porte la demonstration) ; il
     restait ici, dans le bouton que l'on presse justement en croyant tout
     remettre a zero. Signale trois fois, corrige ici.
     `{}` est une VALEUR : elle se pousse comme une autre, la copie du compte
     devient vide a son tour, et les lecteurs ne voient pas la difference. */
  clearAllProgress();
  /* Sans compte, l'endpoint repond 401 et c'est un non-evenement. On ne
     l'attend pas : la page recharge juste apres, et `pushKinds` est deja
     parti. */
  await pushKinds(["progress", "recent"]).catch(() => {});
}
