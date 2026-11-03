import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { animeHref, useClickTarget } from "@/lib/prefs/clickTarget";
import { readProgressMap, PROGRESS_EVENT } from "@/lib/watch/progress";
import { busiestDay, dayKey, type Binge, type WatchDays } from "@/lib/profile/activity";
import { affinity, readAffinity, type Visited } from "@/lib/profile/affinity";
import type { ProfileEntry } from "@/lib/profile/types";
import { BADGES, BY_ID } from "@/lib/badges/catalog";
import { revealAnchor } from "@/lib/badges/reveal";
import BadgeDefs from "../badges/BadgeDefs";
import BadgeToken from "../badges/BadgeToken";
import { Bar, EmptyBlock } from "./common";

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
            <div className="flex min-w-0 flex-col justify-center gap-1.5">
              <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-white">{m?.title ?? "…"}</p>
              {p.note ? (
                <p className="line-clamp-4 font-karla text-[12px] italic leading-snug text-txt">« {p.note} »</p>
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
      .filter((e) => !s || [e.title?.english, e.title?.romaji, e.title?.native].some((x) => x?.toLowerCase().includes(s)))
      /* Toute la liste, la mieux notée d'abord (03/11/2026, Luc : la limite
         à 40 ne montrait que les 10/10). Les affiches se chargent au défilé. */
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [entries, exclude, q]);
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
        {found.map((e) => (
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
            {/* LA NOTE BIEN VISIBLE en édition (03/11/2026, Luc) : en pastille
                sur l'affiche, là où l'œil tombe en choisissant. */}
            <span className="relative block h-full max-h-[160px] shrink-0">
              <Cover src={meta.get(p.id)?.cover} className="h-full max-h-[160px]" />
              {scores.get(p.id) ? (
                <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/75 px-2 py-0.5 font-karla text-[13px] font-bold leading-none text-as-score ring-1 ring-white/10">
                  ★ {scores.get(p.id)}
                </span>
              ) : null}
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
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Top OP / ED ───────────────────────────────────────────────────────── */

export type FavTheme = { a: number; s: string };
export const THEMES_MAX = 5;

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
  song: string | null;
  artists: string[];
  video?: { url: string; audio?: string | null } | null;
};

/* Les génériques d'un anime, par la route du site (cache Turso + CDN, comme
   l'onglet OP/ED de la fiche et la musique du studio). Une fois par session. */
const themeCache = new Map<number, Promise<ThemeRow[]>>();
function themesOf(id: number): Promise<ThemeRow[]> {
  let p = themeCache.get(id);
  if (!p) {
    p = fetch(`/api/v2/themes/${id}?v=4`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.themes) ? (j.themes as ThemeRow[]) : []))
      .catch(() => {
        themeCache.delete(id);
        return [];
      });
    themeCache.set(id, p);
  }
  return p;
}

function useThemes(ids: number[]): Map<number, ThemeRow[]> {
  const [map, setMap] = useState<Map<number, ThemeRow[]>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    let alive = true;
    void Promise.all(ids.map((id) => themesOf(id).then((rows) => [id, rows] as const))).then((pairs) => {
      if (alive) setMap(new Map(pairs));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return map;
}

/** Un seul générique joue à la fois, sur toute la page. */
let playing: HTMLAudioElement | null = null;

function PlayButton({ src }: { src: string | null | undefined }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLAudioElement | null>(null);
  const [on, setOn] = useState(false);
  useEffect(() => () => ref.current?.pause(), []);
  if (!src) return <span className="h-8 w-8 shrink-0" />;
  return (
    <button
      type="button"
      aria-label={t(on ? "profile.blocks.themes.pause" : "profile.blocks.themes.play")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!ref.current) {
          ref.current = new Audio(src);
          ref.current.volume = 0.6;
          ref.current.addEventListener("pause", () => setOn(false));
          ref.current.addEventListener("ended", () => setOn(false));
          ref.current.addEventListener("play", () => setOn(true));
        }
        if (on) ref.current.pause();
        else {
          if (playing && playing !== ref.current) playing.pause();
          playing = ref.current;
          void ref.current.play().catch(() => setOn(false));
        }
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-action text-white shadow-[0_4px_12px_rgba(0,0,0,0.35)] transition-transform hover:scale-105"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5">
        {on ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
      </svg>
    </button>
  );
}

export function ThemesBlock({
  favs,
  entries,
  isOwner,
  onChange,
}: {
  favs: FavTheme[];
  entries: ProfileEntry[];
  isOwner: boolean;
  onChange?: (favs: FavTheme[]) => void;
}) {
  const { t } = useTranslation();
  const ids = useMemo(() => Array.from(new Set(favs.map((f) => f.a))), [favs]);
  const meta = useAnimeMeta(ids, entries);
  const themes = useThemes(ids);

  if (onChange) return <ThemeEditor favs={favs} entries={entries} onChange={onChange} meta={meta} themes={themes} />;
  if (!favs.length)
    return <EmptyBlock note={t(isOwner ? "profile.blocks.themes.emptyOwner" : "profile.blocks.themes.empty")} />;

  return (
    <div className="as-scroller grid h-full min-h-0 content-start gap-1.5 overflow-y-auto pr-1">
      {favs.map((f, i) => {
        const row = themes.get(f.a)?.find((x) => x.slug === f.s);
        const m = meta.get(f.a);
        return (
          <div key={`${f.a}-${f.s}`} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/[0.04]">
            <span className="w-4 shrink-0 text-center font-karla text-[11px] font-bold text-white/30">{i + 1}</span>
            <Cover src={m?.cover} className="h-11" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-white">{row?.song ?? f.s}</p>
              <p className="truncate font-karla text-[11px] text-txt">
                <span className="mr-1.5 rounded bg-white/[0.08] px-1 py-px font-bold text-white/70">{f.s}</span>
                {m?.title ?? "…"}
                {row?.artists?.length ? ` · ${row.artists.join(", ")}` : ""}
              </p>
            </div>
            <PlayButton src={row?.video?.audio || row?.video?.url} />
          </div>
        );
      })}
    </div>
  );
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
  useEffect(() => {
    if (anime == null) return;
    setRows(null);
    let alive = true;
    void themesOf(anime).then((r) => alive && setRows(r));
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

  if (anime != null)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <button type="button" onClick={() => setAnime(null)} className="self-start font-karla text-[12px] text-white/60 hover:text-white">
          ← {t("profile.blocks.pinned.cancel")}
        </button>
        <div className="as-scroller grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-0.5 overflow-y-auto overflow-x-hidden pr-1">
          {rows == null ? (
            <p className="py-4 text-center font-karla text-[12px] text-white/50">…</p>
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
                    onChange([...favs, { a: anime, s: r.slug }].slice(0, THEMES_MAX));
                    setAnime(null);
                  }}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.06] disabled:opacity-40"
                >
                  <span className="rounded bg-white/[0.08] px-1 font-karla text-[11px] font-bold text-white/70">{r.slug}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-white">{r.song ?? r.slug}</span>
                  <span className="truncate font-karla text-[11px] text-txt">{r.artists?.join(", ")}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    );

  return (
    <div className="as-scroller grid h-full min-h-0 content-start gap-1.5 overflow-y-auto pr-1">
      {favs.map((f, i) => {
        const row = themes.get(f.a)?.find((x) => x.slug === f.s);
        return (
          <div key={`${f.a}-${f.s}`} className="flex items-center gap-2 rounded-xl bg-black/15 px-2 py-1.5 ring-1 ring-white/[0.06]">
            <span className="w-4 text-center font-karla text-[11px] font-bold text-white/30">{i + 1}</span>
            <Cover src={meta.get(f.a)?.cover} className="h-9" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-white">
              <b className="mr-1 font-karla text-[11px] text-white/70">{f.s}</b>
              {row?.song ?? meta.get(f.a)?.title}
            </span>
            <button
              type="button"
              disabled={i === 0}
              aria-label="↑"
              onClick={() => {
                const next = favs.slice();
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                onChange(next);
              }}
              className="px-1 text-white/50 hover:text-white disabled:opacity-20"
            >
              ↑
            </button>
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
      {favs.length < THEMES_MAX ? (
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="rounded-xl border border-dashed border-white/15 py-2.5 font-karla text-[13px] text-white/50 transition-colors hover:border-white/30 hover:text-white"
        >
          + {t("profile.blocks.themes.add")}
        </button>
      ) : null}
    </div>
  );
}

/* ── Badges & succès ───────────────────────────────────────────────────── */

export function BadgesBlock({ earned }: { earned: Record<string, number> | null | undefined }) {
  const { t } = useTranslation();
  const got = useMemo(
    () =>
      Object.entries(earned ?? {})
        .filter(([id]) => BY_ID[id])
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id),
    [earned],
  );
  const total = BADGES.filter((b) => !b.secret).length;
  if (!got.length) return <EmptyBlock note={t("profile.blocks.badges.empty")} />;
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <BadgeDefs />
      <p className="font-karla text-[12px] text-txt">
        <b className="font-outfit text-[18px] text-white">{got.length}</b> / {total} · {t("profile.blocks.badges.recent")}
      </p>
      {/* Les plus récents d'abord ; ceux qui ne tiennent pas sont coupés par
          la carte, l'onglet Badges les a tous. */}
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-hidden">
        {got.map((id) => {
          const def = BY_ID[id];
          const name = t(`badges.${id}.name`);
          return (
            <a
              key={id}
              href={`#${revealAnchor(id)}`}
              title={name}
              aria-label={name}
              className="block rounded-lg transition-transform duration-200 hover:scale-110"
            >
              <BadgeToken id={id} rarity={def.rarity} icon={def.icon} tag={def.tag} unlocked size={52} />
            </a>
          );
        })}
      </div>
    </div>
  );
}

/* ── Affinité de goûts ─────────────────────────────────────────────────── */

export function AffinityBlock({
  isOwner,
  entries,
  name,
}: {
  isOwner: boolean;
  entries: ProfileEntry[];
  /** Le nom du profil regardé (vue visiteur). */
  name: string;
}) {
  const { t } = useTranslation();
  const [store, setStore] = useState<ReturnType<typeof readAffinity> | null>(null);
  /* Lu après le montage : c'est l'appareil du LECTEUR, le serveur ne l'a pas. */
  useEffect(() => setStore(readAffinity()), [entries]);

  const ranked = useMemo(() => {
    if (!store || !isOwner || !store.me) return [];
    return store.others
      .map((o: Visited) => ({ o, m: affinity(store.me!, o.taste) }))
      .filter((x) => x.m.shared > 0)
      .sort((a, b) => b.m.pct - a.m.pct);
  }, [store, isOwner]);

  if (!store) return <div className="h-full" />;

  if (!isOwner) {
    /* CHEZ UN AUTRE : toi et lui. Ta liste est celle rangée la dernière fois
       que tu as ouvert ton profil sur cet appareil. */
    if (!store.me) return <EmptyBlock note={t("profile.blocks.affinity.noMe")} />;
    const theirs: Record<string, number> = {};
    for (const e of entries) if (e.status !== "PLANNING") theirs[e.mediaId] = e.score && e.score > 0 ? e.score : 0;
    const m = affinity(store.me, theirs);
    return (
      <div className="flex h-full items-center gap-4">
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
      </div>
    );
  }

  if (!ranked.length) return <EmptyBlock note={t("profile.blocks.affinity.empty")} />;
  return (
    <div className="as-scroller grid h-full min-h-0 content-start gap-2 overflow-y-auto pr-1">
      {ranked.map(({ o, m }) => (
        <Link key={o.href} href={o.href} className="flex items-center gap-3 rounded-xl px-1.5 py-1 hover:bg-white/[0.04]">
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
        </Link>
      ))}
    </div>
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
