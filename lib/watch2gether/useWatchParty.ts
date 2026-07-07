// useWatchParty — client orchestrator for the Watch 2gether feature.
//
// Transport: Ably (managed WebSocket, server -> client) + HTTP POST (client ->
// server). Everyone can control playback; conflicts are mitigated with
// echo-suppression (drop own events) and an `applyingRemote` guard owned by
// the player integration.
//
// Why Ably and not the old SSE stream: an SSE function on Vercel stayed ALIVE
// ~58s per connection, burning ~1h of Fluid Active CPU per person-hour in a
// room. Ably is a direct browser↔Ably WebSocket; Vercel only publishes events
// via a short REST call. The client subscribes to a SUBSCRIBE-only token
// scoped to its room (see /api/v2/watch2gether/ably-token).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Realtime, RealtimeChannel } from "ably";
import { getGuestIdentity } from "./guest";
import type {
  ChatMessage,
  Member,
  PartyEvent,
  PartyEventType,
  RoomSnapshot,
} from "./types";

// Must stay safely below PRESENCE_TTL (12s, see redisRoom) so a live member is
// never pruned between heartbeats. 5s gives ~2.4 refreshes per TTL window — the
// margin a single slow request needs. (The Active-CPU win comes from the SSE
// stream living longer, not from thinning this cheap heartbeat — slowing it
// would also undo the deliberately-fast 12s departure detection.)
const PRESENCE_INTERVAL_MS = 5_000;

/** Live connection quality, surfaced as a coloured dot in the panel.
 *  - "connected"    → green   (Ably channel attached)
 *  - "reconnecting" → yellow  (briefly dropped, Ably is retrying)
 *  - "poor"         → red     (still down after several retries) */
export type ConnectionState = "connected" | "reconnecting" | "poor";

export interface PartyContext {
  roomId: string;
  myId: string | null;
  hostId: string | null;
  isHost: boolean;
  isConnected: boolean;
  connectionState: ConnectionState;
  members: Member[];
  chat: ChatMessage[];
  snapshot: RoomSnapshot | null;
  /** Set by the player while it applies a remote action, to suppress re-broadcast. */
  applyingRemoteRef: React.MutableRefObject<boolean>;
  /** Register a handler for inbound remote playback/episode events. */
  onRemote: (handler: (e: PartyEvent) => void) => () => void;
  broadcast: (type: PartyEventType, payload?: any) => void;
  sendChat: (text: string) => void;
  /** Leave the party (host transfers automatically server-side). */
  leave: () => void;
  /** Host-only: remove a member (they can rejoin). */
  kick: (userId: string) => void;
  /** Host-only: ban a member (cannot rejoin until the room disbands). */
  ban: (userId: string) => void;
  /** Host-only: mute / unmute a member's chat. */
  mute: (userId: string, muted: boolean) => void;
  /** Host-only: block / unblock a member from controlling playback. */
  blockPlayback: (userId: string, blocked: boolean) => void;
  /** Host-only: hand the host role to another member. */
  transferHost: (userId: string) => void;
  /** Host-only: toggle room flags (locked). */
  setFlags: (flags: { locked?: boolean }) => void;
  /** True when the room is locked to new joiners. */
  locked: boolean;
  /** True when WE are muted in chat. */
  amMuted: boolean;
  /** True when the host has blocked US from controlling playback. */
  amPlaybackBlocked: boolean;
  /** True until the FIRST join attempt resolves — the page shows a loading
   *  state instead of the (empty) room so a rejected/banned join never flashes
   *  the room contents. */
  joinPending: boolean;
  inviteUrl: string;
}

interface InitMeta {
  aniId: string | number;
  epiNumber: string | number;
  dub: boolean;
  server?: string;
}

