import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FRIENDS_EVENT, friendAction, stateWith, type FriendState } from "@/lib/friends/client";

/**
 * Le bouton d'ami sur le profil d'un autre (03/11/2026, Luc), à la place du
 * « Pour toi » du propriétaire. Absent pour un invité (pas de compte, pas
 * d'amis) et sur un profil sans compte AniScroll (pas de tag).
 *
 *   rien       → « Ajouter en ami »
 *   envoyée    → « Demande envoyée » (un clic l'annule)
 *   reçue      → « Accepter » et « Refuser »
 *   amis       → « Amis » (au survol : « Retirer », un clic le fait)
 */
export default function FriendButton({ tag }: { tag: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<FriendState | "none" | "self" | "guest" | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void stateWith(tag).then((s) => {
        if (alive) setState(s);
      });
    load();
    window.addEventListener(FRIENDS_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FRIENDS_EVENT, load);
    };
  }, [tag]);

  if (!state || state === "self" || state === "guest") return null;

  const run = async (action: "request" | "accept" | "remove") => {
    setBusy(true);
    const next = await friendAction(tag, action);
    if (next) setState(next);
    setBusy(false);
    setArmed(false);
  };

  const base =
    "inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-karla text-sm font-bold transition-[transform,background-color,color] disabled:opacity-60";
  const primary = `${base} bg-action text-white shadow-glow hover:scale-105`;
  const quiet = `${base} bg-white/[0.08] text-white/85 ring-1 ring-white/15 hover:bg-white/[0.14] hover:text-white`;

  if (state === "in")
    return (
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => run("accept")} className={primary}>
          <PersonIcon plus />
          {t("profile.friends.acceptFrom")}
        </button>
        <button type="button" disabled={busy} onClick={() => run("remove")} className={quiet}>
          {t("profile.friends.decline")}
        </button>
      </div>
    );

  if (state === "out")
    return (
      <button type="button" disabled={busy} onClick={() => run("remove")} className={`group ${quiet}`}>
        <PersonIcon />
        <span className="group-hover:hidden">{t("profile.friends.sent")}</span>
        <span className="hidden group-hover:inline">{t("profile.friends.cancel")}</span>
      </button>
    );

  if (state === "friend")
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => (armed ? run("remove") : setArmed(true))}
        onPointerLeave={() => setArmed(false)}
        className={quiet}
      >
        <PersonIcon check />
        {armed ? t("profile.friends.confirmRemove") : t("profile.friends.isFriend")}
      </button>
    );

  return (
    <button type="button" disabled={busy} onClick={() => run("request")} className={primary}>
      <PersonIcon plus />
      {t("profile.friends.request")}
    </button>
  );
}

function PersonIcon({ plus = false, check = false }: { plus?: boolean; check?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0" />
      {plus ? <path d="M19 8v6M16 11h6" /> : null}
      {check ? <path d="m16 11 2 2 4-4" /> : null}
    </svg>
  );
}
