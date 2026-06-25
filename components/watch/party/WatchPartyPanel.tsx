import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IoSend, IoCopyOutline, IoPeople, IoClose, IoExitOutline, IoAdd, IoEnterOutline } from "react-icons/io5";
import { FaCrown } from "react-icons/fa";
import { MdVolumeOff, MdLock, MdPublic } from "react-icons/md";
import type { PartyContext } from "@/lib/watch2gether/useWatchParty";
import { getGuestIdentity } from "@/lib/watch2gether/guest";
import MemberAvatar from "./MemberAvatar";
import MemberMenu from "./MemberMenu";
import ChatText from "./ChatText";
import ChatComposer, { type ChatComposerHandle } from "./ChatComposer";
import EmojiButton from "./EmojiButton";
import { replaceShortcodes } from "@/lib/watch2gether/animeEmojis";
import { isAnimeSticker } from "@/lib/watch2gether/animeStickers";

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
    <div className="flex h-full w-full flex-col rounded-lg bg-secondary/40 text-white">
      {party ? (
        // While the first join is resolving, show a spinner rather than the
        // (empty) room — so a banned / private rejection never flashes the room.
        party.joinPending ? (
          <JoinLoading onClose={onClose} />
        ) : (
          <ActiveRoom party={party} onClose={onClose} />
        )
      ) : (
        <Lobby lobby={lobby} onClose={onClose} />
      )}
    </div>
  );
}

