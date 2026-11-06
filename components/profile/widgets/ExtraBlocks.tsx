import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { translateTag } from "@/lib/i18n/animeTags";
import { studioOrder } from "@/lib/profile/favorite";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { readProgressMap, PROGRESS_EVENT } from "@/lib/watch/progress";
import { busiestDay, dayKey, type Binge, type WatchDay, type WatchDays } from "@/lib/profile/activity";
import { affinity, readAffinity, tasteOf, type Match } from "@/lib/profile/affinity";
import { cachedFriendTastes, FRIENDS_EVENT, friendTastes, type FriendTaste } from "@/lib/friends/client";
import type { ProfileEntry } from "@/lib/profile/types";
import { Bar, EmptyBlock } from "./common";
import HoverVolume from "@/components/shared/HoverVolume";
import EmojiButton from "@/components/watch/party/EmojiButton";
import { ANIME_EMOJI_MAP } from "@/lib/watch2gether/animeEmojis";
import { ANIME_STICKER_MAP } from "@/lib/watch2gether/animeStickers";

/**
 * LES SEPT DERNIERS BLOCS DU PROFIL (03/11/2026, Luc : « procède comme les
 * autres widgets pour faire ceux qui manquent »). Ils étaient « soon » : chacun
 * a trouvé une source sans rien ajouter au serveur — cf. lib/profile/blocks.ts.
 */

/* ── Métadonnées d'anime ──────────────────────────────────────────────────
   Titre, affiche, format, genres, année d'un anime : la liste du profil les
   a pour ce qu'elle contient (format et genres seulement sur une liste
   AniList). Le reste — un anime regardé hors liste, une liste locale — est
   demandé à AniList directement depuis le navigateur, par paquets de 50, et
   gardé pour la session (rien côté Vercel). */

export type Meta = {
  title: string;
  cover: string | null;
  format: string | null;
  genres: string[];
  year: number | null;
  airing: boolean;
};

const metaCache = new Map<number, Meta | null>();
/* Tous les blocs qui attendent : celui qui a lancé la requête n'est pas le
   seul à vouloir sa réponse (le binge et les épinglés demandent souvent le
   même anime au même moment, et le second ne relance rien). */
const metaListeners = new Set<() => void>();

export function useAnimeMeta(ids: number[], entries: ProfileEntry[]): Map<number, Meta> {
  const pref = useTitlePref();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    metaListeners.add(on);
    return () => {
      metaListeners.delete(on);
    };
  }, []);
  const key = ids.join(",");
  const byEntry = useMemo(() => {
    const m = new Map<number, ProfileEntry>();
    for (const e of entries) m.set(e.mediaId, e);
    return m;
  }, [entries]);

  useEffect(() => {
    const missing = ids.filter((id) => {
      const e = byEntry.get(id);
      return !(e && e.format && e.genres) && !metaCache.has(id);
    });
    if (!missing.length) return;
    missing.forEach((id) => metaCache.set(id, null));
    for (let i = 0; i < missing.length; i += 50) {
      fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query:
            "query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id title{romaji english native} coverImage{large} format genres seasonYear status}}}",
          variables: { ids: missing.slice(i, i + 50) },
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          for (const m of j?.data?.Page?.media ?? []) {
            metaCache.set(m.id, {
              title: pickTitle(m.title, pref) || `#${m.id}`,
              cover: m.coverImage?.large ?? null,
              format: m.format ?? null,
              genres: m.genres ?? [],
              year: m.seasonYear ?? null,
              airing: m.status === "RELEASING",
            });
          }
          metaListeners.forEach((f) => f());
        })
        /* AniList injoignable : les blocs s'affichent avec ce que la liste sait. */
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byEntry]);

  return useMemo(() => {
    const out = new Map<number, Meta>();
    for (const id of ids) {
      const e = byEntry.get(id);
      const f = metaCache.get(id);
      if (e) {
        out.set(id, {
          title: pickTitle(e.title ?? {}, pref) || f?.title || `#${id}`,
          cover: e.cover ?? f?.cover ?? null,
          format: e.format ?? f?.format ?? null,
          genres: e.genres?.length ? e.genres : (f?.genres ?? []),
          year: e.year ?? f?.year ?? null,
          airing: e.nextEpisode != null || !!f?.airing,
        });
      } else if (f) out.set(id, f);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, byEntry, pref, tick]);
}

/* LES TAGS ANILIST (06/11/2026, Luc : la carte « un anime avec un tag au
   hasard ») : ni la liste ni `Meta` ne les ont. Demandés au navigateur, par
   paquets de 50, seulement quand une carte tag est sur la grille. Un tag ne
   compte qu'à partir d'un rang de 50 % (en dessous, AniList le juge accessoire). */
