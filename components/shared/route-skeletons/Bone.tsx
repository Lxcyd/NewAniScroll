/* Le bloc gris commun des squelettes de navigation : la même pulsation et la
   même teinte que les squelettes des onglets du profil (TabSkeletons), pour
   qu'un squelette se lise pareil d'une page à l'autre. */
export function Bone({
  className = "",
  style,
  delay = 0,
}: {
  className?: string;
  style?: React.CSSProperties;
  delay?: number;
}) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-lg bg-white/[0.07] ${className}`}
      style={delay ? { animationDelay: `${delay}ms`, ...style } : style}
    />
  );
}
