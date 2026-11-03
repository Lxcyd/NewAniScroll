import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FRIENDS_ERROR_EVENT,
  friendAction,
  stateWith,
  watchFriends,
  type FriendError,
  type FriendState,
} from "@/lib/friends/client";

/** Le dernier refus du serveur (cf. friendAction), affiché 4 s. */
export function useFriendError(): string | null {
  const { t } = useTranslation();
  const [why, setWhy] = useState<FriendError | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => {
      setWhy((e as CustomEvent<FriendError>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setWhy(null), 4000);
    };
    window.addEventListener(FRIENDS_ERROR_EVENT, on);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(FRIENDS_ERROR_EVENT, on);
    };
  }, []);
  if (!why) return null;
  return t(why === "throttled" ? "profile.friends.errThrottled" : why === "full" ? "profile.friends.errFull" : "profile.friends.errFailed");
}

export function FriendErrorNote() {
  const msg = useFriendError();
  return msg ? (
    <p role="status" className="font-karla text-[12px] font-semibold text-amber-300/90">
      {msg}
    </p>
  ) : null;
}

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

  useEffect(() => {
    let alive = true;
    const load = () =>
      void stateWith(tag).then((s) => {
        if (alive) setState(s);
      });
    /* Relu au retour sur l'onglet du navigateur, sans sondage : ce bouton est
       sur CHAQUE profil visité, et un appel toutes les 30 s par visiteur
       connecté coûterait des invocations Vercel pour presque rien. */
    const stop = watchFriends(load, 0);
    return () => {
      alive = false;
      stop();
    };
  }, [tag]);

  if (!state || state === "self" || state === "guest") return null;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Buttons state={state} setState={setState} tag={tag} />
      <FriendErrorNote />
    </div>
  );
}

function Buttons({
  state,
  setState,
  tag,
}: {
  state: FriendState | "none";
  setState: (s: FriendState | "none") => void;
  tag: string;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  /* La confirmation se désarme seule : au doigt, pointerleave suit chaque
     tap et l'annulait aussitôt — « Retirer » était impossible sur mobile. */
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

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
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setArmed(false);
        }}
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
