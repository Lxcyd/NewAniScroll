import { Key, useEffect, useRef, useState } from "react";
import Skeleton from "react-loading-skeleton";
import { useRouter } from "next/router";
import Link from "next/link";
import Head from "next/head";
import Footer from "@/components/shared/footer";

import Image from "next/image";
import MultiSelector from "@/components/search/dropdown/multiSelector";
import SingleSelector from "@/components/search/dropdown/singleSelector";
import {
  animeFormatOptions,
  formatOptions,
  genreOptions,
  mangaFormatOptions,
  mediaType,
  seasonOptions,
  sortOptions,
  tagsOption,
  yearOptions,
} from "@/components/search/selection";
import InputSelect from "@/components/search/dropdown/inputSelect";
import { Cog6ToothIcon, TrashIcon } from "@heroicons/react/20/solid";
import useDebounce from "@/lib/hooks/useDebounce";
import { Navbar } from "@/components/shared/NavBar";
import MobileNav from "@/components/shared/MobileNav";
import SearchByImage, {
  TraceMoeResultTypes,
} from "@/components/search/searchByImage";
import { PlayIcon } from "@heroicons/react/24/outline";
import { StaticImport } from "next/dist/shared/lib/get-img-props";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { previewAnchor } from "@/lib/preview/anchor";
import { useTranslation } from "react-i18next";
import { useInfiniteScroll } from "@/lib/hooks/useInfiniteScroll";

export async function getServerSideProps(context: any) {
  // Search results are public and keyed entirely by the query string, so the
  // SSR output for a given URL is identical for every visitor (no session is
  // read here). Edge-cache briefly so repeated / shared searches hit the CDN
  // instead of re-running SSR.
  context?.res?.setHeader?.("Cache-Control", "public, max-age=30");
  context?.res?.setHeader?.(
    "CDN-Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600",
  );
  const { param } = context.query;

  const { search, format, genres, season, year, sort } = context.query;

  let getFormat, getSeason, getYear, getSort;
  let getGenres = [];

  if (genres) {
    const gr = genreOptions.find(
      (i) => i.value.toLowerCase() === genres.toLowerCase()
    );
    getGenres.push(gr);
  }

  if (season) {
    getSeason = seasonOptions.find(
      (i) => i.value.toLowerCase() === season.toLowerCase()
    );
    if (!year) {
      const now = new Date().getFullYear();
      getYear = yearOptions.find((i) => i.value === now.toString());
    } else {
      getYear = yearOptions.find((i) => i.value === year);
    }
  }

  if (format) {
    getFormat = formatOptions.find(
      (i) => i.value.toLowerCase() === format.toLowerCase()
    );
  }

  if (sort) {
    // sort.value can be a string or an array (Trending uses both),
    // so we string-compare against `.value`'s primitive form.
    getSort = sortOptions.find(
      (i) =>
        String(i.value).toUpperCase() === String(sort).toUpperCase()
    );
  }

  /* "This Season" defaults: when the URL carries a season but no format
     and no sort, assume the user wants the headline TV series for that
     season ranked by popularity (driven by the navbar "This Season"
     link). Keeps the public URL short
     (?season=winter&year=2026) while still showing the right thing. */
  if (getSeason && !format && !sort) {
    getFormat = formatOptions.find((i) => i.value === "TV");
    getSort = sortOptions.find((i) => i.value === "POPULARITY_DESC");
  }

  if (!param && param.length !== 1) {
    return {
      notFound: true,
    };
  }

  const typeIndex = param[0] === "anime" ? 0 : 1;

  return {
    props: {
      index: typeIndex,
      query: search || null,
      formats: getFormat || null,
      seasons: getSeason || null,
      years: getYear || null,
      genres: getGenres || null,
      sorts: getSort || null,
    },
  };
}

type CardProps = {
  index: number;
  query: string;
  genres: any;
  formats: any;
  seasons: any;
  years: any;
  sorts: any;
};

