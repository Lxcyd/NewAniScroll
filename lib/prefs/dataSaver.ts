/**
 * Data Saver preference (local, per-device). When on, the app avoids the
 * heaviest visual work: the player's live ambient-light sampling is disabled and
 * cover images request a smaller AniList size.
 *
 * Same pattern as the other pref stores: one localStorage key, a CustomEvent for
 * same-tab notification, and a hook returning the live value.
 */

import { useEffect, useState } from "react";

const KEY = "aniscroll:dataSaver";
export const DATA_SAVER_EVENT = "aniscroll:dataSaver:change";

export function getDataSaver(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDataSaver(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
  window.dispatchEvent(new CustomEvent(DATA_SAVER_EVENT));
}

export function useDataSaver(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const read = () => setOn(getDataSaver());
    read();
    window.addEventListener(DATA_SAVER_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(DATA_SAVER_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return on;
}
