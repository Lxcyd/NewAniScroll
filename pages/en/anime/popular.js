import { ChevronLeftIcon } from "@heroicons/react/24/solid";
import Image from "next/image";
import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import Skeleton from "react-loading-skeleton";
import Footer from "@/components/shared/footer";
import { getServerSession } from "next-auth";
import { authOptions } from "../../api/auth/[...nextauth]";
import Head from "next/head";
import MobileNav from "@/components/shared/MobileNav";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";
import { useInfiniteScroll } from "@/lib/hooks/useInfiniteScroll";

export default function PopularAnime({ sessions }) {
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const fetchData = async () => {
      // Server-cached endpoint (1h Redis TTL). N concurrent visitors
      // share a single AniList round-trip instead of each browser
      // burning its own AniList rate-limit quota.
      const res = await fetch(`/api/v2/catalog/popular?page=${page}`);
      const get = await res.json();
      const media = get?.media || [];
      if (media.length === 0) {
        setNextPage(false);
      } else if (page > 1) {
        setData((prevData) => [...(prevData ?? []), ...media]);
        setNextPage(!!get?.hasNextPage);
      } else {
        setData(media);
        setNextPage(!!get?.hasNextPage);
      }
      setLoading(false);
    };
    fetchData();
  }, [page]);

  useInfiniteScroll(
    () => setPage((prevPage) => prevPage + 1),
    page <= 5 && !!nextPage,
  );

  return (
    <Fragment>
      <Head>
        <title>AniScroll • Beta</title>
        <meta name="title" content="Popular Anime" />
        <meta
          name="description"
          content="Explore Beloved Classics and Favorites - Dive into a curated collection of timeless anime on AniScroll's Popular Anime Page. From iconic classics to all-time favorites, experience the stories that have captured hearts worldwide. Start streaming now and relive the magic of anime!"
        />
      </Head>
      <MobileNav sessions={sessions} />
      <main className="flex flex-col gap-2 items-center min-h-screen w-screen px-2 relative pb-10">
        <div className="z-50 bg-primary pt-5 pb-3 shadow-md shadow-primary w-full fixed px-3">
          <Link href="/en" className="flex gap-2 items-center font-karla">
            <ChevronLeftIcon className="w-5 h-5" />
            <h1 className="text-xl">{t("home.popularAnime")}</h1>
          </Link>
        </div>
        <div className="grid grid-cols-2 xs:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-6 gap-3 max-w-6xl pt-16">
          {data?.map((i, index) => (
            <div
              key={index}
              className="flex flex-col items-center w-[150px] lg:w-[180px]"
            >
              <Link
                href={animeHref(i.id, clickTarget)}
                className="p-2"
                title={pickTitle(i.title, titlePref)}
              >
                <Image
                  src={i.coverImage.large}
                  alt={pickTitle(i.title, titlePref)}
                  width={500}
                  height={500}
                  className="w-[140px] h-[190px] lg:w-[170px] lg:h-[230px] object-cover rounded hover:scale-105 scale-100 transition-all duration-200 ease-out"
                />
              </Link>
              <Link
                href={animeHref(i.id, clickTarget)}
                className="w-full px-2"
                title={pickTitle(i.title, titlePref)}
              >
                <h1 className="font-karla font-bold xl:text-base text-[15px] line-clamp-2">
                  {i.status === "RELEASING" ? (
                    <span className="dots bg-green-500" />
                  ) : i.status === "NOT_YET_RELEASED" ? (
                    <span className="dots bg-red-500" />
                  ) : null}
                  {pickTitle(i.title, titlePref)}
                </h1>
              </Link>
            </div>
          ))}

          {loading && (
            <>
              {[1, 2, 4, 5, 6, 7, 8].map((item) => (
                <div
                  key={item}
                  className="flex flex-col items-center w-[150px] lg:w-[180px]"
                >
                  <div className="w-full p-2">
                    <Skeleton className="w-[140px] h-[190px] lg:w-[170px] lg:h-[230px] rounded" />
                  </div>
                  <div className="w-full px-2">
                    <Skeleton width={80} height={20} />
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        {!loading && page > 5 && nextPage && (
          <button
            onClick={() => setPage((p) => p + 1)}
            className="bg-secondary xl:w-[30%] w-[80%] h-10 rounded-md"
          >
            Load More
          </button>
        )}
      </main>
      <Footer />
    </Fragment>
  );
}

export async function getServerSideProps(context) {
  const session = await getServerSession(context.req, context.res, authOptions);

  return {
    props: {
      sessions: session,
    },
  };
}
