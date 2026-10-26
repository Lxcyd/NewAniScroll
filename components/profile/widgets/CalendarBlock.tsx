import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { dayKey, watchDays, type WatchDays } from "@/lib/profile/activity";
import { readHistory } from "@/lib/profile/history";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import type { ProfileEntry } from "@/lib/profile/types";
import { readProgressMap, PROGRESS_EVENT } from "@/lib/watch/progress";

/**
 * LE CALENDRIER DU MOIS : un jour, un visionnage.
 *
 * La source est celle de la flamme de « Vu récemment » — la table de
 * progression, une entrée datée par épisode (cf. `watchDays`,
 * lib/profile/activity.ts). Comme les deux blocs d'activité : chez soi, elle
 * est lue sur cet appareil et suit la lecture en direct ; sur le profil d'un
 * autre, elle vient du rendu serveur (`served`).
 *
 * Chaque jour regardé porte l'affiche de l'anime le plus vu ce jour-là et le
 * nombre d'épisodes ; l'option `covers` éteinte le remplace par une teinte dont
 * l'intensité suit ce nombre. Les flèches feuillettent les douze derniers mois
 * (ce que le serveur garde).
 */

const MONTHS_BACK = 12;

/** Affiches demandées à AniList, pour la session (`null` = en cours / inconnu). */
const fetched = new Map<number, { cover: string | null; title: string } | null>();

function useLocalDays(enabled: boolean): WatchDays | null {
  const [days, setDays] = useState<WatchDays | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const read = () => setDays(watchDays(readProgressMap()));
    read();
    window.addEventListener(PROGRESS_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(PROGRESS_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [enabled]);
  return days;
}

/**
 * LA PLACE DES SATELLITES : des anneaux concentriques autour du disque.
 *
 * Un seul cercle ne tient plus au-delà d'une dizaine d'animes. Les cercles rapetissent avec leur nombre, le premier
 * anneau se remplit, puis le suivant, chacun un peu plus loin ; le dernier
 * répartit ce qui reste sur tout son tour. Distances en diamètres de disque.
 */
function ringLayout(n: number) {
  const size = n <= 8 ? 0.9 : n <= 20 ? 0.76 : 0.64;
  /* PAS DE CHEVAUCHEMENT (Luc) : un diamètre et un peu plus entre deux
     voisins d'un même anneau, et autant d'un anneau au suivant. */
  const gap = size * 1.1;
  const spots: { a: number; r: number }[] = [];
  let r = 0.55 + size / 2 + 0.06;
  let left = n;
  for (let ring = 0; left > 0; ring++) {
    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / gap));
    const here = Math.min(cap, left);
    /* Les anneaux se décalent d'un demi-pas : ils s'emboîtent au lieu de
       s'aligner en rayons. */
    const off = ring % 2 ? 180 / here : 0;
    for (let k = 0; k < here; k++) spots.push({ a: -90 + off + (360 / here) * k, r });
    left -= here;
    r += gap;
  }
  /* L'arrivée en cascade dure au plus ~0,5 s, quel que soit le nombre. */
  return { size, spots, step: Math.min(35, 500 / Math.max(1, n)) };
}

