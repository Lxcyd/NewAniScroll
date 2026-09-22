import { useEffect, useRef } from "react";
// @ts-ignore — react-dom types not installed but createPortal is exported
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  IoAddCircleOutline,
  IoSyncOutline,
  IoBuildOutline,
  IoRemoveCircleOutline,
} from "react-icons/io5";

/** The changelog modal, split out of ChangelogButton and loaded on the first
 *  open. Portaled to <body> — see the note where the button mounts it. */
export default function ChangelogModal({
  onClose,
  loading,
  content,
}: {
  onClose: () => void;
  loading: boolean;
  content: string | null;
}) {
  const { t } = useTranslation();
  return createPortal(
    <ChangelogOverlay onClose={onClose}>
      <div className="font-karla text-sm leading-relaxed text-white/85">
        {loading && <p className="text-white/40">{t("common.loading")}</p>}
        {content && <Markdown source={content} />}
      </div>
    </ChangelogOverlay>,
    document.body,
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

  /* « Lecteur de notes » : avoir lu le changelog JUSQU'EN BAS.
     Surveille sur le panneau, avec une tolerance de deux pixels -- un arrondi
     sous-pixel (zoom du navigateur, ecran a densite fractionnaire) laisse
     souvent `scrollTop + clientHeight` une fraction en dessous de
     `scrollHeight`, et un badge qui exige l'egalite exacte serait hors de
     portee la moitie du temps.
     Un changelog plus court que la fenetre est deja « lu jusqu'en bas » : il
     n'y a rien a faire defiler, et le refuser punirait la brievete. */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const check = () => {
      if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 2) {
        import("@/lib/badges/facts")
          .then((f) => f.recordFlag("changelog"))
          .catch(() => {});
        panel.removeEventListener("scroll", check);
      }
    };
    /* Differe d'une image : a l'ouverture, le contenu n'est pas encore mis en
       page et `scrollHeight` vaut celui d'un panneau vide. */
    const id = requestAnimationFrame(check);
    panel.addEventListener("scroll", check, { passive: true });
    return () => {
      cancelAnimationFrame(id);
      panel.removeEventListener("scroll", check);
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
