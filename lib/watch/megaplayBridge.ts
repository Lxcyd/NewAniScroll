/**
 * Le pont parent <-> iframe de megaplay.
 *
 * POURQUOI CE FICHIER EXISTE. Megaplay est le seul lecteur qu'on affiche en
 * iframe : son extraction est morte (l'adresse du flux ne vit plus que dans un
 * blob chiffre) et on a choisi de ne pas la dechiffrer. On encadre donc LEUR
 * page, et le reproche qui en decoule est juste — « c'est le lecteur de
 * megaplay, pas le notre » : ni reprise de lecture, ni progression enregistree,
 * ni saut d'OP/ED, et leurs publicites.
 *
 * Ce qu'on a essaye et qui NE MARCHE PAS, mesure le 20/09/2026, pour que
 * personne ne le retente :
 *
 *   - `sandbox` sans `allow-popups` (pour tuer les popunders llvpn / luugy /
 *     rtmark constates dans leur page). Leur lecteur DETECTE l'attribut et
 *     refuse de jouer : « Opss! Sandboxed our player is not allowed. Remove
 *     sandbox to use it. » Verifie a l'ecran sur dev, iframe reelle. Il n'y a
 *     donc pas de moyen de leur retirer leurs pubs tout en les affichant.
 *
 * Ce qui MARCHE, et que ce fichier exploite : leur `lib/handle-bridge.min.js`
 * est un vrai canal `postMessage`, et il n'est PAS verrouille a leur domaine
 * (contrairement a `parent-fullscreen-bridge.min.js`, qui, lui, ne s'arme que
 * si l'ancetre contient « anikoto »). Vocabulaire releve dans leur source :
 *
 *   parent -> iframe, en `{ cmd: … }`
 *     SEEK        { value, skip? }   position absolue, ou relative si `skip`
 *     GET_TIME                        provoque un CURRENT_TIME
 *     GET_PIP                         provoque un PIP_STATE
 *     SKP_DATA    { value: { intro, outro }, auto }   nos reperes + auto-saut
 *     PLAY_TOGGLE / MUTE
 *
 *   iframe -> parent
 *     PLAYER_READY | CURRENT_TIME { time, duration } | SEEK_DONE | PIP_STATE
 *
 * Plus un parametre d'URL que leur page lit au demarrage : `?time=<secondes>`
 * (`settings.time`). On s'en sert pour la reprise plutot que d'un SEEK apres
 * coup — la lecture commence AU BON ENDROIT au lieu de sauter sous les yeux.
 *
 * Ce que le pont ne rend pas, et qu'il ne faut pas promettre : les raccourcis
 * clavier. Tant que le pointeur est dans l'iframe, c'est leur document qui a
 * le focus et nos `keydown` ne partent jamais. `PLAY_TOGGLE` et `MUTE` sont
 * exposes ici parce que le protocole les a, pas parce qu'on a un chemin fiable
 * pour les declencher.
 */

import {
  saveProgress,
  markComplete,
  publishDuration,
  getResumeTime,
} from "@/lib/watch/progress";

export const MEGAPLAY_ORIGINE = "https://megaplay.buzz";

/** Un `src` d'iframe sert-il la page de megaplay ? */
export function estMegaplay(src: string | null | undefined): boolean {
  if (!src) return false;
  try {
    return new URL(src).host.endsWith("megaplay.buzz");
  } catch {
    return false;
  }
}

/**
 * La meme URL, mais qui demarre ou l'utilisateur s'etait arrete.
 *
 * A n'appeler QU'UNE FOIS par montage : l'URL est le `src` de l'iframe, donc
 * la recalculer a chaque tick de progression rechargerait le lecteur en
 * boucle. Le point de reprise est fige a l'ouverture, comme pour notre propre
 * lecteur (`getResumeTime` y est lu une seule fois aussi).
 */
export function avecReprise(
  src: string,
  aniListId: number | null | undefined,
  episodeNumber: number | null | undefined,
): string {
  if (!estMegaplay(src) || aniListId == null || episodeNumber == null) return src;
  let secondes = 0;
  try {
    // Un lien horodate partage (`?t=`) prime sur le point sauvegarde, meme
    // regle que le chemin video — cf. UniversalPlayer, effet « resume ».
    const t = new URLSearchParams(window.location.search).get("t");
    const depuisUrl = t == null ? 0 : Math.max(0, parseInt(t, 10) || 0);
    secondes = depuisUrl > 0 ? depuisUrl : getResumeTime(aniListId, episodeNumber);
  } catch {
    return src;
  }
  if (!(secondes > 0)) return src;
  try {
    const u = new URL(src);
    u.searchParams.set("time", String(Math.floor(secondes)));
    return u.toString();
  } catch {
    return src;
  }
}

