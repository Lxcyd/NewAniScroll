import { useEffect, useState } from "react";

/**
 * Latches true the first time `open` is true, and stays true.
 *
 * The gate for lazily-mounted overlays. A dialog that nothing has opened yet
 * renders nothing, so its code — a headless-ui dialog, a form, whatever it
 * fetches — has no business sitting in the chunk that every visitor downloads
 * before the page can paint. `next/dynamic` moves it to its own file; this hook
 * decides when that file is asked for.
 *
 * Why it latches instead of simply mirroring `open`: these overlays close with
 * an exit transition, and unmounting on close would cut the animation off
 * mid-way. Once loaded the component stays mounted, so it behaves exactly as a
 * statically-imported one would — every open after the first is instant, and
 * the close still fades.
 *
 * Only for overlays that render nothing at all while closed. One that keeps a
 * hidden node around and animates it in (RateModal, say) would be born already
 * at its final opacity, skipping its own entrance — mount that one eagerly.
 */
export function useMountedOnce(open: boolean): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted;
}
