import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { recordFlag } from "@/lib/badges/facts";
import { flush as flushBadges } from "@/lib/badges/evaluate";
import { getShowAdult } from "@/lib/prefs/adultPrefs";
import { Combobox, Dialog, Menu, Transition } from "@headlessui/react";
import useDebounce from "@/lib/hooks/useDebounce";
import Image from "next/image";
import { useRouter } from "next/router";
import { useSearch } from "@/lib/context/isOpenState";
import { ChevronDownIcon, ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { BookOpenIcon, PlayIcon, StarIcon } from "@heroicons/react/20/solid";
import { useAniList } from "@/lib/anilist/useAnilist";
import { getFormat } from "@/utils/getFormat";
import SearchByImage from "./search/searchByImage";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref } from "@/lib/prefs/clickTarget";
import { useTranslation } from "react-i18next";

type SearchType = "ANIME" | "MANGA";

/** What was typed, in pink inside each suggestion; the rest of the title stays
    white. Case-insensitive, every occurrence. */
function highlight(text: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const low = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  for (let j = low.indexOf(q); j !== -1; j = low.indexOf(q, i)) {
    if (j > i) out.push(text.slice(i, j));
    out.push(
      <span key={j} className="text-action">
        {text.slice(j, j + q.length)}
      </span>,
    );
    i = j + q.length;
  }
  if (!out.length) return text;
  out.push(text.slice(i));
  return out;
}

/** Le fondu de la bannière, en courbe : deux points seulement donnent un
    dégradé linéaire, dont le début et la fin se voient comme une limite. */
const BANNER_FADE =
  "linear-gradient(90deg, transparent 0%, rgba(0,0,0,.02) 10%, rgba(0,0,0,.07) 20%, rgba(0,0,0,.16) 30%, rgba(0,0,0,.29) 40%, rgba(0,0,0,.45) 50%, rgba(0,0,0,.62) 60%, rgba(0,0,0,.78) 70%, rgba(0,0,0,.9) 80%, rgba(0,0,0,.97) 90%, #000 100%)";

/** La ligne sous le titre : année, format, puis la durée d'un film, les
    épisodes d'une série ou les chapitres d'un manga. */
function metaOf(i: DataTypes, epShort: string): string[] {
  const out: (string | number | null | undefined)[] = [i.startDate?.year || null, getFormat(i.format)];
  if (i.format === "MOVIE" && i.duration) {
    const h = Math.floor(i.duration / 60);
    const m = i.duration % 60;
    out.push(h ? `${h}h${m ? ` ${m}min` : ""}` : `${m}min`);
  } else if (i.episodes) {
    out.push(`${i.episodes} ${epShort}`);
  } else if (i.chapters) {
    out.push(`${i.chapters} ch.`);
  }
  return out.filter(Boolean).map(String);
}

export interface DataTypes {
  id: number;
  title: Title;
  coverImage: CoverImage;
  type: string;
  format: string;
  bannerImage?: string;
  isLicensed: boolean;
  genres: string[];
  startDate: StartDate;
  episodes?: number | null;
  duration?: number | null;
  chapters?: number | null;
  averageScore?: number | null;
}

interface Title {
  userPreferred: string;
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
}

interface CoverImage {
  medium: string;
}

interface StartDate {
  year: number;
}

