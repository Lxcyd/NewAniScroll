import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { IoSend, IoCopyOutline, IoPeople, IoClose } from "react-icons/io5";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";

interface Props {
  party: PartyContext;
  onClose?: () => void;
}

export default function WatchPartyPanel({ party, onClose }: Props) {
  const { members, chat, sendChat, isConnected, inviteUrl, myId, roomId } = party;
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll chat to the bottom on new messages.
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

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Invite link copied!");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      toast.success(`Code ${roomId} copied!`);
    } catch {
      toast.error("Couldn't copy code");
    }
  };

  return (
    <div className="flex h-full w-full flex-col rounded-lg bg-secondary/40 text-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <IoPeople className="text-action" size={18} />
          <span className="text-sm font-semibold">Watch Party</span>
          <button
            onClick={copyCode}
            title="Copy room code"
            className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs tracking-widest text-white/90 hover:bg-white/20"
          >
            {roomId}
          </button>
          <span
            className={`ml-1 inline-block h-2 w-2 rounded-full ${
              isConnected ? "bg-green-500" : "bg-yellow-500"
            }`}
            title={isConnected ? "Connected" : "Reconnecting…"}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyInvite}
            className="flex items-center gap-1 rounded-md bg-action/20 px-2 py-1 text-xs font-medium text-action hover:bg-action/30"
            title="Copy invite link"
          >
            <IoCopyOutline size={14} /> Invite
          </button>
          {onClose && (
            <button onClick={onClose} className="text-white/60 hover:text-white" title="Close">
              <IoClose size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Members */}
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        {members.length === 0 && (
          <span className="text-xs text-white/50">Waiting for participants…</span>
        )}
        {members.map((m) => (
          <div key={m.userId} className="flex items-center gap-1.5" title={m.name}>
            {m.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.image}
                alt={m.name}
                className={`h-6 w-6 rounded-full object-cover ring-1 ${
                  m.userId === myId ? "ring-action" : "ring-white/20"
                }`}
              />
            ) : (
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-action/40 text-[10px]">
                {m.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Chat log */}
      <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3 scrollbar-hide">
        {chat.length === 0 && (
          <p className="text-center text-xs text-white/40">No messages yet. Say hi 👋</p>
        )}
        {chat.map((msg) => (
          <div key={msg.id} className="flex items-start gap-2">
            {msg.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={msg.image} alt="" className="mt-0.5 h-5 w-5 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-action/40 text-[9px]">
                {msg.name.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <span
                className={`mr-1 text-xs font-semibold ${
                  msg.userId === myId ? "text-action" : "text-white/80"
                }`}
              >
                {msg.name}
              </span>
              <span className="break-words text-xs text-white/90">{msg.text}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Composer */}
      <form onSubmit={submit} className="flex items-center gap-2 border-t border-white/10 p-3">
        <input
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
      </form>
    </div>
  );
}
