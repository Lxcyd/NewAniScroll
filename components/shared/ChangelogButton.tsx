import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

/* The modal (overlay, markdown renderer, section icons) only matters once the
   button is pressed — it no longer rides in the navbar chunk every page loads. */
const ChangelogModal = dynamic(() => import("./ChangelogModal"), { ssr: false });

/**
 * Bell-icon button that opens a modal displaying CHANGELOG.md. Lightweight
 * markdown rendering (no remark dependency) — recognises:
 *   • # / ## / ### headings
 *   • Bulleted lists (-)
 *   • **bold**
 *   • [text](url) links
 *   • paragraphs (blank-line separated)
 *
 * Anything fancier (tables, images, code blocks) renders as raw text. Keeps
 * the bundle slim while still producing a readable layout for typical
 * Keep-a-Changelog content.
 */
export default function ChangelogButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { i18n } = useTranslation();
  const lang = i18n.language?.startsWith("fr") ? "fr" : "en";

  // Invalidate the cached markdown when the UI language changes, so the next
  // open re-fetches the file for the new language. Without this, switching
  // language without a page reload kept showing the previously-loaded language
  // (the content !== null guard below short-circuited the refetch).
  useEffect(() => {
    setContent(null);
  }, [lang]);

  // Lazy-load the full changelog when the modal first opens. Each language now
  // has its own hand-written file (changelog/full.<lang>.md), served by
  // /api/v2/changelog?lang=… — no more on-the-fly translation.
  useEffect(() => {
    if (!open || content !== null) return;
    let cancelled = false;
    setLoading(true);
    // Keyed on the build id so a returning visitor gets the latest changelog
    // after a release (the file ships with the deploy, so a new build is the only
    // thing that can change it). It used to be `&t=${Date.now()}` + no-store,
    // which also defeated the route's edge cache: every open was an invocation.
    const build =
      (typeof window !== "undefined" && (window as any).__NEXT_DATA__?.buildId) || "";
    fetch(`/api/v2/changelog?lang=${lang}&b=${encodeURIComponent(build)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch(() => {
        if (!cancelled)
          setContent(`# Changelog\n\n_${t("changelog.unableToLoad")}_`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, content, lang]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t("nav.changelog")}
        aria-label={t("nav.changelog")}
        /* nav-chrome: recoloured when the navbar sits on light artwork
           (styles/globals.css + lib/color/navContrast). */
        className="nav-chrome flex-center w-9 h-9 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
      >
        {/* Material Symbols "deployed_code_update" — a document with a
            change marker. Reads as "changelog / release notes" clearly
            without the notification baggage a bell carries. */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      </button>

      {/* The modal is portaled to <body> so its `position: fixed` is
          anchored to the viewport — not to the navbar's transformed
          stacking context, which would push it off-screen.
          We also lock the background scroll while the modal is open so
          mousewheel events anywhere on screen scroll the changelog. */}
      {open && typeof document !== "undefined" && (
        <ChangelogModal
          onClose={() => setOpen(false)}
          loading={loading}
          content={content}
        />
      )}
    </>
  );
}
