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
      className={`font-outfit font-semibold ${TEXT_CLS[size]} text-action hover:opacity-90 transition-opacity ${className}`}
      aria-label="AniScroll home"
    >
      AniScroll
    </Link>
  );
}
