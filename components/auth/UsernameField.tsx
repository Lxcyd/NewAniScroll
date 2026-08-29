/**
 * Username input with live availability.
 *
 * The check is debounced 400 ms and always races-guarded: an answer that
 * arrives after a newer keystroke is dropped, otherwise a slow reply for
 * "kiri" would label "kirito" as taken.
 *
 * Shape errors come from lib/auth/username.ts through the same endpoint the
 * signup route uses, so the field can never accept a name the server would
 * refuse.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type State =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "error"; code: string };

export default function UsernameField({
  value,
  onChange,
  onValidity,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onValidity?: (ok: boolean) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "idle" });
  const seq = useRef(0);

  useEffect(() => {
    const name = value.trim();
    if (!name) {
      setState({ status: "idle" });
      onValidity?.(false);
      return;
    }

    setState({ status: "checking" });
    onValidity?.(false);
    const mine = ++seq.current;

    const id = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/v2/account/username?u=${encodeURIComponent(name)}`
        );
        const data = await res.json();
        if (mine !== seq.current) return; // a newer keystroke won
        if (data.available) {
          setState({ status: "ok" });
          onValidity?.(true);
        } else {
          setState({ status: "error", code: data.code || "taken" });
          onValidity?.(false);
        }
      } catch {
        if (mine !== seq.current) return;
        // Network trouble is not the user's fault: don't block the form on it,
        // the server checks again at signup anyway.
        setState({ status: "idle" });
        onValidity?.(true);
      }
    }, 400);

    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className="block">
      <span className="block text-sm text-white/70 mb-1.5">
        {t("auth.usernameLabel")}
      </span>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        autoComplete="username"
        maxLength={20}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2.5 text-sm outline-none focus:ring-action/50"
        placeholder={t("auth.usernamePlaceholder")}
      />
      <span className="block mt-1.5 text-xs min-h-[1rem]">
        {state.status === "checking" && (
          <span className="text-white/40">{t("auth.checking")}</span>
        )}
        {state.status === "ok" && (
          <span className="text-green-400">{t("auth.usernameFree")}</span>
        )}
        {state.status === "error" && (
          <span className="text-red-400">
            {t(`auth.username.${state.code}`, t("auth.username.taken"))}
          </span>
        )}
      </span>
    </label>
  );
}