interface PartyOpts {
  /** Called when WE are removed (kick/ban) or leave — the page should strip
   *  `?party` from the URL. Receives a reason for an optional toast. */
  onSelfRemoved?: (reason: "kick" | "ban" | "leave") => void;
  /** Called when a join attempt is rejected (banned / locked room / reaped for
   *  inactivity). The page should strip `?party` and surface the reason. */
  onJoinRejected?: (reason: "banned" | "locked" | "notfound" | "inactive") => void;
}

export function useWatchParty(
  roomId: string | null,
  meta: InitMeta,
  myUserId: string | null,
  opts?: PartyOpts,
): PartyContext | null {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("reconnecting");
  // Consecutive failed (re)connects since the last successful open. Drives the
  // escalation from "reconnecting" (yellow) to "poor" (red).
  const retryCountRef = useRef(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  // The server-confirmed identity from join() — authoritative for "is this me?"
  // regardless of how the guest id resolved client-side.
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  // The roomId whose join() has SUCCEEDED. We derive `joinPending` by comparing
  // it to the current roomId, so the gate flips to "pending" SYNCHRONOUSLY the
  // instant we navigate to a new room — no effect lag that would briefly render
  // the previous room's data (which flashed the room on a banned re-join).
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(null);

  const onSelfRemovedRef = useRef(opts?.onSelfRemoved);
  onSelfRemovedRef.current = opts?.onSelfRemoved;
  const onJoinRejectedRef = useRef(opts?.onJoinRejected);
  onJoinRejectedRef.current = opts?.onJoinRejected;

  // Anonymous identity for guests (stable per browser). Signed-in users ignore
  // it. Resolved client-side in an effect (it reads localStorage) to avoid any
  // SSR/CSR mismatch. The guestId is the guest's SECRET — the server hashes it
  // into the PUBLIC id it broadcasts, so we can NO LONGER compute our own public
  // id locally. For "is this me?" matching we rely on `confirmedId` (the public
  // id the server returns from join()). The secret only gates the connection.
  const [guest, setGuest] = useState<{ guestId: string; guestName: string } | null>(null);
  useEffect(() => {
    if (myUserId) {
      setGuest(null);
      return;
    }
    setGuest(getGuestIdentity());
  }, [myUserId]);
  // Gate for opening the connection: signed-in id, or "we have the guest secret".
  // NOT used for matching (a guest's public id is server-issued, see `myId`).
  const connectGate = myUserId || (guest ? "guest-ready" : null);
  // The authoritative "this is me" id: signed-in id directly (public + session-
  // verified), or the server-confirmed public id for a guest.
  const selfId = myUserId || confirmedId;

  const applyingRemoteRef = useRef(false);
  const remoteHandlers = useRef<Set<(e: PartyEvent) => void>>(new Set());
  // Live Ably client + channel for this room. Replaces the old EventSource.
  const ablyRef = useRef<Realtime | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const myIdRef = useRef<string | null>(selfId);
  myIdRef.current = selfId;
  const guestRef = useRef(guest);
  guestRef.current = guest;
  // Snapshot of the live member list for stale-free lookups inside callbacks
  // (e.g. resolving our own display name for optimistic chat).
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  // After WE toggle the room lock, remember the intended value for a short
  // window so a stale snapshot/settings event (in flight before the server
  // applied our change) can't flap the UI back. Cleared once it matches.
  const pendingLockRef = useRef<{ value: boolean; until: number } | null>(null);
  // Flips to true after we leave / are removed, so the connection effect won't
  // immediately reconnect.
  const removedRef = useRef(false);
  // Guards against a DOUBLE rejection toast: on wake, both the SSE re-join and
  // the presence heartbeat can 403 in parallel. `removedRef` alone races (each
  // path checks it before its own await, then teardown sets it later), so we use
  // a dedicated flag set SYNCHRONOUSLY the instant either path decides to reject.
  const rejectedRef = useRef(false);

  // Reconcile an incoming authoritative snapshot with a just-set lock value:
  // if we toggled the lock <4s ago and the server snapshot still reflects the
  // OLD value (event was in flight), keep our intended value to avoid flapping.
  // Once the server agrees, clear the pending marker.
  const reconcileSnapshot = useCallback((snap: RoomSnapshot | null): RoomSnapshot | null => {
    if (!snap) return snap;
    const p = pendingLockRef.current;
    if (p && Date.now() < p.until) {
      if (snap.locked === p.value) pendingLockRef.current = null;
      else return { ...snap, locked: p.value };
    } else if (p) {
      pendingLockRef.current = null;
    }
    return snap;
  }, []);

  const onRemote = useCallback((handler: (e: PartyEvent) => void) => {
    remoteHandlers.current.add(handler);
    return () => {
      remoteHandlers.current.delete(handler);
    };
  }, []);

  const post = useCallback(async (path: string, body: any) => {
    try {
      // Attach guest identity for anonymous users; the server ignores it when a
      // session is present.
      const g = guestRef.current;
      const merged = g ? { ...body, guestId: g.guestId, guestName: g.guestName } : body;
      const res = await fetch(`/api/v2/watch2gether/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }, []);

  const broadcast = useCallback(
    (type: PartyEventType, payload?: any) => {
      if (!roomId) return;
      post("event", { roomId, type, payload });
    },
    [roomId, post],
  );

  const sendChat = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || !roomId) return;
      // Optimistic: show the message instantly with a temp id, tagged `pending`.
      // When the server echoes it back (real id), dispatch() replaces this one.
      const myId = myIdRef.current;
      if (myId) {
        const mine = membersRef.current.find((m) => m.userId === myId);
        const optimistic: ChatMessage & { pending?: boolean } = {
          id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          userId: myId,
          name: mine?.name || (guestRef.current?.guestName ?? "…"),
          image: mine?.image,
          text: t,
          ts: Date.now(),
          pending: true,
        };
        setChat((prev) => [...prev.slice(-99), optimistic]);
        // If the server never echoes it back (e.g. we were muted), drop the
        // placeholder after a short grace period so it doesn't linger.
        setTimeout(() => {
          setChat((prev) => prev.filter((m) => m.id !== optimistic.id));
        }, 5000);
      }
      broadcast("chat", { text: t });
    },
    [roomId, broadcast],
  );

  // Tear down the live connection (used on leave and when we're removed).
  const teardown = useCallback(() => {
    removedRef.current = true;
    try {
      channelRef.current?.unsubscribe();
    } catch {
      /* noop */
    }
    channelRef.current = null;
    ablyRef.current?.close();
    ablyRef.current = null;
    setIsConnected(false);
    setConnectionState("reconnecting");
    // Forget the joined room so a later re-join (e.g. same code) re-gates with
    // the spinner instead of flashing this session's stale members/snapshot.
    setJoinedRoomId(null);
    setMembers([]);
    setSnapshot(null);
    setChat([]);
  }, []);

  // Reject the join/connection exactly once, no matter how many code paths
  // detect it concurrently (SSE re-join + presence beat on wake). The flag is
  // set synchronously BEFORE any await, so a second caller bails immediately.
  const rejectOnce = useCallback(
    (reason: "banned" | "locked" | "notfound" | "inactive") => {
      if (rejectedRef.current) return;
      rejectedRef.current = true;
      teardown();
      onJoinRejectedRef.current?.(reason);
    },
    [teardown],
  );

  const leave = useCallback(() => {
    if (roomId) post("leave", { roomId });
    teardown();
    onSelfRemovedRef.current?.("leave");
  }, [roomId, post, teardown]);

  // Host moderation actions. All apply an OPTIMISTIC local update first so the
  // host sees instant feedback; the authoritative SSE event that follows simply
  // confirms it (the round-trip Redis→SSE can take ~1s, especially on Hobby).

  const kick = useCallback(
    (userId: string) => {
      if (!roomId) return;
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      post("moderate", { roomId, action: "kick", targetUserId: userId });
    },
    [roomId, post],
  );

  const ban = useCallback(
    (userId: string) => {
      if (!roomId) return;
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
      post("moderate", { roomId, action: "ban", targetUserId: userId });
    },
    [roomId, post],
  );

  const mute = useCallback(
    (userId: string, muted: boolean) => {
      if (!roomId) return;
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, muted } : m)));
      post("moderate", { roomId, action: muted ? "mute" : "unmute", targetUserId: userId });
    },
    [roomId, post],
  );

  const blockPlayback = useCallback(
    (userId: string, blocked: boolean) => {
      if (!roomId) return;
      setMembers((prev) =>
        prev.map((m) => (m.userId === userId ? { ...m, playbackBlocked: blocked } : m)),
      );
      post("moderate", {
        roomId,
        action: blocked ? "block-playback" : "unblock-playback",
        targetUserId: userId,
      });
    },
    [roomId, post],
  );

  const transferHost = useCallback(
    (userId: string) => {
      if (!roomId) return;
      setHostId(userId);
      // The new host becomes host and has any mute / playback-block cleared
      // (mirrors the server). Optimistic so it reflects instantly.
      setMembers((prev) =>
        prev.map((m) =>
          m.userId === userId
            ? { ...m, isHost: true, muted: false, playbackBlocked: false }
            : { ...m, isHost: false },
        ),
      );
      post("moderate", { roomId, action: "transfer-host", targetUserId: userId });
    },
    [roomId, post],
  );

  const setFlags = useCallback(
    (flags: { locked?: boolean }) => {
      if (!roomId) return;
      if (typeof flags.locked === "boolean") {
        pendingLockRef.current = { value: flags.locked, until: Date.now() + 4000 };
      }
      setSnapshot((prev) => (prev ? { ...prev, ...flags } : prev));
      post("moderate", { roomId, action: "set-flags", flags });
    },
    [roomId, post],
  );

  // Join (and re-join on reconnect): pulls authoritative snapshot + history.
  // Handles rejections (banned / locked / not found) explicitly so the page can
  // strip ?party and tell the user why, instead of showing an empty room.
  const join = useCallback(async () => {
    if (!roomId) return;
    let data: any = null;
    try {
      const g = guestRef.current;
      const merged = g ? { roomId, guestId: g.guestId, guestName: g.guestName } : { roomId };
      const res = await fetch(`/api/v2/watch2gether/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(merged),
      });
      if (!res.ok) {
        if ((res.status === 403 || res.status === 404) && !rejectedRef.current) {
          const err = await res.json().catch(() => ({}));
          const msg = String(err?.error || "");
          const reason = /ban/i.test(msg)
            ? "banned"
            : /inactiv/i.test(msg)
              ? "inactive"
              : /lock/i.test(msg)
                ? "locked"
                : "notfound";
          rejectOnce(reason); // idempotent — concurrent presence/join reject won't double-toast
        }
        return;
      }
      data = await res.json();
    } catch {
      return;
    }
    if (!data) return;
    setJoinedRoomId(roomId);
    if (data.me?.userId) setConfirmedId(String(data.me.userId));
    if (data.snapshot) {
      setSnapshot(reconcileSnapshot(data.snapshot));
      if (data.snapshot.hostId) setHostId(data.snapshot.hostId);
    }
    if (Array.isArray(data.chat)) setChat(data.chat);
    if (Array.isArray(data.members)) setMembers(data.members);
    // Replay the snapshot to player handlers so it syncs after a (re)connect.
    // Tag whether WE are the host, computed SYNCHRONOUSLY here from the server's
    // own response (snapshot.hostId vs data.me.userId). The player's snapshot
    // guard must NOT drive the host's own player, but it can't rely on the
    // React-derived `isHost` — on the FIRST snapshot after create/join that
    // state hasn't re-rendered yet (setHostId above is still queued), so the
    // guard read stale `false` and the seeded snapshot's play/pause churn drove
    // the host's player ("creating a party launches the anime"). Passing the
    // authoritative value inline closes that race.
    if (data.snapshot) {
      const selfIsHost =
        !!data.snapshot.hostId &&
        !!data.me?.userId &&
        String(data.snapshot.hostId) === String(data.me.userId);
      const ev: PartyEvent = {
        type: "snapshot",
        senderId: "server",
        ts: Date.now(),
        payload: { snapshot: data.snapshot, selfIsHost },
      };
      remoteHandlers.current.forEach((h) => h(ev));
    }
  }, [roomId, reconcileSnapshot, rejectOnce]);

  // Dispatch inbound SSE events.
  const dispatch = useCallback((ev: PartyEvent) => {
    const myId = myIdRef.current;

    if (ev.type === "presence") {
      if (Array.isArray(ev.payload?.members)) setMembers(ev.payload.members);
      return;
    }
    if (ev.type === "chat") {
      const msg = ev.payload as ChatMessage;
      if (msg) {
        setChat((prev) => {
          // If this is the server echo of OUR optimistic message, replace the
          // matching pending placeholder instead of appending a duplicate.
          if (msg.userId === myId) {
            const idx = prev.findIndex(
              (m) => (m as any).pending && m.userId === myId && m.text === msg.text,
            );
            if (idx !== -1) {
              const next = prev.slice();
              next[idx] = msg;
              return next;
            }
          }
          return [...prev.slice(-99), msg];
        });
      }
      // Also forward to remote handlers so the FULLSCREEN chat overlay (which
      // keeps its own message list via onRemote, not the panel's `chat` state)
      // actually receives messages — otherwise bubbles never appear in FS.
      remoteHandlers.current.forEach((h) => h(ev));
      return;
    }
    if (ev.type === "snapshot") {
      if (ev.payload?.snapshot) {
        setSnapshot(reconcileSnapshot(ev.payload.snapshot));
        if (ev.payload.snapshot.hostId) setHostId(ev.payload.snapshot.hostId);
      }
      if (Array.isArray(ev.payload?.members)) setMembers(ev.payload.members);
      remoteHandlers.current.forEach((h) => h(ev));
      return;
    }
    if (ev.type === "host") {
      if (ev.payload?.hostId) setHostId(ev.payload.hostId);
      return;
    }
    if (ev.type === "settings") {
      // Room flags changed (locked) — adopt the fresh snapshot when present.
      if (ev.payload?.snapshot) {
        setSnapshot(reconcileSnapshot(ev.payload.snapshot));
        if (ev.payload.snapshot.hostId) setHostId(ev.payload.snapshot.hostId);
      }
      return;
    }
    if (ev.type === "mute" || ev.type === "unmute") {
      // The server also broadcasts a fresh presence list (with muted flags), so
      // the UI updates from that. Nothing else to do here.
      return;
    }
    if (ev.type === "kick" || ev.type === "ban") {
      // If we're the target, tear down and let the page strip ?party.
      if (myId && ev.payload?.targetUserId === myId) {
        teardown();
        onSelfRemovedRef.current?.(ev.type);
      }
      return;
    }

    // Playback / episode / server events: drop our own echoes.
    if (myId && ev.senderId === myId) return;
    remoteHandlers.current.forEach((h) => h(ev));
  }, [teardown]);

  // Ably connection lifecycle. Wait until we have an identity (a guest's resolves
  // asynchronously) so the token request authenticates correctly.
  useEffect(() => {
    if (!roomId || !connectGate) return;
    // A new room/identity means a fresh session — clear any prior removal flags.
    removedRef.current = false;
    rejectedRef.current = false;

    let cancelled = false;
    let client: Realtime | null = null;
    let channel: RealtimeChannel | null = null;

    // Eager join: catches ban / locked-room rejection immediately (the token
    // route 403s banned users, but locked-room / inactivity rejection is owned
    // by join(), so we can't rely on the realtime connection alone).
    join();

    // Ably is a client-only dependency (it touches WebSocket/window), so import
    // it dynamically to keep it out of the SSR bundle.
    (async () => {
      let mod: typeof import("ably");
      try {
        mod = await import("ably");
      } catch {
        return; // Ably failed to load — feature degrades (no live sync).
      }
      if (cancelled || removedRef.current) return;
      // Ably v2 exposes Realtime both as a named export and on the default
      // export; accept either so bundler interop differences don't break it.
      const AblyRealtime =
        (mod as any).Realtime || (mod as any).default?.Realtime;
      if (!AblyRealtime) return;

      // Auth via our token route: it mints a SUBSCRIBE-only token scoped to this
      // room's channel. Guests pass their identity in the auth request params so
      // getPartyUser() can resolve their public id server-side.
      const g = guestRef.current;
      const authParams: Record<string, string> = { roomId };
      if (g) {
        authParams.guestId = g.guestId;
        authParams.guestName = g.guestName;
      }

      // Local non-null handles for use in this scope; the outer `client` /
      // `channel` (nullable, captured by the cleanup closure) mirror them.
      const rt: Realtime = new AblyRealtime({
        authUrl: "/api/v2/watch2gether/ably-token",
        authMethod: "GET",
        authParams,
        // We drive (re)sync via join() on connect; Ably handles reconnection.
        closeOnUnload: true,
      });
      client = rt;
      ablyRef.current = rt;

      rt.connection.on("connected", () => {
        retryCountRef.current = 0;
        setIsConnected(true);
        setConnectionState("connected");
        join(); // (re)sync authoritative state on every (re)connect
      });
      // Briefly dropped → yellow; still down after several retries → red.
      const onDrop = () => {
        if (cancelled || removedRef.current) return;
        setIsConnected(false);
        retryCountRef.current += 1;
        setConnectionState(retryCountRef.current >= 3 ? "poor" : "reconnecting");
      };
      rt.connection.on("disconnected", onDrop);
      rt.connection.on("suspended", onDrop);

      const ch: RealtimeChannel = rt.channels.get(`w2g:channel:${roomId}`);
      channel = ch;
      channelRef.current = ch;
      ch.subscribe("event", (msg) => {
        try {
          dispatch(
            (typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data) as PartyEvent,
          );
        } catch {
          /* ignore malformed */
        }
      });
    })();

    return () => {
      cancelled = true;
      try {
        channel?.unsubscribe();
      } catch {
        /* noop */
      }
      channelRef.current = null;
      client?.close();
      ablyRef.current = null;
    };
  }, [roomId, connectGate, join, dispatch]);

  // Presence heartbeat + leave-on-unload.
  useEffect(() => {
    if (!roomId || !connectGate) return;

    // A heartbeat that ALSO inspects the response: when we wake from sleep after
    // being reaped for inactivity, the realtime connection may not reliably
    // re-fire "connected" (so join() isn't re-called), but the presence beat on
    // wake hits the server, which 403s it with "Removed for inactivity". That's
    // our reliable wake signal —
    // detect it here and run the same rejection flow as join() (close the panel
    // + toast), so the kicked user doesn't keep a stale room open.
    const beat = async () => {
      try {
        const g = guestRef.current;
        const body = g ? { roomId, guestId: g.guestId, guestName: g.guestName } : { roomId };
        const res = await fetch(`/api/v2/watch2gether/presence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status === 403 && !rejectedRef.current) {
          const err = await res.json().catch(() => ({}));
          if (/inactiv/i.test(String(err?.error || ""))) {
            rejectOnce("inactive"); // idempotent — won't double-toast vs join()
          }
        }
      } catch {
        /* network blip — next beat retries */
      }
    };

    // Presence beats only run while the tab is VISIBLE. A backgrounded tab that
    // nobody is watching shouldn't keep invoking the presence function — that
    // was needless Vercel CPU. When hidden, we stop the interval; the server's
    // short presence TTL (12s) then drops us as a real departure would. On
    // return to foreground we beat immediately (re-establishing presence / the
    // inactivity-kick signal) and restart the interval.
    let iv: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (iv == null) iv = setInterval(beat, PRESENCE_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (iv != null) {
        clearInterval(iv);
        iv = null;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        beat();
        startInterval();
      } else {
        stopInterval();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    // Kick off according to the current visibility.
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      beat();
      startInterval();
    }

    const leave = () => {
      try {
        const g = guestRef.current;
        const body = g ? { roomId, guestId: g.guestId, guestName: g.guestName } : { roomId };
        const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
        navigator.sendBeacon?.("/api/v2/watch2gether/leave", blob);
      } catch {
        /* noop */
      }
    };
    window.addEventListener("pagehide", leave);

    return () => {
      stopInterval();
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", onVisible);
      // NOTE: we deliberately do NOT call leave() here. This cleanup also runs
      // on an in-app redirect that KEEPS us in the same party (e.g. a joiner
      // being navigated to the host's anime). Leaving on unmount raced with the
      // re-join on the new page and dropped the member from the room ("pas dans
      // le groupe"). Genuine departure (tab close, navigate away) is covered by
      // the `pagehide` beacon above; if the beacon is missed, the presence key
      // lapses via its short TTL (12s) so the member still vanishes quickly.
    };
  }, [roomId, connectGate, rejectOnce]);

  const inviteUrl =
    typeof window !== "undefined" && roomId
      ? `${window.location.origin}${window.location.pathname}?${withParty(window.location.search, roomId)}`
      : "";

  // Memoize the context so its identity only changes when something it carries
  // actually changes. Without this, a new object each render churns the player's
  // useMemo / sync effects (deps include `party`) and breaks live sync.
  // Effective id may briefly be null while a guest identity resolves; fall back
  // to the server-confirmed id so "this is me" (ring, mute/block flags) is right.
  const myId = selfId;
  const isHost = !!myId && myId === hostId;
  const amMuted = !!myId && members.some((m) => m.userId === myId && m.muted);
  const amPlaybackBlocked =
    !!myId && !isHost && members.some((m) => m.userId === myId && m.playbackBlocked);
  const locked = !!snapshot?.locked;
  // Derived (synchronous): pending until THIS room's join has succeeded. Because
  // it compares to the navigated roomId, it's true on the very first render of a
  // new room — no stale frame of the previous room.
  const joinPending = joinedRoomId !== roomId;


  const ctx = useMemo<PartyContext | null>(() => {
    if (!roomId) return null;
    return {
      roomId,
      myId,
      hostId,
      isHost,
      isConnected,
      connectionState,
      members,
      chat,
      snapshot,
      applyingRemoteRef,
      onRemote,
      broadcast,
      sendChat,
      leave,
      kick,
      ban,
      mute,
      blockPlayback,
      transferHost,
      setFlags,
      locked,
      amMuted,
      amPlaybackBlocked,
      joinPending,
      inviteUrl,
    };
  }, [
    roomId,
    myId,
    hostId,
    isHost,
    isConnected,
    connectionState,
    members,
    chat,
    snapshot,
    applyingRemoteRef,
    onRemote,
    broadcast,
    sendChat,
    leave,
    kick,
    ban,
    mute,
    blockPlayback,
    transferHost,
    setFlags,
    locked,
    amMuted,
    amPlaybackBlocked,
    joinPending,
    inviteUrl,
  ]);

  return ctx;
}

// Merge ?party into an existing query string without clobbering other params.
function withParty(search: string, roomId: string): string {
  const params = new URLSearchParams(search);
  params.set("party", roomId);
  return params.toString();
}
