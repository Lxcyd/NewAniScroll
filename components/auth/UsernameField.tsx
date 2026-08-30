/**
 * Username input.
 *
 * It used to ask the server, on every keystroke, whether the pseudo was free.
 * Pseudos are not unique any more — the tag is what makes an identity unique,
 * so two accounts may both be "Lucyd" — which means there is nothing to ask:
 * only the shape can be wrong, and lib/auth/username is the very module the
 * server validates with. One import instead of a debounced request per
 * keystroke, and the endpoint that let anyone enumerate existing pseudos is
 * gone with it.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { validateUsername } from "@/lib/auth/username";

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
  const name = value.trim();
  const code = name ? validateUsername(name) : "empty";

  useEffect(() => {
    onValidity?.(!code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

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
      {/* Nothing is said while the field is empty — an error before the first
          keystroke reads as a reproach. */}
      <span className="block mt-1.5 text-xs min-h-[1rem]">
        {code && code !== "empty" && (
          <span className="text-red-400">{t(`auth.username.${code}`)}</span>
        )}
      </span>
    </label>
  );
}