export default function SearchPalette() {
  const { isOpen, setIsOpen } = useSearch();
  const { quickSearch } = useAniList();
  const titlePref = useTitlePref();
  const { t } = useTranslation();

  const [query, setQuery] = useState<string>("");

  /* TROIS BADGES SECRETS SE JOUENT DANS CE CHAMP, et tous les trois se lisent
     au meme endroit : ce qu'on vient de taper. On compare sur une forme
     normalisee (sans accent, sans casse) parce qu'on cherche une INTENTION, pas
     une orthographe.

     Le pseudo n'est compare que s'il fait au moins trois caracteres : en
     dessous, la collision avec un vrai titre est trop probable pour que le
     badge veuille dire quelque chose. */
  const { data: searchSession } = useSession();
  useEffect(() => {
    const q = query
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
    if (!q) return;
    const me = String((searchSession as any)?.user?.name ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
    /* Le badge tombe A LA FRAPPE, sans Entree : on evalue tout de suite au
       lieu d'attendre les 2 s de calme du debounce, qu'on n'atteignait jamais
       avant de valider ou de continuer a taper. */
    let got = false;
    if (q === "aniscroll") got = recordFlag("recursive") || got;
    if (q === "hentai") got = recordFlag("notHere") || got;
    if (me.length >= 3 && q === me) got = recordFlag("selfSearch") || got;
    if (got) flushBadges();
  }, [query, searchSession]);
  const [data, setData] = useState<DataTypes[] | null>(null);
  const debounceSearch = useDebounce(query, 300);
  const [loading, setLoading] = useState<boolean>(false);
  const [type, setType] = useState<SearchType>("ANIME");

  const [nextPage, setNextPage] = useState<boolean>(false);

  let focusInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  function closeModal() {
    setIsOpen(false);
  }

  function handleChange(event: string): void {
    // Honour the watch/info click-target pref for anime; manga always → info.
    router.push(
      type.toLowerCase() === "anime"
        ? animeHref(event)
        : `/en/${type.toLowerCase()}/${event}`,
    );
  }

  // Only the latest query may write: a slow answer to "nar" must not land
  // over the answer to "naruto".
  const requestSeq = useRef(0);

  async function advance(): Promise<void> {
    const seq = ++requestSeq.current;
    const q = debounceSearch;
    if (!q.trim()) {
      setData(null);
      setNextPage(false);
      setLoading(false);
      return;
    }
    setLoading(true);

    // Run AniList live search AND our local Turso FTS in parallel, then merge.
    // Why: AniList's `search` param matches poorly on French / alternate
    // titles (searching "le chateau ambulant" returns nothing), whereas
    // voiranime.cx finds it because it indexes localized titles. Our local
    // FTS row indexes romaji + english + native + synonyms, so it matches the
    // same way voir-anime does. Merging the two gives AniList's live coverage
    // plus synonym/French-title matching, deduped by id. AniList results come
    // first (more authoritative ordering); local-only hits are appended.
    // Manga uses AniList only — the local FTS is anime-only.
    //
    // Each side is shown AS SOON AS it answers: waiting for both made every
    // search as slow as the slower one (often the cold Turso function).
    let aniResults: DataTypes[] | null = null;
    let localResults: DataTypes[] | null = null;
    const render = () => {
      if (seq !== requestSeq.current) return;
      const ani = aniResults || [];
      const seen = new Set(ani.map((r) => r.id));
      setData([...ani, ...(localResults || []).filter((r) => r && !seen.has(r.id))]);
      // The spinner stays until one side has something, or both are done.
      const done = aniResults !== null && localResults !== null;
      if (done || ani.length > 0 || (localResults?.length ?? 0) > 0) setLoading(false);
    };

    await Promise.all([
      /* `null` : adulte inclus (AniList rend les deux) ; `false` par defaut. */
      quickSearch({ search: q, type, isAdult: getShowAdult() ? (null as unknown as boolean) : false }).then((res) => {
        aniResults = res?.data?.Page?.results || [];
        if (seq === requestSeq.current)
          setNextPage(res?.data?.Page?.pageInfo?.hasNextPage ?? false);
        render();
      }),
      (type === "ANIME" ? fetchLocalSearch(q) : Promise.resolve([])).then((res) => {
        localResults = res;
        render();
      }),
    ]);
  }

  // Query the local Turso FTS endpoint. Maps the cached Media payload onto the
  // subset of fields this palette renders. Never throws — a search outage on
  // our side must not break AniList results.
  async function fetchLocalSearch(raw: string): Promise<DataTypes[]> {
    /* The FTS table is case- and accent-insensitive (unicode61), so "Naruto",
       "naruto " and "NARUTO" return the same rows: one spelling = one edge
       cache entry. Under 3 characters the route answers [] (SEARCH_MIN_CHARS)
       — skip the call. */
    const q = (raw || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (q.length < 3) return [];
    try {
      const res = await fetch(`/api/v2/search?q=${encodeURIComponent(q)}&limit=8`);
      if (!res.ok) return [];
      const json = await res.json();
      const rows: any[] = json?.results || [];
      return rows
        /* La table locale garde les titres adultes (`isAdult` dans la ligne) :
           sans le reglage, ils ne s'affichent pas (10/11/2026). */
        .filter((m) => m?.id && m?.title && (getShowAdult() || !m.isAdult))
        .map((m) => ({
          id: m.id,
          title: m.title,
          coverImage: { medium: m.coverImage?.medium || m.coverImage?.large || "" },
          type: m.type,
          format: m.format,
          bannerImage: m.bannerImage,
          isLicensed: m.isLicensed,
          genres: m.genres || [],
          startDate: { year: m.startDate?.year ?? 0 },
          episodes: m.episodes,
          duration: m.duration,
          chapters: m.chapters,
          averageScore: m.averageScore,
        }));
    } catch {
      return [];
    }
  }

  useEffect(() => {
    advance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounceSearch, type]);

  /* LA FENÊTRE EST CALÉE SUR LES PIXELS DE L'ÉCRAN (23/11/2026, Luc : « le bord
     en haut est trop épais, les coins sont pixelisés »). Centrée, elle tombe sur
     un demi-pixel dès que la fenêtre du navigateur a une taille impaire : les
     traits de 1 px des cartes s'étalaient alors sur deux lignes. */
  const panelEl = useRef<HTMLDivElement | null>(null);
  const panelObserver = useRef<ResizeObserver | null>(null);
  const snapPanel = useCallback(() => {
    const el = panelEl.current;
    if (!el) return;
    el.style.translate = "";
    const r = (el.querySelector('[role="listbox"]') ?? el).getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const off = (v: number) => Math.round(v * dpr) / dpr - v;
    el.style.translate = `${off(r.left)}px ${off(r.top)}px`;
  }, []);
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    panelObserver.current?.disconnect();
    panelEl.current = el;
    if (!el) return;
    panelObserver.current = new ResizeObserver(snapPanel);
    panelObserver.current.observe(el);
  }, [snapPanel]);
  useEffect(() => {
    window.addEventListener("resize", snapPanel);
    return () => window.removeEventListener("resize", snapPanel);
  }, [snapPanel]);

  // Every opening starts from a blank slate. The Ctrl+S handler used to clear
  // these itself, but it moved to SearchProvider so this component could be
  // mounted lazily (see lib/context/isOpenState.js) — and the shortcut is not
  // the only way in anyway: the navbar button opens the palette too, and it
  // never did the reset.
  useEffect(() => {
    if (!isOpen) return;
    setData(null);
    setQuery("");
  }, [isOpen]);

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-[6969]"
        initialFocus={focusInput}
        onClose={closeModal}
      >
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/90" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          {/* Telephone : calee en HAUT. Centree, le clavier qui monte a la
              saisie recouvrait la liste des resultats. */}
          <div className="flex min-h-full items-center justify-center p-4  text-center max-md:items-start max-md:pt-[max(16px,env(safe-area-inset-top))]">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
              afterEnter={snapPanel}
            >
              <Dialog.Panel ref={panelRef} className="w-full max-w-2xl max-h-[68dvh] transform text-left transition-[opacity,transform]">
                <Combobox
                  as="div"
                  className="max-w-2xl mx-auto rounded-lg shadow-2xl relative flex flex-col"
                  onChange={(e: any) => {
                    handleChange(e);
                    setData(null);
                    setIsOpen(false);
                    setQuery("");
                  }}
                >
                  <div className="flex justify-between py-1 font-karla">
                    {/* Raccourci clavier : rien a dire a un ecran tactile. */}
                    <div className="flex items-center px-2 gap-2 [@media(hover:none)]:hidden">
                      <p>{t("search.quickAccess")}</p>
                      <div className="bg-secondary text-white text-xs font-bold px-2 py-1 rounded-md">
                        <span>CTRL</span>
                      </div>
                      <span>+</span>
                      <div className="bg-secondary text-white text-xs font-bold px-2 py-1 rounded-md">
                        <span>S</span>
                      </div>
                    </div>
                    <div className="flex gap-1 items-center ml-auto">
                      <Menu
                        as="div"
                        className="relative inline-block text-left"
                      >
                        <div>
                          <Menu.Button className="capitalize bg-secondary inline-flex w-full justify-center rounded px-3 py-2 text-sm font-medium text-white hover:bg-opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-opacity-75">
                            {type.toLowerCase()}
                            <ChevronDownIcon
                              className="ml-2 -mr-1 h-5 w-5 text-violet-200 hover:text-violet-100"
                              // aria-hidden="true"
                            />
                          </Menu.Button>
                        </div>
                        <Transition
                          as={Fragment}
                          enter="transition ease-out duration-100"
                          enterFrom="transform opacity-0 scale-95"
                          enterTo="transform opacity-100 scale-100"
                          leave="transition ease-in duration-75"
                          leaveFrom="transform opacity-100 scale-100"
                          leaveTo="transform opacity-0 scale-95"
                        >
                          <Menu.Items className="absolute right-0 mt-2 w-56 origin-top-right divide-y divide-gray-100 rounded-md bg-primary shadow ring-1 ring-black ring-opacity-5 focus:outline-none">
                            <div className="px-1 py-1">
                              <Menu.Item>
                                {({ active }) => (
                                  <button
                                    title="Anime"
                                    onClick={() => setType("ANIME")}
                                    className={`${
                                      active
                                        ? "bg-secondary text-white"
                                        : "text-white"
                                    } group flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm`}
                                  >
                                    <PlayIcon className="w-6 h-6" />
                                    <span>Anime</span>
                                  </button>
                                )}
                              </Menu.Item>
                              <Menu.Item>
                                {({ active }) => (
                                  <button
                                    title="Manga"
                                    onClick={() => setType("MANGA")}
                                    className={`${
                                      active
                                        ? "bg-secondary text-white"
                                        : "text-white"
                                    } group flex w-full items-center gap-3 rounded-md px-2 py-2 text-sm`}
                                  >
                                    <BookOpenIcon className="w-6 h-6" />
                                    <span>Manga</span>
                                  </button>
                                )}
                              </Menu.Item>
                            </div>
                          </Menu.Items>
                        </Transition>
                      </Menu>
                      <SearchByImage
                        searchPalette={true}
                        setIsOpen={setIsOpen}
                      />
                    </div>
                  </div>
                  {/* Saisie et résultats dans UN bloc, de la couleur des cases. */}
                  <div className="mt-1 overflow-hidden rounded-2xl border border-white/10 bg-[#101116] shadow-2xl">
                  <div className="flex items-center gap-3 px-5 text-base font-medium">
                    <MagnifyingGlassIcon className="h-5 w-5 shrink-0 text-white/55" />
                    <Combobox.Input
                      ref={focusInput}
                      className="min-w-0 flex-1 border-0 bg-transparent py-4 text-white outline-none"
                      placeholder={t("search.searchSomething")}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    {query ? (
                      <button
                        type="button"
                        aria-label={t("common.close", "Fermer")}
                        onClick={() => {
                          if (focusInput.current) {
                            focusInput.current.value = "";
                            focusInput.current.focus();
                          }
                          setQuery("");
                        }}
                        className="shrink-0 text-white/60 transition-colors hover:text-white"
                      >
                        <XMarkIcon className="h-5 w-5" />
                      </button>
                    ) : null}
                    <kbd className="shrink-0 rounded-md border border-white/15 bg-white/[.06] px-2 py-1 font-karla text-[11px] font-semibold text-white/70 [@media(hover:none)]:hidden">
                      esc
                    </kbd>
                  </div>
                  <Combobox.Options
                    static
                    className="as-scroller flex max-h-[50dvh] flex-col gap-2 overflow-y-auto border-t border-white/10 empty:hidden [&:has(>li)]:p-2"
                  >
                    {!loading ? (
                      <Fragment>
                        {data && data?.length > 0
                          ? data?.map((i) => (
                              <Combobox.Option
                                key={i.id}
                                value={i.id}
                                /* Pas d'`overflow-hidden` : découpée par la carte,
                                   la bannière (masquée, donc sur sa propre couche)
                                   laissait des coins en escalier. Elle porte
                                   elle-même son arrondi, à l'intérieur du liseré. */
                                className="relative flex h-[92px] shrink-0 cursor-pointer items-stretch gap-3 rounded-xl bg-[#101116] p-1.5"
                              >
                                {/* La bannière occupe la droite et s'efface vers
                                    la gauche, sous l'affiche et le titre. Un <img>
                                    différé : ces images ne passent par aucun
                                    redimensionnement (`unoptimized`). */}
                                {i.bannerImage ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={i.bannerImage}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    className="pointer-events-none absolute right-px top-px h-[calc(100%-2px)] w-[80%] rounded-r-[11px] object-cover opacity-60"
                                    style={{ WebkitMaskImage: BANNER_FADE, maskImage: BANNER_FADE }}
                                  />
                                ) : null}
                                <div className="relative h-full w-[53px] shrink-0 overflow-hidden rounded-lg bg-primary/60">
                                  {i.coverImage?.medium ? (
                                    <Image
                                      src={i.coverImage.medium}
                                      alt="coverImage"
                                      width={100}
                                      height={150}
                                      className="h-full w-full object-cover"
                                    />
                                  ) : (
                                    <div className="grid h-full w-full place-items-center text-white/40">
                                      {type === "ANIME" ? <PlayIcon className="h-5 w-5" /> : <BookOpenIcon className="h-5 w-5" />}
                                    </div>
                                  )}
                                </div>
                                <div className="relative flex min-w-0 flex-1 flex-col justify-between py-1 pr-2 [text-shadow:0_1px_4px_rgba(0,0,0,.85)]">
                                  <h3 className="truncate font-karla font-semibold">
                                    {highlight(pickTitle(i.title, titlePref) ?? "", query)}
                                  </h3>
                                  <div className="flex items-center justify-between gap-3">
                                    <p className="truncate text-[13px] font-semibold text-white/85">
                                      {metaOf(i, t("anime.epShort")).join("  ·  ")}
                                    </p>
                                    {i.averageScore ? (
                                      <span className="flex shrink-0 items-center gap-1 text-[13px] font-bold tabular-nums text-white">
                                        <StarIcon className="h-4 w-4 text-action" />
                                        {+(i.averageScore / 10).toFixed(1)}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                                <span aria-hidden className="as-glass-edge" />
                              </Combobox.Option>
                            ))
                          : !loading &&
                            debounceSearch !== "" && (
                              <p className="flex-center font-karla gap-3 p-5">
                                {t("search.noResults")}
                              </p>
                            )}
                        {nextPage && (
                          <button
                            type="button"
                            title="View More"
                            onClick={() => {
                              router.push(
                                `/en/search/${type.toLowerCase()}/${
                                  query !== "" ? `?search=${query}` : ""
                                }`
                              );
                              setIsOpen(false);
                              setQuery("");
                            }}
                            className="flex-center font-karla gap-2 py-4 hover:bg-primary/30 cursor-pointer"
                          >
                            <span>View More</span>
                            <ChevronRightIcon className="w-4 h-4" />
                          </button>
                        )}
                      </Fragment>
                    ) : (
                      <div className="flex-center gap-3 p-5">
                        <div className="flex justify-center">
                          <div className="lds-ellipsis">
                            <span></span>
                            <span></span>
                            <span></span>
                            <span></span>
                          </div>
                        </div>
                      </div>
                    )}
                  </Combobox.Options>
                  </div>
                </Combobox>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
