import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IoSend, IoCopyOutline, IoPeople, IoClose, IoExitOutline, IoAdd, IoEnterOutline } from "react-icons/io5";
import { FaCrown } from "react-icons/fa";
import { MdPersonRemove, MdBlock, MdVolumeOff, MdVolumeUp, MdLock, MdLockOpen, MdPlayDisabled, MdPlayArrow } from "react-icons/md";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";
import { getGuestIdentity } from "@/lib/watch2gether/guest";
import MemberAvatar from "./MemberAvatar";
import ChatText from "./ChatText";
import EmojiButton from "./EmojiButton";
import { ANIME_EMOJI_MAP, SHORTCODE_RE } from "@/lib/watch2gether/animeEmojis";

/** True when the draft contains at least one KNOWN `:shortcode:` that will be
 *  rendered as an inline emoji image — used to surface a live preview. */
function hasRenderableShortcode(text: string): boolean {
  return text.split(SHORTCODE_RE).some((part) => ANIME_EMOJI_MAP[part]);
}

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
  const { t } = useTranslation();
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
      toast.error(t("party.episodeNotReady"));
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
        toast.error(data?.error || t("party.cantCreate"));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.set("party", data.roomId);
      const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(t("party.createdCopied", { code: data.roomId }));
      } catch {
        toast.success(t("party.created", { code: data.roomId }));
      }
      enterRoom(data.roomId);
    } catch {
      toast.error(t("party.cantCreate"));
    } finally {
      setLoading(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = code.trim();
    if (!/^\d{4}$/.test(roomId)) {
      toast.error(t("party.enterCode"));
      return;
    }
    enterRoom(roomId);
  };

  return (
    <>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <IoPeople className="text-action" size={18} />
          <span className="text-sm font-semibold">{t("party.title")}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-white/60 hover:text-white" title={t("common.close")}>
            <IoClose size={18} />
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col justify-center gap-4 px-5">
        <p className="text-center text-sm text-white/60">{t("party.subtitle")}</p>

        <button
          onClick={create}
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-md bg-action px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <IoAdd size={18} />
          {loading ? t("party.creating") : t("party.create")}
        </button>

        <div className="flex items-center gap-2 text-xs text-white/40">
          <span className="h-px flex-1 bg-white/10" /> {t("party.orJoin")}{" "}
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
            <IoEnterOutline size={16} /> {t("party.join")}
          </button>
        </form>
      </div>
    </>
  );
}

