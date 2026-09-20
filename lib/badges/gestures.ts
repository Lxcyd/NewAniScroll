/**
 * Les gestes secrets qui n'appartiennent à aucune page.
 *
 * La séquence de touches et l'ouverture de la console peuvent arriver
 * n'importe où : les poser dans une page voudrait dire les poser dans toutes.
 * Ce module est branché une fois, par le même bootstrap que l'évaluateur.
 *
 * Tout y est PASSIF et borné : deux écouteurs et un intervalle qui s'éteint dès
 * qu'il a trouvé. Rien n'interroge le réseau, rien ne tourne en boucle.
 */

import { recordFlag } from "./facts";

/* ── La séquence ────────────────────────────────────────────────────────────
   Le Konami code, sur `event.code` et non `event.key` : sur un clavier AZERTY
   les flèches et les lettres ne rendent pas les mêmes `key`, et le badge
   deviendrait plus difficile en France qu'ailleurs. Même raison que l'éditeur
   de raccourcis, qui a dû faire la même correction le 06/07 (devlog/player.md). */
const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight",
  "KeyB", "KeyA",
];

function watchKonami(): () => void {
  let at = 0;
  const onKey = (e: KeyboardEvent) => {
    /* On ignore la frappe dans un champ : quelqu'un qui écrit « ba » dans la
       recherche après avoir fait défiler une liste ne vient pas de saisir la
       séquence. */
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    at = e.code === KONAMI[at] ? at + 1 : e.code === KONAMI[0] ? 1 : 0;
    if (at === KONAMI.length) {
      at = 0;
      recordFlag("konami");
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

/* ── La console ─────────────────────────────────────────────────────────────
   Il n'existe aucune API pour « la console est-elle ouverte ». La ruse usuelle
   est la différence de taille entre la fenêtre et la zone de rendu : un panneau
   d'outils ancré prend de la place, et l'écart dépasse largement le bruit.

   Ce que ça NE détecte PAS, et c'est assumé : une console détachée dans sa
   propre fenêtre. Le badge est alors hors de portée par ce chemin, ce qui est
   préférable à la ruse concurrente — piéger `console.log` avec un getter sur un
   objet — qui ralentit chaque appel de journalisation du site entier pour un
   badge.

   L'intervalle s'arrête à la première détection, et de toute façon au bout de
   deux minutes : ce n'est pas une surveillance, c'est une occasion. */
function watchDevtools(): () => void {
  const GAP = 160;
  const EVERY_MS = 1500;
  const GIVE_UP_MS = 120_000;

  const open = () =>
    window.outerWidth - window.innerWidth > GAP ||
    window.outerHeight - window.innerHeight > GAP;

  if (open()) {
    recordFlag("devtools");
    return () => {};
  }
  const started = Date.now();
  const id = window.setInterval(() => {
    if (open()) {
      recordFlag("devtools");
      window.clearInterval(id);
    } else if (Date.now() - started > GIVE_UP_MS) {
      window.clearInterval(id);
    }
  }, EVERY_MS);
  return () => window.clearInterval(id);
}

/* ── Le changement de langue ────────────────────────────────────────────────
   « Dix fois en une minute ». On garde les dix derniers horodatages, pas un
   journal : dès que le plus ancien des dix est à moins d'une minute, c'est
   gagné. */
function watchLanguage(): () => void {
  let stamps: number[] = [];
  const onLang = () => {
    stamps = [...stamps, Date.now()].slice(-10);
    if (stamps.length === 10 && stamps[9] - stamps[0] <= 60_000) {
      recordFlag("polyglot");
    }
  };
  window.addEventListener("aniscroll:lang:change", onLang);
  window.addEventListener("aniscroll:langPref:change", onLang);
  return () => {
    window.removeEventListener("aniscroll:lang:change", onLang);
    window.removeEventListener("aniscroll:langPref:change", onLang);
  };
}

/** Branche tous les gestes globaux. Rend la fonction d'arrêt. */
export function startGestures(): () => void {
  if (typeof window === "undefined") return () => {};
  const stops = [watchKonami(), watchDevtools(), watchLanguage()];
  return () => stops.forEach((s) => s());
}

/**
 * « Rester trois minutes sur une page. »
 *
 * Le minuteur est suspendu quand l'onglet passe en arrière-plan : laisser une
 * page ouverte dans un onglet oublié n'est pas la lire, et le badge dit
 * « rester », pas « avoir ouvert ». À appeler depuis un `useEffect` de la page
 * concernée, en gardant la fonction d'arrêt.
 */
export function dwell(flagName: string, ms: number): () => void {
  if (typeof window === "undefined") return () => {};
  let spent = 0;
  let since = document.visibilityState === "visible" ? Date.now() : 0;
  let done = false;

  const tick = () => {
    if (done) return;
    if (since) spent += Date.now() - since;
    since = document.visibilityState === "visible" ? Date.now() : 0;
    if (spent >= ms) {
      done = true;
      recordFlag(flagName);
      window.clearInterval(id);
    }
  };
  const id = window.setInterval(tick, 5_000);
  document.addEventListener("visibilitychange", tick);
  return () => {
    window.clearInterval(id);
    document.removeEventListener("visibilitychange", tick);
  };
}
