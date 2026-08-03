import { useEffect, useState } from "react";
import {
  isPlayerFullscreen,
  subscribePlayerFullscreen,
} from "./playerFullscreen";

export {
  isPlayerFullscreen,
  setPlayerFullscreen,
  togglePlayerFullscreen,
} from "./playerFullscreen";

/**
 * React view of the player's fullscreen mode (see `./playerFullscreen`).
 *
 * Seeded from the module rather than `false`, which is the whole point: the
 * player is remounted on every episode change, and it must render fullscreen on
 * its FIRST paint — a `useState(false)` + effect would flash a windowed player
 * inside a fullscreen screen.
 */
export function usePlayerFullscreen(): boolean {
  const [active, setActive] = useState(() => isPlayerFullscreen());
  useEffect(() => {
    const sync = () => setActive(isPlayerFullscreen());
    // Catch a change that landed between this render and the subscription.
    sync();
    return subscribePlayerFullscreen(sync);
  }, []);
  return active;
}
