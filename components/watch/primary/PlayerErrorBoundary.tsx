import React from "react";

/**
 * Error boundary around the Vidstack player.
 *
 * The player portals custom controls INTO Vidstack-owned DOM nodes
 * (`.vds-controls-group`, the settings menu list). When Vidstack rebuilds that
 * subtree — which it does on a layout flip OR even on a benign `durationchange`
 * near the end of playback — those nodes are destroyed out from under React,
 * and React's portal cleanup then throws `NotFoundError: removeChild ... is not
 * a child of this node`. Uncaught, that error tears down the WHOLE page.
 *
 * Catching it here keeps the page alive. CRITICAL: recovery must NOT remount
 * the player. An earlier version bumped an inner `key` to force a fresh subtree;
 * that reloaded the HLS source from scratch — i.e. the video jumped back to 0.
 * A trace pinned the "video resets to the start near the end" bug exactly on
 * this: durationchange → Vidstack rebuild → removeChild → boundary remount →
 * source reload at currentTime 0.
 *
 * The portal targets are STABLE: UniversalPlayer portals into `[data-slot]`
 * wrapper nodes it owns and re-creates on demand (ensureSiblingBefore /
 * ensureFirstChildSlot). So after the transient teardown, simply re-rendering
 * the SAME element instance in place lets the portals re-attach on the next
 * commit — no remount, no key bump, the <video> keeps playing untouched.
 *
 * `resetKey` (the source/server identity) is still used by the CALLER as the
 * React `key` on this boundary, so an intentional source swap mounts fresh.
 */
type Props = {
  children: React.ReactNode;
  /** Source/server identity. Reserved for callers that also use it as `key`. */
  resetKey?: string | number;
  fallback?: React.ReactNode;
};

type State = { hasError: boolean };

export default class PlayerErrorBoundary extends React.Component<Props, State> {
  // Throttle in-place recovery so a genuinely broken render can't busy-loop.
  private recoveredAt = 0;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    // We just rendered the fallback for one commit to let React finish unwinding
    // the failed portal teardown; immediately clear the error so the SAME player
    // element re-renders in place (portals re-attach to the stable slots). No
    // key change → the <video>/HLS instance is preserved → no reload, no reset.
    if (this.state.hasError && !prevState.hasError) {
      const now = Date.now();
      if (now - this.recoveredAt > 1000) {
        this.recoveredAt = now;
        // Defer to a microtask so we don't setState synchronously inside the
        // same commit phase.
        Promise.resolve().then(() => {
          if (this.state.hasError) this.setState({ hasError: false });
        });
      }
    }
  }

  render() {
    if (this.state.hasError) {
      // One-commit fallback. Returning the existing fallback (or null) here, NOT
      // a re-keyed copy of the player, is what avoids the remount/reset.
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
