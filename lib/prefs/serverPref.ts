/**
 * Preferred streaming server (local, per-device).
 *
 * This wraps the SAME localStorage key the watch page already reads/writes
 * (`preferred_server`): clicking a server in the player persists it there, and
 * the player applies it on load (when that anime actually offers it, else it
 * falls back to a working one). This module just lets the Settings page
 * read/edit that same preference up front.
 *
 *   - "" (empty)  → Auto: use the site default (megaplay) and remember whatever
 *                   the user clicks in the player.
 *   - "<id>"      → always try this server id first (see lib/servers.js for ids).
 *
 * Same event/hook shape as the other prefs so the Settings UI stays live.
 */

import { useEffect, useState } from "react";
import SERVERS from "@/lib/servers";

const KEY = "preferred_server";
export const SERVER_PREF_EVENT = "aniscroll:serverPref:change";

/**
 * Une preference qui designe un serveur RETIRE doit etre traitee comme absente.
 *
 * Les ids bougent souvent ici — au moins huit ont ete retires ou renommes
 * (`animesama-vidmoly` -> `animesama-ansembed`, `voiranime-voe`, `vidnest`,
 * `4animo`, `miruro-jet`, les `hianime-*`, `embed4me`, `smoothpre`...). Rien ne
 * validait la valeur relue : la page de lecture faisait `setActiveServer(pref)`
 * telle quelle, et un id mort donnait une cascade silencieuse et PERMANENTE —
 * `getServer()` retombe sur SERVERS[0] donc le type reste "api" et la requete
 * part quand meme, `/api/v2/source?server=<id mort>` echoue, `shouldShow` ne
 * trouve aucun chip a marquer actif, le repli finit par ramener megaplay... et
 * comme seul un CLIC reecrit localStorage, l'id mort restait en place et le
 * meme aller-retour perdu (+ le flash « Source unavailable ») se rejouait a
 * CHAQUE chargement, indefiniment. La page info payait le meme prix : elle
 * prechauffe la preference en priorite haute, donc un scrape lourd gaspille a
 * chaque visite.
 *
 * On la purge au passage : garder une valeur qu'on sait morte n'apporte rien,
 * et la relecture suivante repart proprement sur Auto.
 */
function isKnownServer(id: string): boolean {
  return SERVERS.some((s: { id: string }) => s.id === id);
}

export function getServerPref(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = window.localStorage.getItem(KEY) || "";
    if (!raw) return "";
    if (isKnownServer(raw)) return raw;
    window.localStorage.removeItem(KEY);
    return "";
  } catch {
    return "";
  }
}

export function setServerPref(id: string): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(KEY, id);
    else window.localStorage.removeItem(KEY); // empty = Auto
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(SERVER_PREF_EVENT));
}

export function useServerPref(): string {
  const [id, setId] = useState("");
  useEffect(() => {
    const read = () => setId(getServerPref());
    read();
    window.addEventListener(SERVER_PREF_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(SERVER_PREF_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return id;
}
