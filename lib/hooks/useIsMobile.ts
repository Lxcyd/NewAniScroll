import { useEffect, useState } from "react";

/**
 * Mobile-viewport detector.
 *
 * Two-stage detection so the first paint already matches the device:
 *  1. Initial value is computed synchronously from the useragent if
 *     we're in SSR/static-pass. Catches mobile/tablet UA strings the
 *     same way Next.js' own `getServerSideProps` would.
 *  2. After mount we switch to `matchMedia("(max-width: 768px)")` and
 *     subscribe — so resizing the window on desktop and rotating a
 *     phone both produce the correct value.
 *
 * The threshold matches the breakpoint the rest of the V2 design uses
 * for stack-vs-grid layout decisions (Tailwind's `md`: 768 px).
 */
const MOBILE_QUERY = "(max-width: 768px)";

function detectFromUA(ua: string | undefined | null): boolean {
  if (!ua) return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    ua,
  );
}

export function useIsMobile(initialUA?: string | null): boolean {
  // First render — both on the server AND on the client's hydration
  // pass — must seed from the useragent so the markup matches. After
  // mount we switch to matchMedia so window resizing / orientation
  // changes update correctly. Reading matchMedia in the initialiser
  // produced a hydration mismatch when the device's UA said mobile
  // but the viewport (e.g. responsive devtools at desktop width)
  // said desktop, or vice versa.
  const [mobile, setMobile] = useState<boolean>(() => detectFromUA(initialUA));
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return mobile;
}
