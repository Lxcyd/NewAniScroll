import React, { useState } from "react";
import { useRouter } from "next/router";
import { Popover } from "@headlessui/react";
import { toast } from "sonner";
import { IoPeople, IoAdd, IoEnterOutline } from "react-icons/io5";
import { getGuestIdentity } from "@/lib/watch2gether/guest";

interface Props {
  aniId: string | number;
  epiNumber: string | number;
  dub?: boolean;
  server?: string;
  /** Current playback position in seconds, so the room seeds at the right time. */
  getPosition?: () => number;
  className?: string;
}

// "Watch together" entry point. Opens a small menu with two actions: create a
// new party (copies the invite link automatically) or join an existing one with
// a 4-digit code. Pasting an invite link still auto-joins via the page's
// ?party handling. Open to everyone (guests get a stable local identity).
export default function PartyMenuButton({
  aniId,
  epiNumber,
  dub,
  server,
  getPosition,
  className = "",
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState("");

  const enterRoom = async (roomId: string) => {
    await router.replace(
      { pathname: router.pathname, query: { ...router.query, party: roomId } },
      undefined,
      { shallow: true },
    );
  };

  const create = async (close: () => void) => {
    setLoading(true);
    try {
      const guest = getGuestIdentity();
      const res = await fetch("/api/v2/watch2gether/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aniId: String(aniId),
          epiNumber: String(epiNumber),
          dub: !!dub,
          server: server || "",
          position: getPosition?.() || 0,
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
      close();
      await enterRoom(data.roomId);
    } catch {
      toast.error("Couldn't create party");
    } finally {
      setLoading(false);
    }
  };

  const join = async (e: React.FormEvent, close: () => void) => {
    e.preventDefault();
    const roomId = code.trim();
    if (!/^\d{4}$/.test(roomId)) {
      toast.error("Enter the 4-digit room code");
      return;
    }
    close();
    setCode("");
    await enterRoom(roomId);
  };

  return (
    <Popover className="relative">
      <Popover.Button
        className={`flex items-center gap-2 rounded-md bg-action/20 px-3 py-2 text-sm font-medium text-action transition hover:bg-action/30 ${className}`}
      >
        <IoPeople size={16} />
        <span className="hidden lg:block">Watch together</span>
      </Popover.Button>

      <Popover.Panel className="absolute right-0 z-50 mt-2 w-64 rounded-lg border border-white/10 bg-secondary p-3 text-white shadow-xl">
        {({ close }) => (
          <div className="flex flex-col gap-3">
            <button
              onClick={() => create(close)}
              disabled={loading}
              className="flex items-center gap-2 rounded-md bg-action px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              <IoAdd size={18} />
              {loading ? "Creating…" : "Create a party"}
            </button>

            <div className="flex items-center gap-2 text-xs text-white/40">
              <span className="h-px flex-1 bg-white/10" />
              or join
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <form onSubmit={(e) => join(e, close)} className="flex items-center gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                inputMode="numeric"
                placeholder="1234"
                className="w-full rounded-md bg-white/10 px-3 py-2 text-center text-sm tracking-[0.3em] outline-none placeholder:text-white/30 focus:bg-white/15"
              />
              <button
                type="submit"
                className="flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-3 py-2 text-sm font-medium hover:bg-white/20"
              >
                <IoEnterOutline size={16} /> Join
              </button>
            </form>
          </div>
        )}
      </Popover.Panel>
    </Popover>
  );
}
