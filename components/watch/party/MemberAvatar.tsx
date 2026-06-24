import React from "react";
import { UserIcon } from "@heroicons/react/24/solid";

interface Props {
  name: string;
  image?: string;
  /** Avatar diameter in px. */
  size?: number;
  /** Highlight ring (e.g. for the current user). */
  highlight?: boolean;
  className?: string;
}

// Shared avatar. Falls back to the same default user icon the navbar uses for
// signed-out visitors (Heroicons UserIcon on a translucent circle).
export default function MemberAvatar({ name, image, size = 24, highlight, className = "" }: Props) {
  const ring = highlight ? "ring-action" : "ring-white/20";
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt={name}
        title={name}
        className={`rounded-full object-cover ring-1 ${ring} ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      title={name}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/30 ring-1 ${ring} ${className}`}
      style={{ width: size, height: size }}
    >
      <UserIcon className="h-full w-full translate-y-[2px] text-white/90" />
    </span>
  );
}
