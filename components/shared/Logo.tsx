import Link from "next/link";

/**
 * AniScroll brand wordmark.
 *
 * Text-only — the icon (public/logo.png) is reserved for the favicon / OG
 * image / PWA install. In the UI we just want the word "AniScroll" in the
 * brand color, no icon next to it.
 *
 * The size prop scales the text:
 *   • "sm" → navbar inline
 *   • "md" → footer
 *   • "lg" → home page hero
 */
type LogoSize = "sm" | "md" | "lg";

const TEXT_CLS: Record<LogoSize, string> = {
  sm: "text-3xl",
  md: "text-4xl",
  lg: "text-5xl",
};

export default function Logo({
  size = "sm",
  href = "/en",
  className = "",
}: {
  size?: LogoSize;
  href?: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-baseline gap-1.5 font-outfit font-semibold hover:opacity-90 transition-opacity ${className}`}
      aria-label="AniScroll home"
    >
      <span className={`${TEXT_CLS[size]} text-action`}>AniScroll</span>
      {/* Tiny beta tag. Lives at a step smaller than the wordmark so it
          stays visible but doesn't compete with the brand. */}
      {/* nav-chrome-dim: recoloured when the navbar sits on light artwork
          (styles/globals.css) — white/40 is invisible on a white banner.
          Inert everywhere else the logo is used. */}
      <span className="nav-chrome-dim text-xs font-karla font-medium tracking-wider uppercase text-white/40">
        Beta
      </span>
    </Link>
  );
}
