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
 * l'intensité suit ce nombre. Les flèches feuillettent 32 mois en arrière
 * (ce que le serveur garde).
 */

/* 32 mois : le journal en garde 1000 jours depuis le fil AniList (03/11/2026). */
const MONTHS_BACK = 32;

/** Affiches demandées à AniList, pour la session (`null` = en cours / inconnu). */
const fetched = new Map<number, { cover: string | null; title: string } | null>();

export function useLocalDays(enabled: boolean): WatchDays | null {
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
 * LA PLACE DES SATELLITES : un nid d'abeille autour du disque (02/11/2026,
 * maquette « Voile du calendrier »).
 *
 * 6 places sur la première couronne, 12 sur la deuxième, 18 sur la troisième…
 * Chaque couronne commence en haut et tourne dans le sens horaire. La forme
 * reste la même au bord du widget, quitte à en dépasser (le portail le
 * permet). Distances en diamètres de disque.
 */
/* 0,7 dans la maquette ; « agrandis un peu les images » (02/11, Luc). */
const SAT = 0.85;
/** Écart entre deux bulles voisines, et entre le jour et le premier anneau. */
const SAT_GAP = 0.21;
function hexLayout(n: number) {
  const d = SAT + SAT_GAP;
  let R = 1;
  while (3 * R * (R + 1) < n) R++;
  const pts: { x: number; y: number; ring: number; a: number }[] = [];
  const c = Math.cos(-Math.PI / 6);
  const s = Math.sin(-Math.PI / 6);
  for (let i = -R; i <= R; i++) {
    for (let j = -R; j <= R; j++) {
      const ring = (Math.abs(i) + Math.abs(j) + Math.abs(i + j)) / 2;
      if (!ring || ring > R) continue;
      const x = j * d * c;
      const y = -i * d + j * d * s;
      pts.push({ x, y, ring, a: ((Math.atan2(y, x) * 180) / Math.PI + 450 + 1e-6) % 360 });
    }
  }
  pts.sort((p, q) => p.ring - q.ring || p.a - q.a);
  /* LE JOUR EST AGRANDI (×1,1) : sans rien, le premier anneau le touchait
     (02/11, Luc). Tout le nid s'écarte du centre de ce qu'il faut pour que le
     jour ait le même écart que deux bulles entre elles. */
  const push = 0.55 + SAT / 2 + SAT_GAP - d;
  const spots = pts.slice(0, n).map((p) => {
    const r = Math.hypot(p.x, p.y);
    return { x: p.x * (1 + push / r), y: p.y * (1 + push / r) };
  });
  /* Demi-côté du carré où le voile est dessiné : tout le nid, marge et fondu
     compris (un carré fixe coupait le flou net au-delà de 5 couronnes). */
  const ext = Math.max(1, ...spots.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) + SAT / 2 + 0.8;
  /* L'arrivée en cascade dure au plus ~0,5 s, quel que soit le nombre. */
  return { size: SAT, spots, ext, step: Math.min(35, 500 / Math.max(1, n)) };
}

/** Courbe de Bézier CSS en JS : le voile suit les mêmes courbes que les bulles. */
function bezier(p1x: number, p1y: number, p2x: number, p2y: number) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  const dX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (v: number) => {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    let t = v;
    for (let i = 0; i < 8; i++) {
      const e = X(t) - v, dd = dX(t);
      if (Math.abs(e) < 1e-5 || Math.abs(dd) < 1e-6) break;
      t -= e / dd;
    }
    return Y(Math.min(1, Math.max(0, t)));
  };
}
const SPRING = bezier(0.3, 1.35, 0.5, 1);
const EASE_OUT = bezier(0.22, 0.8, 0.24, 1);
/** Marge du voile autour de chaque bulle, en diamètres de disque. */
const VEIL_M = 0.28;
const CLOSE_MS = 280;
/** Temps d'immobilité de la souris avant d'ouvrir un jour. */
const STILL_MS = 180;

