import CatalogGrid from "@/components/anime/CatalogGrid";

/* No getServerSideProps: this page renders the same markup for everybody. It
   used to call getServerSession purely to hand a `sessions` prop to
   <MobileNav>, which doesn't take one — it reads the session itself via
   useSession(). So every view was paying a serverless invocation to produce a
   prop nobody read. Without it the page is fully static and served from the
   CDN. */
export default function PopularAnime() {
  return (
    <CatalogGrid
      sort="popular"
      headingKey="home.popularAnime"
      metaTitle="Popular Anime"
      metaDescription="Explore Beloved Classics and Favorites - Dive into a curated collection of timeless anime on AniScroll's Popular Anime Page. From iconic classics to all-time favorites, experience the stories that have captured hearts worldwide. Start streaming now and relive the magic of anime!"
    />
  );
}
