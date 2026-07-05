import { useEffect, useRef, useState } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  IoAddCircleOutline,
  IoSyncOutline,
  IoBuildOutline,
  IoRemoveCircleOutline,
} from "react-icons/io5";

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
    // Cache-bust + no-store so a returning visitor always gets the latest
    // changelog after a release — without this the browser served its cached
    // copy for the API's full max-age (1h), even across page reloads.
    fetch(`/api/v2/changelog?lang=${lang}&t=${Date.now()}`, { cache: "no-store" })
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
        className="flex-center w-9 h-9 rounded-full text-white/70 hover:text-white hover:bg-white/10 transition-colors"
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
      {open && typeof document !== "undefined" && createPortal(
        <ChangelogOverlay onClose={() => setOpen(false)}>
          <div className="font-karla text-sm leading-relaxed text-white/85">
            {loading && <p className="text-white/40">{t("common.loading")}</p>}
            {content && <Markdown source={content} />}
          </div>
        </ChangelogOverlay>,
        document.body,
      )}
    </>
  );
}

/**
 * Modal shell for the changelog. Handles three things the bare-bones JSX
 * above couldn't:
 *   1. Locks <body> scroll while open (avoids the page scrolling behind).
 *   2. Forwards wheel events that hit the dim backdrop into the modal's
 *      scrollable inner panel, so scrolling anywhere on screen scrolls
 *      the changelog itself.
 *   3. Keeps focus management contained.
 */
function ChangelogOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Disable page scroll while the modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Forward wheel events on the backdrop into the panel so the user can
  // scroll the changelog with their mouse positioned anywhere.
  const onWheelBackdrop = (e: React.WheelEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    // Only forward if the target isn't already inside the panel (which
    // would scroll natively).
    if (panel.contains(e.target as Node)) return;
    e.preventDefault();
    panel.scrollTop += e.deltaY;
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      onWheel={onWheelBackdrop}
    >
      <div
        ref={panelRef}
        className="relative w-full max-w-2xl max-h-[70vh] overflow-y-auto rounded-card bg-as-card ring-1 ring-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ overscrollBehavior: "contain" }}
      >
        {/* Sticky close-button bar — sits at the top of the scrollable panel
            so the X stays visible no matter how far the user scrolls. */}
        <div className="sticky top-0 z-10 flex justify-end bg-as-card px-3 pt-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <div className="px-6 pb-6 -mt-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * Icon + (soft, neutral) colour for a changelog change-type section header.
 * Matches the English and French section names (Added/Ajouté, Changed/Modifié,
 * Fixed/Corrigé, Removed/Retiré|Supprimé). Returns null for any other heading so
 * it keeps the default tone with no icon. Tones are the lighter -300 shades so
 * they read as gentle accents rather than loud labels.
 */
type SectionMeta = { color: string; Icon: React.ComponentType<{ className?: string }> };
function sectionMeta(text: string): SectionMeta | null {
  const t = text.toLowerCase();
  if (/\b(added|ajout)/.test(t)) return { color: "text-emerald-300", Icon: IoAddCircleOutline };
  if (/\b(changed|modifi)/.test(t)) return { color: "text-amber-300", Icon: IoSyncOutline };
  if (/\b(fixed|corrig)/.test(t)) return { color: "text-orange-300", Icon: IoBuildOutline };
  if (/\b(removed|retir|supprim)/.test(t)) return { color: "text-rose-300", Icon: IoRemoveCircleOutline };
  return null;
}

/**
 * Discord-style minimal markdown renderer. Goes through the source line
 * by line so heading prefixes (`#`, `##`, `###`) always render as
 * headings even when blank lines around them are missing.
 *
 * Supported syntax:
 *   # H1, ## H2, ### H3, #### H4
 *   - bullet                             (lists)
 *   1. ordered                           (ordered lists, recognises `digit.`)
 *   **bold**       *italic*              (inline emphasis)
 *   __underline__                        (inline)
 *   ~~strike~~                           (inline)
 *   `code`                               (inline)
 *   [label](url)                         (links)
 *   ---                                  (horizontal rule)
 *
 * Anything else passes through as raw text so unsupported syntax stays
 * readable instead of breaking the page.
 */
function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line → spacer
    if (!trimmed) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed)) {
      nodes.push(<hr key={i} className="my-3 border-white/10" />);
      i++;
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const sizes = ["text-2xl", "text-xl", "text-lg", "text-base"];
      const tones = ["text-white", "text-white", "text-white", "text-white/90"];
      // Change-type section headers (### Added / Changed / Fixed / Removed, and
      // their FR equivalents) get a soft accent colour + an ion-icon so each
      // category reads at a glance.
      const section = sectionMeta(text);
      const Tag = (`h${level}` as unknown) as keyof JSX.IntrinsicElements;
      nodes.push(
        <Tag
          key={i}
          className={`mt-4 mb-2 flex items-center gap-2 font-outfit font-bold ${
            sizes[level - 1]
          } ${section ? section.color : tones[level - 1]}`}
        >
          {section && <section.Icon className="shrink-0 text-[1.1em]" />}
          {renderInline(text)}
        </Tag>,
      );
      i++;
      continue;
    }

    // Unordered list block — consume consecutive bullet lines
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-2 list-disc pl-5 space-y-1">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list block
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-2 list-decimal pl-5 space-y-1">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Plain paragraph — collect consecutive non-empty lines as one paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|[-*]\s|\d+\.\s|-{3,}$)/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    nodes.push(
      <p key={`p-${i}`} className="my-2">
        {renderInline(para.join(" ").trim())}
      </p>,
    );
  }

  return <>{nodes}</>;
}

/**
 * Inline tokens: bold, italic, underline, strike, code, link.
 * Discord-flavoured ordering: links → bold → italic → underline → strike → code.
 */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern =
    /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[1] && match[2]) {
      nodes.push(
        <a
          key={key++}
          href={match[2]}
          target="_blank"
          rel="noreferrer noopener"
          className="text-action hover:underline"
        >
          {match[1]}
        </a>,
      );
    } else if (match[3]) {
      nodes.push(
        <strong key={key++} className="text-white font-semibold">
          {match[3]}
        </strong>,
      );
    } else if (match[4]) {
      nodes.push(
        <u key={key++} className="underline">
          {match[4]}
        </u>,
      );
    } else if (match[5]) {
      nodes.push(
        <s key={key++} className="line-through opacity-70">
          {match[5]}
        </s>,
      );
    } else if (match[6]) {
      nodes.push(
        <em key={key++} className="italic">
          {match[6]}
        </em>,
      );
    } else if (match[7]) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-white/10 px-1 py-0.5 font-mono text-[12px]"
        >
          {match[7]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}