const tagCache = new Map<number, string[] | null>();
const tagListeners = new Set<() => void>();
function useAnimeTags(ids: number[], enabled: boolean): Map<number, string[]> {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    tagListeners.add(on);
    return () => {
      tagListeners.delete(on);
    };
  }, []);
  const key = ids.join(",");
  useEffect(() => {
    if (!enabled) return;
    const missing = ids.filter((id) => !tagCache.has(id));
    if (!missing.length) return;
    missing.forEach((id) => tagCache.set(id, null));
    for (let i = 0; i < missing.length; i += 50) {
      fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: "query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id tags{name rank}}}}",
          variables: { ids: missing.slice(i, i + 50) },
        }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          for (const m of j?.data?.Page?.media ?? [])
            tagCache.set(m.id, (m.tags ?? []).filter((x: { rank?: number }) => (x.rank ?? 0) >= 50).map((x: { name: string }) => x.name));
          tagListeners.forEach((f) => f());
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return useMemo(() => {
    const out = new Map<number, string[]>();
    for (const id of ids) {
      const v = tagCache.get(id);
      if (v) out.set(id, v);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
}

/** La table de progression de CET appareil, tenue à jour pendant qu'on regarde. */
function useLocalBinge(enabled: boolean): Binge | null | undefined {
  const [binge, setBinge] = useState<Binge | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const read = () => setBinge(busiestDay(readProgressMap()));
    read();
    window.addEventListener(PROGRESS_EVENT, read);
    return () => window.removeEventListener(PROGRESS_EVENT, read);
  }, [enabled]);
  return binge;
}

function Cover({ src, className = "" }: { src: string | null | undefined; className?: string }) {
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-lg bg-white/[0.06] ${className}`} style={{ aspectRatio: "2 / 3" }}>
      {src ? <Image src={src} alt="" fill sizes="120px" className="object-cover" /> : null}
    </span>
  );
}

/* ── Plus long binge ───────────────────────────────────────────────────── */

export function BingeBlock({
  served,
  entries,
  order = "most",
  account,
}: {
  served?: Binge | null;
  /** Chez soi : le binge compté sur la sauvegarde du compte. */
  account?: Binge | null;
  entries: ProfileEntry[];
  /** Le paquet : le plus regardé devant, ou dans l'ordre de visionnage. */
  order?: "most" | "watched";
}) {
  const { t, i18n } = useTranslation();
  const local = useLocalBinge(served === undefined);
  /* Chez soi, la table de CET appareil peut être presque vide (dev.aniscroll.com
     n'a pas la même mémoire que le site principal) : on garde le plus long des
     deux, celui de l'appareil et celui du compte (03/11/2026). */
  /* Le binge de démo (NEXT_PUBLIC_CAL_DEMO) est retiré le même jour : le fil
     AniList donne de vrais binges. */
  const binge =
    served !== undefined
      ? served
      : local === undefined
        ? undefined
        : !local || (account && account.n > local.n)
          ? (account ?? local)
          : local;
  /* L'ordre de visionnage n'existe que sur un binge compté depuis le
     03/11/2026 (`o`) ; avant, le paquet reste dans l'ordre du plus regardé. */
  const ids = useMemo(() => (!binge ? [] : order === "watched" && binge.o ? binge.o : binge.a), [binge, order]);
  const counts = useMemo(() => {
    if (!binge?.c) return undefined;
    const by = new Map(binge.a.map((id, i) => [id, binge.c![i]]));
    return ids.map((id) => by.get(id) ?? 0);
  }, [binge, ids]);
  const meta = useAnimeMeta(ids, entries);
  const clickTarget = useClickTarget();
  /* La place de la carte : le paquet en déduit la taille des cartes et
     jusqu'où il peut s'étaler. */
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [binge]);
  if (binge === undefined) return <div className="h-full" />;
  if (!binge) return <EmptyBlock note={t("profile.blocks.binge.empty")} />;

  const h = Math.floor(binge.minutes / 60);
  const m = binge.minutes % 60;
  const date = new Intl.DateTimeFormat(i18n.language || "fr", { day: "numeric", month: "long", year: "numeric" }).format(
    new Date(binge.end),
  );
  return (
    /* Le texte à distance du paquet (03/11/2026, Luc : « trop près ») : les
       cartes inclinées débordent de leur boîte, d'où un écart large. Plus
       gros, et sans la ligne « Demon Slayer et 4 autres » : le paquet les
       montre tous. */
    <div ref={rootRef} className="as-binge relative flex h-full min-h-0 items-center pl-2.5">
      <BingeDeck ids={ids} counts={counts} meta={meta} width={box.w} height={box.h} clickTarget={clickTarget} />
      {/* Au milieu de la place qui reste à droite du paquet, centré
          (03/11/2026, Luc : « plus à droite, et centre le nombre »). */}
      <div className="as-binge-text min-w-0 flex-1 text-center transition-opacity duration-300">
        <p className="as-binge-n font-outfit font-bold leading-none text-white">{binge.n}</p>
        <p className="as-binge-l mt-1 font-karla font-semibold leading-tight text-white/90">
          {t("profile.blocks.binge.episodes", { count: binge.n })}
        </p>
        <p className="as-binge-d mt-1.5 font-karla text-txt">
          <span className="whitespace-nowrap">
            {h ? t("profile.blocks.binge.duration", { h, m: String(m).padStart(2, "0") }) : t("profile.blocks.binge.minutes", { m })}
            {" ·"}
          </span>{" "}
          <span className="whitespace-nowrap">{date}</span>
        </p>
      </div>
    </div>
  );
}

/**
 * LES AFFICHES DU BINGE EN PAQUET DE CARTES (03/11/2026, Luc : « qu'on puisse
 * les hover et interagir comme un deck, et tous les animes du binge »).
 *
 * Au repos, un paquet serré en éventail, la plus regardée devant. Au survol
 * du paquet, les cartes s'étalent vers la droite — par-dessus le texte, qui
 * s'efface (`.as-binge:has(.as-deck:hover)`, globals.css) — d'autant plus
 * qu'il y a de la place. Une carte survolée se soulève, se redresse et montre
 * son titre et ses épisodes ; un clic ouvre l'anime.
 */
function BingeDeck({
  ids,
  counts,
  meta,
  width,
  height,
  clickTarget,
}: {
  ids: number[];
  counts?: number[];
  meta: Map<number, Meta>;
  width: number;
  height: number;
  clickTarget: ReturnType<typeof useClickTarget>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const n = ids.length;
  /* En 2×1, le paquet prend plus de place (03/11/2026, Luc) : cartes plus
     hautes, éventail plus ouvert, jusqu'à 60 % de la largeur. */
  const roomy = width > 420;
  const cardH = Math.max(60, Math.min(height * (roomy ? 0.9 : 0.88), roomy ? 230 : 160, width * 0.42 * 1.5));
  const cardW = (cardH * 2) / 3;
  /* Serré : chaque carte dépasse d'un quart de la précédente, moins quand il
     y en a beaucoup. Étalé : jusqu'à une carte entière, dans la largeur. */
  /* Le paquet serré ne prend jamais plus de la moitié de la carte : en 1×1,
     le texte garde sa place (03/11/2026, Luc : « pas responsive »). */
  const share = roomy ? 0.56 : 0.5;
  const tight =
    n > 1
      ? /* Peu de cartes : elles se chevauchent toujours, mais occupent la
           place au lieu de rester tassées (03/11/2026, Luc). */
        Math.max(0, Math.min(cardW * (roomy ? 0.6 : 0.45), (width * share - cardW) / (n - 1)))
      : 0;
  const wide = n > 1 ? Math.max(tight, Math.min(cardW * 1.06, (width - cardW - 8) / (n - 1))) : 0;
  const step = open ? wide : tight;
  const mid = (n - 1) / 2;
  return (
    <div
      className="as-deck relative z-10 shrink-0 self-center"
      style={{ width: cardW + tight * (n - 1) + 6, height: cardH, marginLeft: roomy ? cardH * 0.06 : 0 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        setOpen(false);
        setHot(null);
      }}
    >
      {ids.map((id, i) => {
        const m = meta.get(id);
        const up = hot === i;
        const rot = open ? (up ? 0 : (i - mid) * 1.5) : (i - mid) * (n > 6 ? 2 : 4);
        return (
          <Link
            key={id}
            href={animeHref(id, clickTarget)}
            aria-label={m?.title}
            onMouseEnter={() => setHot(i)}
            onFocus={() => {
              setOpen(true);
              setHot(i);
            }}
            className="absolute left-0 top-0 block rounded-lg outline-none transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-white/70"
            style={{
              width: cardW,
              height: cardH,
              zIndex: up ? 100 : n - i,
              transform: `translateX(${i * step}px) translateY(${up ? -10 : 0}px) rotate(${rot}deg) scale(${up ? 1.08 : 1})`,
              transformOrigin: "50% 100%",
            }}
          >
            <Cover src={m?.cover} className="h-full w-full shadow-[0_6px_16px_rgba(0,0,0,0.45)]" />
            {/* Le titre et les épisodes, sur la carte soulevée. */}
            <span
              className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-start gap-1 rounded-b-lg bg-gradient-to-t from-black via-black/80 to-transparent px-2 pb-2 pt-8 transition-opacity duration-200 ${
                up ? "opacity-100" : "opacity-0"
              }`}
            >
              <span className="line-clamp-2 w-full break-words text-[11px] font-bold leading-[1.2] text-white">
                {m?.title ?? "…"}
              </span>
              {counts?.[i] ? (
                <span className="rounded-full bg-action px-1.5 py-px font-karla text-[10px] font-bold leading-snug text-white">
                  {t("profile.blocks.binge.eps", { count: counts[i] })}
                </span>
              ) : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/* ── Objectif annuel ───────────────────────────────────────────────────── */

export function GoalBlock({
  days,
  unit,
  target,
  colored = false,
}: {
  days: WatchDays | null;
  unit: "episodes" | "animes";
  target: number;
  /** L'anneau du rouge au vert selon l'avancée, au lieu de la couleur du site. */
  colored?: boolean;
}) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const done = useMemo(() => {
    if (!days) return 0;
    let n = 0;
    const ids = new Set<number>();
    for (const [k, d] of Object.entries(days)) {
      if (!k.startsWith(`${year}-`)) continue;
      n += d.n;
      d.a.forEach((id) => ids.add(id));
    }
    return unit === "animes" ? ids.size : n;
  }, [days, unit, year]);
  /* De 1×1 à 2×2 (03/11/2026, Luc : « 2 max et adapte la taille ») : l'anneau
     suit la place de la carte, et le texte suit l'anneau. */
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days]);
  if (!days) return <div className="h-full" />;

  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  const elapsed = (Date.now() - start) / (end - start);
  const pace = Math.round(target * elapsed);
  const pct = Math.min(1, done / Math.max(1, target));
  const R = 34;
  const C = 2 * Math.PI * R;
  /* Option « couleur selon l'avancée » (03/11/2026, Luc) : rouge tant qu'on
     n'a pas fait grand-chose, vert tout près du but — la teinte suit la part
     de l'objectif atteinte, de 0° (rouge) à 135° (vert). */
  const ring = colored ? `hsl(${Math.round(135 * pct)} 78% 52%)` : "var(--brand-primary, #E94560)";
  /* Une carte haute (2×2) empile : l'anneau en grand, le compte dessous. */
  const tall = box.h > 300;
  /* 84 px en 1×1 ; jusqu'à 280 px en 2×2. */
  const size = !box.w
    ? 84
    : tall
      ? Math.max(72, Math.min(280, box.h * 0.6, box.w * 0.7))
      : Math.max(72, Math.min(200, box.h * 0.92, box.w * 0.42));
  const k = Math.min(size / 84, tall ? 1.6 : 2);
  /* LE TEXTE SUIT LA PLACE QUI LUI RESTE (03/11/2026, Luc : « plus gros quand
     il y a de la place ») : ~100 px à droite de l'anneau en 1×1 = tailles de
     base ; jusqu'à 2,8× quand la carte s'élargit. Empilé, il a toute la largeur. */
  const room = tall ? box.w * 0.55 : box.w - size - 20 * Math.min(k, 1.8);
  const tk = box.w ? Math.max(1, Math.min(2.8, room / 95)) : 1;
  return (
    /* L'anneau à gauche, le compte à droite (03/11/2026, Luc : « remets
       l'interface d'avant », après un essai avec le compte dans l'anneau). */
    <div
      ref={boxRef}
      className={`flex h-full min-h-0 items-center justify-center ${tall ? "flex-col text-center" : ""}`}
      style={{ gap: 20 * Math.min(k, 1.8) }}
    >
      <div className="relative aspect-square shrink-0" style={{ width: size, height: size }}>
        <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
          {/* Piste et arc fantôme un peu plus FINS que l'avancée (03/11/2026) :
              à même épaisseur, leurs bords anticrénelés dépassaient en liseré
              sombre autour de l'arc coloré. */}
          <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7.2" />
          {/* LE RYTHME EN ARC FANTÔME (03/11/2026, Luc, choisi parmi 20) : la
              piste s'éclaircit jusqu'à où il faudrait en être aujourd'hui
              pour finir pile le 31 décembre ; l'avancée se peint par-dessus. */}
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="7.2"
            strokeLinecap="round"
            strokeDasharray={`${C * Math.min(1, elapsed)} ${C}`}
          >
            <title>{t("profile.blocks.goal.paceMark", { count: pace })}</title>
          </circle>
          <circle
            cx="40"
            cy="40"
            r={R}
            fill="none"
            stroke={ring}
            strokeWidth="8"
            strokeLinecap="round"
            /* Plein à 100 % : un tiret de toute la circonférence laissait une
               fente d'un pixel à la jointure, où la piste grise se voyait. */
            strokeDasharray={pct >= 1 ? undefined : `${C * pct} ${C}`}
            className="transition-[stroke-dasharray,stroke] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)]"
          />
        </svg>
        {/* LE POURCENTAGE AU CENTRE (03/11/2026, Luc, choisi parmi 20). Il
            continue au-delà de 100 % quand l'objectif est dépassé. */}
        <span
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-outfit font-bold leading-none text-white"
          style={{ fontSize: size * (done / Math.max(1, target) >= 0.995 ? 0.2 : 0.24) }}
        >
          {Math.round((done / Math.max(1, target)) * 100)}
          <span className="font-karla font-semibold text-txt" style={{ fontSize: size * 0.12, marginLeft: size * 0.02 }}>
            %
          </span>
        </span>
      </div>
      <div className="min-w-0">
        <p className="whitespace-nowrap font-outfit font-bold leading-none text-white" style={{ fontSize: 22 * tk }}>
          {done}
          <span className="font-karla font-semibold text-txt" style={{ fontSize: 12 * tk }}>
            {" "}
            / {target}
          </span>
        </p>
        <p className="mt-1 font-karla leading-snug text-txt" style={{ fontSize: 9 * Math.min(tk, 2) }}>
          {t(`profile.blocks.goal.${unit}`, { count: target })} · {year}
        </p>
        {/* Plus de ligne « N de retard / d'avance » (03/11/2026, Luc) : l'arc
            fantôme le montre. Reste « Objectif atteint ». */}
        {done >= target ? (
          <p className="mt-1.5 font-karla font-bold text-action" style={{ fontSize: 9.5 * Math.min(tk, 2) }}>
            {t("profile.blocks.goal.reached")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── Trois épinglés ────────────────────────────────────────────────────── */

export type Pin = { id: number; note: string };
export const PIN_NOTE_MAX = 120;

export function parsePins(raw: string | undefined): Pin[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p)
      ? p
          .filter((x) => Number.isFinite(Number(x?.id)))
          .slice(0, 3)
          .map((x) => ({ id: Number(x.id), note: String(x.note ?? "").slice(0, PIN_NOTE_MAX) }))
      : [];
  } catch {
    return [];
  }
}

export function PinnedBlock({
  pins,
  entries,
  isOwner,
  onChange,
  showScore = true,
}: {
  pins: Pin[];
  entries: ProfileEntry[];
  isOwner: boolean;
  /** Présent = l'éditeur (crayon de la carte). */
  onChange?: (pins: Pin[]) => void;
  /** La note du profil sous le titre (réglage du widget, 03/11/2026). */
  showScore?: boolean;
}) {
  const { t } = useTranslation();
  const clickTarget = useClickTarget();
  const scores = useMemo(() => new Map(entries.map((e) => [e.mediaId, e.score])), [entries]);
  const meta = useAnimeMeta(
    pins.map((p) => p.id),
    entries,
  );

  if (onChange) return <PinEditor pins={pins} entries={entries} onChange={onChange} meta={meta} />;
  if (!pins.length)
    return <EmptyBlock note={t(isOwner ? "profile.blocks.pinned.emptyOwner" : "profile.blocks.pinned.empty")} />;

  return (
    <div className="grid h-full min-h-0 gap-3" style={{ gridTemplateColumns: `repeat(${pins.length}, minmax(0, 1fr))` }}>
      {pins.map((p) => {
        const m = meta.get(p.id);
        return (
          <Link
            key={p.id}
            href={animeHref(p.id, clickTarget)}
            className="group relative flex min-h-0 min-w-0 gap-3 rounded-xl bg-black/15 p-2 ring-1 ring-white/[0.06] transition-colors hover:bg-black/25"
          >
            <Cover src={m?.cover} className="h-full max-h-[160px] transition-transform duration-200 group-hover:scale-[1.03]" />
            {/* `pb-5` sous la note de l'anime : la phrase s'arrête avant elle. */}
            <div className={`flex min-w-0 flex-1 flex-col justify-center gap-1.5 ${showScore && scores.get(p.id) ? "pb-5" : ""}`}>
              <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{m?.title ?? "…"}</p>
              {p.note ? (
                /* SUR PLUSIEURS LIGNES (03/11/2026, Luc) : un mot sans espace se
                   coupe au bord au lieu de déborder, et les retours à la ligne
                   tapés sont gardés. */
                <p className="line-clamp-4 whitespace-pre-line font-karla text-[12px] italic leading-snug text-txt [overflow-wrap:anywhere]">
                  « {p.note} »
                </p>
              ) : null}
            </div>
            {/* La note en bas à droite de la carte (03/11/2026, Luc, choisie
                parmi 20) : une signature sous le commentaire. */}
            {/* Toujours rendue, montrée ou cachée en fondu quand on bascule le
                réglage (03/11/2026, Luc). */}
            {scores.get(p.id) ? (
              <span
                aria-hidden={!showScore}
                className={`absolute bottom-2 right-3 font-karla text-[16px] font-bold text-as-score transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  showScore ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-90 opacity-0"
                }`}
              >
                ★ {scores.get(p.id)}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

/** Choisir un titre de la liste, par recherche. */
function EntryPicker({
  entries,
  exclude,
  onPick,
  onClose,
}: {
  entries: ProfileEntry[];
  exclude: Set<number>;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pref = useTitlePref();
  const [q, setQ] = useState("");
  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    return entries
      .filter((e) => !exclude.has(e.mediaId))
      .filter((e) => !s || [e.title?.english, e.title?.romaji, e.title?.native].some((x) => x?.toLowerCase().includes(s)));
    /* Toute la liste (03/11/2026, Luc : la limite à 40 ne montrait que les
         10/10), DANS L'ORDRE DU MENU MUSIQUE DU STUDIO : favoris, puis
         revisionnages, puis note, puis statut (`studioOrder`). */
  }, [entries, exclude, q]);
  const ordered = useMemo(() => studioOrder(found, (e) => pickTitle(e.title ?? {}, pref)), [found, pref]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("profile.blocks.pinned.search")}
          className="min-w-0 flex-1 rounded-lg bg-black/30 px-3 py-1.5 font-karla text-[13px] text-white outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        <button type="button" onClick={onClose} className="rounded-lg px-2 font-karla text-[12px] text-white/60 hover:text-white">
          {t("profile.blocks.pinned.cancel")}
        </button>
      </div>
      <div className="as-scroller grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
        {ordered.map((e) => (
          <button
            key={e.mediaId}
            type="button"
            onClick={() => onPick(e.mediaId)}
            className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.06]"
          >
            <Cover src={e.cover} className="h-9" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-white">{pickTitle(e.title ?? {}, pref)}</span>
            {e.score ? <span className="font-karla text-[11px] font-bold text-as-score">★ {e.score}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function PinEditor({
  pins,
  entries,
  onChange,
  meta,
}: {
  pins: Pin[];
  entries: ProfileEntry[];
  onChange: (pins: Pin[]) => void;
  meta: Map<number, Meta>;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const scores = useMemo(() => new Map(entries.map((e) => [e.mediaId, e.score])), [entries]);
  if (picking)
    return (
      <EntryPicker
        entries={entries}
        exclude={new Set(pins.map((p) => p.id))}
        onClose={() => setPicking(false)}
        onPick={(id) => {
          onChange([...pins, { id, note: "" }].slice(0, 3));
          setPicking(false);
        }}
      />
    );
  return (
    <div className="grid h-full min-h-0 grid-cols-3 gap-3">
      {[0, 1, 2].map((i) => {
        const p = pins[i];
        if (!p)
          return (
            <button
              key={i}
              type="button"
              onClick={() => setPicking(true)}
              className="flex items-center justify-center rounded-xl border border-dashed border-white/15 font-karla text-[13px] text-white/50 transition-colors hover:border-white/30 hover:text-white"
            >
              + {t("profile.blocks.pinned.add")}
            </button>
          );
        return (
          <div key={p.id} className="flex min-h-0 min-w-0 gap-2 rounded-xl bg-black/15 p-2 ring-1 ring-white/[0.06]">
            <span className="relative block h-full max-h-[160px] shrink-0">
              <Cover src={meta.get(p.id)?.cover} className="h-full max-h-[160px]" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex items-start gap-1">
                <p className="line-clamp-2 flex-1 text-[12px] font-semibold leading-tight text-white">{meta.get(p.id)?.title ?? "…"}</p>
                <button
                  type="button"
                  aria-label={t("profile.blocks.pinned.remove")}
                  onClick={() => onChange(pins.filter((x) => x.id !== p.id))}
                  className="text-white/40 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <textarea
                value={p.note}
                maxLength={PIN_NOTE_MAX}
                onChange={(e) => onChange(pins.map((x) => (x.id === p.id ? { ...x, note: e.target.value } : x)))}
                placeholder={t("profile.blocks.pinned.notePlaceholder")}
                className="min-h-0 flex-1 resize-none rounded-lg bg-black/30 p-2 font-karla text-[12px] text-white outline-none ring-1 ring-white/10 focus:ring-white/30"
              />
              {/* LA NOTE EN BAS À DROITE, comme sur la carte du profil
                  (03/11/2026, Luc) : la case du texte raccourcit pour lui
                  laisser sa ligne. */}
              {scores.get(p.id) ? (
                <span className="shrink-0 self-end whitespace-nowrap font-karla text-[16px] font-bold leading-none text-as-score">
                  ★ {scores.get(p.id)}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Top OP / ED ───────────────────────────────────────────────────────── */

export type FavTheme = { a: number; s: string };
/** Pas de limite voulue (03/11/2026, Luc) : seulement le plafond de sauvegarde (grid.ts). */
export const THEMES_MAX = 250;

export function parseThemes(raw: string | undefined): FavTheme[] {
  try {
    const p = JSON.parse(raw || "[]");
    return Array.isArray(p)
      ? p
          .filter((x) => Number.isFinite(Number(x?.a)) && typeof x?.s === "string")
          .slice(0, THEMES_MAX)
          .map((x) => ({ a: Number(x.a), s: String(x.s).slice(0, 8) }))
      : [];
  } catch {
    return [];
  }
}

type ThemeRow = {
  slug: string;
  /** `ins` : une autre musique de l'anime (AnisongDB), « SONG » à l'écran. */
  kind?: "op" | "ed" | "ins";
  song: string | null;
  artists: string[];
  /** Pochette du morceau (Deezer, iTunes…), si elle est connue. */
  cover?: string | null;
  video?: { url: string; audio?: string | null } | null;
  /** Le mp3 d'AnisongDB du même slug : un repli quand le fichier
      d'AnimeThemes ne démarre pas. */
  alt?: string | null;
};

/* LES MUSIQUES D'UN ANIME, COMME LE MENU MUSIQUE DU STUDIO (03/11/2026, Luc :
   « fais OP / ED ou musique », avec leurs images). Les OP/ED d'AnimeThemes
   (/api/v2/themes, avec les pochettes quand elles sont prêtes) et les autres
   musiques d'AnisongDB (/api/v2/anisongs), dédoublonnées par slug. Une fois
   par session. `onBase` reçoit les OP/ED dès qu'ils arrivent, sans attendre
   AnisongDB, plus lent. */
const themeCache = new Map<number, Promise<ThemeRow[]>>();
const themeBaseSeen = new Map<number, ThemeRow[]>();
function themesOf(id: number, onBase?: (rows: ThemeRow[]) => void): Promise<ThemeRow[]> {
  const seen = themeBaseSeen.get(id);
  if (seen && onBase) onBase(seen);
  let p = themeCache.get(id);
  if (!p) {
    const main = fetch(`/api/v2/themes/${id}?v=4`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const covers = (j?.covers ?? {}) as Record<string, string | null>;
        const rows: ThemeRow[] = Array.isArray(j?.themes)
          ? (j.themes as ThemeRow[]).map((r) => ({ ...r, cover: r.cover ?? covers[r.slug] ?? null }))
          : [];
        themeBaseSeen.set(id, rows);
        onBase?.(rows);
        return rows;
      });
    const extra = fetch(`/api/v2/anisongs/${id}?v=6`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.songs) ? (j.songs as ThemeRow[]) : []))
      .catch(() => [] as ThemeRow[]);
    p = Promise.all([main, extra])
      .then(([base, more]) => {
        const bySlug = new Map(more.map((m) => [m.slug.toUpperCase(), m]));
        const have = new Set(base.map((x) => x.slug.toUpperCase()));
        return [
          ...base.map((r) => {
            const m = bySlug.get(r.slug.toUpperCase());
            return { ...r, cover: r.cover ?? m?.cover ?? null, alt: m?.video?.audio || m?.video?.url || null };
          }),
          ...more.filter((x) => !have.has(x.slug.toUpperCase())),
        ];
      })
      .catch(() => {
        themeCache.delete(id);
        return [] as ThemeRow[];
      });
    themeCache.set(id, p);
  }
  return p;
}

/** Absent de la carte tant que les musiques de l'anime ne sont pas arrivées. */
function useThemes(ids: number[]): Map<number, ThemeRow[]> {
  const [map, setMap] = useState<Map<number, ThemeRow[]>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    let alive = true;
    const put = (id: number, rows: ThemeRow[]) => {
      if (alive) setMap((m) => (m.get(id) === rows ? m : new Map(m).set(id, rows)));
    };
    ids.forEach((id) => void themesOf(id, (rows) => put(id, rows)).then((rows) => put(id, rows)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

/* LES PASTILLES DU MENU MUSIQUE : OP à la couleur du site, ED en bleu, SONG en
   violet (BannerStudio, `row.chip`). */
function KindChip({ row, slug }: { row?: ThemeRow; slug: string }) {
  const kind = row?.kind ?? (/^OP/i.test(slug) ? "op" : /^ED/i.test(slug) ? "ed" : "ins");
  const color = kind === "op" ? "var(--brand-primary, #E94560)" : kind === "ed" ? "#8a9bff" : "#c084fc";
  return (
    <span
      className="shrink-0 rounded font-karla text-[10px] font-bold leading-none tracking-[.03em]"
      style={{
        padding: "3px 5px",
        background: kind === "ed" ? "rgba(120,140,255,0.14)" : `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
      }}
    >
      {kind === "ins" ? "SONG" : slug.toUpperCase()}
    </span>
  );
}

/** La pochette du morceau, carrée ; l'affiche de l'anime à défaut. */
function SongCover({ row, fallback, className = "" }: { row?: ThemeRow; fallback?: string | null; className?: string }) {
  const src = row?.cover || fallback || null;
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-md bg-white/[0.06] ${className}`}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : null}
    </span>
  );
}

function Skeleton({ rows = 3, tall = false }: { rows?: number; tall?: boolean }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
          <span className={`shrink-0 animate-pulse rounded-md bg-white/[0.07] ${tall ? "h-11 w-11" : "h-8 w-8"}`} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-3 w-3/5 animate-pulse rounded bg-white/[0.08]" style={{ animationDelay: `${i * 90}ms` }} />
            <span className="h-2.5 w-2/5 animate-pulse rounded bg-white/[0.05]" style={{ animationDelay: `${i * 90}ms` }} />
          </span>
        </div>
      ))}
    </>
  );
}

/* ── Le lecteur ──
   UN SEUL MORCEAU À LA FOIS SUR LA PAGE. Chaque ligne garde son <audio>,
   préchargé (`metadata` à l'affichage, le fichier entier au survol) : le clic
   démarre aussitôt au lieu d'attendre le réseau (Luc : « elles mettent
   beaucoup de temps à se lancer ou ne se lancent pas du tout »).
   L'ORDRE DES SOURCES : le mp3 d'AnisongDB d'abord (0,5 s au premier octet),
   le fichier audio d'AnimeThemes ensuite — a.animethemes.moe répondait 504
   au bout de 60 s le 03/11/2026 —, sa vidéo en dernier. Une source en erreur,
   ou qui n'a pas démarré 5 s après le clic, passe la main à la suivante. */
let playing: HTMLAudioElement | null = null;
const STALL_MS = 5000;

function fmt(s: number) {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function useTrack(sources: (string | null | undefined)[]) {
  const key = Array.from(new Set(sources.filter(Boolean))).join("|");
  const ref = useRef<HTMLAudioElement | null>(null);
  /** Passe à la source suivante (posée par l'effet, appelée par le délai). */
  const nextRef = useRef<() => void>(() => {});
  /** Repart de la première source (après un échec de toutes). */
  const resetRef = useRef<() => void>(() => {});
  const stall = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /* `failed` : AUCUNE source n'a répondu (03/11/2026 : les serveurs de fichiers
     d'AnimeThemes ne répondaient plus, et une version anglaise comme « We Are! »
     OP1-EN n'a pas de mp3 AnisongDB pour la relayer). La ligne le dit, et un
     clic réessaie, au lieu d'un bouton qui ne fait rien. */
  const [state, setState] = useState({ on: false, loading: false, t: 0, d: 0, started: false, failed: false });
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (!list.length) return;
    let k = 0;
    const a = new Audio();
    a.preload = "metadata";
    a.volume = readVolume();
    a.src = list[0];
    ref.current = a;
    const onVol = (v: number) => {
      a.volume = v;
    };
    volListeners.add(onVol);
    const sync = () =>
      setState((s) => ({ ...s, on: !a.paused, t: a.currentTime, d: Number.isFinite(a.duration) ? a.duration : s.d }));
    const onWait = () => setState((s) => ({ ...s, loading: true }));
    // Une musique qui démarre met en pause celle qui jouait.
    const onStart = () => {
      if (playing && playing !== a) playing.pause();
      playing = a;
    };
    const onPlay = () => {
      clearTimeout(stall.current);
      setState((s) => ({ ...s, loading: false, on: true, started: true }));
    };
    const onErr = () => {
      clearTimeout(stall.current);
      if (k + 1 >= list.length) {
        // Plus rien à essayer : on lâche la source qui pend, et on le dit.
        if (playing === a) playing = null;
        a.pause();
        a.removeAttribute("src");
        a.load();
        setState((s) => ({ ...s, loading: false, on: false, failed: true }));
        return;
      }
      const wasOn = playing === a;
      a.src = list[++k];
      if (wasOn) {
        stall.current = setTimeout(onErr, STALL_MS);
        void a.play().catch(() => {});
      }
    };
    nextRef.current = onErr;
    resetRef.current = () => {
      k = 0;
      a.src = list[0];
      setState((s) => ({ ...s, failed: false }));
    };
    a.addEventListener("timeupdate", sync);
    a.addEventListener("loadedmetadata", sync);
    a.addEventListener("pause", () => {
      clearTimeout(stall.current);
      setState((s) => ({ ...s, loading: false }));
      sync();
    });
    a.addEventListener("ended", sync);
    a.addEventListener("waiting", onWait);
    a.addEventListener("play", onStart);
    a.addEventListener("playing", onPlay);
    a.addEventListener("error", onErr);
    return () => {
      volListeners.delete(onVol);
      clearTimeout(stall.current);
      a.pause();
      if (playing === a) playing = null;
      a.removeAttribute("src");
      a.load();
      ref.current = null;
    };
  }, [key]);
  const warm = () => {
    const a = ref.current;
    if (a && a.preload !== "auto") a.preload = "auto";
  };
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (!a.paused) {
      clearTimeout(stall.current);
      a.pause();
      return;
    }
    if (state.failed) resetRef.current();
    if (playing && playing !== a) playing.pause();
    playing = a;
    const ready = a.readyState >= 3;
    setState((s) => ({ ...s, loading: !ready }));
    clearTimeout(stall.current);
    if (!ready) stall.current = setTimeout(() => nextRef.current(), STALL_MS);
    void a.play().catch((e: unknown) => {
      /* Refus du navigateur (pas d'interaction) : rien à essayer d'autre. */
      if ((e as Error)?.name === "NotAllowedError") {
        clearTimeout(stall.current);
        setState((s) => ({ ...s, loading: false, on: false }));
      }
    });
  };
  const seek = (t: number) => {
    const a = ref.current;
    if (!a) return;
    a.currentTime = t;
    setState((s) => ({ ...s, t, started: true }));
  };
  return { has: !!key, ...state, warm, toggle, seek };
}

/* ── Le volume ──
   UN RÉGLAGE À SOI, PAS UN PARAMÈTRE DU WIDGET (03/11/2026, Luc : « un bouton
   personnel pour le volume, pour les users aussi ») : chaque visiteur règle le
   sien, gardé dans son navigateur, et tous les morceaux le suivent. */
const VOL_KEY = "aniscroll:themesVolume";
const MUTE_KEY = "aniscroll:themesMuted";
/* Chaque écouteur reçoit le volume EFFECTIF (0 quand coupé). */
const volListeners = new Set<(v: number) => void>();
let volCache: number | null = null;
let mutedCache = false;
function readVolume(): number {
  if (volCache == null) {
    let v = 0.6;
    try {
      const raw = localStorage.getItem(VOL_KEY);
      if (raw != null && Number.isFinite(Number(raw))) v = Math.min(1, Math.max(0, Number(raw)));
      mutedCache = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* stockage refusé : le défaut */
    }
    volCache = v;
  }
  return mutedCache ? 0 : volCache;
}
function saveVolume() {
  try {
    localStorage.setItem(VOL_KEY, String(volCache));
    localStorage.setItem(MUTE_KEY, mutedCache ? "1" : "0");
  } catch {
    /* best-effort */
  }
  const eff = readVolume();
  volListeners.forEach((f) => f(eff));
}
function setVolume(v: number) {
  readVolume();
  volCache = Math.min(1, Math.max(0, v));
  saveVolume();
}
function setMuted(m: boolean) {
  readVolume();
  mutedCache = m;
  saveVolume();
}
function useVolume(): { v: number; muted: boolean } {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    readVolume();
    f();
    volListeners.add(f);
    return () => {
      volListeners.delete(f);
    };
  }, []);
  return { v: volCache ?? 0.6, muted: mutedCache };
}

/**
 * LE RAIL, AU DESSIN DE LA MUSIQUE DU PROFIL (BannerStudio `MusicRail`) : un
 * rail de 8 px, la partie jouée à la couleur du site, sans les bornes jaunes de
 * l'extrait (03/11/2026, Luc). On clique ou on glisse n'importe où dessus.
 */
function Rail({
  value,
  max,
  onSeek,
  label,
  className = "",
}: {
  value: number;
  max: number;
  onSeek: (v: number) => void;
  label: string;
  className?: string;
}) {
  const held = useRef(false);
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * max;
  };
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  /* Le glissement doux ne sert qu'à la lecture qui avance (une mise à jour
     toutes les ~250 ms). Un clic ou un glisser TÉLÉPORTE le rose sous la souris. */
  const prev = useRef(value);
  const smooth = !held.current && value >= prev.current && value - prev.current < 1.5;
  prev.current = value;
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max * 100) / 100}
      aria-valuenow={Math.round(value * 100) / 100}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        held.current = true;
        onSeek(at(e));
      }}
      onPointerMove={(e) => {
        if (held.current && e.buttons & 1) onSeek(at(e));
      }}
      onPointerUp={() => {
        held.current = false;
      }}
      onPointerCancel={() => {
        held.current = false;
      }}
      onKeyDown={(e) => {
        const step = max / 20;
        if (e.key === "ArrowLeft") onSeek(Math.max(0, value - step));
        else if (e.key === "ArrowRight") onSeek(Math.min(max, value + step));
        else return;
        e.preventDefault();
      }}
      className={`relative h-2 cursor-pointer touch-none overflow-hidden rounded-full bg-white/[0.09] outline-none focus-visible:ring-2 focus-visible:ring-white/30 ${className}`}
    >
      {/* Une pilule de toute la largeur, poussée hors du rail puis ramenée :
          le rose ENTRE petit à petit, arrondi des deux côtés dès le premier
          pixel (le rail rogne le début, la pilule arrondit la fin). */}
      <span
        className={`absolute inset-0 rounded-full bg-action ${smooth ? "transition-transform duration-300 ease-linear" : ""}`}
        style={{ transform: `translateX(${pct - 100}%)` }}
      />
    </div>
  );
}

/** Le volume : le même geste que la musique du profil (`HoverVolume`). */
function VolumeButton() {
  const { t } = useTranslation();
  const { v, muted } = useVolume();
  return (
    <HoverVolume
      muted={muted}
      volume={v}
      onMuted={setMuted}
      onVolume={setVolume}
      fallback={0.6}
      placement="up"
      size={18}
      label={t("profile.blocks.themes.volume")}
    />
  );
}

function TrackRow({
  rank,
  row,
  slug,
  animeTitle,
  animeCover,
  loading,
}: {
  rank: number;
  row?: ThemeRow;
  slug: string;
  animeTitle?: string;
  animeCover?: string | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const track = useTrack([row?.alt, row?.video?.audio, row?.video?.url]);
  if (loading) return <Skeleton rows={1} tall />;
  return (
    <div
      onPointerEnter={track.warm}
      style={{ animationDelay: `${Math.min(rank - 1, 10) * 35}ms` }}
      /* Le fond du survol reste pendant la lecture, et s'en va à l'arrêt. */
      className={`as-swap-row flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.05] ${track.on || track.loading ? "bg-white/[0.05]" : ""}`}
    >
      <span className="w-4 shrink-0 text-center font-karla text-[11px] font-bold text-white/30">{rank}</span>
      {/* La pochette en plus grand (03/11/2026, Luc), sur toute la hauteur de
          la ligne ; la barre d'écoute vit à sa droite, sous la ligne OP1. */}
      <SongCover row={row} fallback={animeCover} className="h-14 w-14" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-[13px] font-semibold leading-tight text-white">{row?.song ?? slug}</p>
        <p className="flex min-w-0 items-center gap-1.5 font-karla text-[11px] text-txt">
          <KindChip row={row} slug={slug} />
          <span className="truncate">
            {animeTitle ?? "…"}
            {row?.artists?.length ? ` · ${row.artists.join(", ")}` : ""}
          </span>
        </p>
        {/* La barre, toujours là (03/11/2026, Luc). */}
        <div className="mt-0.5 flex items-center gap-2">
          <span className="w-8 shrink-0 whitespace-nowrap font-karla text-[10px] tabular-nums text-white/50">{fmt(track.t)}</span>
          <Rail
            value={track.t}
            max={track.d}
            onSeek={track.seek}
            label={row?.song ?? slug}
            className={`min-w-0 flex-1 transition-opacity ${track.failed ? "opacity-40" : ""}`}
          />
          {/* La durée arrive avec les métadonnées ; en attendant, un point
              qui pulse plutôt qu'un « –:–– » tassé. */}
          <span className="flex w-8 shrink-0 justify-end whitespace-nowrap font-karla text-[10px] tabular-nums text-white/50">
            {track.d ? (
              fmt(track.d)
            ) : track.failed || !track.has ? (
              "—"
            ) : (
              <span className="h-1.5 w-5 animate-pulse rounded-full bg-white/15" />
            )}
          </span>
        </div>
      </div>
      {track.has && track.failed ? (
        <button
          type="button"
          aria-label={t("profile.blocks.themes.retry")}
          title={t("profile.blocks.themes.unavailable")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            track.toggle();
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/60 ring-1 ring-white/10 transition-colors hover:bg-white/[0.14] hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>
      ) : track.has ? (
        <button
          type="button"
          aria-label={t(track.on ? "profile.blocks.themes.pause" : "profile.blocks.themes.play")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            track.toggle();
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-action text-white shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-transform hover:scale-105"
        >
          {track.loading ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
              {track.on ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
            </svg>
          )}
        </button>
      ) : (
        <span className="h-8 w-8 shrink-0" />
      )}
    </div>
  );
}

export function ThemesBlock({
  favs,
  entries,
  isOwner,
  onChange,
  byKind = false,
}: {
  favs: FavTheme[];
  entries: ProfileEntry[];
  isOwner: boolean;
  onChange?: (favs: FavTheme[]) => void;
  /** Option « Trier » : les OP, puis les ED, puis les musiques. */
  byKind?: boolean;
}) {
  const { t } = useTranslation();
  const ids = useMemo(() => Array.from(new Set(favs.map((f) => f.a))), [favs]);
  const meta = useAnimeMeta(ids, entries);
  const themes = useThemes(ids);
  /* « Par type » : trois CATÉGORIES DISTINCTES, chacune sous son titre et
     numérotée depuis 1 (03/11/2026, Luc). Dans chacune, l'ordre du
     propriétaire. Une catégorie vide n'apparaît pas. */
  const groups = useMemo((): { kind: "all" | "op" | "ed" | "ins"; items: FavTheme[] }[] => {
    if (!byKind) return [{ kind: "all", items: favs }];
    const kindOf = (f: FavTheme) =>
      themes.get(f.a)?.find((x) => x.slug === f.s)?.kind ?? (/^OP/i.test(f.s) ? "op" : /^ED/i.test(f.s) ? "ed" : "ins");
    return (["op", "ed", "ins"] as const)
      .map((kind) => ({ kind, items: favs.filter((f) => kindOf(f) === kind) }))
      .filter((g) => g.items.length);
  }, [favs, byKind, themes]);

  if (onChange) return <ThemeEditor favs={favs} entries={entries} onChange={onChange} meta={meta} themes={themes} />;
  if (!favs.length)
    return <EmptyBlock note={t(isOwner ? "profile.blocks.themes.emptyOwner" : "profile.blocks.themes.empty")} />;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Le volume dans le coin de l'en-tête (03/11/2026, Luc), sur la ligne
          d'œil de la flamme et de la moyenne (`as-themes-vol`, globals.css). */}
      <div className="as-themes-vol absolute right-0 z-10">
        <VolumeButton />
      </div>
      <div className="as-scroller grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-1 overflow-y-auto overflow-x-hidden pr-1">
        {groups.map((g, gi) => (
          <section key={g.kind} className="contents">
            {g.kind !== "all" ? (
              <h3 className={`flex items-center gap-2 px-2 font-karla text-[11px] font-bold uppercase tracking-[.08em] text-white/45 ${gi ? "mt-2" : ""}`}>
                {t(`profile.blocks.themes.group.${g.kind}`)}
                <span className="h-px flex-1 bg-white/[0.08]" />
                <span className="tabular-nums text-white/30">{g.items.length}</span>
              </h3>
            ) : null}
            {g.items.map((f, i) => {
          const list = themes.get(f.a);
          const m = meta.get(f.a);
          return (
            <TrackRow
              key={`${f.a}-${f.s}`}
              rank={i + 1}
              slug={f.s}
              row={list?.find((x) => x.slug === f.s)}
              animeTitle={m?.title}
              animeCover={m?.cover}
              loading={!list}
            />
          );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] py-1 pl-1.5 pr-3 font-karla text-[12px] font-bold text-white/75 ring-1 ring-white/10 transition-colors hover:bg-white/[0.1] hover:text-white"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      {label}
    </button>
  );
}

/**
 * LE GLISSER-DÉPOSER DU GESTIONNAIRE DE LISTES d'AniScroll (Blazor,
 * s00295653/AniScroll, `startRowDrag` de scroll-helpers.js), porté tel quel
 * (03/11/2026, Luc) : la ligne prise par sa poignée flotte sous le pointeur,
 * à demi transparente et ombrée ; un emplacement vide de sa hauteur glisse
 * entre les autres jusqu'à l'endroit où elle tombera. Au lâcher, tout reprend
 * sa place et l'ordre est commité d'un coup.
 */
function startRowDrag(
  body: HTMLElement,
  pointerId: number,
  fromIndex: number,
  startClientY: number,
  done: (from: number, to: number) => void,
) {
  const rows = Array.from(body.querySelectorAll<HTMLElement>("[data-drag-row]"));
  if (fromIndex < 0 || fromIndex >= rows.length) return;
  const dragged = rows[fromIndex];
  /* Plus fluide que l'original (03/11/2026, Luc) : tout bouge en `transform`,
     sur le compositeur. Les autres lignes GLISSENT vers leur nouvelle place
     au lieu de sauter, et la ligne lâchée se pose en douceur avant le commit. */
  const step = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : dragged.offsetHeight + 6;
  const EASE = "cubic-bezier(0.22,1,0.36,1)";
  const MOVE_MS = 150;
  const DROP_MS = 120;

  /* L'animation d'entrée (`as-swap-row`) repartait quand React déplaçait le
     nœud au commit : la ligne poussée disparaissait puis revenait (04/11/2026,
     Luc). Coupée pour de bon dès qu'on glisse — elle a déjà joué. */
  for (const r of rows) r.style.animation = "none";
  for (const r of rows) if (r !== dragged) r.style.transition = `transform ${MOVE_MS}ms ${EASE}`;
  Object.assign(dragged.style, {
    position: "relative",
    zIndex: "50",
    /* Pas de transparence (03/11/2026, Luc : « un peu laggy ») : une ligne
       semi-transparente sur la carte floutée se recompose à chaque image. */
    boxShadow: "0 12px 22px -10px rgba(0,0,0,0.7)",
    transition: "none",
    transform: "translate3d(0,0,0)",
    cursor: "grabbing",
    willChange: "transform",
  });
  document.body.style.cursor = "grabbing";

  let toIndex = fromIndex;
  let ended = false;
  try {
    dragged.setPointerCapture(pointerId);
  } catch {
    /* le pointeur est déjà parti */
  }

  // Strictement bloquée entre la première et la dernière place.
  const minDy = -dragged.offsetTop + rows[0].offsetTop;
  const maxDy = rows[rows.length - 1].offsetTop - dragged.offsetTop;
  /* LA LIGNE RESTE SOUS LE CURSEUR QUAND LA LISTE DÉFILE (04/11/2026, Luc) :
     le défilement depuis la prise s'ajoute au déplacement du pointeur. */
  let scroller: HTMLElement | null = body.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const startScroll = scroller?.scrollTop ?? 0;
  const onScroll = () => onMove(lastY);
  scroller?.addEventListener("scroll", onScroll, { passive: true });
  const onMove = (clientY: number) => {
    const scrolled = (scroller?.scrollTop ?? 0) - startScroll;
    const dy = Math.min(maxDy, Math.max(minDy, clientY - startClientY + scrolled));
    // Pas d'agrandissement : la ligne garde la largeur de la liste.
    dragged.style.transform = `translate3d(0,${dy}px,0)`;
    toIndex = Math.min(rows.length - 1, Math.max(0, fromIndex + Math.round(dy / step)));
    rows.forEach((r, i) => {
      if (r === dragged) return;
      let shift = 0;
      if (fromIndex < toIndex && i > fromIndex && i <= toIndex) shift = -step;
      else if (toIndex < fromIndex && i >= toIndex && i < fromIndex) shift = step;
      r.style.transform = shift ? `translate3d(0,${shift}px,0)` : "";
    });
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    scroller?.removeEventListener("scroll", onScroll);
    document.removeEventListener("pointermove", onPM);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.style.cursor = "";
    try {
      dragged.releasePointerCapture(pointerId);
    } catch {
      /* déjà relâché */
    }
    // La ligne se pose dans son emplacement, puis l'ordre est commité.
    if (raf) {
      // La dernière position, pas celle de l'image d'avant.
      cancelAnimationFrame(raf);
      raf = 0;
      onMove(lastY);
    }
    dragged.style.transition = `transform ${DROP_MS}ms ${EASE}, box-shadow ${DROP_MS}ms`;
    dragged.style.transform = `translate3d(0,${(toIndex - fromIndex) * step}px,0)`;
    dragged.style.boxShadow = "";
    setTimeout(() => {
      // Le nouvel ordre et l'effacement des décalages dans la même image : pas de saut.
      flushSync(() => done(fromIndex, toIndex));
      for (const r of rows)
        for (const k of ["transition", "transform", "position", "zIndex", "opacity", "boxShadow", "cursor", "willChange"] as const)
          r.style[k] = "";
    }, DROP_MS);
  };
  // Une mise à jour par image d'écran, pas une par évènement de souris.
  let raf = 0;
  let lastY = startClientY;
  const onPM = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        onMove(lastY);
      });
  };
  document.addEventListener("pointermove", onPM);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
}

/**
 * LE MÊME GLISSER, EN GRILLE (05/11/2026, Luc : « fais comme les widgets ») :
 * `startRowDrag` à deux dimensions. La case prise suit le pointeur, les autres
 * glissent vers leur nouvelle place (ordre de lecture, la case s'insère), et
 * au lâcher elle se pose dans son emplacement avant le commit. Tout en
 * `transform`, sur le compositeur.
 */
function startGridDrag(
  body: HTMLElement,
  pointerId: number,
  fromIndex: number,
  startX: number,
  startY: number,
  done: (dest: number[]) => void,
) {
  const cells = Array.from(body.querySelectorAll<HTMLElement>("[data-drag-cell]"));
  if (fromIndex < 0 || fromIndex >= cells.length) return;
  const dragged = cells[fromIndex];
  /* Les emplacements, relevés une fois : ils ne bougent pas pendant le glisser. */
  const slots = cells.map((c) => ({ x: c.offsetLeft, y: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
  /* La grille peut être mise à l'échelle par un parent (`transform: scale`) :
     le pointeur parle en pixels d'écran, la case en pixels de la grille. Sans
     cette division la carte prend du retard (ou de l'avance) sur la souris. */
  const rect = body.getBoundingClientRect();
  const kx = body.offsetWidth ? rect.width / body.offsetWidth : 1;
  const ky = body.offsetHeight ? rect.height / body.offsetHeight : 1;
  const EASE = "cubic-bezier(0.22,1,0.36,1)";
  const MOVE_MS = 180;
  const DROP_MS = 140;

  for (const c of cells) c.style.animation = "none";
  for (const c of cells) if (c !== dragged) c.style.transition = `transform ${MOVE_MS}ms ${EASE}`;
  Object.assign(dragged.style, {
    position: "relative",
    zIndex: "50",
    boxShadow: "0 14px 26px -10px rgba(0,0,0,0.75)",
    transition: "none",
    transform: "translate3d(0,0,0) scale(1.04)",
    cursor: "grabbing",
    willChange: "transform",
  });
  document.body.style.cursor = "grabbing";
  try {
    dragged.setPointerCapture(pointerId);
  } catch {
    /* le pointeur est déjà parti */
  }

  let toIndex = fromIndex;
  let ended = false;
  const from = slots[fromIndex];
  /* Sur une même ligne OU une même colonne, la case s'insère et les autres de
     la ligne/colonne se décalent. `dest[i]` = où va la case i. */
  const minDx = Math.min(...slots.map((s) => s.x)) - from.x;
  const maxDx = Math.max(...slots.map((s) => s.x + s.w)) - from.x - from.w;
  const minDy = Math.min(...slots.map((s) => s.y)) - from.y;
  const maxDy = Math.max(...slots.map((s) => s.y + s.h)) - from.y - from.h;
  let dest = slots.map((_, i) => i);
  /* Insérer la case `f` en `to`, les deux sur une même ligne ou colonne. */
  const shiftLine = (f: number, to: number): number[] => {
    const d = slots.map((_, i) => i);
    const axis = slots[to].y === slots[f].y ? "y" : "x";
    const line = slots
      .map((_, i) => i)
      .filter((i) => slots[i][axis] === slots[f][axis])
      .sort((a, b) => (axis === "y" ? slots[a].x - slots[b].x : slots[a].y - slots[b].y));
    const pf = line.indexOf(f);
    const pt = line.indexOf(to);
    line.forEach((cell, q) => {
      let nq = q;
      if (q === pf) nq = pt;
      else if (pf < pt && q > pf && q <= pt) nq = q - 1;
      else if (pt < pf && q >= pt && q < pf) nq = q + 1;
      d[cell] = line[nq];
    });
    return d;
  };
  /* En diagonale (05/11/2026, Luc) : pas d'échange. L'axe que la carte a
     dépassé EN PREMIER passe en premier : horizontal = la ligne puis la
     colonne, vertical = la colonne puis la ligne. */
  let firstAxis: "x" | "y" | null = null;
  const placement = (to: number): number[] => {
    if (slots[to].y === from.y || slots[to].x === from.x) return shiftLine(fromIndex, to);
    const m =
      firstAxis === "y"
        ? slots.findIndex((s) => s.x === from.x && s.y === slots[to].y)
        : slots.findIndex((s) => s.x === slots[to].x && s.y === from.y);
    if (m < 0) return shiftLine(fromIndex, to);
    const d1 = shiftLine(fromIndex, m);
    const d2 = shiftLine(m, to);
    return d1.map((s) => d2[s]);
  };
  const onMove = (x: number, y: number) => {
    /* Si la page défile pendant le glisser, la grille bouge à l'écran mais le
       pointeur non : on retire ce déplacement de la grille (quel que soit le
       parent qui défile) pour que la carte reste sous la souris. */
    const r = body.getBoundingClientRect();
    /* La carte ne sort pas de la grille : son déplacement est borné aux bords. */
    const dx = Math.min(maxDx, Math.max(minDx, (x - startX - (r.left - rect.left)) / (kx || 1)));
    const dy = Math.min(maxDy, Math.max(minDy, (y - startY - (r.top - rect.top)) / (ky || 1)));
    dragged.style.transform = `translate3d(${dx}px,${dy}px,0) scale(1.04)`;
    /* L'emplacement le plus proche du centre de la case portée. */
    const cx = from.x + from.w / 2 + dx;
    const cy = from.y + from.h / 2 + dy;
    let best = toIndex;
    let bestD = Infinity;
    slots.forEach((s, i) => {
      const d = (s.x + s.w / 2 - cx) ** 2 + (s.y + s.h / 2 - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    toIndex = best;
    const outX = Math.abs(dx) / (from.w / 2);
    const outY = Math.abs(dy) / (from.h / 2);
    if (outX < 1 && outY < 1) firstAxis = null;
    else if (!firstAxis) firstAxis = outX >= outY ? "x" : "y";
    dest = placement(toIndex);
    /* Les autres prennent la place qu'elles auront une fois la case posée. */
    cells.forEach((c, i) => {
      if (c === dragged) return;
      const k = dest[i];
      const tx = slots[k].x - slots[i].x;
      const ty = slots[k].y - slots[i].y;
      c.style.transform = tx || ty ? `translate3d(${tx}px,${ty}px,0)` : "";
    });
  };
  let raf = 0;
  let lastX = startX;
  let lastY = startY;
  const onPM = (e: PointerEvent) => {
    lastX = e.clientX;
    lastY = e.clientY;
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        onMove(lastX, lastY);
      });
  };
  /* Le défilement ne produit pas de `pointermove` : on recalcule à part. */
  const onScroll = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        onMove(lastX, lastY);
      });
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    document.removeEventListener("pointermove", onPM);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.body.style.cursor = "";
    try {
      dragged.releasePointerCapture(pointerId);
    } catch {
      /* déjà relâché */
    }
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    onMove(lastX, lastY);
    const to = slots[toIndex];
    dragged.style.transition = `transform ${DROP_MS}ms ${EASE}, box-shadow ${DROP_MS}ms`;
    dragged.style.transform = `translate3d(${to.x - from.x}px,${to.y - from.y}px,0)`;
    dragged.style.boxShadow = "";
    setTimeout(() => {
      flushSync(() => done(dest));
      for (const c of cells)
        for (const k of ["transition", "transform", "position", "zIndex", "boxShadow", "cursor", "willChange"] as const)
          c.style[k] = "";
    }, DROP_MS);
  };
  document.addEventListener("pointermove", onPM);
  document.addEventListener("scroll", onScroll, true);
  document.addEventListener("pointerup", onEnd);
  document.addEventListener("pointercancel", onEnd);
  onMove(startX, startY);
}

function ThemeEditor({
  favs,
  entries,
  onChange,
  meta,
  themes,
}: {
  favs: FavTheme[];
  entries: ProfileEntry[];
  onChange: (favs: FavTheme[]) => void;
  meta: Map<number, Meta>;
  themes: Map<number, ThemeRow[]>;
}) {
  const { t } = useTranslation();
  const [anime, setAnime] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [rows, setRows] = useState<ThemeRow[] | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pickedMeta = useAnimeMeta(anime != null ? [anime] : [], entries);
  useEffect(() => {
    if (anime == null) return;
    setRows(null);
    let alive = true;
    void themesOf(anime, (base) => {
      if (alive) setRows(base);
    }).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [anime]);

  if (picking)
    return (
      <EntryPicker
        entries={entries}
        exclude={new Set()}
        onClose={() => setPicking(false)}
        onPick={(id) => {
          setAnime(id);
          setPicking(false);
        }}
      />
    );

  if (anime != null) {
    const am = pickedMeta.get(anime);
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BackButton onClick={() => setAnime(null)} label={t("profile.blocks.themes.back")} />
          <span className="min-w-0 truncate font-karla text-[12px] font-semibold text-white/70">{am?.title ?? ""}</span>
        </div>
        <div className="as-scroller grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
          {rows == null ? (
            <Skeleton rows={6} />
          ) : !rows.length ? (
            <p className="py-4 text-center font-karla text-[12px] text-white/50">{t("profile.blocks.themes.none")}</p>
          ) : (
            rows.map((r) => {
              const taken = favs.some((f) => f.a === anime && f.s === r.slug);
              return (
                <button
                  key={r.slug}
                  type="button"
                  disabled={taken}
                  onClick={() => {
                    onChange([...favs, { a: anime, s: r.slug }]);
                    setAnime(null);
                  }}
                  className="flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-white/[0.06] disabled:opacity-40"
                >
                  <SongCover row={r} fallback={am?.cover} className="h-8 w-8" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <KindChip row={r} slug={r.slug} />
                      <span className="truncate text-[13px] font-semibold text-white">{r.song ?? r.slug}</span>
                    </span>
                    <span className="truncate font-karla text-[11px] text-txt">{r.artists?.join(", ")}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    );
  }

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = favs.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  return (
    /* `pl-0.5` : sans lui, la zone qui défile rogne le tireté gauche du bouton « Ajouter ». */
    <div className="as-scroller flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pl-0.5 pr-1">
      <div ref={bodyRef} className="flex flex-col gap-1">
        {favs.map((f, i) => {
          const list = themes.get(f.a);
          const row = list?.find((x) => x.slug === f.s);
          const m = meta.get(f.a);
          return (
            <div
              key={`${f.a}-${f.s}`}
              data-drag-row
              /* Toute la carte se saisit (03/11/2026, Luc), sauf la croix. */
              onPointerDown={(e) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                e.preventDefault();
                e.stopPropagation();
                if (bodyRef.current) startRowDrag(bodyRef.current, e.pointerId, i, e.clientY, move);
              }}
              /* LA MÊME TAILLE QU'EN LECTURE (03/11/2026, Luc) : pochette de
                 56 px, mêmes deux lignes ; `py-[5px]` + le bord = le `py-1.5`
                 de la ligne du widget. */
              style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}
              className="as-swap-row group/row flex min-w-0 cursor-grab touch-none select-none items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-[5px] hover:border-white/10 hover:bg-white/[0.065]"
            >
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center text-white/25 transition-colors group-hover/row:text-white/60"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </span>
              <span className="w-4 shrink-0 text-center font-karla text-[11px] font-bold text-white/30">{i + 1}</span>
              {list ? (
                <SongCover row={row} fallback={m?.cover} className="h-14 w-14" />
              ) : (
                <span className="h-14 w-14 shrink-0 animate-pulse rounded-md bg-white/[0.07]" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[13px] font-semibold leading-tight text-white">{row?.song ?? (list ? f.s : "…")}</span>
                <span className="flex min-w-0 items-center gap-1.5 font-karla text-[11px] text-txt">
                  <KindChip row={row} slug={f.s} />
                  <span className="truncate">
                    {m?.title ?? ""}
                    {row?.artists?.length ? ` · ${row.artists.join(", ")}` : ""}
                  </span>
                </span>
              </span>
              <button
                type="button"
                aria-label={t("profile.blocks.pinned.remove")}
                onClick={() => onChange(favs.filter((_, k) => k !== i))}
                className="px-1 text-white/40 hover:text-white"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      {favs.length < THEMES_MAX ? (
        <button
          type="button"
          onClick={() => setPicking(true)}
          style={{ animationDelay: `${Math.min(favs.length, 11) * 35}ms` }}
          className="as-swap-row shrink-0 rounded-[14px] border border-dashed border-white/15 py-2.5 font-karla text-[13px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
        >
          + {t("profile.blocks.themes.add")}
        </button>
      ) : null}
    </div>
  );
}

/* ── Affinité de goûts ─────────────────────────────────────────────────── */

/** Un tableau JSON de tags rangé dans les réglages du bloc (`affOrder`, `affHidden`). */
export function parseTags(s: string | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * LES AMIS D'ANISCROLL (03/11/2026, Luc : « uniquement sur le site ») : les
 * amis acceptés, chacun avec les goûts qu'il a rangés en ouvrant son profil
 * (lib/auth/friends.ts), classés du plus proche au plus lointain. `null` = pas
 * encore lu. Partagé par le widget et son panneau de réglages.
 */
function useRankedFriends(isOwner: boolean, entries: ProfileEntry[], owner?: string) {
  const [friends, setFriends] = useState<FriendTaste[] | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    /* Le cache de l'appareil d'abord (lib/friends/client.ts), puis le réseau.
       Lu dans l'effet et pas à l'initialisation : le serveur ne l'a pas. */
    const cached = cachedFriendTastes(owner);
    if (cached) setFriends((f) => f ?? cached);
    let alive = true;
    const load = () =>
      void friendTastes(owner).then((f) => {
        if (alive && f) setFriends(f);
        else if (alive) setFriends((cur) => cur ?? []);
      });
    load();
    window.addEventListener(FRIENDS_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FRIENDS_EVENT, load);
    };
  }, [isOwner, owner]);

  const ranked = useMemo(() => {
    if (!isOwner || !friends || !entries.length) return [];
    const me = tasteOf(entries);
    return friends
      .concat(devFakeFriends(entries))
      .map((o) => ({ o, m: affinity(me, o.taste) }))
      .filter((x) => x.m.shared > 0)
      .sort((a, b) => b.m.pct - a.m.pct);
  }, [isOwner, friends, entries]);
  return { friends, ranked };
}

/**
 * DE FAUX AMIS EN LOCAL SEULEMENT (04/11/2026, Luc : « ajoute des faux amis pour
 * tester »). Jamais en base : la base Turso est la même pour local, dev et prod.
 * Chacun reprend une part de ta liste avec des notes décalées, d'un jumeau
 * presque parfait à quelqu'un qui pense l'inverse.
 */
const FAKES = [
  { name: "Aiko (test)", keep: 0.8, drift: 0.3, flip: false },
  { name: "Kenji (test)", keep: 0.5, drift: 1.5, flip: false },
  { name: "Mika (test)", keep: 0.35, drift: 2.5, flip: false },
  { name: "Ren (test)", keep: 0.6, drift: 0.8, flip: true },
  { name: "Sora (test)", keep: 0.2, drift: 1, flip: false },
  { name: "Yuki (test)", keep: 0.7, drift: 0, flip: false },
];
function devFakeFriends(entries: ProfileEntry[]) {
  if (process.env.NODE_ENV !== "development") return [];
  return FAKES.map((f, n) => {
    const taste: Record<string, number> = {};
    const fav: string[] = [];
    entries.forEach((e, i) => {
      if (e.status === "PLANNING") return;
      // Pseudo-hasard stable : la même liste donne les mêmes faux amis à chaque rendu.
      const r = ((e.mediaId * 9301 + (n + 1) * 49297) % 233280) / 233280;
      if (r > f.keep) return;
      const base = e.score && e.score > 0 ? e.score : 0;
      const big = base > 10;
      const s = !base ? 0 : f.flip ? (big ? 100 : 10) + (big ? 10 : 1) - base : base + (r * 2 - 1) * f.drift * (big ? 10 : 1);
      taste[e.mediaId] = Math.round(Math.min(big ? 100 : 10, Math.max(big ? 10 : 1, s)) * 2) / 2;
      if (i % 7 === n) fav.push(String(e.mediaId));
    });
    return { tag: `FAKE0${n}`, name: f.name, avatar: null, href: "#", since: 0, taste, fav };
  });
}

/** L'ordre perso : les tags rangés d'abord, les nouveaux amis à la suite (par affinité). */
function inOrder<T extends { o: { tag: string } }>(ranked: T[], order: string[]): T[] {
  const at = new Map(order.map((tag, i) => [tag, i]));
  return ranked
    .map((x, i) => ({ x, k: at.get(x.o.tag) ?? order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((y) => y.x);
}

/** Le réglage de l'affinité, tel que le bloc le range (04/11/2026, Luc). */
export type AffinityPrefs = { custom: boolean; auto: boolean; order: string[]; hidden: string[] };
const NO_PREFS: AffinityPrefs = { custom: false, auto: true, order: [], hidden: [] };

/**
 * Un ami est-il montré ? Décoché = non. Sinon oui, sauf un ami ARRIVÉ APRÈS
 * qu'on a éteint « Ajouter les nouveaux amis » : un ami déjà vu est dans
 * `order` ou `hidden` (le bloc y range ceux qu'il découvre tant que l'ajout
 * automatique est allumé), un inconnu est donc un nouveau.
 */
function shownFriend(tag: string, p: AffinityPrefs) {
  if (p.hidden.includes(tag)) return false;
  return p.auto || p.order.includes(tag) || tag.startsWith("FAKE");
}

/**
 * L'ÉDITEUR DE L'AFFINITÉ, au crayon (04/11/2026, Luc : « dans le même style
 * que les musiques ») : les amis en lignes à glisser, comme le Top OP / ED,
 * chacun avec une case cochée par défaut (décochée = masqué du widget).
 * Par affinité tant qu'on n'a rien glissé ; glisser une ligne passe le widget
 * en ordre perso, « Trier par affinité » l'y ramène (le réglage d'ordre a été
 * retiré le même jour, Luc).
 */
export function AffinityEditor({
  entries,
  owner,
  prefs,
  onChange,
}: {
  entries: ProfileEntry[];
  /** Le tag du propriétaire : la clé du cache des goûts des amis. */
  owner?: string;
  prefs: AffinityPrefs;
  onChange: (patch: { custom?: boolean; order?: string[]; hidden?: string[] }) => void;
}) {
  const { t } = useTranslation();
  const { friends, ranked } = useRankedFriends(true, entries, owner);
  const bodyRef = useRef<HTMLDivElement>(null);
  const list = prefs.custom ? inOrder(ranked, prefs.order) : ranked;

  if (friends == null) return <Skeleton rows={3} />;
  if (!list.length) return <EmptyBlock note={t("profile.blocks.affinity.empty")} />;

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = list.map((x) => x.o.tag);
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange({ custom: true, order: next });
  };
  const toggle = (tag: string, on: boolean) => {
    const hidden = on ? [...prefs.hidden, tag] : prefs.hidden.filter((x) => x !== tag);
    /* Recocher un nouvel ami (ajout auto éteint) le fait entrer dans les connus. */
    const order = !on && !prefs.order.includes(tag) ? [...prefs.order, tag] : prefs.order;
    onChange({ hidden, order });
  };
  return (
    <div className="as-scroller flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pl-0.5 pr-1">
      <div ref={bodyRef} className="flex flex-col gap-1">
        {list.map(({ o, m }, i) => {
          const on = shownFriend(o.tag, prefs);
          return (
            <div
              key={o.tag}
              data-drag-row
              /* Toute la carte se saisit, sauf la case. */
              onPointerDown={(e) => {
                if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                e.preventDefault();
                e.stopPropagation();
                if (bodyRef.current) startRowDrag(bodyRef.current, e.pointerId, i, e.clientY, move);
              }}
              style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}
              className="as-swap-row group/row flex min-w-0 cursor-grab touch-none select-none items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-[5px] hover:border-white/10 hover:bg-white/[0.065]"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-white/25 transition-colors group-hover/row:text-white/60">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                  <circle cx="9" cy="6" r="1.6" />
                  <circle cx="15" cy="6" r="1.6" />
                  <circle cx="9" cy="12" r="1.6" />
                  <circle cx="15" cy="12" r="1.6" />
                  <circle cx="9" cy="18" r="1.6" />
                  <circle cx="15" cy="18" r="1.6" />
                </svg>
              </span>
              {o.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={o.avatar} alt="" className={`h-10 w-10 shrink-0 rounded-full object-cover ${on ? "" : "opacity-40"}`} />
              ) : (
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-outfit text-[15px] font-bold text-white ${on ? "" : "opacity-40"}`}>
                  {o.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className={`truncate text-[13px] font-semibold leading-tight ${on ? "text-white" : "text-white/40"}`}>{o.name}</span>
                <span className="truncate font-karla text-[11px] text-txt">
                  {m.pct}% · {t("profile.blocks.affinity.shared", { count: m.shared })}
                </span>
              </span>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={o.name}
                onClick={() => toggle(o.tag, on)}
                className={`mr-1 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors ${
                  on ? "bg-action text-white" : "bg-white/[0.06] ring-1 ring-inset ring-white/25"
                }`}
              >
                {on ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      {prefs.custom ? (
        <button
          type="button"
          onClick={() => onChange({ custom: false })}
          className="shrink-0 rounded-[14px] border border-dashed border-white/15 py-2 font-karla text-[12px] text-white/50 transition-colors hover:border-white/25 hover:text-white"
        >
          {t("profile.blocks.affinity.resetOrder")}
        </button>
      ) : null}
    </div>
  );
}

export function AffinityBlock({
  isOwner,
  entries,
  name,
  prefs = NO_PREFS,
  onKnown,
  owner,
}: {
  isOwner: boolean;
  entries: ProfileEntry[];
  /** Le tag du propriétaire : la clé du cache des goûts des amis. */
  owner?: string;
  /** Le nom du profil regardé (vue visiteur). */
  name: string;
  /** L'ordre et les amis montrés (réglages du bloc, chez soi). */
  prefs?: AffinityPrefs;
  /** Ranger les amis découverts tant que l'ajout automatique est allumé. */
  onKnown?: (order: string[]) => void;
}) {
  const { t } = useTranslation();
  const [store, setStore] = useState<ReturnType<typeof readAffinity> | null>(null);
  /* Lu après le montage : c'est l'appareil du LECTEUR, le serveur ne l'a pas. */
  useEffect(() => setStore(readAffinity()), [entries]);

  /* Le tag de l'ami dont on regarde les titres en commun ; "visit" chez un autre. */
  const [opened, setOpened] = useState<string | null>(null);
  const { friends, ranked: all } = useRankedFriends(isOwner, entries, owner);
  const ranked = useMemo(
    () => (prefs.custom ? inOrder(all, prefs.order) : all).filter((x) => shownFriend(x.o.tag, prefs)),
    [all, prefs],
  );
  /* Les nouveaux amis, rangés comme « connus » tant que l'ajout auto est
     allumé : éteint plus tard, seuls ceux arrivés APRÈS restent masqués.
     Une écriture seulement quand un ami apparaît (les faux amis jamais). */
  const fresh = prefs.auto
    ? all.map((x) => x.o.tag).filter((t) => !t.startsWith("FAKE") && !prefs.order.includes(t) && !prefs.hidden.includes(t))
    : [];
  const freshKey = fresh.join(",");
  useEffect(() => {
    if (freshKey && onKnown) onKnown([...prefs.order, ...freshKey.split(",")]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshKey]);

  if (!isOwner) {
    if (!store) return <div className="h-full" />;
    /* CHEZ UN AUTRE : toi et lui. Ta liste est celle rangée la dernière fois
       que tu as ouvert ton profil sur cet appareil. */
    if (!store.me) return <EmptyBlock note={t("profile.blocks.affinity.noMe")} />;
    const theirs: Record<string, number> = {};
    for (const e of entries) if (e.status !== "PLANNING") theirs[e.mediaId] = e.score && e.score > 0 ? e.score : 0;
    const m = affinity(store.me, theirs);
    const me = store.me;
    const meFav = new Set(store.meFav ?? []);
    return (
      <>
      {/* Hors du bouton : les clics d'un portail remontent l'arbre React. */}
      {opened === "visit" ? (
        <CommonTitles
          name={name}
          match={m}
          items={entries
            .filter((e) => e.status !== "PLANNING" && e.mediaId in me)
            .map((e) => ({
              e,
              mine: me[e.mediaId] || 0,
              theirs: e.score || 0,
              mineFav: meFav.has(String(e.mediaId)),
              theirsFav: !!e.favourite,
            }))}
          onClose={() => setOpened(null)}
        />
      ) : null}
      <button
        type="button"
        onClick={() => setOpened("visit")}
        title={t("profile.blocks.affinity.seeCommon")}
        className="flex h-full w-full items-center gap-4 rounded-xl text-left hover:bg-white/[0.03]"
      >
        <p className="font-outfit text-[42px] font-bold leading-none text-white">
          {m.pct}
          <span className="text-[20px] text-txt">%</span>
        </p>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-white">{t("profile.blocks.affinity.youAnd", { name })}</p>
          <div className="my-1.5">
            <Bar pct={m.pct} />
          </div>
          <p className="font-karla text-[11px] text-txt">
            {t("profile.blocks.affinity.shared", { count: m.shared })}
            {m.rated >= 5 ? ` · ${t("profile.blocks.affinity.rated", { count: m.rated })}` : ""}
          </p>
        </div>
      </button>
      </>
    );
  }

  if (friends == null) return <Skeleton rows={3} />;
  if (!ranked.length) {
    return (
      <EmptyBlock
        note={t(
          all.length
            ? "profile.blocks.affinity.allHidden"
            : friends.length
              ? "profile.blocks.affinity.noTaste"
              : "profile.blocks.affinity.empty",
        )}
      />
    );
  }
  const open = opened ? ranked.find((x) => x.o.tag === opened) : null;
  return (
    <div className="as-scroller grid h-full min-h-0 content-start gap-2 overflow-y-auto pr-1">
      {open ? (
        <CommonTitles
          name={open.o.name}
          match={open.m}
          items={entries
            .filter((e) => e.status !== "PLANNING" && e.mediaId in open.o.taste)
            .map((e) => ({
              e,
              mine: e.score || 0,
              theirs: open.o.taste[e.mediaId] || 0,
              mineFav: !!e.favourite,
              theirsFav: !!open.o.fav?.includes(String(e.mediaId)),
            }))}
          onClose={() => setOpened(null)}
        />
      ) : null}
      {ranked.map(({ o, m }) => (
        <button
          key={o.tag}
          type="button"
          onClick={() => setOpened(o.tag)}
          title={t("profile.blocks.affinity.seeCommon")}
          className="flex w-full items-center gap-3 rounded-xl px-1.5 py-1 text-left hover:bg-white/[0.04]"
        >
          {o.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.avatar} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-outfit text-[13px] font-bold text-white">
              {o.name.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13px] font-semibold text-white">{o.name}</span>
              <span className="font-outfit text-[13px] font-bold text-white">{m.pct}%</span>
            </div>
            <div className="mt-1">
              <Bar pct={m.pct} />
            </div>
            <p className="mt-0.5 font-karla text-[10px] text-txt">{t("profile.blocks.affinity.shared", { count: m.shared })}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

/* La taille des affiches de « En commun » (04/11/2026, Luc). */
type CommonSize = "small" | "normal" | "large";
const COMMON_SIZE_KEY = "aniscroll:commonSize";
const COMMON_SIZES: Record<CommonSize, { row: string; cover: string; title: string; score: string }> = {
  small: { row: "px-2 py-1", cover: "h-8 w-6", title: "truncate text-[12px]", score: "text-[13px]" },
  normal: { row: "p-2", cover: "h-12 w-9", title: "truncate text-[13px]", score: "text-[14px]" },
  large: { row: "px-2 py-2.5", cover: "h-24 w-16", title: "line-clamp-2 text-[15px] leading-snug", score: "text-[16px]" },
};

/**
 * CE QU'ON A EN COMMUN (03/11/2026, Luc : « quand on clique, voir ce qu'on a
 * en commun ») : les titres vus des deux côtés, les deux notes côte à côte.
 * Notés des deux côtés d'abord (par note moyenne), puis le reste.
 */
function CommonTitles({
  name,
  match,
  items,
  onClose,
}: {
  name: string;
  match: Match;
  items: { e: ProfileEntry; mine: number; theirs: number; mineFav: boolean; theirsFav: boolean }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pref = useTitlePref();
  const clickTarget = useClickTarget();
  /* « Favoris » (04/11/2026, Luc) : les titres en favori d'au moins un des deux. */
  const [filter, setFilter] = useState<"all" | "rated" | "fav">("all");
  /* Une bascule « Terminés / Notés » (04/11/2026, Luc), terminés par défaut :
     ce qu'on a vu en entier se compare mieux qu'un titre lâché ou en cours.
     Statut et note de la liste affichée (la mienne chez moi, la sienne chez lui). */
  const [base, setBase] = useState<"done" | "scored">("done");
  const [query, setQuery] = useState("");
  /* La taille des affiches, retenue sur cet appareil. */
  const [size, setSize] = useState<CommonSize>(() => {
    try {
      const v = localStorage.getItem(COMMON_SIZE_KEY);
      return v === "small" || v === "large" ? v : "normal";
    } catch {
      return "normal";
    }
  });
  /* CHANGER DE TAILLE NE FAIT PAS SAUTER LA LISTE (04/11/2026, Luc) : le
     titre en haut de la vue y reste, au même décalage. Sans ça, le même
     scrollTop tombait trois fois plus haut ou plus bas dans la liste. */
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; off: number } | null>(null);
  useLayoutEffect(() => {
    const box = listRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (!box || !a) return;
    const el = box.querySelector<HTMLElement>(`[data-media="${a.id}"]`);
    if (el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - a.off;
  }, [size]);
  const cycleSize = () => {
    const next: CommonSize = size === "small" ? "normal" : size === "normal" ? "large" : "small";
    const box = listRef.current;
    if (box && box.scrollTop > 0) {
      const top = box.getBoundingClientRect().top;
      const first = Array.from(box.querySelectorAll<HTMLElement>("[data-media]")).find(
        (el) => el.getBoundingClientRect().bottom > top + 1,
      );
      if (first) anchor.current = { id: first.dataset.media!, off: first.getBoundingClientRect().top - top };
    }
    setSize(next);
    try {
      localStorage.setItem(COMMON_SIZE_KEY, next);
    } catch {
      /* stockage bloqué : la taille vaut pour cette ouverture */
    }
  };
  const sz = COMMON_SIZES[size];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    /* La page défile sur <html>, pas sur <body> : `overflow-x: clip` sur html
       (globals.css) empêche le overflow du body de remonter au viewport, donc
       bloquer le body ne bloquait rien (04/11/2026, Luc). */
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      root.style.overflow = prev;
    };
  }, [onClose]);

  const rows = useMemo(() => {
    const both = (x: { mine: number; theirs: number }) => x.mine > 0 && x.theirs > 0;
    const favs = (x: { mineFav: boolean; theirsFav: boolean }) => Number(x.mineFav) + Number(x.theirsFav);
    const q = query.trim().toLowerCase();
    const hit = (e: ProfileEntry) =>
      !q || [e.title?.english, e.title?.romaji, e.title?.native, e.title?.userPreferred].some((v) => v?.toLowerCase().includes(q));
    return items
      .filter((x) =>
        base === "done" ? x.e.status === "COMPLETED" || x.e.status === "REPEATING" : (x.e.score ?? 0) > 0,
      )
      .filter((x) => hit(x.e))
      .filter((x) => (filter === "rated" ? both(x) : filter === "fav" ? favs(x) > 0 : true))
      .sort(
        (a, b) =>
          (filter === "fav" ? favs(b) - favs(a) : 0) ||
          Number(both(b)) - Number(both(a)) ||
          b.mine + b.theirs - (a.mine + a.theirs) ||
          pickTitle(a.e.title, pref).localeCompare(pickTitle(b.e.title, pref)),
      );
  }, [items, filter, pref, base, query]);

  const fmt = (n: number) => (n > 0 ? String(Math.round(n * 10) / 10) : "–");
  /* Accord d'une ligne (04/11/2026, Luc) : les couleurs de note de l'éditeur de
     liste (listEditor.css). Vert = petit écart (≤ 1/10), jaune = jusqu'à 4/10,
     rouge = plus de 4/10, gris = un des deux n'a pas noté. Même note : blanc
     (piste 2 de la planche, Luc). */
  const tone = (a: number, b: number) => {
    if (!(a > 0 && b > 0)) return "text-white/35";
    if (a === b) return "text-white";
    const gap = Math.abs(a - b) / (Math.max(a, b) > 10 ? 100 : 10);
    return gap <= 0.1 ? "text-[#22c55e]" : gap <= 0.4 ? "text-[#eab308]" : "text-[#ef4444]";
  };
  /* Le cœur des favoris du site (#E94560, cf. WidgetSettings). */
  const heart = (on: boolean) =>
    on ? (
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute left-full top-1/2 ml-1 h-3.5 w-3.5 -translate-y-1/2 text-[#E94560]" aria-label="♥">
        <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.5 1.1 5.2 3 1.7-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z" />
      </svg>
    ) : null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[10060] flex items-start justify-center px-4 pt-[8vh]" role="dialog" aria-modal="true" aria-label={t("profile.blocks.affinity.commonWith", { name })}>
      <button type="button" aria-label={t("common.close", { defaultValue: "Close" })} onClick={onClose} className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm" />
      <div className="relative flex max-h-[84vh] w-full max-w-xl flex-col overflow-hidden rounded-[22px] bg-[#15161d] shadow-[0_28px_80px_rgba(0,0,0,.7)] ring-1 ring-white/10">
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-outfit text-[18px] font-bold text-white">{t("profile.blocks.affinity.commonWith", { name })}</h3>
            <p className="mt-0.5 font-karla text-[12px] text-white/50">
              {match.pct}% · {t("profile.blocks.affinity.shared", { count: match.shared })}
              {match.rated ? ` · ${t("profile.blocks.affinity.rated", { count: match.rated })}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close", { defaultValue: "Close" })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/[0.08] hover:text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="h-4 w-4">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2 px-5 pb-2.5">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/[0.06] px-3 ring-1 ring-inset ring-white/[0.08] focus-within:ring-white/25">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              id="common-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("profile.blocks.affinity.search")}
              className="min-w-0 flex-1 bg-transparent font-karla text-[13px] text-white outline-none placeholder:text-white/35"
            />
          </label>
          <button
            type="button"
            onClick={cycleSize}
            aria-label={t("profile.blocks.affinity.cardSize")}
            title={t("profile.blocks.affinity.cardSize")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-white/70 ring-1 ring-inset ring-white/[0.08] transition-colors hover:bg-white/[0.1] hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
              {/* 3×3 = petites, 2×2 = normales, un carré = grandes (04/11/2026, Luc). */}
              {size === "large" ? (
                <rect x="2" y="2" width="20" height="20" rx="3" />
              ) : size === "normal" ? (
                [2, 12.5].flatMap((y) => [2, 12.5].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="9.5" height="9.5" rx="1.8" />))
              ) : (
                [3, 10, 17].flatMap((y) => [3, 10, 17].map((x) => <rect key={`${x}-${y}`} x={x} y={y} width="4.6" height="4.6" rx="1" />))
              )}
            </svg>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 pb-2">
          <div role="radiogroup" className="relative flex rounded-full bg-white/[0.06] p-0.5 ring-1 ring-inset ring-white/[0.08]">
            <span
              aria-hidden
              className={`absolute bottom-0.5 top-0.5 w-[calc(50%-2px)] rounded-full bg-action transition-[left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                base === "done" ? "left-0.5" : "left-1/2"
              }`}
            />
            {(["done", "scored"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={base === v}
                onClick={() => setBase(v)}
                className={`relative z-[1] min-w-[5.5rem] rounded-full px-3 py-1 font-karla text-[12px] font-bold transition-colors ${
                  base === v ? "text-white" : "text-white/55 hover:text-white/85"
                }`}
              >
                {t(v === "done" ? "profile.blocks.affinity.filterDone" : "profile.blocks.affinity.filterScored")}
              </button>
            ))}
          </div>
          <span className="h-4 w-px bg-white/10" aria-hidden />
          {(["all", "rated", "fav"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter(v)}
              className={`rounded-full px-3 py-1 font-karla text-[12px] font-bold transition-colors ${
                filter === v ? "bg-white text-black" : "bg-white/[0.06] text-white/60 hover:text-white"
              }`}
            >
              {t(v === "rated" ? "profile.blocks.affinity.filterRated" : v === "fav" ? "profile.blocks.affinity.filterFav" : "profile.blocks.affinity.filterAll")}
            </button>
          ))}
        </div>
        <div ref={listRef} className="as-scroller min-h-0 flex-1 overflow-y-auto px-3 pb-3 [overflow-anchor:none]">
          {/* L'en-tête des colonnes DANS la zone qui défile (04/11/2026, Luc :
              « pas alignés ») : la barre de défilement réduit la liste, il faut
              qu'elle réduise l'en-tête de la même largeur. Mêmes bords que les
              lignes (px-2) et mêmes colonnes (w-10, gap-3). */}
          <div className="sticky top-0 z-[1] flex justify-end bg-[#15161d] px-2 pb-1 pt-1.5">
            <span className="grid grid-cols-2 gap-3 font-karla text-[10px] font-bold uppercase tracking-wider text-white/40">
              <span className="w-16 text-center">{t("profile.blocks.affinity.you")}</span>
              <span className="w-16 truncate text-center">{name}</span>
            </span>
          </div>
          {rows.length ? (
            rows.map(({ e, mine, theirs, mineFav, theirsFav }) => (
              <Link
                key={e.mediaId}
                data-media={e.mediaId}
                href={animeHref(e.mediaId, clickTarget)}
                className={`flex items-center gap-3 rounded-xl hover:bg-white/[0.05] ${sz.row}`}
              >
                {e.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.cover} alt="" loading="lazy" className={`shrink-0 rounded-md object-cover ${sz.cover}`} />
                ) : (
                  <span className={`shrink-0 rounded-md bg-white/[0.06] ${sz.cover}`} />
                )}
                <span className={`min-w-0 flex-1 font-semibold text-white ${sz.title}`}>{pickTitle(e.title, pref)}</span>
                <span className={`grid shrink-0 grid-cols-2 gap-3 font-outfit font-bold tabular-nums ${sz.score} ${tone(mine, theirs)}`}>
                  <span className="relative w-16 text-center">
                    {/* Le cœur colle au chiffre, pas au bord de la colonne. */}
                    <span className="relative">
                      {fmt(mine)}
                      {heart(mineFav)}
                    </span>
                  </span>
                  <span className="relative w-16 text-center">
                    <span className="relative">
                      {fmt(theirs)}
                      {heart(theirsFav)}
                    </span>
                  </span>
                </span>
              </Link>
            ))
          ) : (
            <p className="px-3 py-8 text-center font-karla text-[13px] text-white/45">{t(
                query.trim()
                  ? "profile.blocks.affinity.noneSearch"
                  : filter === "fav"
                    ? "profile.blocks.affinity.noneFav"
                    : filter === "rated"
                      ? "profile.blocks.affinity.noneRated"
                      : "profile.blocks.affinity.noneDone",
              )}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Bingo de la saison ────────────────────────────────────────────────── */

/** La saison en cours : hiver (janv.–mars), printemps, été, automne. */
function seasonNow(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3);
  return {
    key: (["winter", "spring", "summer", "fall"] as const)[q],
    start: new Date(now.getFullYear(), q * 3, 1),
    year: now.getFullYear(),
  };
}

/* ── Les objectifs du bingo (04/11/2026, Luc) ──────────────────────────────
   Chacun se calcule sur la saison en cours avec ce que la page a déjà : le
   journal des jours regardés (`days`), la fiche des animes vus (`Meta`), la
   liste, et chez soi les goûts des amis. Trois familles d'identifiants :
     - un id du catalogue (`streak7`…), libellé `profile.blocks.bingo.cell.<id>` ;
     - `g:<Genre>` / `a:<mediaId>` : les cases du thème de la saison ;
     - `c:<clé>` : un objectif écrit par le propriétaire, coché à la main. */
type BingoCtx = {
  days: [string, WatchDay][];
  /** Le dernier jour où chaque anime a été vu AVANT la saison. */
  before: Map<number, string>;
  /** Le premier jour où il a été vu dans la saison. */
  first: Map<number, string>;
  eps: number;
  bestDay: number;
  bestRun: number;
  ids: number[];
  metas: Map<number, Meta>;
  list: Meta[];
  byId: Map<number, ProfileEntry>;
  year: number;
  startKey: string;
  friendIds: Set<number>;
  rnd: number | null;
};
type Goal = { id: string; icon: string; need: number; got: (c: BingoCtx) => number };

const shiftDay = (k: string, n: number) => {
  const [y, m, d] = k.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
};
const gapDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const ofSeason = (m: Meta, c: BingoCtx) => m.airing || m.year === c.year;
const genre = (g: string) => (c: BingoCtx) => (c.list.some((m) => m.genres.includes(g)) ? 1 : 0);
const finished = (c: BingoCtx) =>
  c.ids.filter((id) => {
    const s = c.byId.get(id)?.status;
    return s === "COMPLETED" || s === "REPEATING";
  }).length;
/** Les épisodes d'un anime un jour donné (`c` manque sur les vieux jours). */
const epsOn = (d: WatchDay, i: number) => (d.c ? d.c[i] ?? 0 : d.a.length === 1 ? d.n : 0);

export const BINGO_GOALS: Goal[] = [
  { id: "streak7", icon: "🔥", need: 7, got: (c) => c.bestRun },
  { id: "day10", icon: "⚡", need: 10, got: (c) => c.bestDay },
  { id: "movie", icon: "🎬", need: 1, got: (c) => c.list.filter((m) => m.format === "MOVIE").length },
  { id: "airing", icon: "📡", need: 1, got: (c) => (c.list.some((m) => ofSeason(m, c)) ? 1 : 0) },
  { id: "eps100", icon: "📺", need: 100, got: (c) => c.eps },
  { id: "classic", icon: "📼", need: 1, got: (c) => (c.list.some((m) => m.year != null && m.year <= c.year - 15) ? 1 : 0) },
  { id: "genres5", icon: "🎭", need: 5, got: (c) => new Set(c.list.flatMap((m) => m.genres)).size },
  { id: "animes10", icon: "🗂", need: 10, got: (c) => c.ids.length },
  { id: "finish", icon: "🏁", need: 1, got: finished },
  /* La sélection de Luc (04/11/2026), puis des objectifs faciles. */
  { id: "streak21", icon: "🔗", need: 21, got: (c) => c.bestRun },
  { id: "day15", icon: "🌋", need: 12, got: (c) => c.bestDay },
  { id: "oneShow10", icon: "🎯", need: 5, got: (c) => Math.max(0, ...c.days.map(([, d]) => Math.max(0, ...d.a.map((_, i) => epsOn(d, i))))) },
  { id: "seasonInDay", icon: "🏃", need: 1, got: (c) =>
      c.days.some(([, d]) => d.a.some((id, i) => {
        const tot = c.byId.get(id)?.total ?? 0;
        return tot > 0 && tot <= 12 && epsOn(d, i) >= tot;
      })) ? 1 : 0 },
  { id: "doubleFeature", icon: "🎞️", need: 1, got: (c) =>
      c.days.some(([, d]) => d.a.filter((id) => c.metas.get(id)?.format === "MOVIE").length >= 2) ? 1 : 0 },
  { id: "special", icon: "🎁", need: 1, got: (c) => (c.list.some((m) => m.format === "SPECIAL") ? 1 : 0) },
  /* 06/11/2026, Luc : un épisode d'un anime EN COURS de diffusion, à n'importe quel moment. */
  { id: "newSeason", icon: "🌱", need: 1, got: (c) => (c.list.some((m) => m.airing) ? 1 : 0) },
  { id: "finish5", icon: "🏆", need: 5, got: finished },
  { id: "secondChance", icon: "🩹", need: 1, got: (c) =>
      c.ids.some((id) => { const b = c.before.get(id); const f = c.first.get(id); return !!b && !!f && gapDays(b, f) >= 30; }) ? 1 : 0 },
  { id: "newStart", icon: "📝", need: 1, got: (c) => c.ids.filter((id) => !c.before.has(id)).length },
  { id: "rewatch", icon: "🔁", need: 1, got: (c) => (c.ids.some((id) => { const e = c.byId.get(id); return e?.status === "REPEATING" || (e?.repeat ?? 0) > 0; }) ? 1 : 0) },
  { id: "sharedShow", icon: "🤝", need: 1, got: (c) => (c.ids.some((id) => c.friendIds.has(id)) ? 1 : 0) },
  { id: "random", icon: "🎲", need: 1, got: (c) => (c.rnd != null && c.ids.includes(c.rnd) ? 1 : 0) },
  { id: "favSeason", icon: "❤️", need: 1, got: (c) => (c.ids.some((id) => c.byId.get(id)?.favourite) ? 1 : 0) },
  { id: "rate3", icon: "⭐", need: 3, got: (c) => c.ids.filter((id) => { const e = c.byId.get(id); return (e?.score ?? 0) > 0 && (e?.status === "COMPLETED" || e?.status === "REPEATING"); }).length },
  { id: "season3", icon: "🌸", need: 3, got: (c) => c.list.filter((m) => ofSeason(m, c)).length },
  { id: "firstEps3", icon: "🚀", need: 3, got: (c) => c.ids.filter((id) => !c.before.has(id)).length },
  { id: "weekend", icon: "🛋️", need: 1, got: (c) => {
      const set = new Set(c.days.map(([k]) => k));
      return c.days.some(([k]) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d).getDay() === 6 && set.has(shiftDay(k, 1)); }) ? 1 : 0;
    } },
  { id: "streak3", icon: "🕯️", need: 3, got: (c) => c.bestRun },
  { id: "eps50", icon: "📈", need: 50, got: (c) => c.eps },
  { id: "finish3", icon: "🥉", need: 3, got: finished },
  { id: "active30", icon: "📅", need: 30, got: (c) => c.days.length },
  { id: "short", icon: "🍿", need: 1, got: (c) => (c.list.some((m) => m.format === "OVA" || m.format === "ONA" || m.format === "SPECIAL") ? 1 : 0) },
  { id: "retro", icon: "🕹️", need: 1, got: (c) => (c.list.some((m) => m.year != null && m.year < 2000) ? 1 : 0) },
  { id: "rated10", icon: "💯", need: 1, got: (c) => (c.ids.some((id) => { const s = c.byId.get(id)?.score ?? 0; return s === 10 || s === 100; }) ? 1 : 0) },
  { id: "horror", icon: "👻", need: 1, got: genre("Horror") },
  { id: "romance", icon: "💌", need: 1, got: genre("Romance") },
  { id: "sports", icon: "🏀", need: 1, got: genre("Sports") },
  { id: "mecha", icon: "🤖", need: 1, got: genre("Mecha") },
  { id: "slice", icon: "🍵", need: 1, got: genre("Slice of Life") },
  { id: "mystery", icon: "🔎", need: 1, got: genre("Mystery") },
  { id: "day20", icon: "💥", need: 20, got: (c) => c.bestDay },
  { id: "streak14", icon: "☄️", need: 14, got: (c) => c.bestRun },
  { id: "eps250", icon: "🛰️", need: 250, got: (c) => c.eps },
  { id: "animes20", icon: "📚", need: 20, got: (c) => c.ids.length },
  /* De nouveaux objectifs (06/11/2026, Luc : « crée en d'autres »). */
  { id: "day3shows", icon: "🎪", need: 3, got: (c) => Math.max(0, ...c.days.map(([, d]) => d.a.length)) },
  { id: "active15", icon: "📆", need: 15, got: (c) => c.days.length },
  { id: "comedy", icon: "😂", need: 1, got: genre("Comedy") },
  { id: "scifi", icon: "🛸", need: 1, got: genre("Sci-Fi") },
  { id: "psycho", icon: "🧠", need: 1, got: genre("Psychological") },
  { id: "music", icon: "🎵", need: 1, got: genre("Music") },
  { id: "supernatural", icon: "🔮", need: 1, got: genre("Supernatural") },
  { id: "adventure", icon: "🗺️", need: 1, got: genre("Adventure") },
  { id: "finishStarted", icon: "🏅", need: 1, got: (c) =>
      c.ids.some((id) => { const st = c.byId.get(id)?.status; return !c.before.has(id) && (st === "COMPLETED" || st === "REPEATING"); }) ? 1 : 0 },
  { id: "animes5", icon: "🔢", need: 5, got: (c) => c.ids.length },
  { id: "genres10", icon: "🌈", need: 10, got: (c) => new Set(c.list.flatMap((m) => m.genres)).size },
  { id: "movies3", icon: "🎟️", need: 3, got: (c) => c.list.filter((m) => m.format === "MOVIE").length },
];
const GOAL = new Map(BINGO_GOALS.map((g) => [g.id, g]));
/** Une case vidée au crayon. */
const EMPTY = "-";
/** Jetons du pool, remplacés au tirage par `rg:<Genre>` / `rt:<Tag>`. */
const RAND_GENRE = "~rg";
const RAND_TAG = "~rt";
/** Ce qu'on tire au hasard pour la grille officielle, après le thème de la saison. */
const SEASON_POOL = [
  "streak7", "streak21", "day15", "oneShow10", "seasonInDay", "doubleFeature", "special", "newSeason",
  "finish5", "secondChance", "newStart", "rewatch", "sharedShow", "random", "favSeason", "rate3",
  "weekend", "firstEps3", "genres5", "movie",
  /* Ajoutés le 06/11/2026 (Luc). */
  "streak3", "streak14", "eps50", "eps100", "eps250", "airing",
  "day3shows", "active15", "comedy", "scifi", "psycho", "music", "supernatural", "adventure",
  "finishStarted", "animes5",
  /* UN GENRE / UN TAG AU HASARD (06/11/2026, Luc) : chaque jeton tiré devient
     une case `rg:<Genre>` ou `rt:<Tag>` ; cinq jetons de chaque, donc une
     grille peut en avoir plusieurs (« une romance » ET « une comédie »…). */
  ...Array<string>(5).fill(RAND_GENRE), ...Array<string>(5).fill(RAND_TAG),
];
/** Les genres AniList (sans le genre adulte), pour la carte « genre au hasard ». */
const RAND_GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha",
  "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller",
];
/** Des tags AniList connus et assez fréquents pour qu'une saison suffise. */
const RAND_TAGS = [
  "Shoujo", "Shounen", "Seinen", "Josei", "Isekai", "School", "Magic", "Vampire", "Time Manipulation",
  "Iyashikei", "Super Power", "Martial Arts", "Military", "Survival", "Detective", "Samurai", "Ninja",
  "Idol", "Food", "Dragons", "Ghost", "Robots", "Female Protagonist", "Tragedy", "Revenge", "Parody",
  "Found Family", "Space", "Zombie", "Post-Apocalyptic", "Love Triangle", "Video Games", "Dystopian",
  "Demons", "Witch", "Mythology", "Coming of Age", "Historical", "Tsundere", "Cyberpunk", "Band",
  "Swordplay", "Urban Fantasy", "Reincarnation", "Gods", "Ensemble Cast", "Delinquents", "Assassins",
  "Mafia", "Body Swapping",
];
/** Les cartes de genre fixes : un `rg:` ne tire pas un genre déjà sur la grille. */
const FIXED_GENRE: Record<string, string> = {
  horror: "Horror", romance: "Romance", sports: "Sports", mecha: "Mecha", slice: "Slice of Life",
  mystery: "Mystery", comedy: "Comedy", scifi: "Sci-Fi", psycho: "Psychological", music: "Music",
  supernatural: "Supernatural", adventure: "Adventure",
};

type Custom = { k: string; t: string; d?: string; e?: string };
/** Les points du bingo : 10 par case, toutes pareilles (05/11/2026, Luc : pas de
 *  bonus selon le chiffre de l'objectif), +20 par ligne/colonne/diagonale, +50 grille pleine. */
const cellPoints = (id: string): number => (id === EMPTY ? 0 : 10);
/** Total : les cases cochées + 20 par ligne/colonne/diagonale + 50 la grille pleine. */
const bingoPoints = (cellIds: string[], done: boolean[], lines: number, full: boolean) =>
  cellIds.reduce((s, id, i) => s + (done[i] ? cellPoints(id) : 0), 0) + lines * 20 + (full ? 50 : 0);
type BingoState = { done: string[]; rnd?: { k: string; id: number } };
type SeasonData = { key: string; genres: string[]; top: { id: number; title: string }[] };

function parseJson<T>(s: unknown, ok: (v: unknown) => boolean, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try {
    const v = JSON.parse(s);
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Le hasard de la grille officielle : le même pour tout le monde, graine = la saison. */
function seeded(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * LA GRILLE OFFICIELLE (04/11/2026, Luc) : le thème de la saison (ses genres,
 * ses titres phares, « trois animes de la saison ») posé aux coins et au
 * centre, et le reste tiré dans un pool d'objectifs. 25 cases ; une grille n×n
 * en prend les n² premières.
 */
function seasonGrid(key: string, data: SeasonData | null, n: number): string[] {
  /* UNE GRILLE PAR TAILLE (04/11/2026, Luc) : chaque taille a sa graine, ses
     cases de thème (3, 5 ou 6) et leurs places, tirées une fois pour tous. */
  const r = seeded(`${key}:${n}`);
  const shuffle = <T,>(a: T[]) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const pool = shuffle(SEASON_POOL.slice());
  const g = (data?.genres ?? []).map((x) => `g:${x}`);
  const a = (data?.top ?? []).map((x) => `a:${x.id}`);
  const themed = ([g[0], a[0], g[1], "season3", g[2], a[1]].filter(Boolean) as string[]).slice(0, n === 3 ? 3 : n === 4 ? 5 : 6);
  const slots = new Set(shuffle(Array.from({ length: n * n }, (_, i) => i)).slice(0, themed.length));
  const out: string[] = [];
  for (let i = 0; i < n * n; i++) out.push((slots.has(i) ? themed.shift() : pool.shift()) ?? pool.shift() ?? EMPTY);
  /* Les jetons « au hasard » prennent un genre / un tag pas déjà sur la grille. */
  const usedGenres = new Set(
    out.flatMap((id) => (id.startsWith("g:") ? [id.slice(2)] : FIXED_GENRE[id] ? [FIXED_GENRE[id]] : [])),
  );
  const genres = shuffle(RAND_GENRES.filter((x) => !usedGenres.has(x)));
  const tags = shuffle(RAND_TAGS.slice());
  return out.map((id) =>
    id === RAND_GENRE ? (genres.length ? `rg:${genres.shift()}` : EMPTY) : id === RAND_TAG ? `rt:${tags.shift()}` : id,
  );
}

const seasonMemo = new Map<string, SeasonData | null>();
/** Le thème de la saison, une fois par session (le serveur le fige pour la saison). */
function useSeasonData(key: string): SeasonData | null | undefined {
  const [data, setData] = useState<SeasonData | null | undefined>(() => seasonMemo.get(key));
  useEffect(() => {
    if (seasonMemo.has(key)) return setData(seasonMemo.get(key));
    let alive = true;
    void fetch("/api/v2/bingo-season")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: SeasonData | null) => {
        const v = j && j.key === key && Array.isArray(j.genres) ? j : null;
        seasonMemo.set(key, v);
        if (alive) setData(v);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [key]);
  return data;
}

/** Les lignes gagnantes d'une grille n×n : lignes, colonnes, deux diagonales. */
function bingoLines(n: number): number[][] {
  const r = Array.from({ length: n }, (_, i) => i);
  return [
    ...r.map((y) => r.map((x) => y * n + x)),
    ...r.map((x) => r.map((y) => y * n + x)),
    r.map((i) => i * n + i),
    r.map((i) => i * n + (n - 1 - i)),
  ];
}

/* LE PARTAGE (04/11/2026, Luc : « copier un bingo et le partager ») : la grille
   et ses objectifs perso dans un code à coller. */
const CODE_PREFIX = "ASB1:";
/** Le bingo d'un autre, mis de côté sur cet appareil pour mon profil. */
const BINGO_PENDING = "aniscroll:bingoPending";
function encodeBingo(cells: string[], customs: Custom[]): string {
  const used = customs.filter((c) => cells.includes(`c:${c.k}`));
  const json = JSON.stringify({ c: cells, x: used });
  return CODE_PREFIX + btoa(unescape(encodeURIComponent(json)));
}
function decodeBingo(code: string): { c: string[]; x: Custom[] } | null {
  const s = code.trim();
  if (!s.startsWith(CODE_PREFIX)) return null;
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(s.slice(CODE_PREFIX.length)))));
    if (!Array.isArray(v?.c) || !v.c.every((x: unknown) => typeof x === "string")) return null;
    const x = Array.isArray(v.x)
      ? v.x.filter((g: Custom) => g && typeof g.k === "string" && typeof g.t === "string").map((g: Custom) => cleanCustom(g))
      : [];
    return { c: v.c.slice(0, 25), x };
  } catch {
    return null;
  }
}
function cleanCustom(g: Custom): Custom {
  return {
    k: String(g.k).slice(0, 8),
    t: String(g.t).slice(0, 40),
    ...(g.d ? { d: String(g.d).slice(0, 90) } : {}),
    ...(g.e ? { e: Array.from(String(g.e)).slice(0, 2).join("") } : {}),
  };
}
const newKey = () => Math.random().toString(36).slice(2, 7);

export function BingoBlock({
  days,
  entries,
  saved,
  size,
  isOwner,
  owner,
  name = "",
  editing = false,
  onPatch,
}: {
  days: WatchDays | null;
  entries: ProfileEntry[];
  /** Le nom du profil (« Utiliser le bingo de X »). */
  name?: string;
  /** Les réglages rangés du bloc (mode, cases, objectifs perso, état). */
  saved: Record<string, boolean | string> | undefined;
  /** Le côté de la grille : 3, 4 ou 5. */
  size: number;
  isOwner: boolean;
  /** Le tag du propriétaire (goûts des amis). */
  owner?: string;
  /** Au crayon : chaque case se clique pour choisir son objectif. */
  editing?: boolean;
  onPatch?: (patch: Record<string, string>) => void;
}) {
  const { t, i18n } = useTranslation();
  const season = seasonNow();
  const seasonId = `${season.year}-${season.key.toUpperCase()}`;
  const n = size >= 3 && size <= 5 ? size : 3;
  const [picking, setPicking] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);
  const [copied, setCopied] = useState(false);
  const seasonData = useSeasonData(seasonId);

  /* Ce qui est rangé. */
  /* Mon bingo par défaut ; le bouton pose celui de la saison (04/11/2026, Luc). */
  const mode = saved?.bingoMode === "season" ? "season" : "mine";

  /* LA PÉRIODE (04/11/2026, Luc : « une durée autre que la saison ») : mon
     bingo peut courir sur le mois, l'année, ou des dates choisies au crayon.
     Celui de la saison court toujours sur la saison. */
  const spanSaved = String(saved?.bingoSpan ?? "");
  const span = mode === "season" ? "season" : ["month", "year", "custom"].includes(spanSaved) ? spanSaved : "season";
  const today = dayKey(Date.now());
  const range = (() => {
    const m = /^(\d{4}-\d{2}-\d{2})\|(\d{4}-\d{2}-\d{2})$/.exec(String(saved?.bingoRange ?? ""));
    return m && m[1] <= m[2] ? { from: m[1], to: m[2] } : { from: today, to: shiftDay(today, 29) };
  })();
  const now = new Date();
  const lang = i18n.language || undefined;
  const period =
    span === "month"
      ? {
          start: dayKey(new Date(now.getFullYear(), now.getMonth(), 1).getTime()),
          end: dayKey(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()),
          label: now.toLocaleDateString(lang, { month: "long", year: "numeric" }).replace(/^./, (c) => c.toUpperCase()),
        }
      : span === "year"
        ? { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear() + 1}-01-01`, label: String(now.getFullYear()) }
        : span === "custom"
          ? {
              start: range.from,
              end: shiftDay(range.to, 1),
              label: [range.from, range.to]
                .map((k) => new Date(`${k}T12:00:00`).toLocaleDateString(lang, { day: "numeric", month: "short" }))
                .join(" → "),
            }
          : {
              start: dayKey(season.start.getTime()),
              end: dayKey(new Date(season.start.getFullYear(), season.start.getMonth() + 3, 1).getTime()),
              label: `${t(`profile.blocks.bingo.season.${season.key}`)} ${season.year}`,
            };
  const startKey = period.start;
  const periodId = span === "season" ? seasonId : `${span}:${period.start}`;
  const endAt = new Date(`${period.end}T00:00:00`).getTime();
  const daysLeft = Math.max(0, Math.ceil((endAt - Date.now()) / 864e5));
  const customs = parseJson<Custom[]>(saved?.bingoCustom, Array.isArray, []);
  /* NOM ET EMOJI PROPRES À UNE CASE (05/11/2026, Luc) : au crayon, le nom est un
     champ de texte et l'emoji ouvre le menu d'emojis du chat. Rangés par
     identifiant d'objectif, pour suivre la carte quand on la déplace. */
  const labels = parseJson<Record<string, { t?: string; e?: string }>>(
    saved?.bingoLabels,
    (v) => !!v && typeof v === "object" && !Array.isArray(v),
    {},
  );
  const state = parseJson<BingoState>(saved?.bingoState, (v) => !!v && typeof v === "object", { done: [] });
  const seasonEdit = parseJson<{ k: string; c: string[] } | null>(
    saved?.bingoSeason,
    (v) => !!v && typeof v === "object" && Array.isArray((v as { c?: unknown }).c),
    null,
  );
  const editKey = `${seasonId}:${n}`;
  /* LA GRILLE OFFICIELLE N'SE MODIFIE PAS (05/11/2026, Luc) : seul « mon bingo »
     se retouche ; une ancienne retouche de la saison est ignorée. */
  const edited = false;
  const ce = editing && mode !== "season";
  const official = useMemo(() => seasonGrid(seasonId, seasonData ?? null, n), [seasonId, seasonData, n]);
  const customKeys = new Set(customs.map((c) => `c:${c.k}`));
  const valid = (id: string) =>
    GOAL.has(id) || /^(g|rg|rt):.+/.test(id) || /^a:\d+$/.test(id) || customKeys.has(id);
  const fill = (saved: string[], pad: string[]) => {
    const cells = saved.slice(0, n * n).map((id) => (valid(id) ? id : EMPTY));
    const used = new Set(cells);
    const pool = pad.filter((id) => !used.has(id));
    while (cells.length < n * n) cells.push(pool.shift() ?? EMPTY);
    return cells;
  };
  const cellIds =
    mode === "mine"
      ? /* Mon bingo se remplit de cartes écrites à la main (04/11/2026, Luc) :
           les cases libres restent vides, « + » au crayon. */
        fill(parseJson<string[]>(saved?.bingoCells, Array.isArray, []), [])
      : edited
        ? fill(seasonEdit!.c, official)
        : official.slice(0, n * n);

  /* Les amis (chez soi seulement : la page d'un autre ne les a pas). */
  const [friendIds, setFriendIds] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (!isOwner || !cellIds.includes("sharedShow")) return;
    const put = (f: FriendTaste[] | null) =>
      f && setFriendIds(new Set(f.flatMap((x) => Object.keys(x.taste).map(Number))));
    put(cachedFriendTastes(owner));
    void friendTastes(owner).then(put);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, owner, cellIds.includes("sharedShow")]);

  const allDays = useMemo(() => Object.entries(days ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)), [days]);
  const inSeason = useMemo(() => allDays.filter(([k]) => k >= startKey && k < period.end), [allDays, startKey, period.end]);
  const ids = useMemo(() => {
    const s = new Set<number>();
    for (const [, d] of inSeason) d.a.forEach((id) => s.add(id));
    return Array.from(s);
  }, [inSeason]);
  const rnd = state.rnd?.k === periodId ? state.rnd.id : null;
  const extraIds = useMemo(
    () => [...cellIds.filter((id) => id.startsWith("a:")).map((id) => Number(id.slice(2))), ...(rnd != null ? [rnd] : [])],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cellIds.join(","), rnd],
  );
  const meta = useAnimeMeta(useMemo(() => [...ids, ...extraIds], [ids, extraIds]), entries);
  const tagsOf = useAnimeTags(ids, cellIds.some((id) => id.startsWith("rt:")));

  const ctx: BingoCtx = useMemo(() => {
    let eps = 0;
    let bestDay = 0;
    let run = 0;
    let bestRun = 0;
    let prev = "";
    const first = new Map<number, string>();
    for (const [k, d] of inSeason) {
      eps += d.n;
      bestDay = Math.max(bestDay, d.n);
      run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
      bestRun = Math.max(bestRun, run);
      prev = k;
      for (const id of d.a) if (!first.has(id)) first.set(id, k);
    }
    const before = new Map<number, string>();
    for (const [k, d] of allDays) if (k < startKey) for (const id of d.a) before.set(id, k);
    const metas = new Map<number, Meta>();
    for (const id of ids) {
      const m = meta.get(id);
      if (m) metas.set(id, m);
    }
    return {
      days: inSeason,
      before,
      first,
      eps,
      bestDay,
      bestRun,
      ids,
      metas,
      list: Array.from(metas.values()),
      byId: new Map(entries.map((e) => [e.mediaId, e])),
      year: season.year,
      startKey,
      friendIds,
      rnd,
    };
  }, [inSeason, allDays, ids, meta, entries, season.year, startKey, friendIds, rnd]);

  const [draftEmoji, setDraftEmoji] = useState<Record<number, string>>({});
  const done = new Set(state.done);
  const customOf = (id: string) => customs.find((c) => `c:${c.k}` === id);
  /** Ce qu'une case affiche et où elle en est. */
  const resolve = (id: string): { icon: string; label: string; desc?: string; got: number; need: number } | null => {
    if (id === EMPTY) return null;
    const g = GOAL.get(id);
    if (g) {
      if (id === "random" && rnd != null) {
        return { icon: g.icon, label: t("profile.blocks.bingo.cell.randomPick", { title: meta.get(rnd)?.title ?? "…" }), got: Math.min(g.got(ctx), 1), need: 1 };
      }
      return { icon: g.icon, label: t(`profile.blocks.bingo.cell.${id}`, { count: g.need }), got: Math.min(g.got(ctx), g.need), need: g.need };
    }
    if (id.startsWith("g:")) {
      const name = id.slice(2);
      return {
        icon: "🏷️",
        label: t("profile.blocks.bingo.cell.seasonGenre", { genre: genreLabel(t, name) }),
        got: ctx.list.some((m) => ofSeason(m, ctx) && m.genres.includes(name)) ? 1 : 0,
        need: 1,
      };
    }
    if (id.startsWith("rg:")) {
      const name = id.slice(3);
      return {
        icon: "🎰",
        label: t("profile.blocks.bingo.cell.randGenre", { genre: genreLabel(t, name) }),
        got: ctx.list.some((m) => m.genres.includes(name)) ? 1 : 0,
        need: 1,
      };
    }
    if (id.startsWith("rt:")) {
      const name = id.slice(3);
      return {
        icon: "🔖",
        label: t("profile.blocks.bingo.cell.randTag", { tag: translateTag(name, i18n.language) }),
        got: ids.some((aid) => tagsOf.get(aid)?.includes(name)) ? 1 : 0,
        need: 1,
      };
    }
    if (id.startsWith("a:")) {
      const aid = Number(id.slice(2));
      const title = meta.get(aid)?.title ?? seasonData?.top.find((x) => x.id === aid)?.title ?? "…";
      return { icon: "🌟", label: t("profile.blocks.bingo.cell.seasonAnime", { title }), got: ids.includes(aid) ? 1 : 0, need: 1 };
    }
    const c = customOf(id);
    if (c) return { icon: c.e || "✏️", label: c.t, got: done.has(id) ? 1 : 0, need: 1 };
    return null;
  };
  const baseCells = cellIds.map((id) => resolve(id));
  const cells = baseCells.map((r, i) => {
    const o = r && labels[cellIds[i]];
    const r2 = r && o ? { ...r, icon: o.e || r.icon, label: o.t || r.label } : r;
    /* MON BINGO : c'est l'utilisateur qui valide ses cartes, d'un clic. */
    return r2 && mode === "mine" ? { ...r2, got: done.has(cellIds[i]) ? 1 : 0, need: 1 } : r2;
  });
  const setLabel = (id: string, p: { t?: string; e?: string }) => {
    const cur: Record<string, { t?: string; e?: string }> = {};
    for (const k of cellIds) if (labels[k]) cur[k] = labels[k];
    const merged = { ...cur[id], ...p };
    if (!merged.t) delete merged.t;
    if (!merged.e) delete merged.e;
    if (Object.keys(merged).length) cur[id] = merged;
    else delete cur[id];
    onPatch?.({ bingoLabels: JSON.stringify(cur) });
  };
  /** Une icône : un emoji, ou une image quand l'emoji vient des animés du chat. */
  const iconNode = (icon: string) => {
    const img = /^:[^:\s]+:$/.test(icon) ? (ANIME_STICKER_MAP[icon]?.src ?? ANIME_EMOJI_MAP[icon]?.url) : null;
    // eslint-disable-next-line @next/next/no-img-element
    return img ? <img src={img} alt="" className="inline-block h-[1.1em] w-[1.1em] object-contain" /> : icon;
  };
  const isDone = cells.map((c) => !!c && c.got >= c.need);
  const lines = editing ? [] : bingoLines(n).filter((l) => l.every((i) => isDone[i]));
  const inLine = new Set(lines.flat());
  const full = cells.length > 0 && isDone.every(Boolean);

  /* LE BADGE « BINGO À 100 % » (04/11/2026, Luc) : chez soi, quand toutes les
     cases sont cochées. Le badge est un drapeau du catalogue (`bingoFull`). */
  useEffect(() => {
    if (isOwner && !editing && days && full && mode === "season")
      void import("@/lib/badges/facts").then((f) => f.recordFlag("bingoFull")).catch(() => {});
  }, [isOwner, editing, days, full, mode]);

  /* ── Écritures ── */
  const writeCells = (next: string[], extra: Record<string, string> = {}) => {
    if (!onPatch) return;
    if (mode === "mine") onPatch({ bingoCells: JSON.stringify(next), ...extra });
    else onPatch({ bingoSeason: JSON.stringify({ k: editKey, c: next }), ...extra });
  };
  const setCell = (i: number, id: string, extra?: Record<string, string>) => {
    const next = cellIds.slice();
    next[i] = id;
    writeCells(next, extra);
    setPicking(null);
  };
  const toggleCustom = (id: string) =>
    onPatch?.({
      bingoState: JSON.stringify({ ...state, done: done.has(id) ? state.done.filter((x) => x !== id) : [...state.done, id] }),
    });
  const draw = () => {
    const pool = entries.filter((e) => e.status === "PLANNING");
    if (!pool.length || !onPatch) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    onPatch({ bingoState: JSON.stringify({ ...state, rnd: { k: periodId, id: pick.mediaId } }) });
  };
  /* LE HASARD SE TIRE TOUT SEUL (05/11/2026, Luc) : chez soi, dès que la case
     🎲 est sur la grille sans tirage pour la période. Une fois par période. */
  const drewFor = useRef<string | null>(null);
  const hasRandom = cellIds.includes("random");
  useEffect(() => {
    if (!isOwner || editing || !hasRandom || rnd != null || drewFor.current === periodId) return;
    if (!entries.some((e) => e.status === "PLANNING")) return;
    drewFor.current = periodId;
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, editing, hasRandom, rnd, periodId, entries]);
  /** Faire sien un bingo partagé : il devient « mon bingo ». */
  const applyCode = (code: string): boolean => {
    const v = decodeBingo(code);
    if (!v || !onPatch) return false;
    /* Les objectifs perso importés prennent une clé neuve : deux bingos
       peuvent avoir chacun leur `c:abc12`. */
    const rename = new Map(v.x.map((g) => [`c:${g.k}`, newKey()]));
    const imported = v.x.map((g) => ({ ...g, k: rename.get(`c:${g.k}`)! }));
    const cellsIn = v.c.map((id) => (rename.has(id) ? `c:${rename.get(id)}` : id));
    onPatch({
      bingoMode: "mine",
      bingoCells: JSON.stringify(cellsIn),
      bingoCustom: JSON.stringify([...customs, ...imported]),
    });
    return true;
  };
  /* UTILISER LE BINGO D'UN AUTRE (04/11/2026, Luc) : chez lui, « Utiliser ce
     bingo » le met de côté sur l'appareil ; sur mon profil, un bandeau propose
     de le prendre. La page d'un autre ne peut pas écrire dans MA disposition. */
  const [pending, setPending] = useState<{ code: string; from: string } | null>(null);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (!isOwner || editing) return;
    try {
      const v = JSON.parse(localStorage.getItem(BINGO_PENDING) || "null");
      if (v && typeof v.code === "string") setPending({ code: v.code, from: String(v.from || "") });
    } catch {
      /* rien de mis de côté */
    }
  }, [isOwner, editing]);
  const dropPending = () => {
    try {
      localStorage.removeItem(BINGO_PENDING);
    } catch {
      /* stockage bloqué */
    }
    setPending(null);
  };
  const keepForMe = () => {
    try {
      localStorage.setItem(BINGO_PENDING, JSON.stringify({ code: encodeBingo(cellIds, customs), from: name }));
      setKept(true);
    } catch {
      copyCode();
    }
  };
  const copyCode = () => {
    const code = encodeBingo(cellIds, customs);
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => window.prompt?.("", code));
  };

  /* LE TEXTE SUIT LA CARTE (05/11/2026, Luc : « titres bien plus gros ») : la
     taille est une part de la largeur de la grille (`cqw`, la grille est un
     conteneur), bornée pour rester lisible en petit et sage en grand. */
  /* ... et de la HAUTEUR (`cqh`) : une carte basse ne coupe plus un nom de trois lignes. */
  /* Chaque CARTE est son propre conteneur (`cqw`/`cqh` = la carte) : emoji,
     marge et trois lignes de nom tiennent dans ~70 % de sa hauteur, quelle que
     soit la taille de la grille. */
  const iconStyle = { fontSize: `clamp(11px, min(18cqw, 20cqh), 34px)` };
  const labelStyle = { fontSize: `clamp(9px, min(11cqw, 15cqh), 19px)` };

  if (!days && !editing) return <div className="h-full" />;

  const cellsDone = isDone.filter(Boolean).length;
  /* Mon bingo ne compte que les cartes qui ont un contenu. */
  const filled = cells.filter(Boolean).length;
  const pts = bingoPoints(cellIds, isDone, lines.length, full);
  /* Le maximum : toutes les cases, toutes les lignes/colonnes/diagonales
     (2n + 2) et la grille pleine. Affiché tel quel, sans paliers. */
  const maxPts = Math.max(1, bingoPoints(cellIds, cellIds.map(() => true), 2 * n + 2, true));

  /* Officiel : des points ; mon bingo : des cartes cochées par soi. */
  const barNow = mode === "season" ? pts : cellsDone;
  const barMax = mode === "season" ? maxPts : Math.max(1, filled);

  /* ── Choisir l'objectif d'une case ── */
  if (editing && picking != null) {
    return (
      <GoalPicker
        current={cellIds[picking]}
        used={new Set(cellIds)}
        customs={customs}
        seasonData={seasonData ?? null}
        resolve={resolve}
        onBack={() => setPicking(null)}
        onPick={(id) => setCell(picking, id)}
        onDelete={(k) => onPatch?.({ bingoCustom: JSON.stringify(customs.filter((c) => c.k !== k)) })}
      />
    );
  }

  return (
    /* AU CRAYON, LE CONTENU PART 8 PX PLUS HAUT QU'EN LECTURE (mesuré sur deux
       captures : cases, emoji et noms décalés de 8 px) : le panneau d'édition
       a un titre plus court. On le redescend en `translate`, sans changer la
       hauteur, pour que les cartes ne bougent ni ne rétrécissent. */
    <div className={`flex min-h-0 flex-1 flex-col gap-2 -mt-1.5 h-[calc(100%+6px)]`}>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          {/* UN BOUTON, PAS UN CHOIX DANS LA LISTE (04/11/2026, Luc) : il pose
              la grille officielle de la taille choisie ; mon bingo reste rangé
              et revient par l'autre bouton. */}
          {/* AUTRE INTERFACE (05/11/2026, Luc : « enlève cette barre ») : un petit
              interrupteur à deux positions, sur la même ligne que les actions,
              au lieu d'une barre pleine largeur. */}
          {/* MÊME HAUTEUR QUE LA LIGNE DU MODE LECTURE (05/11/2026, Luc : « pour ne
              pas rétrécir les cartes ») : une seule ligne de 24 px ; l'aide passe
              dans l'infobulle du ⓘ. */}
          <div className="flex h-8 items-center gap-2 overflow-hidden font-karla text-[13px]">
            <div role="group" aria-label={t("profile.blocks.bingo.modeLabel")} className="flex shrink-0 rounded-full bg-black/25 p-0.5 ring-1 ring-inset ring-white/10">
              {(["season", "mine"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => mode !== m && onPatch?.({ bingoMode: m })}
                  className={`whitespace-nowrap rounded-full px-3.5 py-1 font-bold leading-4 transition-colors ${
                    mode === m ? "bg-action text-white" : "text-white/60 hover:text-white"
                  }`}
                >
                  {m === "season" ? `★ ${t("profile.blocks.bingo.modeSeason")}` : t("profile.blocks.bingo.modeMine")}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {mode === "mine" && span === "custom" ? (
              <div className="flex min-w-0 items-center gap-1.5 text-txt">
                <span>{t("profile.blocks.bingo.from")}</span>
                <DateField id="bingo-from" value={range.from} max={range.to} onCommit={(v) => onPatch?.({ bingoRange: `${v}|${range.to}` })} />
                <span>{t("profile.blocks.bingo.to")}</span>
                <DateField id="bingo-to" value={range.to} min={range.from} onCommit={(v) => onPatch?.({ bingoRange: `${range.from}|${v}` })} />
              </div>
            ) : null}
            {edited ? (
              <button type="button" onClick={() => onPatch?.({ bingoSeason: "" })} className="shrink-0 whitespace-nowrap rounded-full bg-white/[0.06] px-3 py-1 font-bold text-white/70 hover:text-white">
                {t("profile.blocks.bingo.backOfficial")}
              </button>
            ) : null}
            <button type="button" onClick={copyCode} className="shrink-0 whitespace-nowrap rounded-full bg-white/[0.06] px-3 py-1 font-bold text-white/70 hover:text-white">
              {copied ? t("profile.blocks.bingo.copied") : t("profile.blocks.bingo.copyCode")}
            </button>
            <button type="button" onClick={() => setImporting((v) => !v)} className="shrink-0 whitespace-nowrap rounded-full bg-white/[0.06] px-3 py-1 font-bold text-white/70 hover:text-white">
              {t("profile.blocks.bingo.import")}
            </button>
          </div>
          {importing ? (
            <ImportCode
              onImport={(code) => {
                const ok = applyCode(code);
                if (ok) setImporting(false);
                return ok;
              }}
            />
          ) : null}
        </div>
      ) : (
        <p className="flex h-8 items-center gap-2.5 font-karla text-[14px] text-txt">
          {/* LES POINTS (05/11/2026, Luc : « garde ça » sur la maquette 05) :
              10 par case, +20 par ligne ou colonne complète, +50 la grille
              pleine ; « 180 / 270 » = vers le prochain palier (un quart du
              maximum), et la barre dessous le suit. */}
          <span className="min-w-0 truncate" title={t("profile.blocks.bingo.pointsTitle")}>
            {mode === "season"
              ? t("profile.blocks.bingo.points", { points: `${pts} / ${maxPts}` })
              : t("profile.blocks.bingo.cards", { done: cellsDone, total: filled })}
          </span>
          {/* La barre vers le prochain palier : petite, juste à côté des points. */}
          <span
            className="h-2.5 w-28 shrink-0 overflow-hidden rounded-full bg-white/[0.1]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={barMax}
            aria-valuenow={Math.min(barNow, barMax)}
          >
            <span className="block h-full rounded-full bg-action transition-[width] duration-500" style={{ width: `${Math.min(100, (barNow / barMax) * 100)}%` }} />
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Les jours qui restent avant la saison suivante (04/11/2026, Luc). */}
            <span className="font-karla text-[13px] text-white/45" title={t("profile.blocks.bingo.daysLeftTitle")}>
              {daysLeft > 0 ? t("profile.blocks.bingo.daysLeft", { count: daysLeft }) : t("profile.blocks.bingo.ended")}
            </span>
              {/* LE BADGE DE LA SAISON : la grille officielle, non retouchée. */}
              {mode === "season" && !edited ? (
                <span className="shrink-0 rounded-full bg-action px-2.5 py-1 font-outfit text-[12px] font-bold text-white" title={t("profile.blocks.bingo.officialTitle")}>
                  ★ {t("profile.blocks.bingo.official")}
                </span>
              ) : null}
            {!isOwner ? (
              <button
                type="button"
                onClick={keepForMe}
                title={t("profile.blocks.bingo.useThisTitle")}
                className="rounded-full bg-action px-3 py-1 font-karla text-[13px] font-bold text-white hover:brightness-110"
              >
                {kept ? t("profile.blocks.bingo.kept") : t("profile.blocks.bingo.useThis")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={copyCode}
              title={t("profile.blocks.bingo.copyCode")}
              aria-label={t("profile.blocks.bingo.copyCode")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/45 hover:bg-white/[0.08] hover:text-white"
            >
              {copied ? (
                "✓"
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[18px] w-[18px]" aria-hidden>
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h8" />
                </svg>
              )}
            </button>
          </span>
        </p>
      )}
      {pending && isOwner && !editing ? (
        <div className="flex items-center gap-2 rounded-lg bg-white/[0.06] px-2 py-1.5 font-karla text-[11px] ring-1 ring-inset ring-white/10">
          <span className="min-w-0 flex-1 truncate text-white/80">
            {t("profile.blocks.bingo.pending", { name: pending.from || "?" })}
          </span>
          <button
            type="button"
            onClick={() => {
              if (applyCode(pending.code)) dropPending();
            }}
            className="rounded-full bg-action px-2 py-0.5 font-bold text-white"
          >
            {t("profile.blocks.bingo.pendingUse")}
          </button>
          <button type="button" onClick={dropPending} className="px-1 text-white/50 hover:text-white">
            {t("profile.blocks.bingo.pendingDrop")}
          </button>
        </div>
      ) : null}
      <div
        ref={gridRef}
        className="grid min-h-0 flex-1 select-none gap-1.5 [container-type:size]"
        style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${n}, minmax(0, 1fr))` }}
      >
        {cells.map((c, i) => {
          const id = cellIds[i];
          const body = c && ce ? (
            <>
              {/* L'emoji ouvre le menu d'emojis du chat ; le nom se tape sur place. */}
              <span data-nodrag onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} className="mb-[4cqh] leading-none">
                <EmojiButton bare closeOnPick title={t("profile.blocks.bingo.pickEmoji")} className="rounded-md px-1 leading-none group-hover:outline-dashed group-hover:outline-1 group-hover:outline-offset-2 group-hover:outline-white/45" onPick={(e) => setLabel(id, { e })}>
                  <span style={iconStyle}>{iconNode(c.icon)}</span>
                </EmojiButton>
              </span>
              <CellName
                key={`${id}:${c.label}`}
                value={c.label}
                style={labelStyle}
                onCommit={(v) => setLabel(id, { t: v && v !== baseCells[i]?.label ? v : "" })}
              />
            </>
          ) : c ? (
            <>
              <span className="mb-[4cqh] leading-none" style={iconStyle}>{iconNode(c.icon)}</span>
              <span className="line-clamp-3 w-full min-w-0 [overflow-wrap:anywhere] px-1 font-karla font-semibold leading-tight text-white" style={labelStyle}>{c.label}</span>
              {!ce && isDone[i] ? (
                <span className="absolute right-1 top-0.5 text-[11px] font-bold text-white">✓</span>
              ) : !ce && c.need > 1 && n < 5 ? (
                <span className="font-karla text-[9px] text-white/50">
                  {c.got}/{c.need}
                </span>
              ) : null}
            </>
          ) : ce ? (
            /* CASE VIDE AU CRAYON (05/11/2026, Luc) : comme les autres, un emoji et
               un nom en pointillés. Écrire le nom crée l'objectif dans la case. */
            <>
              <span data-nodrag onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} className="mb-[4cqh] leading-none">
                <EmojiButton bare closeOnPick title={t("profile.blocks.bingo.pickEmoji")} className="rounded-md px-1 leading-none group-hover:outline-dashed group-hover:outline-1 group-hover:outline-offset-2 group-hover:outline-white/45" onPick={(e) => setDraftEmoji((d) => ({ ...d, [i]: e }))}>
                  <span style={draftEmoji[i] ? iconStyle : { ...iconStyle, color: "#9ca3af" }}>{draftEmoji[i] ? iconNode(draftEmoji[i]) : <svg viewBox="0 0 24 24" fill="currentColor" className="h-[1.1em] w-[1.1em]" aria-hidden><path d="M15.5,11q0.63,0 1.06-0.44T17,9.5T16.56,8.44T15.5,8T14.44,8.44T14,9.5t0.44,1.06T15.5,11Zm-7,0q0.63,0 1.06-0.44T10,9.5T9.56,8.44T8.5,8T7.44,8.44T7,9.5t0.44,1.06T8.5,11ZM8.1,21.21q-1.82-0.79-3.17-2.14Q3.58,17.73 2.79,15.9T2,12Q2,9.92 2.79,8.1Q3.58,6.27 4.93,4.93Q6.28,3.57 8.1,2.79Q9.93,2 12,2t3.9,0.79t3.17,2.14q1.35,1.35 2.14,3.17Q22,9.92 22,12t-0.79,3.9t-2.14,3.17q-1.35,1.35-3.17,2.14T12,22q-2.07,0-3.9-0.79ZM12,12Zm5.68,5.68Q20,15.35 20,12T17.68,6.32T12,4T6.33,6.32T4,12t2.33,5.68T12,20t5.68-2.32ZM12,17.5q1.45,0 2.68-0.7t1.98-1.9q0.15-0.3-0.03-0.6T16.1,14H7.9q-0.35,0-0.53,0.3T7.35,14.9q0.75,1.2 1.99,1.9T12,17.5Z" /></svg>}</span>
                </EmojiButton>
              </span>
              <CellName
                key={`new:${i}`}
                value=""
                placeholder={t("profile.blocks.bingo.newTitle")}
                style={labelStyle}
                onCommit={(v) => {
                  if (!v) return;
                  const k = newKey();
                  setCell(i, `c:${k}`, { bingoCustom: JSON.stringify([...customs, cleanCustom({ t: v, e: draftEmoji[i] || undefined, k })]) });
                  setDraftEmoji((d) => ({ ...d, [i]: "" }));
                }}
              />
            </>
          ) : (
            <span className="leading-none text-white/30" style={iconStyle} />
          );
          const cls = `relative flex min-h-0 flex-col [container-type:size] items-center justify-center gap-0.5 overflow-hidden rounded-lg p-1 text-center transition-colors ${
            !ce && isDone[i] ? "" : "bg-black/20 ring-1 ring-white/[0.06]"
          }`;
          /* La couleur du site : une case gagnée la prend à moitié, une case
             d'une ligne complète en entier. */
          const style =
            !ce && isDone[i]
              ? {
                  background: `color-mix(in srgb, var(--brand-primary, #E94560) ${inLine.has(i) ? 80 : 35}%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) ${inLine.has(i) ? 100 : 55}%, transparent)`,
                }
              : undefined;
          const tip = c ? c.label : undefined;
          /* Chez soi, hors crayon : un objectif perso se coche à la main (le
             hasard, lui, se tire tout seul). */
          const act =
            ce
              ? null
              : isOwner && onPatch && c && (mode === "mine" || id.startsWith("c:"))
                ? () => toggleCustom(id)
                : null;
          /* DÉPLACER LES CARTES (05/11/2026, Luc : « comme les widgets ») : au
             crayon, une carte se glisse à sa place (`startGridDrag`). Le glisser
             ne part qu'après 6 px : en deçà c'est un clic, qui choisit l'objectif. */
          const dnd = ce
            ? {
                "data-drag-cell": true,
                onPointerDown: (e: React.PointerEvent) => {
                  if (e.button !== 0 || !gridRef.current) return;
                  /* Le champ de texte et l'emoji ne lancent pas le glisser. */
                  if ((e.target as HTMLElement).closest("[data-nodrag]")) return;
                  dragged.current = false;
                  const sx = e.clientX;
                  const sy = e.clientY;
                  const pid = e.pointerId;
                  const box = gridRef.current;
                  const move = (ev: PointerEvent) => {
                    if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
                    stop();
                    dragged.current = true;
                    startGridDrag(box, pid, i, sx, sy, (dest) => {
                      if (dest.every((d, k) => d === k)) return;
                      const next = cellIds.slice();
                      dest.forEach((d, k) => {
                        next[d] = cellIds[k];
                      });
                      writeCells(next);
                    });
                  };
                  const stop = () => {
                    document.removeEventListener("pointermove", move);
                    document.removeEventListener("pointerup", stop);
                  };
                  document.addEventListener("pointermove", move);
                  document.addEventListener("pointerup", stop);
                },
              }
            : {};
          /* Au crayon une case porte un champ et un bouton : ce n'est plus un
             <button> (pas de bouton dans un bouton) mais un bloc cliquable. */
          if (ce) {
            return (
              <div
                key={i}
                role="button"
                tabIndex={0}
                title={tip}
                onClick={() => {
                  if (dragged.current) {
                    dragged.current = false;
                    return;
                  }
                }}
                {...dnd}
                className={`${cls} group cursor-grab touch-none select-none hover:bg-white/[0.08] hover:ring-white/20`}
                style={style}
              >
                {body}
              </div>
            );
          }
          return act ? (
            <button
              key={i}
              type="button"
              onClick={() => {
                /* Le clic qui suit un glisser ne rouvre pas le choix. */
                if (dragged.current) {
                  dragged.current = false;
                  return;
                }
                act();
              }}
              title={tip}
              {...dnd}
              className={`${cls} hover:bg-white/[0.08] hover:ring-white/20 ${!c && ce ? "border border-dashed border-white/15" : ""} ${
                ce ? "cursor-grab touch-none select-none" : ""
              }`}
              style={style}
            >
              {body}
            </button>
          ) : (
            <div key={i} title={tip} className={cls} style={style}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Le nom d'une case, au crayon : un champ de texte qui s'enregistre en le quittant. */
function CellName({ value, style, onCommit, placeholder }: { value: string; style: React.CSSProperties; onCommit: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  /* Comme la lecture (3 lignes au plus) : le champ grandit avec son texte au
     lieu de couper à deux lignes. */
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, style.fontSize]);
  return (
    /* Le cadre en pointillés est sur l'enveloppe (comme celui de l'emoji, qui
       s'affiche) et non sur le champ lui-même. */
    <span className="block w-full rounded-md group-hover:outline-dashed group-hover:outline-1 group-hover:outline-offset-1 group-hover:outline-white/45 focus-within:![outline-style:solid] focus-within:![outline-color:rgba(255,255,255,0.7)]">
    <textarea
      ref={ta}
      data-nodrag
      value={text}
      placeholder={placeholder}
      rows={1}
      maxLength={40}
      spellCheck={false}
      onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
      onBlur={() => onCommit(text.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="w-full resize-none select-text block rounded-md bg-transparent px-1 py-0 text-center font-karla font-semibold leading-tight text-white outline-none placeholder:text-white/35 focus:bg-white/[0.12]"
      style={{ ...style, maxHeight: "3.75em", overflow: "hidden" }}
    />
    </span>
  );
}

function ImportCode({ onImport }: { onImport: (code: string) => boolean }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(!onImport(code));
      }}
    >
      <input
        id="bingo-import"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setBad(false);
        }}
        placeholder={t("profile.blocks.bingo.importPlaceholder")}
        className={`min-w-0 flex-1 rounded-lg bg-white/[0.06] px-2 py-1 font-karla text-[11px] text-white outline-none ring-1 ring-inset placeholder:text-white/35 ${
          bad ? "ring-[#ef4444]" : "ring-white/10 focus:ring-white/30"
        }`}
      />
      <button type="submit" className="rounded-lg bg-action px-2.5 py-1 font-karla text-[11px] font-bold text-white">
        {t("profile.blocks.bingo.importGo")}
      </button>
    </form>
  );
}

/**
 * LE CHOIX D'UN OBJECTIF : en écrire un (titre, description et emoji
 * facultatifs), ou reprendre un des siens. Le catalogue ne se pioche pas : ses
 * objectifs n'arrivent que par la grille de la saison (04/11/2026, Luc).
 */
function GoalPicker({
  current,
  used,
  customs,
  seasonData,
  resolve,
  onBack,
  onPick,
  onDelete,
}: {
  current: string;
  used: Set<string>;
  customs: Custom[];
  seasonData: SeasonData | null;
  resolve: (id: string) => { icon: string; label: string; desc?: string } | null;
  onBack: () => void;
  onPick: (id: string) => void;
  onDelete: (k: string) => void;
}) {
  const { t } = useTranslation();
  const row = (id: string, extra?: ReactNode) => {
    const r = resolve(id);
    if (!r) return null;
    const here = current === id;
    const taken = used.has(id) && !here;
    return (
      <div key={id} className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          disabled={taken}
          onClick={() => onPick(id)}
          className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left disabled:opacity-35 ${
            here ? "bg-white/[0.08] ring-1 ring-white/15" : "hover:bg-white/[0.06]"
          }`}
        >
          <span className="w-6 shrink-0 text-center text-[17px] leading-none">{r.icon}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-karla text-[13px] font-semibold text-white">{r.label}</span>
          </span>
        </button>
        {extra}
      </div>
    );
  };
  const head = (k: string) => (
    <p className="px-2 pb-0.5 pt-2 font-karla text-[10px] font-bold uppercase tracking-wider text-white/40">{t(k)}</p>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <BackButton onClick={onBack} label={t("profile.blocks.bingo.back")} />
        {current !== EMPTY ? (
          <button
            type="button"
            onClick={() => onPick(EMPTY)}
            className="ml-auto rounded-full bg-white/[0.06] px-2.5 py-1 font-karla text-[11px] font-bold text-white/60 hover:text-white"
          >
            {t("profile.blocks.bingo.clear")}
          </button>
        ) : null}
      </div>
      <div className="as-scroller grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
        {customs.length ? head("profile.blocks.bingo.groupMine") : null}
        {customs.map((c) =>
          row(
            `c:${c.k}`,
            <button
              type="button"
              aria-label={t("profile.blocks.bingo.deleteGoal")}
              title={t("profile.blocks.bingo.deleteGoal")}
              onClick={() => onDelete(c.k)}
              className="px-1.5 text-white/35 hover:text-white"
            >
              ✕
            </button>,
          ),
        )}
      </div>
    </div>
  );
}

/** Un champ de date qui se SAISIT au clavier : tant que la date tapée est incomplète
 *  (« 0 », « 05/1 »…) l'état reste local, et on ne l'enregistre qu'une fois valide. */
function DateField({ id, value, min, max, onCommit }: { id: string; value: string; min?: string; max?: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      id={id}
      type="date"
      value={text}
      min={min}
      max={max}
      onBlur={() => setText(value)}
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value;
        if (/^20\d{2}-\d{2}-\d{2}$/.test(v) && (!min || v >= min) && (!max || v <= max)) onCommit(v);
      }}
      className="h-7 w-[8.5rem] min-w-0 rounded-lg bg-white/[0.06] px-1.5 py-0 text-white outline-none ring-1 ring-inset ring-white/10 [color-scheme:dark] focus:ring-white/30"
    />
  );
}
