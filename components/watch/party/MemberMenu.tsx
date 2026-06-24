import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FaCrown } from "react-icons/fa";
import { MdPersonRemove, MdBlock, MdVolumeOff, MdVolumeUp, MdPlayDisabled, MdPlayArrow } from "react-icons/md";
import type { Member } from "@/lib/watch2gether/types";

interface Props {
  member: Member;
  /** The avatar element this menu anchors to. */
  anchor: HTMLElement | null;
  onClose: () => void;
  transferHost: (userId: string) => void;
  mute: (userId: string, muted: boolean) => void;
  blockPlayback: (userId: string, blocked: boolean) => void;
  kick: (userId: string) => void;
  ban: (userId: string) => void;
}

const MENU_W = 180;

// Moderation menu rendered in a body PORTAL so it escapes the party panel's
// `overflow-hidden` clip and can sit ABOVE the panel frame, centred over the
// avatar. Portalling also removes the hover-gap problem (it's click-driven).
export default function MemberMenu({
  member,
  anchor,
  onClose,
  transferHost,
  mute,
  blockPlayback,
  kick,
  ban,
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position centred over the avatar; open UPWARD so it overflows above the
  // panel. Clamp horizontally to the viewport.
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = menuRef.current?.offsetHeight || 0;
    let left = r.left + r.width / 2 - MENU_W / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - MENU_W - 8));
    const top = Math.max(8, r.top - h - 8);
    setPos({ top, left });
  }, [anchor]);

  // Close on outside click / Escape / scroll.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose]);

  if (typeof document === "undefined") return null;

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const itemCls =
    "flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-xs font-medium";

  return createPortal(
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: MENU_W,
        zIndex: 2147483000,
        opacity: pos ? 1 : 0,
      }}
      className="flex flex-col gap-0.5 rounded-md border border-white/10 bg-black/95 p-1 shadow-xl"
    >
      <div className="truncate border-b border-white/10 px-2 pb-1.5 pt-0.5 text-[11px] font-semibold text-white/60">
        {member.name}
      </div>
      <button onClick={act(() => transferHost(member.userId))} className={`${itemCls} text-yellow-300 hover:bg-yellow-400/15`}>
        <FaCrown size={13} /> {t("party.makeHost")}
      </button>
      <button
        onClick={act(() => mute(member.userId, !member.muted))}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        {member.muted ? <MdVolumeUp size={15} /> : <MdVolumeOff size={15} />}
        {member.muted ? t("party.unmute") : t("party.mute")}
      </button>
      <button
        onClick={act(() => blockPlayback(member.userId, !member.playbackBlocked))}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        {member.playbackBlocked ? <MdPlayArrow size={15} /> : <MdPlayDisabled size={15} />}
        {member.playbackBlocked ? t("party.unblockPlayback") : t("party.blockPlayback")}
      </button>
      <button
        onClick={act(() => kick(member.userId))}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        <MdPersonRemove size={15} /> {t("party.kick")}
      </button>
      <button onClick={act(() => ban(member.userId))} className={`${itemCls} text-red-300 hover:bg-red-500/20 hover:text-red-200`}>
        <MdBlock size={15} /> {t("party.ban")}
      </button>
    </div>,
    document.body,
  );
}