export type SegmentSaut = { start: number; end: number; type: string };

export type OptionsPont = {
  aniListId: number | null | undefined;
  episodeNumber: number | null | undefined;
  segments: SegmentSaut[];
  /** L'utilisateur a-t-il demande le saut automatique (OP et/ou ED) ? */
  autoSaut: boolean;
  /** Appele une seule fois quand l'episode compte comme vu. */
  surFin?: () => void;
};

/* Leur bridge repond a GET_TIME ; il n'emet rien de lui-meme en continu. On
   demande donc la position a intervalle regulier. 5 s est le pas de notre
   propre sauvegarde de progression — inutile d'etre plus fin, un point de
   reprise a 5 s pres ne se voit pas, et chaque message reveille leur page. */
const PAS_MS = 5000;
/* Sous ce nombre de secondes restantes, l'episode compte comme termine. Meme
   valeur que END_THRESHOLD_SECONDS cote progression, pour que les deux
   chemins (video et iframe) marquent « vu » au meme moment. */
const MARGE_FIN = 30;

/**
 * Branche le pont sur une iframe megaplay deja montee. Rend la fonction de
 * debranchement.
 */
export function ouvrePont(
  iframe: HTMLIFrameElement,
  src: string,
  opts: OptionsPont,
): () => void {
  if (!estMegaplay(src)) return () => {};
  const { aniListId, episodeNumber, segments, autoSaut, surFin } = opts;

  let mort = false;
  let finTiree = false;
  let vuCompte = false;

  const envoie = (charge: Record<string, unknown>) => {
    if (mort) return;
    try {
      // `JSON.stringify` et non l'objet : leur pont accepte les deux, mais son
      // propre code emet des chaines, et une chaine traverse tout.
      iframe.contentWindow?.postMessage(JSON.stringify(charge), MEGAPLAY_ORIGINE);
    } catch {}
  };

  const envoieReperes = () => {
    const op = segments.find((s) => s.type === "op");
    const ed = segments.find((s) => s.type === "ed");
    if (!op && !ed) return;
    envoie({
      cmd: "SKP_DATA",
      value: {
        intro: op ? { start: op.start, end: op.end } : null,
        outro: ed ? { start: ed.start, end: ed.end } : null,
      },
      auto: autoSaut,
    });
  };

  const surMessage = (ev: MessageEvent) => {
    // L'origine, toujours : une page encadree n'est pas une source de
    // confiance, et `postMessage` accepte n'importe quel emetteur.
    if (ev.origin !== MEGAPLAY_ORIGINE) return;
    let donnee: any = ev.data;
    if (typeof donnee === "string") {
      try {
        donnee = JSON.parse(donnee);
      } catch {
        return;
      }
    }
    if (!donnee || typeof donnee !== "object") return;

    if (donnee.event === "PLAYER_READY") {
      // Les reperes ne peuvent etre poses qu'une fois leur jwplayer pret :
      // leur `SKP_DATA` les dessine sur la barre, ce qui suppose une duree
      // connue. Avant PLAYER_READY, le message est simplement perdu.
      envoieReperes();
      return;
    }

    if (donnee.event === "CURRENT_TIME") {
      const t = Number(donnee.time);
      const d = Number(donnee.duration);
      if (aniListId == null || episodeNumber == null) return;
      if (!Number.isFinite(t) || t < 0) return;
      if (Number.isFinite(d) && d > 0) publishDuration(aniListId, episodeNumber, d);
      saveProgress(aniListId, episodeNumber, t, Number.isFinite(d) ? d : 0);
      if (!vuCompte && t >= 120) {
        vuCompte = true;
        // Import paresseux : le compteur de serie n'a rien a faire dans le
        // paquet de la page tant qu'on n'a pas regarde deux minutes.
        import("@/lib/stats/streak")
          .then((m) => m.recordWatchToday())
          .catch(() => {});
      }
      if (!finTiree && Number.isFinite(d) && d > 0 && t >= d - MARGE_FIN) {
        finTiree = true;
        markComplete(aniListId, episodeNumber, d);
        surFin?.();
      }
    }
  };

  window.addEventListener("message", surMessage);
  const minuteur = window.setInterval(() => envoie({ cmd: "GET_TIME" }), PAS_MS);
  /* PLAYER_READY peut partir AVANT qu'on ait branche l'ecouteur (leur script
     l'emet des le premier `firstFrame`). On repousse donc les reperes une
     seconde fois, sans attendre l'evenement — SKP_DATA est idempotent. */
  const rappel = window.setTimeout(envoieReperes, 4000);

  return () => {
    mort = true;
    window.removeEventListener("message", surMessage);
    window.clearInterval(minuteur);
    window.clearTimeout(rappel);
  };
}
