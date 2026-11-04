import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { studioOrder } from "@/lib/profile/favorite";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { readProgressMap, PROGRESS_EVENT } from "@/lib/watch/progress";
import { busiestDay, dayKey, type Binge, type WatchDays } from "@/lib/profile/activity";
import { affinity, readAffinity, tasteOf, type Match } from "@/lib/profile/affinity";
import { FRIENDS_EVENT, friendTastes, type FriendCard } from "@/lib/friends/client";
import type { ProfileEntry } from "@/lib/profile/types";
import { Bar, EmptyBlock } from "./common";
import { Segmented } from "../WidgetSettings";
import HoverVolume from "@/components/shared/HoverVolume";

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
  const onMove = (clientY: number) => {
    const dy = Math.min(maxDy, Math.max(minDy, clientY - startClientY));
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
function useRankedFriends(isOwner: boolean, entries: ProfileEntry[]) {
  const [friends, setFriends] = useState<(FriendCard & { taste: Record<string, number>; fav?: string[] })[] | null>(null);
  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    const load = () =>
      void friendTastes().then((f) => {
        if (alive) setFriends(f ?? []);
      });
    load();
    window.addEventListener(FRIENDS_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FRIENDS_EVENT, load);
    };
  }, [isOwner]);

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

/**
 * L'ÉDITEUR DE L'AFFINITÉ, au crayon (04/11/2026, Luc : « pas des paramètres
 * mais en édit ») : par affinité ou dans son ordre, puis la liste des amis,
 * chacun avec une case cochée par défaut (décochée = masqué du widget). En
 * ordre perso, les lignes se glissent comme celles du Top OP / ED.
 */
