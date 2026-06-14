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

const KEY = "preferred_server";
export const SERVER_PREF_EVENT = "aniscroll:serverPref:change";

export function getServerPref(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) || "";
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
