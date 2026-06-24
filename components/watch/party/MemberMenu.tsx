import React from "react";
import { useTranslation } from "react-i18next";
import { FaCrown } from "react-icons/fa";
import { MdPersonRemove, MdBlock, MdVolumeOff, MdVolumeUp, MdPlayDisabled, MdPlayArrow } from "react-icons/md";
import type { Member } from "@/lib/watch2gether/types";

interface Props {
  member: Member;
  transferHost: (userId: string) => void;
  mute: (userId: string, muted: boolean) => void;
  blockPlayback: (userId: string, blocked: boolean) => void;
  kick: (userId: string) => void;
  ban: (userId: string) => void;
}

// Host moderation menu — rendered inline beneath the avatar (revealed on hover
// by the parent). Each row has the same hover background animation.
export default function MemberMenu({ member, transferHost, mute, blockPlayback, kick, ban }: Props) {
  const { t } = useTranslation();

  const itemCls =
    "flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-xs font-medium transition-colors";

  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-white/10 bg-black/95 p-1 shadow-xl">
      <button
        onClick={() => transferHost(member.userId)}
        className={`${itemCls} text-yellow-300 hover:bg-white/10`}
      >
        <FaCrown size={13} /> {t("party.makeHost")}
      </button>
      <button
        onClick={() => mute(member.userId, !member.muted)}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        {member.muted ? <MdVolumeUp size={15} /> : <MdVolumeOff size={15} />}
        {member.muted ? t("party.unmute") : t("party.mute")}
      </button>
      <button
        onClick={() => blockPlayback(member.userId, !member.playbackBlocked)}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        {member.playbackBlocked ? <MdPlayArrow size={15} /> : <MdPlayDisabled size={15} />}
        {member.playbackBlocked ? t("party.unblockPlayback") : t("party.blockPlayback")}
      </button>
      <button
        onClick={() => kick(member.userId)}
        className={`${itemCls} text-white/85 hover:bg-white/10 hover:text-white`}
      >
        <MdPersonRemove size={15} /> {t("party.kick")}
      </button>
      <button
        onClick={() => ban(member.userId)}
        className={`${itemCls} text-red-300 hover:bg-red-500/20 hover:text-red-200`}
      >
        <MdBlock size={15} /> {t("party.ban")}
      </button>
    </div>
  );
}
