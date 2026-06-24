import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { toast } from "sonner";
import { IoSend, IoCopyOutline, IoPeople, IoClose, IoExitOutline, IoAdd, IoEnterOutline } from "react-icons/io5";
import { FaCrown } from "react-icons/fa";
import { MdPersonRemove, MdBlock } from "react-icons/md";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";
import { getGuestIdentity } from "@/lib/watch2gether/guest";
import MemberAvatar from "./MemberAvatar";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";

interface LobbyMeta {
  aniId?: string | number;
  epiNumber?: string | number;
  dub?: boolean;
  server?: string;
}

interface Props {
  /** Active room context, or null when showing the lobby (Create / Join). */
  party: PartyContext | null;
  /** Metadata used to seed a newly-created room (lobby mode). */
  lobby?: LobbyMeta;
  onClose?: () => void;
}

export default function WatchPartyPanel({ party, lobby, onClose }: Props) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg bg-secondary/40 text-white">
      {party ? (
        <ActiveRoom party={party} onClose={onClose} />
      ) : (
        <Lobby lobby={lobby} onClose={onClose} />
      )}
    </div>
  );
}

// ── Lobby (not yet in a room): create or join by code ───────────────────────
function Lobby({ lobby, onClose }: { lobby?: LobbyMeta; onClose?: () => void }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");

  const enterRoom = (roomId: string) =>
    router.replace(
      { pathname: router.pathname, query: { ...router.query, party: roomId } },
      undefined,
      { shallow: true },
    );

  const create = async () => {
    if (!lobby?.aniId || !lobby?.epiNumber) {
      toast.error("Episode not ready yet");
      return;
    }
    setLoading(true);
    try {
      const guest = getGuestIdentity();
      const res = await fetch("/api/v2/watch2gether/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aniId: String(lobby.aniId),
          epiNumber: String(lobby.epiNumber),
          dub: !!lobby.dub,
          server: lobby.server || "",
          guestId: guest.guestId,
          guestName: guest.guestName,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.roomId) {
        toast.error(data?.error || "Couldn't create party");
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.set("party", data.roomId);
      const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(`Party ${data.roomId} created — invite link copied!`);
      } catch {
        toast.success(`Party created! Code: ${data.roomId}`);
      }
      enterRoom(data.roomId);
    } catch {
      toast.error("Couldn't create party");
    } finally {
      setLoading(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = code.trim();
    if (!/^\d{4}$/.test(roomId)) {
      toast.error("Enter the 4-digit room code");
      return;
    }
    enterRoom(roomId);
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <IoPeople className="text-action" size={18} />
          <span className="text-sm font-semibold">Watch Party</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-white/60 hover:text-white" title="Close">
            <IoClose size={18} />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-center gap-4 px-5">
        <p className="text-center text-sm text-white/60">
          Watch this episode in sync with friends — chat, react and control playback together.
        </p>

        <button
          onClick={create}
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-md bg-action px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <IoAdd size={18} />
          {loading ? "Creating…" : "Create a party"}
        </button>

        <div className="flex items-center gap-2 text-xs text-white/40">
          <span className="h-px flex-1 bg-white/10" /> or join with a code{" "}
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <form onSubmit={join} className="flex items-center gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="1234"
            className="w-full rounded-md bg-white/10 px-3 py-3 text-center text-lg tracking-[0.4em] outline-none placeholder:text-white/30 focus:bg-white/15"
          />
          <button
            type="submit"
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-4 py-3 text-sm font-medium hover:bg-white/20"
          >
            <IoEnterOutline size={16} /> Join
          </button>
        </form>
      </div>
    </>
  );
}

// ── Active room: members + chat ─────────────────────────────────────────────
function ActiveRoom({ party, onClose }: { party: PartyContext; onClose?: () => void }) {
  const { members, chat, sendChat, connectionState, inviteUrl, myId, roomId, isHost, leave, kick, ban } =
    party;

  // Connection-quality dot: green = connected, yellow = reconnecting, red = poor.
  const conn = {
    connected: { color: "#22c55e", label: "Connected" },
    reconnecting: { color: "#eab308", label: "Reconnecting…" },
    poor: { color: "#ef4444", label: "Connection lost — retrying" },
  }[connectionState];
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sendChat(t);
    setText("");
  };

  const insertEmoji = (insert: string) => {
    setText((prev) => prev + insert);
    inputRef.current?.focus();
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied!`);
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <IoPeople className="text-action" size={18} />
          <span className="text-sm font-semibold">Watch Party</span>
          <button
            onClick={() => copy(roomId, `Code ${roomId}`)}
            title="Copy room code"
            className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs tracking-widest text-white/90 hover:bg-white/20"
          >
            {roomId}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => copy(inviteUrl, "Invite link")}
            className="flex items-center gap-1 rounded-md bg-action/20 px-2 py-1 text-xs font-medium text-action hover:bg-action/30"
            title="Copy invite link"
          >
            <IoCopyOutline size={14} /> Invite
          </button>
          <button
            onClick={leave}
            className="flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-xs font-medium text-red-300 hover:bg-red-500/25"
            title="Leave party"
          >
            <IoExitOutline size={14} /> Leave
          </button>
          {onClose && (
            <button onClick={onClose} className="text-white/60 hover:text-white" title="Hide panel">
              <IoClose size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Members */}
      <div className="flex flex-wrap items-start gap-3 border-b border-white/10 px-4 py-3">
        {members.length === 0 && (
          <span className="text-xs text-white/50">Waiting for participants…</span>
        )}
        {members.map((m) => {
          const canModerate = isHost && m.userId !== myId;
          return (
            <div key={m.userId} className="group relative flex flex-col items-center">
              {/* Fixed-size avatar box so the crown never shifts alignment. */}
              <div className="relative h-7 w-7">
                <MemberAvatar name={m.name} image={m.image} size={28} highlight={m.userId === myId} />
                {m.isHost && (
                  <FaCrown
                    className="absolute -left-1.5 -top-1.5 -rotate-[25deg] text-yellow-400 drop-shadow"
                    size={11}
                    title="Host"
                  />
                )}
              </div>
              {canModerate && (
                <div className="absolute -bottom-7 left-1/2 z-30 hidden -translate-x-1/2 gap-1 rounded-md bg-black/90 p-1 shadow-lg group-hover:flex">
                  <button
                    onClick={() => kick(m.userId)}
                    title={`Kick ${m.name}`}
                    className="flex items-center rounded p-1 text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    <MdPersonRemove size={14} />
                  </button>
                  <button
                    onClick={() => ban(m.userId)}
                    title={`Ban ${m.name}`}
                    className="flex items-center rounded p-1 text-red-300 hover:bg-red-500/20 hover:text-red-200"
                  >
                    <MdBlock size={14} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Chat log */}
      <div ref={logRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 scrollbar-hide">
        {chat.length === 0 && (
          <p className="text-center text-xs text-white/40">No messages yet. Say hi 👋</p>
        )}
        {chat.map((msg) => (
          <div key={msg.id} className="flex items-start gap-2">
            <MemberAvatar name={msg.name} image={msg.image} size={20} className="mt-0.5" />
            <div className="min-w-0">
              <span
                className={`mr-1 text-xs font-semibold ${
                  msg.userId === myId ? "text-action" : "text-white/80"
                }`}
              >
                {msg.name}
              </span>
              <span className="break-words text-xs text-white/90">
                <ChatText text={msg.text} />
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={submit} className="relative flex items-center gap-1 border-t border-white/10 p-3">
        <EmojiButton onPick={insertEmoji} />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Message…"
          className="flex-1 rounded-md bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/40 focus:bg-white/15"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="flex h-9 w-9 items-center justify-center rounded-md bg-action text-white disabled:opacity-40"
        >
          <IoSend size={16} />
        </button>
        {/* Connection-quality dot, bottom-right. */}
        <span
          className="pointer-events-none absolute bottom-1 right-1 h-2 w-2 rounded-full ring-2 ring-secondary/40"
          style={{
            background: conn.color,
            boxShadow: `0 0 6px ${conn.color}`,
          }}
          title={conn.label}
        />
      </form>
    </>
  );
}
