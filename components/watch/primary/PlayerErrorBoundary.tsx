import React from "react";

/**
 * Error boundary around the Vidstack player.
 *
 * The player portals custom controls INTO Vidstack-owned DOM nodes
 * (`.vds-controls-group`, the settings menu list). When Vidstack rebuilds that
 * subtree — which it does on a source change / layout breakpoint flip — those
 * nodes are destroyed out from under React, and React's portal cleanup then
 * throws `NotFoundError: removeChild ... is not a child of this node`. That
 * uncaught error tears down the WHOLE page (the "client-side exception"), so
 * the player vanishes entirely.
 *
 * Catching it here keeps the rest of the page alive. We also auto-remount the
 * player once (via a key bump) so a transient teardown self-heals instead of
 * leaving a dead frame. `resetKey` (the source/server identity) resets the
 * boundary whenever the caller intentionally swaps sources, so a new source
 * always gets a clean mount.
 */
type Props = {
  children: React.ReactNode;
  /** Bump this when the source/server changes so the boundary resets. */
  resetKey?: string | number;
  fallback?: React.ReactNode;
};

type State = { hasError: boolean; remountKey: number };

export default class PlayerErrorBoundary extends React.Component<Props, State> {
  // Guards against an infinite remount loop if the error is persistent rather
  // than the one-off teardown race we expect.
  private remountedAt = 0;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, remountKey: 0 };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: Props) {
    // Caller changed the source/server → clear any error state for the new mount.
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState((s) => ({ hasError: false, remountKey: s.remountKey + 1 }));
    }
  }

  componentDidCatch() {
    const now = Date.now();
    // Auto-recover from a transient portal teardown: remount once, but not more
    // than once every 2s, so a genuinely broken render doesn't thrash.
    if (now - this.remountedAt > 2000) {
      this.remountedAt = now;
      this.setState((s) => ({ hasError: false, remountKey: s.remountKey + 1 }));
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    // The inner key forces a fresh subtree on recovery so no orphaned portal
    // state survives.
    return (
      <React.Fragment key={this.state.remountKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
