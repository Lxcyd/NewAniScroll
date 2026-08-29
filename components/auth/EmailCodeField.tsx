/**
 * "Send me a code" + the field to type it back.
 *
 * Used by the two actions that need proof of the mailbox on top of an open
 * session: changing the password, and deleting the account. Both sit in the
 * settings, so both get the same control rather than two spellings of it.
 *
 * The button carries the whole flow — asking, reporting where the mail went,
 * and its own cooldown — so the parent only has to read the code back.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notifications/noticeStore";

const RESEND_COOLDOWN_S = 45;

export default function EmailCodeField({
  action,
  value,
  onChange,
}: {
  action: "password" | "delete";
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const request = async () => {
    setSending(true);
    try {
      const res = await fetch("/api/v2/account/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        notify.error(t(`auth.errors.${data.error}`, t("auth.errors.generic")));
        return;
      }
      setSent(true);
      setCooldown(RESEND_COOLDOWN_S);
      notify.success(t("auth.code.sent", { email: data.email }));
    } catch {
      notify.error(t("auth.errors.generic"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          /* inputMode + pattern get the numeric keypad on a phone; autocomplete
             lets the browser offer the code straight from the mail. */
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={6}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
          placeholder={t("auth.code.placeholder")}
          className="w-full rounded-lg bg-white/5 ring-1 ring-white/10 px-3 py-2.5 text-sm tracking-[0.4em] text-center outline-none focus:ring-action/50"
        />
        <button
          type="button"
          disabled={sending || cooldown > 0}
          onClick={request}
          className="shrink-0 px-3 py-2.5 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15 disabled:opacity-50 whitespace-nowrap"
        >
          {cooldown > 0
            ? `${cooldown}s`
            : sent
            ? t("auth.code.resend")
            : t("auth.code.send")}
        </button>
      </div>
      <span className="text-xs text-white/40">
        {sent ? t("auth.code.check") : t("auth.code.hint")}
      </span>
    </div>
  );
}
