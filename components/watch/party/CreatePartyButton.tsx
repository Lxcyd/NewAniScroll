import React, { useState } from "react";
import { useRouter } from "next/router";
import { toast } from "sonner";
import { IoPeople, IoEnterOutline } from "react-icons/io5";
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

// Open to everyone: signed-in users are identified by their session, guests by
// a stable local identity. Creating a party copies the invite link to the
// clipboard; a 4-digit code can be typed in to join an existing room.
export default function CreatePartyButton({
  aniId,
  epiNumber,
  dub,
  server,
  getPosition,
  className = "",
}: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [code, setCode] = useState("");

  const enterRoom = async (roomId: string) => {
    await router.replace(
      { pathname: router.pathname, query: { ...router.query, party: roomId } },
      undefined,
      { shallow: true },
    );
  };

  const create = async () => {
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
          // Ignored server-side when a session exists.
          guestId: guest.guestId,
          guestName: guest.guestName,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.roomId) {
        toast.error(data?.error || "Couldn't create party");
        return;
      }

      // Copy the invite link automatically.
      const params = new URLSearchParams(window.location.search);
      params.set("party", data.roomId);
      const url = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
      try {
        await navigator.clipboard.writeText(url);
        toast.success(`Party ${data.roomId} created — invite link copied!`);
      } catch {
        toast.success(`Party created! Code: ${data.roomId}`);
      }

      await enterRoom(data.roomId);
    } catch {
      toast.error("Couldn't create party");
    } finally {
      setLoading(false);
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const roomId = code.trim();
    if (!/^\d{4}$/.test(roomId)) {
      toast.error("Enter the 4-digit room code");
      return;
    }
    // The room is keyed by the code itself; join validation happens in the hook.
    await enterRoom(roomId);
    setShowJoin(false);
    setCode("");
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={create}
        disabled={loading}
        className={`flex items-center gap-2 rounded-md bg-action/20 px-3 py-2 text-sm font-medium text-action transition hover:bg-action/30 disabled:opacity-50 ${className}`}
      >
        <IoPeople size={16} />
        {loading ? "Creating…" : "Watch together"}
      </button>

      {showJoin ? (
        <form onSubmit={join} className="flex items-center gap-1">
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="1234"
            className="w-16 rounded-md bg-white/10 px-2 py-2 text-center text-sm tracking-widest outline-none placeholder:text-white/30 focus:bg-white/15"
          />
          <button
            type="submit"
            className="flex h-9 items-center rounded-md bg-action px-2 text-sm font-medium text-white"
          >
            Join
          </button>
        </form>
      ) : (
        <button
          onClick={() => setShowJoin(true)}
          title="Join with a code"
          className="flex items-center gap-1 rounded-md px-2 py-2 text-sm font-medium text-white/70 ring-1 ring-white/20 transition hover:text-white"
        >
          <IoEnterOutline size={16} />
          <span className="hidden lg:block">Join code</span>
        </button>
      )}
    </div>
  );
}
