/**
 * Placeholder that reserves the exact vertical space a populated <Content>
 * carousel occupies, so a section whose data arrives late (On-Going Anime,
 * Your Watch List, Your Plan…) swaps in WITHOUT pushing the rest of the page
 * down. Matches Content's layout: a heading row + a horizontally-scrolling
 * row of cards.
 *
 * `variant` mirrors Content's two card shapes:
 *   - "portrait" → tall poster cards (most rows)
 *   - "landscape" → 16:9 thumbnail cards (Recently Watched / recentAdded)
 */
export default function CarouselSkeleton({
  variant = "portrait",
}: {
  variant?: "portrait" | "landscape";
}) {
  const cards = Array.from({ length: 8 });
  return (
    <div className="animate-pulse">
      {/* Heading row — same px-5 + height as Content's <h1> block. */}
      <div className="flex items-center gap-3 px-5">
        <div className="h-5 w-44 rounded bg-white/[0.07]" />
      </div>
      {/* Card row — same paddings as Content's scroller (lg:p-10 / py-8 px-5). */}
      <div className="flex w-full gap-4 overflow-hidden lg:gap-8 lg:p-10 py-8 px-5">
        {cards.map((_, i) => (
          <div
            key={i}
            className={
              variant === "landscape"
                ? "h-[180px] w-[320px] shrink-0 rounded-md bg-white/[0.05]"
                : "h-[190px] w-[135px] shrink-0 rounded-md bg-white/[0.05] lg:h-[265px] lg:w-[185px]"
            }
          />
        ))}
      </div>
    </div>
  );
}
