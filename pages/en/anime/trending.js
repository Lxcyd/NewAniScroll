import CatalogGrid from "@/components/anime/CatalogGrid";

/* No getServerSideProps: this page renders the same markup for everybody. It
   used to call getServerSession purely to hand a `sessions` prop to
   <MobileNav>, which doesn't take one — it reads the session itself via
   useSession(). So every view was paying a serverless invocation to produce a
   prop nobody read. Without it the page is fully static and served from the
   CDN. */
export default function TrendingAnime() {
  return (
    <CatalogGrid
      sort="trending"
      headingKey="home.trendingNow"
      metaTitle="Trending Anime"
      metaDescription="Explore Top Trending Anime - Dive into the latest and most popular anime series on AniScroll. From thrilling action to heartwarming romance, discover the buzzworthy shows that have everyone talking. Stream now and stay up-to-date with the hottest anime trends!"
    />
  );
}
