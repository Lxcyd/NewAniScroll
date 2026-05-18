import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import UnderConstruction from "@/components/shared/UnderConstruction";

/**
 * Catch-all manga page. Manga support is on the roadmap but the reader,
 * scrapers, and data model aren't shipped yet — instead of 404-ing the
 * route, we show a "coming soon" placeholder.
 */
export default function MangaUnderConstruction() {
  return (
    <>
      <Navbar withNav scrollP={5} shrink />
      <UnderConstruction
        feature="Manga"
        description="Manga reading isn't shipped yet. We're focusing on the anime experience first — manga will land once the player work is settled."
      />
      <Footer />
    </>
  );
}
