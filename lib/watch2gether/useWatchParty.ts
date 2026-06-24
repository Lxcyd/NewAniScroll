// useWatchParty — client orchestrator for the Watch 2gether feature.
//
// Transport: SSE (server -> client) via EventSource + HTTP POST (client ->
// server). Everyone can control playback; conflicts are mitigated with
// echo-suppression (drop own events) and an `applyingRemote` guard owned by
// the player integration.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGuestIdentity } from "./guest";
import type {
  ChatMessage,
  Member,
  PartyEvent,
  PartyEventType,
  RoomSnapshot,
} from "./types";

const PRESENCE_INTERVAL_MS = 15_000;

/** Live connection quality, surfaced as a coloured dot in the panel.
 *  - "connected"    → green   (SSE open)
 *  - "reconnecting" → yellow  (briefly dropped, EventSource is retrying)
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

  const onSelfRemovedRef = useRef(opts?.onSelfRemoved);
  onSelfRemovedRef.current = opts?.onSelfRemoved;

  // Anonymous identity for guests (stable per browser). Signed-in users ignore
  // it. Resolved client-side in an effect (it reads localStorage) to avoid any
  // SSR/CSR mismatch. On the server the guest userId becomes `g:{guestId}`, so
  // mirror that here for correct echo-suppression.
  const [guest, setGuest] = useState<{ guestId: string; guestName: string } | null>(null);
  useEffect(() => {
    if (myUserId) {
      setGuest(null);
      return;
    }
    setGuest(getGuestIdentity());
  }, [myUserId]);
  const effectiveUserId = myUserId || (guest ? `g:${guest.guestId}` : null);

  const applyingRemoteRef = useRef(false);
  const remoteHandlers = useRef<Set<(e: PartyEvent) => void>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const myIdRef = useRef<string | null>(effectiveUserId);
  myIdRef.current = effectiveUserId;
  const guestRef = useRef(guest);
  guestRef.current = guest;
  // Flips to true after we leave / are removed, so the connection effect won't
  // immediately reconnect.
  const removedRef = useRef(false);

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
      broadcast("chat", { text: t });
    },
    [roomId, broadcast],
  );

  // Tear down the live connection (used on leave and when we're removed).
  const teardown = useCallback(() => {
    removedRef.current = true;
    esRef.current?.close();
    esRef.current = null;
    setIsConnected(false);
    setConnectionState("reconnecting");
  }, []);

  const leave = useCallback(() => {
    if (roomId) post("leave", { roomId });
    teardown();
    onSelfRemovedRef.current?.("leave");
  }, [roomId, post, teardown]);

  const kick = useCallback(
    (userId: string) => {
      if (!roomId) return;
      post("moderate", { roomId, action: "kick", targetUserId: userId });
    },
    [roomId, post],
  );

  const ban = useCallback(
    (userId: string) => {
      if (!roomId) return;
      post("moderate", { roomId, action: "ban", targetUserId: userId });
    },
    [roomId, post],
  );

  const mute = useCallback(
    (userId: string, muted: boolean) => {
      if (!roomId) return;
      post("moderate", { roomId, action: muted ? "mute" : "unmute", targetUserId: userId });
    },
    [roomId, post],
  );

  const blockPlayback = useCallback(
    (userId: string, blocked: boolean) => {
      if (!roomId) return;
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
      post("moderate", { roomId, action: "transfer-host", targetUserId: userId });
    },
    [roomId, post],
  );

  const setFlags = useCallback(
    (flags: { locked?: boolean }) => {
      if (!roomId) return;
      post("moderate", { roomId, action: "set-flags", flags });
    },
    [roomId, post],
  );

  // Join (and re-join on reconnect): pulls authoritative snapshot + history.
  const join = useCallback(async () => {
    if (!roomId) return;
    const data = await post("join", { roomId });
    if (!data) return;
    if (data.snapshot) {
      setSnapshot(data.snapshot);
      if (data.snapshot.hostId) setHostId(data.snapshot.hostId);
    }
    if (Array.isArray(data.chat)) setChat(data.chat);
    if (Array.isArray(data.members)) setMembers(data.members);
    // Replay the snapshot to player handlers so it syncs after a (re)connect.
    if (data.snapshot) {
      const ev: PartyEvent = {
        type: "snapshot",
        senderId: "server",
        ts: Date.now(),
        payload: { snapshot: data.snapshot },
      };
      remoteHandlers.current.forEach((h) => h(ev));
    }
  }, [roomId, post]);

  // Dispatch inbound SSE events.
  const dispatch = useCallback((ev: PartyEvent) => {
    const myId = myIdRef.current;

    if (ev.type === "presence") {
      if (Array.isArray(ev.payload?.members)) setMembers(ev.payload.members);
      return;
    }
    if (ev.type === "chat") {
      // Append even our own (server is the ordering authority).
      if (ev.payload) setChat((prev) => [...prev.slice(-99), ev.payload as ChatMessage]);
      // Also forward to remote handlers so the FULLSCREEN chat overlay (which
      // keeps its own message list via onRemote, not the panel's `chat` state)
      // actually receives messages — otherwise bubbles never appear in FS.
      remoteHandlers.current.forEach((h) => h(ev));
      return;
    }
    if (ev.type === "snapshot") {
      if (ev.payload?.snapshot) {
        setSnapshot(ev.payload.snapshot);
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
        setSnapshot(ev.payload.snapshot);
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

  // SSE connection lifecycle. Wait until we have an identity (a guest's resolves
  // asynchronously) so the very first connection authenticates correctly.
  useEffect(() => {
    if (!roomId || !effectiveUserId) return;
    // A new room/identity means a fresh session — clear any prior removal flag.
    removedRef.current = false;

    let cancelled = false;

    const connect = () => {
      if (cancelled || removedRef.current) return;
      // Guests pass their identity in the query (SSE can't send a body).
      const g = guestRef.current;
      const params = new URLSearchParams({ roomId });
      if (g) {
        params.set("guestId", g.guestId);
        params.set("guestName", g.guestName);
      }
      const es = new EventSource(`/api/v2/watch2gether/stream?${params.toString()}`);
      esRef.current = es;

      es.onopen = () => {
        retryCountRef.current = 0;
        setIsConnected(true);
        setConnectionState("connected");
        join(); // (re)sync authoritative state on every (re)connect
      };
      es.onmessage = (msg) => {
        try {
          dispatch(JSON.parse(msg.data) as PartyEvent);
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        // EventSource auto-reconnects, but if it hard-closed we recreate it.
        // Escalate the quality signal: a brief drop is "reconnecting" (yellow),
        // but after a few failed attempts in a row we call it "poor" (red).
        setIsConnected(false);
        retryCountRef.current += 1;
        setConnectionState(retryCountRef.current >= 3 ? "poor" : "reconnecting");
        if (es.readyState === EventSource.CLOSED && !cancelled && !removedRef.current) {
          es.close();
          esRef.current = null;
          setTimeout(connect, 1500);
        }
      };
    };

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
    };
  }, [roomId, effectiveUserId, join, dispatch]);

  // Presence heartbeat + leave-on-unload.
  useEffect(() => {
    if (!roomId || !effectiveUserId) return;
    post("presence", { roomId });
    const iv = setInterval(() => post("presence", { roomId }), PRESENCE_INTERVAL_MS);

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
      clearInterval(iv);
      window.removeEventListener("pagehide", leave);
      // NOTE: we deliberately do NOT call leave() here. This cleanup also runs
      // on an in-app redirect that KEEPS us in the same party (e.g. a joiner
      // being navigated to the host's anime). Leaving on unmount raced with the
      // re-join on the new page and dropped the member from the room ("pas dans
      // le groupe"). Genuine departure (tab close, navigate away) is covered by
      // the `pagehide` beacon above; abandoning the party without it simply lets
      // our presence key lapse via its 30s TTL.
    };
  }, [roomId, effectiveUserId, post]);

  const inviteUrl =
    typeof window !== "undefined" && roomId
      ? `${window.location.origin}${window.location.pathname}?${withParty(window.location.search, roomId)}`
      : "";

  // Memoize the context so its identity only changes when something it carries
  // actually changes. Without this, a new object each render churns the player's
  // useMemo / sync effects (deps include `party`) and breaks live sync.
  const isHost = !!effectiveUserId && effectiveUserId === hostId;
  const amMuted =
    !!effectiveUserId && members.some((m) => m.userId === effectiveUserId && m.muted);
  const amPlaybackBlocked =
    !!effectiveUserId &&
    !isHost &&
    members.some((m) => m.userId === effectiveUserId && m.playbackBlocked);
  const locked = !!snapshot?.locked;

  const ctx = useMemo<PartyContext | null>(() => {
    if (!roomId) return null;
    return {
      roomId,
      myId: effectiveUserId,
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
      inviteUrl,
    };
  }, [
    roomId,
    effectiveUserId,
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
