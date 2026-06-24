import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { IoSend, IoCopyOutline, IoPeople, IoClose, IoExitOutline } from "react-icons/io5";
import { FaCrown } from "react-icons/fa";
import { MdPersonRemove, MdBlock } from "react-icons/md";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";
import MemberAvatar from "./MemberAvatar";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";

interface Props {
  party: PartyContext;
  onClose?: () => void;
}

export default function WatchPartyPanel({ party, onClose }: Props) {
  const { members, chat, sendChat, isConnected, inviteUrl, myId, roomId, isHost, leave, kick, ban } =
    party;
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
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

  const insertEmoji = (insert: string) => {
    setText((prev) => prev + insert);
    inputRef.current?.focus();
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
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg bg-secondary/40 text-white">
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
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        {members.length === 0 && (
          <span className="text-xs text-white/50">Waiting for participants…</span>
        )}
        {members.map((m) => {
          const canModerate = isHost && m.userId !== myId;
          return (
            <div key={m.userId} className="group relative flex flex-col items-center">
              <div className="relative">
                <MemberAvatar
                  name={m.name}
                  image={m.image}
                  size={28}
                  highlight={m.userId === myId}
                />
                {m.isHost && (
                  <FaCrown
                    className="absolute -right-1 -top-1.5 text-yellow-400"
                    size={12}
                    title="Host"
                  />
                )}
              </div>
              {canModerate && (
                <div className="pointer-events-none absolute -bottom-1 left-1/2 z-20 flex -translate-x-1/2 translate-y-full gap-1 rounded-md bg-black/90 p-1 opacity-0 shadow-lg transition group-hover:pointer-events-auto group-hover:opacity-100">
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
      <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-3 scrollbar-hide">
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
      <form onSubmit={submit} className="flex items-center gap-1 border-t border-white/10 p-3">
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
      </form>
    </div>
  );
}
