import { useEffect, useState } from "react";
import { getLang, setLang, Lang, LANG_EVENT } from "@/lib/i18n/languagePref";

/**
 * Compact EN | FR switch for the navbar dropdown. Reads the live language
 * from languagePref (browser-detected or user-chosen) and writes the user's
 * explicit choice, which then takes priority over auto-detection everywhere.
 *
 * Renders nothing until mounted to avoid an SSR/CSR mismatch — the server
 * always assumes the default locale, the client knows the real one only
 * after hydration.
 */
export default function LanguageToggle({
  className = "",
}: {
  className?: string;
}) {
  const [lang, setLangState] = useState<Lang | null>(null);

  useEffect(() => {
    setLangState(getLang());
    const onChange = () => setLangState(getLang());
    window.addEventListener(LANG_EVENT, onChange);
    return () => window.removeEventListener(LANG_EVENT, onChange);
  }, []);

  if (lang === null) return null;

  const pick = (next: Lang) => {
    if (next !== lang) setLang(next);
  };

  return (
    <div
      className={`flex items-center justify-center gap-1 text-sm ${className}`}
    >
      {(["en", "fr"] as Lang[]).map((l, i) => (
        <span key={l} className="flex items-center">
          {i > 0 && <span className="mx-1 text-white/20">|</span>}
          <button
            type="button"
            onClick={() => pick(l)}
            className={`uppercase transition-colors ${
              lang === l
                ? "text-action font-semibold"
                : "text-white/50 hover:text-white"
            }`}
            aria-pressed={lang === l}
          >
            {l}
          </button>
        </span>
      ))}
    </div>
  );
}