// ── Active room: members + chat ─────────────────────────────────────────────
function ActiveRoom({ party, onClose }: { party: PartyContext; onClose?: () => void }) {
  const { t } = useTranslation();
  const {
    members,
    chat,
    sendChat,
    inviteUrl,
    myId,
    roomId,
    isHost,
    leave,
    kick,
    ban,
    mute,
    blockPlayback,
    transferHost,
    setFlags,
    snapshot,
    amMuted,
  } = party;
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
      toast.success(t("party.copied", { label }));
    } catch {
      toast.error(t("party.cantCopy"));
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <IoPeople className="text-action" size={18} />
          <span className="text-sm font-semibold">{t("party.title")}</span>
          <button
            onClick={() => copy(roomId, roomId)}
            title={t("party.copyRoomCode")}
            className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs tracking-widest text-white/90 hover:bg-white/20"
          >
            {roomId}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Host: lock the room to new joiners — sits left of the invite button. */}
          {isHost && (
            <button
              onClick={() => setFlags({ locked: !snapshot?.locked })}
              title={snapshot?.locked ? t("party.roomLockedHint") : t("party.roomOpenHint")}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${
                snapshot?.locked
                  ? "bg-action/20 text-action hover:bg-action/30"
                  : "bg-white/10 text-white/70 hover:bg-white/15"
              }`}
            >
              {snapshot?.locked ? <MdLock size={14} /> : <MdLockOpen size={14} />}
              {snapshot?.locked ? t("party.roomLocked") : t("party.roomOpen")}
            </button>
          )}
          <button
            onClick={() => copy(inviteUrl, t("party.inviteLink"))}
            className="flex items-center gap-1 rounded-md bg-action/20 px-2 py-1 text-xs font-medium text-action hover:bg-action/30"
            title={t("party.inviteLink")}
          >
            <IoCopyOutline size={14} /> {t("party.invite")}
          </button>
          <button
            onClick={leave}
            className="flex items-center gap-1 rounded-md bg-red-500/15 px-2 py-1 text-xs font-medium text-red-300 hover:bg-red-500/25"
            title={t("party.leaveParty")}
          >
            <IoExitOutline size={14} /> {t("party.leave")}
          </button>
          {onClose && (
            <button onClick={onClose} className="text-white/60 hover:text-white" title={t("party.hidePanel")}>
              <IoClose size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Members — rendered in join order (oldest first / leftmost). */}
      <div className="flex flex-wrap items-start gap-3 border-b border-white/10 px-4 py-3">
        {members.length === 0 && (
          <span className="text-xs text-white/50">{t("party.waiting")}</span>
        )}
        {members.map((m) => {
          const canModerate = isHost && m.userId !== myId;
          return (
            <div key={m.userId} className="group relative flex flex-col items-center">
              {/* Fixed-size avatar box so badges never shift alignment. */}
              <div className="relative h-7 w-7">
                <MemberAvatar name={m.name} image={m.image} size={28} highlight={m.userId === myId} />
                {/* Crown bottom-right; mute / playback badges stack on the left. */}
                {m.isHost && (
                  <FaCrown
                    className="absolute -bottom-1 -right-1.5 text-yellow-400 drop-shadow"
                    size={11}
                    title={t("party.host")}
                  />
                )}
                {m.muted && (
                  <MdVolumeOff
                    className="absolute -bottom-1 -left-1.5 rounded-full bg-black/70 text-red-300"
                    size={12}
                    title={t("party.mute")}
                  />
                )}
                {m.playbackBlocked && (
                  <MdPlayDisabled
                    className="absolute -top-1 -left-1.5 rounded-full bg-black/70 text-orange-300"
                    size={12}
                    title={t("party.blockPlayback")}
                  />
                )}
              </div>
              {canModerate && (
                <div className="absolute top-9 left-1/2 z-30 hidden w-max min-w-[150px] -translate-x-1/2 flex-col gap-0.5 rounded-md bg-black/90 p-1 shadow-lg group-hover:flex">
                  <button
                    onClick={() => transferHost(m.userId)}
                    title={t("party.makeHost")}
                    className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-yellow-300 hover:bg-yellow-400/15"
                  >
                    <FaCrown size={12} /> {t("party.makeHost")}
                  </button>
                  <button
                    onClick={() => mute(m.userId, !m.muted)}
                    title={m.muted ? t("party.unmute") : t("party.mute")}
                    className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    {m.muted ? <MdVolumeUp size={14} /> : <MdVolumeOff size={14} />}
                    {m.muted ? t("party.unmute") : t("party.mute")}
                  </button>
                  <button
                    onClick={() => blockPlayback(m.userId, !m.playbackBlocked)}
                    title={m.playbackBlocked ? t("party.unblockPlayback") : t("party.blockPlayback")}
                    className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    {m.playbackBlocked ? <MdPlayArrow size={14} /> : <MdPlayDisabled size={14} />}
                    {m.playbackBlocked ? t("party.unblockPlayback") : t("party.blockPlayback")}
                  </button>
                  <button
                    onClick={() => kick(m.userId)}
                    title={t("party.kick")}
                    className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-white/80 hover:bg-white/10 hover:text-white"
                  >
                    <MdPersonRemove size={14} /> {t("party.kick")}
                  </button>
                  <button
                    onClick={() => ban(m.userId)}
                    title={t("party.ban")}
                    className="flex items-center gap-2 whitespace-nowrap rounded px-2 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/20 hover:text-red-200"
                  >
                    <MdBlock size={14} /> {t("party.ban")}
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
          <p className="text-center text-xs text-white/40">{t("party.noMessages")}</p>
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

      {/* Composer (disabled while muted by the host) */}
      <div className="border-t border-white/10">
        {/* Live preview: shows `:pog:` etc. as the actual emoji before sending. */}
        {hasRenderableShortcode(text) && (
          <div className="flex items-center gap-1 px-3 pt-2 text-sm text-white/90">
            <ChatText text={text} />
          </div>
        )}
        <form onSubmit={submit} className="flex items-center gap-1 p-3">
          <EmojiButton onPick={insertEmoji} />
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
            disabled={amMuted}
            placeholder={amMuted ? t("party.muted") : t("party.message")}
            className="flex-1 rounded-md bg-white/10 px-3 py-2 text-sm outline-none placeholder:text-white/40 focus:bg-white/15 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={amMuted || !text.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-md bg-action text-white disabled:opacity-40"
          >
            <IoSend size={16} />
          </button>
        </form>
      </div>
    </>
  );
}