export default function Card({
  index,
  query,
  genres,
  formats,
  seasons,
  years,
  sorts,
}: CardProps) {
  const inputRef = useRef(null);
  const router = useRouter();
  const titlePref = useTitlePref();
  const clickTarget = useClickTarget();
  const { t } = useTranslation();

  const [data, setData] = useState<any>();
  const [imageSearch, setImageSearch] = useState<TraceMoeResultTypes[]>();

  const [loading, setLoading] = useState(true);

  const [search, setQuery] = useState<string | null | undefined>(query);
  const debounceSearch = useDebounce(search, 500);

  const [type, setSelectedType] = useState<{
    name: string;
    value: string;
  } | null>(mediaType[index]);
  const [year, setYear] = useState(years);
  const [season, setSeason] = useState(seasons);
  const [sort, setSelectedSort] = useState<{ name: string; value: string } | undefined>(
    sorts || undefined
  );
  const [genre, setGenre] = useState(genres);
  const [format, setFormat] = useState(formats);

  // Next.js doesn't remount this page when only the query string changes
  // (e.g. clicking from /en/search/anime?season=WINTER... to
  // /en/search/anime). The component keeps its old useState values, so the
  // filters look applied even though the URL says otherwise. Resync each
  // filter from its prop whenever SSR re-runs and feeds us new values.
  useEffect(() => {
    setSelectedType(mediaType[index]);
  }, [index]);
  useEffect(() => {
    setYear(years);
  }, [years]);
  useEffect(() => {
    setSeason(seasons);
  }, [seasons]);
  useEffect(() => {
    setSelectedSort(sorts || undefined);
  }, [sorts]);
  useEffect(() => {
    setGenre(genres);
  }, [genres]);
  useEffect(() => {
    setFormat(formats);
  }, [formats]);
  useEffect(() => {
    setQuery(query);
  }, [query]);

  const [isVisible, setIsVisible] = useState(false);

  const [page, setPage] = useState(1);
  const [nextPage, setNextPage] = useState(true);

  async function advance() {
    setLoading(true);
    /* Server-side wrapper around aniAdvanceSearch. Done this way (vs.
       importing the function directly) so the browser bundle doesn't
       try to pull in ioredis (used by the AniList rate-limiter inside
       aniAdvanceSearch's transitive deps), which would fail with
       "Module not found: Can't resolve 'dns'". */
    const res = await fetch("/api/v2/anilist-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: debounceSearch,
        type: type?.value,
        genres: genre,
        page: page,
        sort: sort?.value,
        format: format?.value,
        season: season?.value,
        seasonYear: year?.value,
      }),
    });
    const data = res.ok ? await res.json() : null;
    if (data?.media?.length === 0) {
      setNextPage(false);
      setLoading(false);
    } else if (data !== null && page > 1) {
      setData((prevData: any) => {
        return [...(prevData ?? []), ...data?.media];
      });
      setNextPage(data?.pageInfo.hasNextPage);
      setLoading(false);
    } else {
      setData(data?.media);
      setNextPage(data?.pageInfo.hasNextPage);
      setLoading(false);
    }
  }

  useEffect(() => {
    setData(null);
    setPage(1);
    setNextPage(true);
    if (page === 1) {
      advance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    debounceSearch,
    type?.value,
    sort?.value,
    genre,
    format?.value,
    season?.value,
    year?.value,
  ]);

  useEffect(() => {
    if (imageSearch) return;
    if (page > 1) {
      advance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, imageSearch]);

  useInfiniteScroll(
    () => {
      // `loading` is checked here rather than in `enabled` so an in-flight page
      // doesn't tear down and re-arm the listener on every fetch.
      if (!loading) setPage((prevPage) => prevPage + 1);
    },
    !imageSearch && page <= 10 && !!nextPage,
  );

  const handleKeyDown = async (event: any) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const inputValue = event.target.value;
      if (inputValue === "") {
        setQuery(undefined);
      } else {
        setQuery(inputValue);
      }
    }
  };

  function trash() {
    setImageSearch(undefined);
    setQuery(undefined);
    setGenre(undefined);
    setFormat(undefined);
    setSelectedSort(undefined);
    setSeason(undefined);
    setYear(undefined);
    router.push(`/en/search/${mediaType[index]?.value?.toLowerCase()}`);
  }

  function handleVisible() {
    setIsVisible(!isVisible);
  }

  const handleVideoHover = (hovered: boolean, id: any) => {
    const updatedImageSearch = imageSearch?.map((item: any) => {
      if (item.filename === id) {
        return { ...item, hovered };
      }
      return item;
    });
    setImageSearch(updatedImageSearch);
  };

  // console.log({ loading, data });

  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta name="title" content="Search" />
        <meta name="description" content="Search your favourites Anime/Manga" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>

      <Navbar
        scrollP={10}
        withNav={true}
        shrink={true}
        paddingY="py-1 lg:py-3"
      />
      <MobileNav hideProfile={true} />
      <main className="w-screen min-h-screen z-40 py-14 lg:py-24">
        <div className="max-w-screen-xl flex flex-col gap-3 mx-auto">
          <div className="w-full flex justify-between items-end gap-2 my-3 lg:gap-10 px-5 xl:px-0 relative">
            <div className="hidden lg:flex items-end w-full gap-5 z-50">
              <InputSelect
                inputRef={inputRef}
                data={mediaType}
                label={t("search.label")}
                keyDown={handleKeyDown}
                query={search}
                setQuery={setQuery}
                selected={type}
                setSelected={setSelectedType}
              />
              {/* GENRES */}
              <MultiSelector
                data={genreOptions}
                other={tagsOption}
                selected={genre}
                setSelected={setGenre}
                label={t("search.genres")}
                inputRef={inputRef}
              />
              {/* SORT */}
              {/* <SingleSelector
                data={sortOptions}
                selected={sort}
                setSelected={setSelectedSort}
                label={t("search.sort")}
              /> */}
              {/* FORMAT */}
              <SingleSelector
                data={index === 0 ? animeFormatOptions : mangaFormatOptions}
                selected={format}
                setSelected={setFormat}
                label={t("search.format")}
              />
              {/* SEASON */}
              <SingleSelector
                data={seasonOptions}
                selected={season}
                setSelected={setSeason}
                label={t("search.season")}
              />
              {/* YEAR */}
              <SingleSelector
                data={yearOptions}
                selected={year}
                setSelected={setYear}
                label={t("search.year")}
              />
            </div>
            <div className="w-full lg:hidden">
              <InputSelect
                inputRef={inputRef}
                data={mediaType}
                label={t("search.label")}
                keyDown={handleKeyDown}
                query={search}
                setQuery={setQuery}
                selected={type}
                setSelected={setSelectedType}
              />
            </div>

            <div className="flex gap-2">
              <div
                className="lg:hidden py-2 px-2 bg-secondary rounded flex justify-center items-center cursor-pointer hover:bg-opacity-75 transition-all duration-100 group"
                onClick={handleVisible}
              >
                <Cog6ToothIcon className="w-5 h-5" />
              </div>
              <SearchByImage setMedia={setData} setData={setImageSearch} />
              <div
                className="py-2 px-2 bg-secondary rounded flex justify-center items-center cursor-pointer hover:bg-opacity-75 transition-all duration-100 group"
                onClick={trash}
              >
                <TrashIcon className="w-5 h-5" />
              </div>
            </div>
          </div>
          {isVisible && (
            <div className="lg:hidden w-full flex justify-center z-40">
              <div className="grid grid-cols-2 grid-rows-2 place-items-center w-full px-5 z-30 gap-4">
                {/* GENRES */}
                <MultiSelector
                  data={genreOptions}
                  other={tagsOption}
                  selected={genre}
                  setSelected={setGenre}
                  label={t("search.genres")}
                  inputRef={inputRef}
                />
                {/* SORT */}
                {/* <SingleSelector
                data={sortOptions}
                selected={sort}
                setSelected={setSelectedSort}
                label={t("search.sort")}
              /> */}
                {/* FORMAT */}
                <SingleSelector
                  data={index === 0 ? animeFormatOptions : mangaFormatOptions}
                  selected={format}
                  setSelected={setFormat}
                  label={t("search.format")}
                />
                {/* SEASON */}
                <SingleSelector
                  data={seasonOptions}
                  selected={season}
                  setSelected={setSeason}
                  label={t("search.season")}
                />
                {/* YEAR */}
                <SingleSelector
                  data={yearOptions}
                  selected={year}
                  setSelected={setYear}
                  label={t("search.year")}
                />
              </div>
            </div>
          )}
          {/* <div> */}
          <div className="flex flex-col gap-14 items-center z-30 overflow-x-hidden">
            <div
              key="card-keys"
              className={`${
                imageSearch ? "hidden" : ""
              } grid pt-3 px-5 xl:px-0 xxs:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-6 justify-items-center grid-cols-2 w-screen xl:w-auto xl:gap-7 gap-5 gap-y-10`}
            >
              {loading
                ? ""
                : !data && (
                    <div className="w-full text-[#ff7f57] col-span-6 items-center flex justify-center text-center font-bold font-karla xl:text-2xl">
                      {t("search.nothingFound")}<br></br> {t("search.nothingFoundSub")}
                    </div>
                  )}

              {data &&
                data?.length > 0 &&
                !imageSearch &&
                data?.map(
                  (
                    anime: {
                      format: string;
                      id: any;
                      title: {
                        userPreferred: string;
                        english?: string | null;
                        romaji?: string | null;
                        native?: string | null;
                      };
                      coverImage: { extraLarge: string | StaticImport };
                      status: string;
                      episodes: any;
                      chapters: any;
                    },
                    index: Key | null | undefined
                  ) => {
                    return (
                      <div
                        className="as-pop-in w-full"
                        key={index}
                        {...(anime.format === "MANGA" || anime.format === "NOVEL"
                          ? {}
                          : previewAnchor(anime.id))}
                      >
                        <Link
                          href={
                            anime.format === "MANGA" || anime.format === "NOVEL"
                              ? `/en/manga/${anime.id}`
                              : animeHref(anime.id, clickTarget)
                          }
                          title={pickTitle(anime.title, titlePref)}
                          className="block relative overflow-hidden bg-secondary hover:scale-[1.03] scale-100 transition-all cursor-pointer duration-200 ease-out rounded"
                          style={{
                            paddingTop: "145%", // 2:3 aspect ratio (3/2 * 100%)
                          }}
                        >
                          <Image
                            className="object-cover"
                            src={anime.coverImage.extraLarge}
                            alt={pickTitle(anime.title, titlePref)}
                            sizes="(min-width: 808px) 50vw, 100vw"
                            quality={100}
                            fill
                          />
                        </Link>
                        <Link
                          href={
                            anime.format === "MANGA" || anime.format === "NOVEL"
                              ? `/en/manga/${anime.id}`
                              : animeHref(anime.id, clickTarget)
                          }
                          title={pickTitle(anime.title, titlePref)}
                        >
                          <h1 className="font-outfit font-bold xl:text-base text-[15px] pt-4 line-clamp-2">
                            {anime.status === "RELEASING" ? (
                              <span className="dots bg-green-500" />
                            ) : anime.status === "NOT_YET_RELEASED" ? (
                              <span className="dots bg-red-500" />
                            ) : null}
                            {pickTitle(anime.title, titlePref)}
                          </h1>
                        </Link>
                        <h2 className="font-outfit xl:text-[15px] text-[11px] font-light pt-2 text-[#8B8B8B]">
                          {anime.format || <p>-</p>} &#183;{" "}
                          {anime.status || <p>-</p>} &#183;{" "}
                          {anime.episodes
                            ? `${anime.episodes || "N/A"} Episodes`
                            : `${anime.chapters || "N/A"} Chapters`}
                        </h2>
                      </div>
                    );
                  }
                )}

              {loading && (
                <>
                  {[1, 2, 4, 5, 6, 7, 8].map((item) => (
                    <div className="w-full" key={item}>
                      <div className="w-full">
                        <Skeleton
                          className="w-full rounded"
                          style={{
                            paddingTop: "140%", // 2:3 aspect ratio (3/2 * 100%)
                            width: "(min-width: 808px) 50vw, 100vw",
                            lineHeight: 1,
                          }}
                        />
                      </div>
                      <div>
                        <h1 className="font-outfit w-[320px] font-bold xl:text-base text-[15px] pt-4 line-clamp-2">
                          <Skeleton width={120} height={26} />
                        </h1>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {imageSearch && (
              <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4 gap-3 md:gap-7 px-5 lg:px-0">
                {imageSearch.map((a, index) => {
                  return (
                    <div
                      key={index}
                      className="as-pop-in-lg flex flex-col gap-2 shrink-0 cursor-pointer relative group/item"
                    >
                      <Link
                        className="relative aspect-video rounded-md overflow-hidden group"
                        href={animeHref(a.anilist.id, clickTarget)}
                        onMouseEnter={() => {
                          handleVideoHover(true, a.filename);
                        }}
                        onMouseLeave={() => handleVideoHover(false, a.filename)}
                      >
                        <div className="w-full h-full bg-gradient-to-t from-black/70 from-20% to-transparent group-hover:to-black/40 transition-all duration-300 ease-out absolute z-30" />
                        <div className="absolute bottom-3 left-0 mx-2 text-white flex gap-2 items-center w-[80%] z-30">
                          <PlayIcon className="w-5 h-5 shrink-0" />
                          <h1
                            className="font-semibold font-karla line-clamp-1"
                            title={pickTitle(a?.anilist.title, titlePref)}
                          >
                            {`Episode ${a.episode}`}
                          </h1>
                        </div>

                        {a?.image && (
                          <Image
                            src={a?.image}
                            width={200}
                            height={200}
                            alt="Episode Thumbnail"
                            className={`w-full object-cover group-hover:scale-[1.02] duration-300 ease-out z-10 ${
                              !a.hovered ? "visible" : "hidden"
                            }`}
                          />
                        )}
                        {a?.video && (
                          <video
                            src={a.video}
                            className={`w-full object-cover group-hover:scale-[1.02] duration-300 ease-out z-10 ${
                              a.hovered ? "visible" : "hidden"
                            }`}
                            autoPlay
                            muted
                            loop
                            playsInline
                          />
                        )}
                      </Link>

                      <Link
                        className="flex flex-col font-karla w-full"
                        href={animeHref(a.anilist.id, clickTarget)}
                      >
                        {/* <h1 className="font-semibold">{a.title}</h1> */}
                        <p className="flex items-center gap-1 text-sm text-gray-400 max-w-[320px]">
                          <span
                            className="text-white max-w-[120px] md:max-w-[200px] lg:max-w-[220px]"
                            style={{
                              display: "inline-block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={pickTitle(a?.anilist.title, titlePref)}
                          >
                            {pickTitle(a?.anilist.title, titlePref)}
                          </span>{" "}
                          | Episode {a.episode}
                        </p>
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
            {!loading && page > 10 && nextPage && (
              <button
                onClick={() => setPage((p) => p + 1)}
                className="bg-secondary xl:w-[30%] w-[80%] h-10 rounded-md"
              >
                Load More
              </button>
            )}
          </div>
          {/* </div> */}
        </div>
      </main>
      <Footer />
    </>
  );
}
