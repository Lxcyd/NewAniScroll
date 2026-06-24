// useWatchParty — client orchestrator for the Watch 2gether feature.
//
// Transport: SSE (server -> client) via EventSource + HTTP POST (client ->
// server). Everyone can control playback; conflicts are mitigated with
// echo-suppression (drop own events) and an `applyingRemote` guard owned by
// the player integration.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  Member,
  PartyEvent,
  PartyEventType,
  RoomSnapshot,
} from "./redisRoom";

const PRESENCE_INTERVAL_MS = 15_000;

export interface PartyContext {
  roomId: string;
  myId: string | null;
  isConnected: boolean;
  members: Member[];
  chat: ChatMessage[];
  snapshot: RoomSnapshot | null;
  /** Set by the player while it applies a remote action, to suppress re-broadcast. */
  applyingRemoteRef: React.MutableRefObject<boolean>;
  /** Register a handler for inbound remote playback/episode events. */
  onRemote: (handler: (e: PartyEvent) => void) => () => void;
  broadcast: (type: PartyEventType, payload?: any) => void;
  sendChat: (text: string) => void;
  inviteUrl: string;
}

interface InitMeta {
  aniId: string | number;
  epiNumber: string | number;
  dub: boolean;
  server?: string;
}

export function useWatchParty(
  roomId: string | null,
  meta: InitMeta,
  myUserId: string | null,
): PartyContext | null {
  const [isConnected, setIsConnected] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);

  const applyingRemoteRef = useRef(false);
  const remoteHandlers = useRef<Set<(e: PartyEvent) => void>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const myIdRef = useRef<string | null>(myUserId);
  myIdRef.current = myUserId;

  const onRemote = useCallback((handler: (e: PartyEvent) => void) => {
    remoteHandlers.current.add(handler);
    return () => {
      remoteHandlers.current.delete(handler);
    };
  }, []);

  const post = useCallback(async (path: string, body: any) => {
    try {
      const res = await fetch(`/api/v2/watch2gether/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  // Join (and re-join on reconnect): pulls authoritative snapshot + history.
  const join = useCallback(async () => {
    if (!roomId) return;
    const data = await post("join", { roomId });
    if (!data) return;
    if (data.snapshot) setSnapshot(data.snapshot);
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
      return;
    }
    if (ev.type === "snapshot") {
      if (ev.payload?.snapshot) setSnapshot(ev.payload.snapshot);
      if (Array.isArray(ev.payload?.members)) setMembers(ev.payload.members);
      remoteHandlers.current.forEach((h) => h(ev));
      return;
    }

    // Playback / episode events: drop our own echoes.
    if (myId && ev.senderId === myId) return;
    remoteHandlers.current.forEach((h) => h(ev));
  }, []);

  // SSE connection lifecycle.
  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      const es = new EventSource(`/api/v2/watch2gether/stream?roomId=${encodeURIComponent(roomId)}`);
      esRef.current = es;

      es.onopen = () => {
        setIsConnected(true);
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
        setIsConnected(false);
        if (es.readyState === EventSource.CLOSED && !cancelled) {
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
  }, [roomId, join, dispatch]);

  // Presence heartbeat + leave-on-unload.
  useEffect(() => {
    if (!roomId) return;
    post("presence", { roomId });
    const iv = setInterval(() => post("presence", { roomId }), PRESENCE_INTERVAL_MS);

    const leave = () => {
      try {
        const blob = new Blob([JSON.stringify({ roomId })], { type: "application/json" });
        navigator.sendBeacon?.("/api/v2/watch2gether/leave", blob);
      } catch {
        /* noop */
      }
    };
    window.addEventListener("pagehide", leave);

    return () => {
      clearInterval(iv);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [roomId, post]);

  if (!roomId) return null;

  const inviteUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${window.location.pathname}?${withParty(window.location.search, roomId)}`
      : "";

  return {
    roomId,
    myId: myUserId,
    isConnected,
    members,
    chat,
    snapshot,
    applyingRemoteRef,
    onRemote,
    broadcast,
    sendChat,
    inviteUrl,
  };
}

// Merge ?party into an existing query string without clobbering other params.
function withParty(search: string, roomId: string): string {
  const params = new URLSearchParams(search);
  params.set("party", roomId);
  return params.toString();
}
