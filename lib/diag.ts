/**
 * Journal de lecture a distance, pour les sessions ouvertes avec `?diag=1`.
 *
 * Pourquoi. Megaplay « basculait » sur l'iPhone de Luc alors que tout passait
 * dans Chrome — et pour cause : sur iPhone, Vidstack confie le flux au lecteur
 * HLS NATIF de Safari (hls.js n'y tourne jamais), avec ses propres regles
 * d'autoplay et de chargement. Aucun outil d'ici ne reproduit ca (28/09/2026).
 * Ce module fait parler le vrai appareil : il note ce que fait le lecteur et
 * l'envoie au Worker (`/w/diag`, KV, 3 jours), sans une seule invocation
 * Vercel. Lecture : `https://proxy.aniscroll.com/w/diag?k=<DIAG_TOKEN>&sid=…`.
 *
 * Inerte sans `?diag=1` : aucune ecriture, aucun envoi, cout nul. Une fois vu,
 * le drapeau tient pour l'onglet (sessionStorage) — la navigation interne vers
 * l'episode suivant garde son journal.
 */

const BASE = (
  (process.env.NEXT_PUBLIC_PROXY_BASE as string | undefined) || "https://proxy.aniscroll.com"
).replace(/\/+$/, "");
const CLE = "aniscroll:diag";

let etat: { on: boolean; sid: string } | null = null;
let tampon: Array<Record<string, unknown>> = [];
let t0 = 0;
let minuterie: ReturnType<typeof setTimeout> | null = null;

function lireEtat(): { on: boolean; sid: string } {
  if (etat) return etat;
  etat = { on: false, sid: "" };
  if (typeof window === "undefined") return etat;
  try {
    const garde = sessionStorage.getItem(CLE);
    if (garde) etat = { on: true, sid: garde };
    else if (/[?&]diag=1\b/.test(window.location.search)) {
      const sid = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(CLE, sid);
      etat = { on: true, sid };
    }
  } catch {
    /* stockage refuse : on s'en tient a l'URL de cette page */
    if (/[?&]diag=1\b/.test(window.location.search)) {
      etat = { on: true, sid: Math.random().toString(36).slice(2, 10) };
    }
  }
  if (etat.on) {
    t0 = Date.now();
    // Un badge discret : la personne SAIT que le journal tourne, et lit l'id
    // de session a donner (le meme que dans les cles du Worker).
    try {
      const b = document.createElement("div");
      b.textContent = `diag ${etat.sid}`;
      b.style.cssText =
        "position:fixed;left:6px;bottom:6px;z-index:2147483647;font:11px monospace;" +
        "padding:2px 6px;border-radius:4px;background:#b91c1c;color:#fff;opacity:.85;pointer-events:none";
      const poser = () => document.body?.appendChild(b);
      if (document.body) poser();
      else window.addEventListener("DOMContentLoaded", poser, { once: true });
    } catch {
      /* sans badge, le journal marche quand meme */
    }
    window.addEventListener("pagehide", () => flushDiag("pagehide"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDiag("hidden");
    });
  }
  return etat;
}

/** Le journal est-il actif sur cet onglet ? (et son identifiant) */
export function diagSession(): string | null {
  const e = lireEtat();
  return e.on ? e.sid : null;
}

/** Note un evenement. Sans `?diag=1`, ne fait rien. */
export function diag(ev: string, data: Record<string, unknown> = {}): void {
  const e = lireEtat();
  if (!e.on) return;
  tampon.push({ t: Date.now() - t0, ev, ...data });
  if (tampon.length > 300) tampon = tampon.slice(-300);
  if (!minuterie) minuterie = setTimeout(() => flushDiag("25s"), 25_000);
}

/** Envoie ce qui est en attente. A appeler aux moments qui comptent (abandon). */
export function flushDiag(pourquoi = "manuel"): void {
  const e = lireEtat();
  if (!e.on || tampon.length === 0) return;
  if (minuterie) {
    clearTimeout(minuterie);
    minuterie = null;
  }
  const corps = JSON.stringify({
    sid: e.sid,
    pourquoi,
    url: window.location.pathname + window.location.search,
    events: tampon,
  });
  tampon = [];
  try {
    // text/plain : requete « simple », pas de pre-verification CORS.
    const blob = new Blob([corps], { type: "text/plain" });
    if (!navigator.sendBeacon?.(`${BASE}/w/diag`, blob)) {
      void fetch(`${BASE}/w/diag`, { method: "POST", body: corps, keepalive: true }).catch(() => {});
    }
  } catch {
    /* un journal perdu ne doit jamais casser la page */
  }
}