export function AffinityEditor({
  entries,
  custom,
  order,
  hidden,
  onCustom,
  onOrder,
  onHidden,
}: {
  entries: ProfileEntry[];
  custom: boolean;
  order: string[];
  hidden: string[];
  onCustom: (custom: boolean) => void;
  onOrder: (tags: string[]) => void;
  onHidden: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const { friends, ranked } = useRankedFriends(true, entries);
  const bodyRef = useRef<HTMLDivElement>(null);
  const list = custom ? inOrder(ranked, order) : ranked;
  const off = new Set(hidden);

  if (friends == null) return <Skeleton rows={3} />;
  if (!list.length) return <EmptyBlock note={t("profile.blocks.affinity.empty")} />;

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = list.map((x) => x.o.tag);
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onOrder(next);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
    <Segmented
      className=""
      label={t("profile.blocks.affinity.sort")}
      value={custom ? "custom" : "affinity"}
      choices={[
        { value: "affinity", label: t("profile.blocks.affinity.sortAffinity") },
        { value: "custom", label: t("profile.blocks.affinity.sortCustom") },
      ]}
      onPick={(v) => onCustom(v === "custom")}
    />
    <div className="as-scroller min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
    <div ref={bodyRef} className="flex flex-col gap-1">
      {list.map(({ o, m }, i) => {
        const on = !off.has(o.tag);
        return (
          <div
            key={o.tag}
            data-drag-row
            onPointerDown={
              custom
                ? (e) => {
                    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (bodyRef.current) startRowDrag(bodyRef.current, e.pointerId, i, e.clientY, move);
                  }
                : undefined
            }
            className={`group/row flex min-w-0 select-none items-center gap-2 rounded-xl border border-white/[0.08] bg-[#1b1c24] px-2 py-1.5 ${
              custom ? "cursor-grab touch-none hover:border-white/10 hover:bg-[#20212a]" : ""
            }`}
          >
            {custom ? (
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 shrink-0 text-white/25 group-hover/row:text-white/60" aria-hidden>
                <circle cx="9" cy="6" r="1.6" />
                <circle cx="15" cy="6" r="1.6" />
                <circle cx="9" cy="12" r="1.6" />
                <circle cx="15" cy="12" r="1.6" />
                <circle cx="9" cy="18" r="1.6" />
                <circle cx="15" cy="18" r="1.6" />
              </svg>
            ) : null}
            {o.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={o.avatar} alt="" className={`h-7 w-7 shrink-0 rounded-full object-cover ${on ? "" : "opacity-40"}`} />
            ) : (
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-outfit text-[12px] font-bold text-white ${on ? "" : "opacity-40"}`}>
                {o.name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${on ? "text-white" : "text-white/40"}`}>{o.name}</span>
            <span className="shrink-0 font-outfit text-[12px] font-bold text-white/50">{m.pct}%</span>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={o.name}
              onClick={() => onHidden(on ? [...hidden, o.tag] : hidden.filter((x) => x !== o.tag))}
              className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors ${
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
    </div>
    </div>
  );
}

export function AffinityBlock({
  isOwner,
  entries,
  name,
  custom = false,
  order = [],
  hidden = [],
}: {
  isOwner: boolean;
  entries: ProfileEntry[];
  /** Le nom du profil regardé (vue visiteur). */
  name: string;
  /** Ordre perso plutôt que par affinité, et les amis masqués (réglages du bloc). */
  custom?: boolean;
  order?: string[];
  hidden?: string[];
}) {
  const { t } = useTranslation();
  const [store, setStore] = useState<ReturnType<typeof readAffinity> | null>(null);
  /* Lu après le montage : c'est l'appareil du LECTEUR, le serveur ne l'a pas. */
  useEffect(() => setStore(readAffinity()), [entries]);

  /* Le tag de l'ami dont on regarde les titres en commun ; "visit" chez un autre. */
  const [opened, setOpened] = useState<string | null>(null);
  const { friends, ranked: all } = useRankedFriends(isOwner, entries);
  const ranked = useMemo(() => {
    const off = new Set(hidden);
    return (custom ? inOrder(all, order) : all).filter((x) => !off.has(x.o.tag));
  }, [all, custom, order, hidden]);

  if (!store) return <div className="h-full" />;

  if (!isOwner) {
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
          href={open.o.href}
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

/**
 * CE QU'ON A EN COMMUN (03/11/2026, Luc : « quand on clique, voir ce qu'on a
 * en commun ») : les titres vus des deux côtés, les deux notes côte à côte.
 * Notés des deux côtés d'abord (par note moyenne), puis le reste.
 */
function CommonTitles({
  name,
  href,
  match,
  items,
  onClose,
}: {
  name: string;
  href?: string;
  match: Match;
  items: { e: ProfileEntry; mine: number; theirs: number; mineFav: boolean; theirsFav: boolean }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pref = useTitlePref();
  const clickTarget = useClickTarget();
  /* « Favoris » (04/11/2026, Luc) : les titres en favori d'au moins un des deux. */
  const [filter, setFilter] = useState<"all" | "rated" | "fav">("all");

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
    return items
      .filter((x) => (filter === "rated" ? both(x) : filter === "fav" ? favs(x) > 0 : true))
      .sort(
        (a, b) =>
          (filter === "fav" ? favs(b) - favs(a) : 0) ||
          Number(both(b)) - Number(both(a)) ||
          b.mine + b.theirs - (a.mine + a.theirs) ||
          pickTitle(a.e.title, pref).localeCompare(pickTitle(b.e.title, pref)),
      );
  }, [items, filter, pref]);

  const fmt = (n: number) => (n > 0 ? String(Math.round(n * 10) / 10) : "–");
  /* Accord d'une ligne (04/11/2026, Luc) : vert vif = même note, vert = petit
     écart (≤ 1/10), jaune = moyen, rouge = gros (≥ 3/10), gris = un des deux
     n'a pas noté. */
  const tone = (a: number, b: number) => {
    if (!(a > 0 && b > 0)) return "text-white/35";
    if (a === b) return "text-lime-300";
    const gap = Math.abs(a - b) / (Math.max(a, b) > 10 ? 100 : 10);
    return gap <= 0.1 ? "text-emerald-500" : gap >= 0.3 ? "text-red-400" : "text-amber-300";
  };
  const heart = (on: boolean) =>
    on ? (
      <svg viewBox="0 0 24 24" fill="currentColor" className="absolute -right-1 top-1/2 h-2.5 w-2.5 -translate-y-1/2 text-pink-400" aria-label="♥">
        <path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.5 1.1 5.2 3 1.7-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z" />
      </svg>
    ) : null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[10060] flex items-start justify-center px-4 pt-[8vh]" role="dialog" aria-modal="true" aria-label={t("profile.blocks.affinity.commonWith", { name })}>
      <button type="button" aria-label={t("common.close", { defaultValue: "Close" })} onClick={onClose} className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm" />
      <div className="relative flex max-h-[84vh] w-full max-w-lg flex-col overflow-hidden rounded-[22px] bg-[#15161d] shadow-[0_28px_80px_rgba(0,0,0,.7)] ring-1 ring-white/10">
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-outfit text-[18px] font-bold text-white">{t("profile.blocks.affinity.commonWith", { name })}</h3>
            <p className="mt-0.5 font-karla text-[12px] text-white/50">
              {match.pct}% · {t("profile.blocks.affinity.shared", { count: match.shared })}
              {match.rated ? ` · ${t("profile.blocks.affinity.rated", { count: match.rated })}` : ""}
            </p>
          </div>
          {href ? (
            <Link href={href} onClick={onClose} className="shrink-0 rounded-full bg-white/[0.07] px-3 py-1.5 font-karla text-[12px] font-bold text-white/80 ring-1 ring-white/10 hover:bg-white/[0.12] hover:text-white">
              {t("profile.blocks.affinity.seeProfile")}
            </Link>
          ) : null}
          <button type="button" onClick={onClose} aria-label={t("common.close", { defaultValue: "Close" })} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 hover:bg-white/[0.08] hover:text-white">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="h-4 w-4">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2 px-5 pb-2">
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
          <span className="ml-auto grid grid-cols-2 gap-3 font-karla text-[10px] font-bold uppercase tracking-wider text-white/40">
            <span className="w-10 text-center">{t("profile.blocks.affinity.you")}</span>
            <span className="w-10 truncate text-center">{name}</span>
          </span>
        </div>
        <div className="as-scroller min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {rows.length ? (
            rows.map(({ e, mine, theirs, mineFav, theirsFav }) => (
              <Link
                key={e.mediaId}
                href={animeHref(e.mediaId, clickTarget)}
                className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[0.05]"
              >
                {e.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.cover} alt="" loading="lazy" className="h-12 w-9 shrink-0 rounded-md object-cover" />
                ) : (
                  <span className="h-12 w-9 shrink-0 rounded-md bg-white/[0.06]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">{pickTitle(e.title, pref)}</span>
                <span className={`grid shrink-0 grid-cols-2 gap-3 font-outfit text-[14px] font-bold tabular-nums ${tone(mine, theirs)}`}>
                  <span className="relative w-10 text-center">
                    {fmt(mine)}
                    {heart(mineFav)}
                  </span>
                  <span className="relative w-10 text-center">
                    {fmt(theirs)}
                    {heart(theirsFav)}
                  </span>
                </span>
              </Link>
            ))
          ) : (
            <p className="px-3 py-8 text-center font-karla text-[13px] text-white/45">{t(filter === "fav" ? "profile.blocks.affinity.noneFav" : "profile.blocks.affinity.noneRated")}</p>
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

type Cell = { id: string; got: number; need: number; icon: string };

export function BingoBlock({ days, entries }: { days: WatchDays | null; entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const season = seasonNow();
  const startKey = dayKey(season.start.getTime());

  const inSeason = useMemo(
    () => Object.entries(days ?? {}).filter(([k]) => k >= startKey).sort(([a], [b]) => (a < b ? -1 : 1)),
    [days, startKey],
  );
  const ids = useMemo(() => {
    const s = new Set<number>();
    for (const [, d] of inSeason) d.a.forEach((id) => s.add(id));
    return Array.from(s);
  }, [inSeason]);
  const meta = useAnimeMeta(ids, entries);

  const cells: Cell[] = useMemo(() => {
    let eps = 0;
    let bestDay = 0;
    let run = 0;
    let bestRun = 0;
    let prev = "";
    for (const [k, d] of inSeason) {
      eps += d.n;
      bestDay = Math.max(bestDay, d.n);
      const [y, m, dd] = prev.split("-").map(Number);
      run = prev && dayKey(new Date(y, m - 1, dd + 1).getTime()) === k ? run + 1 : 1;
      bestRun = Math.max(bestRun, run);
      prev = k;
    }
    const metas = ids.map((id) => meta.get(id)).filter(Boolean) as Meta[];
    const genres = new Set(metas.flatMap((m) => m.genres));
    const status = new Map(entries.map((e) => [e.mediaId, e.status]));
    const finished = ids.filter((id) => status.get(id) === "COMPLETED").length;
    const has = (f: (m: Meta) => boolean) => (metas.some(f) ? 1 : 0);
    return [
      { id: "streak7", got: Math.min(bestRun, 7), need: 7, icon: "🔥" },
      { id: "day10", got: Math.min(bestDay, 10), need: 10, icon: "⚡" },
      { id: "movie", got: has((m) => m.format === "MOVIE"), need: 1, icon: "🎬" },
      { id: "airing", got: has((m) => m.airing || m.year === season.year), need: 1, icon: "📡" },
      { id: "eps100", got: Math.min(eps, 100), need: 100, icon: "📺" },
      { id: "classic", got: has((m) => m.year != null && m.year <= season.year - 15), need: 1, icon: "📼" },
      { id: "genres5", got: Math.min(genres.size, 5), need: 5, icon: "🎭" },
      { id: "animes10", got: Math.min(ids.length, 10), need: 10, icon: "🗂" },
      { id: "finish", got: Math.min(finished, 1), need: 1, icon: "🏁" },
    ];
  }, [inSeason, ids, meta, entries, season.year]);

  if (!days) return <div className="h-full" />;
  const done = cells.map((c) => c.got >= c.need);
  const LINES = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  const lines = LINES.filter((l) => l.every((i) => done[i]));
  const inLine = new Set(lines.flat());

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <p className="flex items-center justify-between font-karla text-[12px] text-txt">
        <span>
          {t(`profile.blocks.bingo.season.${season.key}`)} {season.year} · {done.filter(Boolean).length}/9
        </span>
        {lines.length ? (
          <span className="rounded-full bg-action px-2 py-0.5 font-outfit text-[11px] font-bold text-white">
            BINGO{lines.length > 1 ? ` ×${lines.length}` : ""}
          </span>
        ) : null}
      </p>
      <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-3 gap-1.5">
        {cells.map((c, i) => (
          <div
            key={c.id}
            title={t(`profile.blocks.bingo.cell.${c.id}`, { count: c.need })}
            className={`relative flex min-h-0 flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg p-1 text-center transition-colors ${
              done[i] ? "" : "bg-black/20 ring-1 ring-white/[0.06]"
            }`}
            /* La couleur du site : une case gagnée la prend à moitié, une case
               d'une ligne complète en entier. */
            style={
              done[i]
                ? {
                    background: `color-mix(in srgb, var(--brand-primary, #E94560) ${inLine.has(i) ? 80 : 35}%, transparent)`,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) ${inLine.has(i) ? 100 : 55}%, transparent)`,
                  }
                : undefined
            }
          >
            <span className="text-[18px] leading-none">{c.icon}</span>
            <span className="line-clamp-2 font-karla text-[10px] font-semibold leading-tight text-white">
              {t(`profile.blocks.bingo.cell.${c.id}`, { count: c.need })}
            </span>
            {done[i] ? (
              <span className="absolute right-1 top-0.5 text-[11px] font-bold text-white">✓</span>
            ) : c.need > 1 ? (
              <span className="font-karla text-[9px] text-white/50">
                {c.got}/{c.need}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
