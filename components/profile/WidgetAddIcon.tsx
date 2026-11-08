/** L'icône « ajouter un widget » (07/11/2026, fournie par Luc) : trois tuiles
    et un « + » rond. Le menu Widgets du studio et le bouton sous la grille. */
export default function WidgetAddIcon({ className }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M3,20H8q0.43,0 0.71-0.29Q9,19.43 9,19V14q0-0.43-0.29-0.71T8,13H3q-0.42,0-0.71,0.29T2,14v5q0,0.43 0.29,0.71T3,20ZM4,9V6h6V9H4ZM3,11h8q0.43,0 0.71-0.29Q12,10.43 12,10V5q0-0.43-0.29-0.71T11,4H3Q2.58,4 2.29,4.29T2,5v5q0,0.42 0.29,0.71T3,11Zm10,7V15h7v3H13Zm-1,2h9q0.43,0 0.71-0.29Q22,19.43 22,19V14q0-0.43-0.29-0.71T21,13H12q-0.42,0-0.71,0.29T11,14v5q0,0.43 0.29,0.71T12,20ZM4,18V15H7v3H4Zm6-9Zm8,2q-2.07,0-3.54-1.46T13,6q0-2.08 1.46-3.54T18,1t3.54,1.46T23,6q0,2.07-1.46,3.54T18,11ZM17.5,6.5v2q0,0.2 0.15,0.35T18,9t0.35-0.15T18.5,8.5v-2h2q0.2,0 0.35-0.15T21,6T20.85,5.65T20.5,5.5h-2v-2q0-0.2-0.15-0.35T18,3T17.65,3.15T17.5,3.5v2h-2q-0.2,0-0.35,0.15T15,6t0.15,0.35T15.5,6.5h2ZM7,15Zm6,0Z" />
    </svg>
  );
}