function JoinLoading({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
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
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-action" />
      </div>
    </>
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

        {/* items-stretch so the Join button matches the input's full height. */}
        <form onSubmit={join} className="flex items-stretch gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="1234"
            className="w-full rounded-md bg-white/10 px-3 py-3 text-center text-lg tracking-[0.4em] outline-none placeholder:text-white/30 focus:bg-white/15"
          />
          <button
            type="submit"
            className="flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-4 text-sm font-medium hover:bg-white/20"
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
  // Cooldown after toggling the room lock so spamming the button can't outpace
  // the round-trip and leave local/server state flapping between Public/Private.
  const [lockBusy, setLockBusy] = useState(false);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [hasText, setHasText] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  const toggleLock = () => {
    if (lockBusy) return;
    setLockBusy(true);
    setFlags({ locked: !snapshot?.locked });
    window.setTimeout(() => setLockBusy(false), 700);
  };

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const send = (raw: string) => {
    const val = raw.trim();
    if (!val) return;
    if (amMuted) {
      toast.error(t("party.mutedBanner"));
      return;
    }
    sendChat(val);
    composerRef.current?.clear();
    setHasText(false);
  };

  const insertEmoji = (token: string) => {
    // Stickers stay as :shortcode: (composer renders the image inline); unicode-
    // backed emoji are converted to their char first.
    composerRef.current?.insert(isAnimeSticker(token) ? token : replaceShortcodes(token));
    setHasText(true);
    composerRef.current?.focus();
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
          {/* Host: Public (anyone can join) vs Private (locked). Sits left of
              the invite button. */}
          {isHost && (
            <button
              onClick={toggleLock}
              disabled={lockBusy}
              title={snapshot?.locked ? t("party.roomLockedHint") : t("party.roomOpenHint")}
              className={`flex items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs font-medium disabled:opacity-60 ${
                snapshot?.locked
                  ? "text-action hover:bg-[#E94560]/25"
                  : "text-white/70 hover:bg-white/20"
              }`}
            >
              {snapshot?.locked ? <MdLock size={14} /> : <MdPublic size={14} />}
              {snapshot?.locked ? t("party.roomPrivate") : t("party.roomPublic")}
            </button>
          )}
          <button
            onClick={() => copy(inviteUrl, t("party.inviteLink"))}
            className="flex items-center gap-1 rounded-md bg-transparent px-2 py-1 text-xs font-medium text-action hover:bg-[#E94560]/25"
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
          const isMe = m.userId === myId;
          return (
            <div key={m.userId} className="group relative flex flex-col items-center">
              {/* Custom tooltip ABOVE the avatar (native title shows below). High
                  z so it sits over every other panel element. */}
              <span className="pointer-events-none absolute -top-7 left-1/2 z-[100] hidden -translate-x-1/2 whitespace-nowrap rounded bg-black/90 px-2 py-1 text-[10px] font-medium text-white shadow-lg group-hover:block">
                {m.name}
              </span>
              {/* Host moderation menu — appears on HOVER, directly under the avatar. */}
              {canModerate && (
                <div className="absolute left-1/2 top-7 z-[90] hidden w-max min-w-[150px] -translate-x-1/2 pt-1 group-hover:block">
                  <MemberMenu
                    member={m}
                    transferHost={transferHost}
                    mute={mute}
                    blockPlayback={blockPlayback}
                    kick={kick}
                    ban={ban}
                  />
                </div>
              )}
              {/* Fixed-size avatar box so badges never shift alignment. The
                  current user's avatar gets a thin pink ring. An offline member
                  (phone asleep / tab backgrounded) is kept but dimmed — they
                  stay in the room until they leave/are removed. */}
              <div
                className={`relative h-7 w-7 transition-opacity ${
                  m.online === false ? "opacity-40" : ""
                }`}
                title={m.online === false ? t("party.offline") : undefined}
              >
                <MemberAvatar name={m.name} image={m.image} size={28} highlight={isMe} noTitle />
                {/* Crown bottom-right; mute badge also bottom-right (a muted
                    member is never the host, so they never collide). No badge
                    for playback-block (kept invisible by request). */}
                {m.isHost && (
                  <FaCrown
                    className="absolute -bottom-1 -right-1.5 text-yellow-400 drop-shadow"
                    size={11}
                  />
                )}
                {m.muted && !m.isHost && (
                  <MdVolumeOff
                    className="absolute -bottom-1 -right-1.5 rounded-full bg-black/70 text-red-300"
                    size={12}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Chat log — messages flow bottom→top; a scrollbar appears when full. */}
      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-thin scrollbar-thumb-white/15 scrollbar-thumb-rounded"
      >
        <div className="flex min-h-full flex-col justify-end space-y-2">
          {chat.length === 0 && (
            <p className="text-center text-sm text-white/40">{t("party.noMessages")}</p>
          )}
          {chat.map((msg) => (
            <div key={msg.id} className="flex items-center gap-2">
              <MemberAvatar name={msg.name} image={msg.image} size={28} className="shrink-0" />
              <div className="min-w-0">
                <span className="mr-1.5 text-sm font-semibold text-action">{msg.name}</span>
                <span className="break-words text-sm text-white/90">
                  <ChatText text={msg.text} size={20} />
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Composer. When muted by the host: input + send are disabled, a banner
          explains why, and clicking the area shows a toast. Typed `:pog:`
          shortcodes are converted to the actual emoji inline on change. */}
      <div className="border-t border-white/10">
        {amMuted && (
          <div className="flex items-center gap-1.5 px-3 pt-2 text-xs font-medium text-red-300">
            <MdVolumeOff size={14} /> {t("party.mutedBanner")}
          </div>
        )}
        <div className="relative">
          <div className="flex items-center gap-1 p-3">
            <EmojiButton onPick={insertEmoji} />
            <ChatComposer
              ref={composerRef}
              placeholder={amMuted ? t("party.muted") : t("party.message")}
              onSubmit={send}
              onChange={(v) => setHasText(!!v)}
              className={`flex-1 rounded-md bg-white/10 px-3 py-2 text-sm focus:bg-white/15 ${
                amMuted ? "pointer-events-none opacity-60" : ""
              }`}
            />
            {/* Always clickable: when empty it simply no-ops (send() ignores
                blank text). We only dim it visually when there's nothing to
                send — no `disabled` so the cursor stays normal, not "blocked". */}
            <button
              type="button"
              onClick={() => send(composerRef.current?.getText() || "")}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-action text-white transition-opacity ${
                hasText && !amMuted ? "" : "opacity-40"
              }`}
            >
              <IoSend size={16} />
            </button>
          </div>
          {/* When muted, a transparent overlay swallows clicks (disabled inputs
              don't fire events) and shows the "you are muted" toast. */}
          {amMuted && (
            <button
              type="button"
              aria-label={t("party.mutedBanner")}
              onClick={() => toast.error(t("party.mutedBanner"))}
              className="absolute inset-0 z-10 cursor-not-allowed bg-transparent"
            />
          )}
        </div>
      </div>
    </>
  );
}