export function CalendarBlock({
  served,
  entries,
  bubbles = true,
}: {
  /** Les jours du propriétaire, servis au visiteur. Absent : cet appareil. */
  served?: WatchDays | null;
  entries: ProfileEntry[];
  /** Les autres animes du jour en bulles au survol (réglage du widget). */
  bubbles?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const pref = useTitlePref();
  const local = useLocalDays(served == null);
  const [fetchedTick, setFetchedTick] = useState(0);
  const days = served ?? local;

  /* Le mois affiché, en décalage depuis le mois courant (0, -1, … -12). */
  const [offset, setOffset] = useState(0);

  /* LA COURONNE OUVERTE. Elle est rendue dans un portail, par-dessus toute la
     page : dans la carte, son `overflow` la coupait au bord du widget (Luc).
     La souris passe du jour aux cercles, qui ne sont plus ses enfants : un
     court délai avant la fermeture laisse traverser les interstices. */
  const [orbit, setOrbit] = useState<OrbitState | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const release = useCallback(() => {
    keep();
    closeTimer.current = setTimeout(() => {
      setOrbit((o) => (o ? { ...o, closing: true } : o));
      /* Le temps que le compteur du jour revienne (as-cal-ct-in, 0,68 s). */
      closeTimer.current = setTimeout(() => setOrbit(null), 700);
    }, 160);
  }, [keep]);
  const openOrbit = (
    key: string,
    el: HTMLElement,
    ids: number[],
    day: Omit<OrbitState, "id" | "key" | "rect" | "ids" | "closing" | "count">,
  ) => {
    keep();
    const r = el.getBoundingClientRect();
    /* Le compteur peut être masqué (widget étroit) : la copie fait pareil. */
    const ct = el.querySelector(".as-cal-count");
    setOrbit({
      id: ++orbitSeq,
      key,
      rect: { left: r.left, top: r.top, size: r.width },
      ids,
      ...day,
      count: !!ct && getComputedStyle(ct).display !== "none",
      closing: false,
    });
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
  /* LA SOURIS DOIT S'ARRÊTER (02/11/2026, Luc) : traverser le calendrier
     n'ouvre rien. Chaque mouvement sur un jour relance l'attente ; la couronne
     s'ouvre après STILL_MS sans bouger. */
  const stillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsettle = useCallback(() => {
    if (stillTimer.current) clearTimeout(stillTimer.current);
    stillTimer.current = null;
  }, []);
  const settle = (open: () => void) => {
    unsettle();
    stillTimer.current = setTimeout(open, STILL_MS);
  };
  useEffect(() => () => (keep(), unsettle()), [keep, unsettle]);

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
    if (!days) return;
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
  }, [days, known, pref]);

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

  /* TOUJOURS 6 LIGNES (02/11/2026, Luc) : la taille du disque ne change pas
     d'un mois à l'autre. Elle est calculée pour 6 semaines, le pire cas ; un
     mois de 5 semaines laisse sa dernière ligne vide. (Essayé avant : 5 lignes
     avec le 30/31 remonté en haut à gauche, refusé.) */
  const rows = 6;
  const arrow =
    "flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-colors hover:bg-white/15 hover:text-white disabled:pointer-events-none disabled:opacity-25";

  return (
    <div className="as-cal flex h-full min-h-0 flex-col gap-3">
      {/* L'EN-TÊTE (28/10/2026, Luc : « pas pratique ») : le mois et son bilan à
          gauche, les commandes groupées à droite — les flèches encadraient le
          mois et sautaient avec la longueur de son nom. */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0">
          <p className="truncate font-outfit text-[15px] font-bold capitalize leading-tight text-white">
            {monthLabel}
          </p>
          <p className="as-cal-sum truncate font-karla text-[11px] leading-tight text-white/45">
            {watchedDays
              ? `${t("profile.blocks.calendar.days", { count: watchedDays })} · ${t(
                  "profile.blocks.calendar.episodes",
                  { count: episodes },
                )}`
              : t("profile.blocks.calendar.none")}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
        </div>
      </div>

      {/* LA GRILLE EST CARRÉE (28/10/2026, Luc) : des cases de même côté, même
          écart en largeur et en hauteur. Leur côté est le plus grand qui fasse
          tenir 7 colonnes et `rows` lignes dans la place offerte (unités de
          conteneur, .as-cal-board) ; le reste se répartit autour, la grille
          restant centrée. Les initiales des jours sont dans la même grille,
          donc toujours alignées sur leurs colonnes. */}
      <div className="as-cal-stage relative min-h-0 flex-1">
        <div
          key={`${year}-${month}`}
          className={`as-cal-grid as-cal-board${orbit && !orbit.closing ? " has-open" : ""}`}
          style={{ ["--rows" as any]: rows, gridTemplateRows: `var(--lab) repeat(${rows}, var(--c))` }}
        >
          {weekdays.map((w, i) => (
            <span
              key={`wd-${i}`}
              className="self-center text-center font-karla text-[10px] font-bold uppercase text-white/35"
            >
              {w}
            </span>
          ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {cells.map((c, i) => {
          const w = days[c.key];
          const today = c.key === todayKey;
          const future = c.key > todayKey;
          const top = w ? known.get(w.a[0]) : undefined;
          const art = top?.cover ?? null;
          const delay = { animationDelay: `${Math.min(i, 30) * 12}ms` };

          if (!w) {
            return (
              <span key={c.key} style={delay} className={`as-cal-day as-cal-cell${future ? " opacity-40" : ""}`}>
                {/* Un peu plus visibles (02/11/2026, Luc) : 0,04 → 0,07 et 40 → 55 %. */}
                <span className={`as-cal-dot flex items-center justify-center rounded-full bg-white/[0.07]${today ? " ring-2 ring-action" : ""}`}>
                  <span className="as-cal-num font-karla text-[12px] font-bold text-white/55">{c.d}</span>
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
          const others = bubbles ? w.a.slice(1).filter((id) => known.get(id)?.cover) : [];

          return (
            <span
              key={c.key}
              style={delay}
              className={`as-cal-day as-cal-cell group${others.length ? " as-cal-multi" : ""}${
                orbit?.key === c.key ? (orbit.closing ? " is-back" : " is-open") : ""
              }`}
              onMouseMove={
                others.length
                  ? (e) => {
                      const dot = e.currentTarget.firstElementChild as HTMLElement;
                      settle(() =>
                        openOrbit(c.key, dot, others, {
                          main: w.a[0],
                          d: c.d,
                          n: w.n,
                          art,
                          heat,
                          today,
                          mainN: w.c?.[0],
                          counts: others.map((id) => w.c?.[w.a.indexOf(id)]),
                        }),
                      );
                    }
                  : undefined
              }
              onMouseLeave={
                others.length
                  ? () => {
                      unsettle();
                      release();
                    }
                  : undefined
              }
            >
              <span className="as-cal-dot">
                <Link
                  href={`/en/anime/${w.a[0]}`}
                  aria-label={label}
                  className={`as-cal-main absolute inset-0 flex items-center justify-center overflow-hidden rounded-full as-clip-bg [--clip-bg:var(--surface-card,#1a1a24)]${
                    today ? " ring-2 ring-action" : ""
                  }`}
                >
                  {art ? (
                    <>
                      <Image src={art} alt="" fill sizes="96px" className="object-cover" />
                      <span className="absolute inset-0" style={{ background: "rgba(0,0,0,0.38)" }} />
                    </>
                  ) : (
                    <span className="absolute inset-0" style={{ background: `rgba(233, 69, 96, ${heat.toFixed(2)})` }} />
                  )}
                  {/* Le numéro au centre, en blanc, comme les jours vides. */}
                  <span className="as-cal-num relative font-karla text-[12px] font-bold text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.8)]">
                    {c.d}
                  </span>
                </Link>
                {/* SUR LE BORD DU ROND (02/11/2026, Luc) : au coin du carré, le
                    compteur s'éloignait du disque à mesure qu'il grandissait.
                    Point d'ancrage à 45° sur le cercle (85 %), compteur centré
                    dessus par flex : son `transform` reste libre pour
                    l'animation as-cal-ct-out/in. Le total du jour reste rose ; au
                    survol, les compteurs par anime sont en EP_BLUE (ListBlocks.tsx),
                    le bleu des barres d'épisodes. */}
                {/* Pas de compteur pour un seul épisode (02/11/2026, Luc). */}
                {w.n > 1 ? (
                  <span className="as-cal-badge">
                    {/* UN SEUL ANIME CE JOUR (06/11/2026, Luc) : pas de couronne à
                        ouvrir, mais le survol montre quand même ses épisodes en
                        bleu (« x4 »), comme les bulles d'un jour à plusieurs. */}
                    {others.length ? (
                      <span className="as-cal-count pointer-events-none rounded-full bg-action px-1.5 font-outfit text-[10px] font-bold leading-[16px] text-white as-cal-detour">
                        {w.n}
                      </span>
                    ) : (
                      <span className="relative inline-flex">
                        <span className="as-cal-count pointer-events-none rounded-full bg-action px-1.5 font-outfit text-[10px] font-bold leading-[16px] text-white transition-opacity duration-200 as-cal-detour group-hover:opacity-0">
                          {w.n}
                        </span>
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                          <span className="rounded-full bg-[#0ea5e9] px-[7px] font-outfit text-[10px] font-bold leading-[16px] text-white">
                            {t("profile.blocks.calendar.eps", { count: w.c?.[0] ?? w.n })}
                          </span>
                        </span>
                      </span>
                    )}
                  </span>
                ) : null}
              </span>
            </span>
          );
        })}
        </div>
      </div>
      {orbit && typeof document !== "undefined"
        ? createPortal(
            <Orbit key={orbit.id} orbit={orbit} known={known} onEnter={keep} onLeave={release} />,
            document.body,
          )
        : null}
    </div>
  );
}

let orbitSeq = 0;
type OrbitState = {
  /** Un numéro par ouverture : rouvrir le même jour relance le voile. */
  id: number;
  key: string;
  rect: { left: number; top: number; size: number };
  ids: number[];
  main: number;
  d: number;
  n: number;
  art: string | null;
  heat: number;
  today: boolean;
  count: boolean;
  /** Épisodes de l'anime du jour, puis de chaque bulle (même ordre que `ids`). */
  mainN?: number;
  counts: (number | undefined)[];
  closing: boolean;
};

/**
 * Les cercles autour du jour ouvert, posés en `fixed` sur son disque.
 *
 * LE VOILE (02/11/2026, maquette « Voile du calendrier ») : un verre léger et
 * flou derrière les bulles, découpé à la forme de la zone de survol. Son
 * masque est la réunion d'un disque dégradé par bulle, redessinée à chaque
 * image pour suivre les bulles qui sortent du centre : le contour s'estompe
 * au lieu de trancher. Le jour est recopié par-dessus le voile, son compteur
 * s'efface pendant le survol et revient à la fermeture.
 */
function Orbit({
  orbit,
  known,
  onEnter,
  onLeave,
}: {
  orbit: OrbitState;
  known: Map<number, { cover: string | null; title: string }>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const others = orbit.ids;
  const ring = hexLayout(others.length);
  const D = orbit.rect.size;

  const veil = useRef<HTMLSpanElement>(null);
  const t0 = useRef<number | null>(null);
  useEffect(() => {
    const el = veil.current;
    if (!el) return;
    const start = (t0.current ??= performance.now());
    const tc = orbit.closing ? performance.now() : 0;
    const P = ring.ext * D;
    const f = 0.17 * D;
    let raf = 0;
    const tick = (now: number) => {
      let done = true;
      const prog = (delay: number, dur: number, fn: (v: number) => number) => {
        if (orbit.closing) {
          const t = (now - tc) / CLOSE_MS;
          if (t < 1) done = false;
          return 1 - SPRING(Math.min(1, t));
        }
        const t = (now - start - delay) / dur;
        if (t < 1) done = false;
        return fn(Math.max(0, t));
      };
      const C = [{ x: 0, y: 0, r: 0.5 + (0.05 + VEIL_M) * prog(0, 300, EASE_OUT) }];
      ring.spots.forEach((p, k) => {
        const e = prog(ring.step * k, 550, SPRING);
        const k01 = Math.min(1, Math.max(0, e));
        C.push({ x: p.x * e, y: p.y * e, r: Math.max(0, (ring.size / 2) * (0.25 + 0.75 * Math.max(0, e)) + VEIL_M * k01) });
      });
      const mask =
        C.filter((c) => c.r * D > 1)
          .map((c) => {
            const x = (P + c.x * D).toFixed(1);
            const y = (P + c.y * D).toFixed(1);
            const r = c.r * D;
            return `radial-gradient(circle at ${x}px ${y}px, #000 ${Math.max(0, r - f).toFixed(1)}px, rgba(0,0,0,.55) ${r.toFixed(1)}px, transparent ${(r + f * 1.3).toFixed(1)}px)`;
          })
          .join(",") || "linear-gradient(transparent,transparent)";
      el.style.webkitMaskImage = mask;
      el.style.maskImage = mask;
      if (!done) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbit.closing]);

  /* LA ZONE DE SURVOL ÉPOUSE LES BULLES (28/10/2026, Luc). Un disque invisible
     un peu plus large derrière chacune, et derrière le jour : leur réunion
     dessine la forme de la couronne, marge comprise, et ils se chevauchent
     assez pour combler les interstices. C'est aussi la forme du voile. */
  const marge = VEIL_M * D;
  const zones = [
    { x: D / 2, y: D / 2, r: 0.55 * D + marge },
    ...ring.spots.map((p) => ({ x: D / 2 + p.x * D, y: D / 2 + p.y * D, r: (ring.size * D) / 2 + marge })),
  ];
  const actif = !orbit.closing;
  /* Place d'une bulle : translation en % de la bulle elle-même (taille SAT ×
     disque), départ en cascade (--d). Partagée avec son compteur. */
  const satStyle = (k: number) =>
    ({
      "--tx": `${((ring.spots[k].x / ring.size) * 100).toFixed(1)}%`,
      "--ty": `${((ring.spots[k].y / ring.size) * 100).toFixed(1)}%`,
      "--d": `${Math.round(k * ring.step)}ms`,
      width: `${ring.size * 100}%`,
      height: `${ring.size * 100}%`,
      left: `${((1 - ring.size) / 2) * 100}%`,
      top: `${((1 - ring.size) / 2) * 100}%`,
    }) as React.CSSProperties;
  return (
    <div
      className={`as-cal-orbit${orbit.closing ? " is-closing" : ""}`}
      style={{
        position: "fixed",
        left: orbit.rect.left,
        top: orbit.rect.top,
        width: D,
        height: D,
        zIndex: 70,
        pointerEvents: "none",
      }}
    >
      <span
        ref={veil}
        aria-hidden
        className="as-cal-veil"
        style={{
          left: D / 2 - ring.ext * D,
          top: D / 2 - ring.ext * D,
          width: 2 * ring.ext * D,
          height: 2 * ring.ext * D,
        }}
      />
      {zones.map((z, i) => (
        <span
          key={`z${i}`}
          aria-hidden
          className="absolute rounded-full"
          style={{
            left: z.x - z.r,
            top: z.y - z.r,
            width: z.r * 2,
            height: z.r * 2,
            pointerEvents: actif ? "auto" : "none",
          }}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        />
      ))}
      {/* Le jour, recopié au-dessus du voile ; toujours cliquable. */}
      <Link
        href={`/en/anime/${orbit.main}`}
        aria-hidden
        tabIndex={-1}
        className={`as-cal-hc absolute inset-0 z-[5] flex items-center justify-center rounded-full${
          orbit.today ? " ring-2 ring-action" : ""
        }`}
        style={{ pointerEvents: actif ? "auto" : "none" }}
        onMouseEnter={onEnter}
      >
        <span className="absolute inset-0 overflow-hidden rounded-full">
          {orbit.art ? (
            <>
              <Image src={orbit.art} alt="" fill sizes="96px" className="object-cover" />
              <span className="absolute inset-0" style={{ background: "rgba(0,0,0,0.38)" }} />
            </>
          ) : (
            <span className="absolute inset-0" style={{ background: `rgba(233, 69, 96, ${orbit.heat.toFixed(2)})` }} />
          )}
        </span>
        <span className="relative font-karla text-[12px] font-bold text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.8)]">
          {orbit.d}
        </span>
        {orbit.count ? (
          <span className="as-cal-badge">
            <span className="as-cal-hcount pointer-events-none rounded-full bg-action px-1.5 font-outfit text-[10px] font-bold leading-[16px] text-white as-cal-detour">
              {orbit.n}
            </span>
          </span>
        ) : null}
        {/* AU SURVOL, LES ÉPISODES DE CHAQUE ANIME (02/11/2026, Luc) : le total
            du jour s'efface, celui de l'anime du jour prend sa place, et
            chaque bulle a le sien. Rien pour un seul épisode, comme la case. */}
        {(orbit.mainN ?? 0) > 1 ? (
          <span className="as-cal-badge">
            <span className="as-cal-ep pointer-events-none rounded-full bg-[#0ea5e9] px-[7px] font-outfit text-[10px] font-bold leading-[16px] text-white as-cal-detour">
              {t("profile.blocks.calendar.eps", { count: orbit.mainN })}
            </span>
          </span>
        ) : null}
      </Link>
      {others.map((id, k) => (
        <Link
          key={id}
          href={`/en/anime/${id}`}
          aria-label={known.get(id)?.title}
          className="as-cal-sat"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          style={satStyle(k)}
        >
          <span className="absolute inset-0 overflow-hidden rounded-full">
            <Image src={known.get(id)?.cover || ""} alt="" fill sizes="80px" className="object-cover" />
          </span>
        </Link>
      ))}
      {/* LES COMPTEURS PAR-DESSUS TOUT (02/11/2026, Luc) : posés dans leur
          bulle, ils passaient sous la bulle voisine. Une couche à part, après
          toutes les bulles, qui reprend leur place et leur mouvement. */}
      {others.map((id, k) =>
        (orbit.counts[k] ?? 0) > 1 ? (
          <span key={`ep-${id}`} aria-hidden className="as-cal-sat as-cal-sat-tag" style={satStyle(k)}>
            <span className="as-cal-badge">
              <span className="as-cal-ep pointer-events-none rounded-full bg-[#0ea5e9] px-[7px] font-outfit text-[10px] font-bold leading-[16px] text-white as-cal-detour">
                {t("profile.blocks.calendar.eps", { count: orbit.counts[k] })}
              </span>
            </span>
          </span>
        ) : null,
      )}
    </div>
  );
}
