/**
 * Password input with a reveal toggle.
 *
 * One component rather than an eye pasted into each form: the sign-in, the
 * signup, the password change and the reset page all need it, and a toggle
 * that behaves differently in one of them is worse than none.
 *
 * The button is `tabIndex={-1}` on purpose — tabbing from the field must reach
 * the submit button, not a decoration. It carries an aria-label so it is still
 * reachable to a screen reader, and `aria-pressed` says which state it is in.
 */

import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "react-i18next";

export default function PasswordField({
  value,
  onChange,
  label,
  placeholder,
  hint,
  autoComplete = "current-password",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Rendered above the field. Omit inside a form that already labels it. */
  label?: string;
  placeholder?: string;
  hint?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);

  return (
    <label className="block">
      {label && (
        <span className="block text-sm text-white/70 mb-1.5">{label}</span>
      )}
      <span className="relative block">
        <input
          type={shown ? "text" : "password"}
          value={value}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          /* pr-11 keeps the text clear of the button. */
          className="w-full rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2.5 pr-11 text-sm outline-none focus:ring-action/50"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-pressed={shown}
          aria-label={shown ? t("auth.hidePassword") : t("auth.showPassword")}
          title={shown ? t("auth.hidePassword") : t("auth.showPassword")}
          onClick={() => setShown((v) => !v)}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center text-white/40 hover:text-white/80"
        >
          {shown ? (
            <EyeSlashIcon className="w-5 h-5" />
          ) : (
            <EyeIcon className="w-5 h-5" />
          )}
        </button>
      </span>
      {hint && <span className="block mt-1.5 text-xs text-white/40">{hint}</span>}
    </label>
  );
}