export function CalendarBlock({
  served,
  entries,
  covers: coversOn = true,
}: {
  /** Les jours du propriétaire, servis au visiteur. Absent : cet appareil. */
  served?: WatchDays | null;
  entries: ProfileEntry[];
  covers?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const pref = useTitlePref();
  const local = useLocalDays(served == null);
  const days = served ?? local;

  /* Le mois affiché, en décalage depuis le mois courant (0, -1, … -12). */
  const [offset, setOffset] = useState(0);
  const [fetchedTick, setFetchedTick] = useState(0);

  /* LA COURONNE OUVERTE. Elle est rendue dans un portail, par-dessus toute la
     page : dans la carte, son `overflow` la coupait au bord du widget (Luc).
     La souris passe du jour aux cercles, qui ne sont plus ses enfants : un
     court délai avant la fermeture laisse traverser les interstices. */
  const [orbit, setOrbit] = useState<{
    key: string;
    rect: { left: number; top: number; size: number };
    ids: number[];
    closing: boolean;
  } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const release = useCallback(() => {
    keep();
    closeTimer.current = setTimeout(() => {
      setOrbit((o) => (o ? { ...o, closing: true } : o));
      closeTimer.current = setTimeout(() => setOrbit(null), 240);
    }, 160);
  }, [keep]);
  const openOrbit = (key: string, el: HTMLElement, ids: number[]) => {
    keep();
    const r = el.getBoundingClientRect();
    setOrbit({ key, rect: { left: r.left, top: r.top, size: r.width }, ids, closing: false });
  };
  useEffect(() => {
    if (!orbit) return;
    /* La couronne est posée en `fixed` : elle ne suivrait pas un défilement. */
    const shut = () => {
      keep();
      setOrbit(null);
    };
    window.addEventListener("scroll", shut, { passive: true, capture: true });
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("scroll", shut, { capture: true });
      window.removeEventListener("resize", shut);
    };
  }, [orbit, keep]);
  useEffect(() => keep, [keep]);

  /* Affiches et titres : la liste du profil d'abord, l'historique de
     l'appareil ensuite (un anime regardé sans être ajouté). */
  const known = useMemo(() => {
    const m = new Map<number, { cover: string | null; title: string }>();
    if (served == null) {
      for (const r of readHistory(200)) {
        m.set(r.aniId, { cover: r.cover ?? null, title: r.animeTitle || `#${r.aniId}` });
      }
    }
    for (const e of entries) {
      m.set(e.mediaId, {
        cover: e.cover ?? m.get(e.mediaId)?.cover ?? null,
        title: e.title ? pickTitle(e.title, pref) : m.get(e.mediaId)?.title || `#${e.mediaId}`,
      });
    }
    fetched.forEach((v, id) => {
      if (v && !m.get(id)?.cover) m.set(id, v);
    });
    return m;
    // `local` : l'historique a pu grandir depuis le dernier calcul.
  }, [entries, pref, served, local, fetchedTick]);

  /* LES ANIMES QUE NI LA LISTE NI L'HISTORIQUE NE CONNAISSENT (regardés sans
     être ajoutés) n'avaient pas d'affiche, donc pas de cercle au survol. Une
     requête AniList groupée, directe depuis le navigateur (rien côté Vercel),
     gardée pour la session. */
  useEffect(() => {
    if (!days || !coversOn) return;
    const missing = new Set<number>();
    for (const w of Object.values(days)) {
      for (const id of w.a) if (!known.get(id)?.cover && !fetched.has(id)) missing.add(id);
    }
    const ids = Array.from(missing).slice(0, 50);
    if (!ids.length) return;
    ids.forEach((id) => fetched.set(id, null));
    fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        query:
          "query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id title{romaji english} coverImage{large}}}}",
        variables: { ids },
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        for (const m of j?.data?.Page?.media ?? []) {
          fetched.set(m.id, {
            cover: m.coverImage?.large ?? null,
            title: pickTitle(m.title, pref) || `#${m.id}`,
          });
        }
        setFetchedTick((n) => n + 1);
      })
      .catch(() => {});
  }, [days, known, coversOn, pref]);

  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = first.getFullYear();
  const month = first.getMonth();
  const inMonth = new Date(year, month + 1, 0).getDate();
  /* Semaine du lundi : getDay() vaut 0 le dimanche. */
  const lead = (first.getDay() + 6) % 7;
  const todayKey = dayKey(now.getTime());

  const locale = i18n.language || "fr";
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(first);
  const dayLabel = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" });
  /* Le 1er janvier 2024 était un lundi. */
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(new Date(2024, 0, 1 + i)),
  );

  const cells: { key: string; d: number; date: Date }[] = [];
  for (let d = 1; d <= inMonth; d++) {
    const date = new Date(year, month, d);
    cells.push({ key: dayKey(date.getTime()), d, date });
  }

  let watchedDays = 0;
  let episodes = 0;
  let max = 1;
  for (const c of cells) {
    const w = days?.[c.key];
    if (!w) continue;
    watchedDays++;
    episodes += w.n;
    max = Math.max(max, w.n);
  }

  if (!days) return <div className="h-full" />;

  const arrow =
    "flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-25";

  return (
    <div className="as-cal flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className={arrow}
          onClick={() => setOffset((o) => Math.max(-MONTHS_BACK, o - 1))}
          disabled={offset <= -MONTHS_BACK}
          aria-label={t("profile.blocks.calendar.prev")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
        </button>
        <p className="min-w-[7.5rem] text-center font-outfit text-sm font-bold capitalize text-white">
          {monthLabel}
        </p>
        <button
          type="button"
          className={arrow}
          onClick={() => setOffset((o) => Math.min(0, o + 1))}
          disabled={offset >= 0}
          aria-label={t("profile.blocks.calendar.next")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
          </svg>
        </button>
        <p className="as-cal-sum ml-auto truncate pl-2 font-karla text-[11px] text-white/45">
          {watchedDays
            ? `${t("profile.blocks.calendar.days", { count: watchedDays })} · ${t(
                "profile.blocks.calendar.episodes",
                { count: episodes },
              )}`
            : t("profile.blocks.calendar.none")}
        </p>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center font-karla text-[10px] font-bold uppercase text-white/35">
        {weekdays.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>

      <div
        key={`${year}-${month}`}
        className={`as-cal-grid grid min-h-0 flex-1 grid-cols-7 gap-1${orbit && !orbit.closing ? " has-open" : ""}`}
        style={{ gridTemplateRows: `repeat(${Math.ceil((lead + inMonth) / 7)}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {cells.map((c, i) => {
          const w = days[c.key];
          const today = c.key === todayKey;
          const future = c.key > todayKey;
          const top = w ? known.get(w.a[0]) : undefined;
          const art = coversOn && top?.cover ? top.cover : null;
          const delay = { animationDelay: `${Math.min(i, 30) * 12}ms` };

          if (!w) {
            return (
              <span key={c.key} style={delay} className={`as-cal-day as-cal-cell${future ? " opacity-40" : ""}`}>
                <span className={`as-cal-dot flex items-center justify-center rounded-full bg-white/[0.04]${today ? " ring-2 ring-action" : ""}`}>
                  <span className="as-cal-num font-karla text-[12px] font-bold text-white/40">{c.d}</span>
                </span>
              </span>
            );
          }

          const label = `${dayLabel.format(c.date)} · ${t("profile.blocks.calendar.episodes", {
            count: w.n,
          })}`;
          /* Sans affiche : une teinte qui monte avec le nombre d'épisodes. */
          const heat = 0.22 + 0.58 * (w.n / max);
          /* Les autres animes du jour : au survol, ils sortent du centre et se
             rangent en anneaux autour de la case (globals.css, .as-cal-sat). */
          const others = coversOn ? w.a.slice(1).filter((id) => known.get(id)?.cover) : [];

          return (
            <span
              key={c.key}
              style={delay}
              className={`as-cal-day as-cal-cell group${others.length ? " as-cal-multi" : ""}${
                orbit?.key === c.key && !orbit.closing ? " is-open" : ""
              }`}
              onMouseEnter={
                others.length
                  ? (e) => openOrbit(c.key, e.currentTarget.firstElementChild as HTMLElement, others)
                  : undefined
              }
              onMouseLeave={others.length ? release : undefined}
            >
              <span className="as-cal-dot">
                <Link
                  href={`/en/anime/${w.a[0]}`}
                  aria-label={label}
                  className={`as-cal-main absolute inset-0 flex items-center justify-center overflow-hidden rounded-full bg-as-card${
                    today ? " ring-2 ring-action" : ""
                  }`}
                >
                  {art ? (
                    <>
                      <Image src={art} alt="" fill sizes="96px" className="object-cover" />
                      <span className="absolute inset-0 bg-[rgba(0,0,0,0.38)]" />
                    </>
                  ) : (
                    <span className="absolute inset-0" style={{ background: `rgba(233, 69, 96, ${heat.toFixed(2)})` }} />
                  )}
                  {/* Le numéro au centre, en blanc, comme les jours vides. */}
                  <span className="as-cal-num relative font-karla text-[12px] font-bold text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.8)]">
                    {c.d}
                  </span>
                </Link>
                <span className="as-cal-count pointer-events-none absolute -bottom-0.5 -right-0.5 z-[3] rounded-full bg-action px-1.5 font-outfit text-[10px] font-bold leading-[16px] text-white shadow">
                  {w.n}
                </span>
              </span>
            </span>
          );
        })}
      </div>
      {orbit && typeof document !== "undefined"
        ? createPortal(
            <Orbit orbit={orbit} known={known} onEnter={keep} onLeave={release} />,
            document.body,
          )
        : null}
    </div>
  );
}

/** Les cercles autour du jour ouvert, posés en `fixed` sur son disque. */
function Orbit({
  orbit,
  known,
  onEnter,
  onLeave,
}: {
  orbit: { rect: { left: number; top: number; size: number }; ids: number[]; closing: boolean };
  known: Map<number, { cover: string | null; title: string }>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const others = orbit.ids;
  const ring = ringLayout(others.length);
  return (
    <div
      className={`as-cal-orbit${orbit.closing ? " is-closing" : ""}`}
      style={{
        position: "fixed",
        left: orbit.rect.left,
        top: orbit.rect.top,
        width: orbit.rect.size,
        height: orbit.rect.size,
        zIndex: 70,
        pointerEvents: "none",
      }}
    >
      {others.map((id, k) => (
        <Link
          key={id}
          href={`/en/anime/${id}`}
          aria-label={known.get(id)?.title}
          className="as-cal-sat"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          style={
            {
              "--a": `${ring.spots[k].a}deg`,
              "--t": `${Math.round((ring.spots[k].r / ring.size) * 100)}%`,
              "--d": `${Math.round(k * ring.step)}ms`,
              width: `${ring.size * 100}%`,
              height: `${ring.size * 100}%`,
              left: `${((1 - ring.size) / 2) * 100}%`,
              top: `${((1 - ring.size) / 2) * 100}%`,
            } as React.CSSProperties
          }
        >
          <Image src={known.get(id)?.cover || ""} alt="" fill sizes="80px" className="object-cover" />
        </Link>
      ))}
    </div>
  );
}
