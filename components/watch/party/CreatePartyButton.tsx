import React, { useState } from "react";
import { useRouter } from "next/router";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { IoPeople } from "react-icons/io5";

interface Props {
  aniId: string | number;
  epiNumber: string | number;
  dub?: boolean;
  server?: string;
  /** Current playback position in seconds, so the room seeds at the right time. */
  getPosition?: () => number;
  className?: string;
}

export default function CreatePartyButton({
  aniId,
  epiNumber,
  dub,
  server,
  getPosition,
  className = "",
}: Props) {
  const router = useRouter();
  const { data: session } = useSession();
  const [loading, setLoading] = useState(false);

  const create = async () => {
    if (!session?.user) {
      toast.error("Sign in to start a watch party");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/v2/watch2gether/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aniId: String(aniId),
          epiNumber: String(epiNumber),
          dub: !!dub,
          server: server || "",
          position: getPosition?.() || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.roomId) {
        toast.error(data?.error || "Couldn't create party");
        return;
      }
      // Add ?party to the current route, preserving existing query params.
      const query = { ...router.query, party: data.roomId };
      await router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
      toast.success("Watch party started — share the invite link!");
    } catch {
      toast.error("Couldn't create party");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={create}
      disabled={loading}
      className={`flex items-center gap-2 rounded-md bg-action/20 px-3 py-2 text-sm font-medium text-action transition hover:bg-action/30 disabled:opacity-50 ${className}`}
    >
      <IoPeople size={16} />
      {loading ? "Creating…" : "Watch together"}
    </button>
  );
}
