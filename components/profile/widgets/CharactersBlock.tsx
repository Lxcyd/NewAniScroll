import Image from "next/image";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useTranslation } from "react-i18next";

import { anilistWritesAllowed } from "@/lib/anilist/writeGuard";
import { animeCharsCached, loadAnimeChars } from "@/lib/profile/avatarChoices";
import {
  loadLiveFavChars,
  saveFavCharOrder,
  searchAnimes,
  searchFavChars,
  setFavChars,
  toggleFavChar,
  useFavChars,
  type FoundAnime,
} from "@/lib/profile/favChars";
import type { ProfileCharacter } from "@/lib/profile/types";
import { Segmented } from "../WidgetSettings";
import { EmptyBlock } from "./common";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Size = "small" | "normal" | "large";

/* Les classes qui dépendent de la taille des cartes, en un seul endroit. */
const SZ = {
  small: { gap: "gap-x-2 gap-y-3", col: "4.75rem", inner: "gap-1.5", name: "text-[11px]", from: "text-[9px]", img: "96px" },
  normal: { gap: "gap-x-3 gap-y-4", col: "7rem", inner: "gap-2", name: "text-xs", from: "text-[10px]", img: "160px" },
  large: { gap: "gap-x-5 gap-y-6", col: "10rem", inner: "gap-2", name: "text-sm", from: "text-xs", img: "240px" },
} as const;

/**
 * PERSONNAGES FAVORIS, sur le modèle d'« En cours de visionnage » (25/10/2026) :
 * tous les favoris, la liste défile (`as-scroller`), les colonnes suivent la
 * LARGEUR DE LA CARTE (`auto-fill`). Réglages : taille des portraits, anime
 * d'origine.
 *
 * ÉDITION SUR PLACE (`editing`, 25/10/2026, Luc) : le crayon de la carte
 * (WidgetGrid, `BlockChrome.editor`) rend ce même bloc en mode édition — on
 * glisse un portrait pour le déplacer, la croix le retire des favoris, la case
 * « + » ouvre la recherche (personnage OU anime) à la place de la grille.
 * Ajouts et retraits partent tout de suite à AniList ; l'ordre, un instant
 * après le dernier lâcher.
 */
export function CharactersBlock({
  characters,
  showFrom = true,
  size = "normal",
  isOwner = false,
  editing = false,
}: {
  characters: ProfileCharacter[];
  showFrom?: boolean;
  size?: Size;
  isOwner?: boolean;
  editing?: boolean;
}) {
  const { t } = useTranslation();
  const list = useFavChars(characters, isOwner);
  const gridRef = useRef<HTMLDivElement>(null);
  useFlip(gridRef, [list, size, showFrom, editing]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!editing) setSearching(false);
  }, [editing]);
  const ed = useEditor(list, editing, gridRef);
  const z = SZ[size];

  if (editing && !ed.token) {
    return <EmptyBlock note={t("profile.blocks.characters.needAnilist")} />;
  }
  if (editing && searching) {
    return (
      <CharacterSearch
        have={new Set(list.map((c) => c.id))}
        onPick={ed.add}
        onBack={() => setSearching(false)}
        size={size}
      />
    );
  }
  if (!list.length && !editing) return <EmptyBlock note={t("profile.blocks.characters.empty")} />;

  const heldChar = ed.held != null ? list.find((c) => c.id === ed.held) : null;

  return (
    <div ref={ed.boxRef} className="relative flex h-full flex-col">
      {/* La copie qui suit la souris (cf. useEditor). Posée en haut à gauche du
          bloc ; c'est son `transform` qui la promène, écrit hors React. */}
      {heldChar ? (
        <div
          ref={ed.floatRef}
          className={`pointer-events-none absolute left-0 top-0 z-30 grid justify-items-center text-center ${z.inner}`}
          style={{ width: ed.gripWidth, willChange: "transform" }}
        >
          <span className="block w-full rounded-full shadow-[0_14px_28px_rgba(0,0,0,0.55)]">
            <Portrait c={heldChar} sizes={z.img} ring="ring-action" />
          </span>
          <Caption c={heldChar} size={size} showFrom={showFrom} />
        </div>
      ) : null}
      {editing ? (
        <p className={`mb-2 shrink-0 font-karla text-[12px] leading-snug ${ed.error ? "text-red-400" : "text-white/45"}`}>
          {ed.error
            ? t("profile.blocks.characters.syncError")
            : ed.local
              ? t("profile.blocks.characters.localOnly")
              : t("profile.blocks.characters.manageDesc")}
        </p>
      ) : null}
      <div
        ref={gridRef}
        className={`as-scroller relative grid min-h-0 flex-1 content-start overflow-y-auto overflow-x-hidden p-1 pr-2 ${z.gap} ${
          ed.held != null ? "select-none" : ""
        }`}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${z.col}, 1fr))` }}
      >
        {list.map((c) => (
          <Tile
            key={c.id}
            c={c}
            size={size}
            showFrom={showFrom}
            editing={editing}
            held={ed.held === c.id}
            onGrab={ed.grab}
            onRemove={ed.remove}
          />
        ))}

        {/* LA CASE « + », celle de « Tes imports » du studio : un rond en
            tirets, le plus au centre, le libellé dessous. */}
        {editing ? (
          <button
            type="button"
            onClick={() => setSearching(true)}
            disabled={ed.loading}
            className={`group relative grid min-w-0 justify-items-center text-center ${z.inner}`}
          >
            <span
              className="grid w-full place-items-center rounded-full border-2 border-dashed border-white/20 transition-colors group-hover:border-white/40 group-hover:bg-white/[0.04]"
              style={{ aspectRatio: "1" }}
            >
              <span className="grid h-[40%] w-[40%] place-items-center rounded-full bg-white/[0.06] text-white transition-colors group-hover:bg-white/[0.12]">
                {ed.loading ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="h-1/2 w-1/2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                )}
              </span>
            </span>
            <span className={`block w-full truncate font-semibold text-white ${z.name}`}>
              {t("profile.blocks.characters.add")}
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Caption({ c, size, showFrom }: { c: ProfileCharacter; size: Size; showFrom: boolean }) {
  const z = SZ[size];
  return (
    <span className="block w-full min-w-0">
      <span className={`block truncate font-semibold text-white ${z.name}`}>{c.name}</span>
      {showFrom && c.from ? <span className={`block truncate font-karla text-white/40 ${z.from}`}>{c.from}</span> : null}
    </span>
  );
}

/**
 * UNE CASE, MÉMOÏSÉE : réordonner ne refait que les cases dont l'état change
 * (la tenue), pas les vingt `next/Image` à chaque case franchie.
 */
const Tile = memo(function Tile({
  c,
  size,
  showFrom,
  editing,
  held,
  onGrab,
  onRemove,
}: {
  c: ProfileCharacter;
  size: Size;
  showFrom: boolean;
  editing: boolean;
  held: boolean;
  onGrab: (e: React.PointerEvent, id: number) => void;
  onRemove: (c: ProfileCharacter) => void;
}) {
  const { t } = useTranslation();
  const z = SZ[size];
  const cls = `group relative grid min-w-0 justify-items-center text-center ${z.inner}`;
  if (!editing) {
    return (
      <a
        data-char={c.id}
        href={`https://anilist.co/character/${c.id}`}
        target="_blank"
        rel="noopener noreferrer"
        title={c.from ? `${c.name} — ${c.from}` : c.name}
        className={cls}
      >
        <Portrait c={c} sizes={z.img} hover />
        <Caption c={c} size={size} showFrom={showFrom} />
      </a>
    );
  }
  return (
    <div
      data-char={c.id}
      onPointerDown={(e) => onGrab(e, c.id)}
      title={t("profile.blocks.characters.dragHint")}
      className={`${cls} ${held ? "cursor-grabbing" : "cursor-grab"}`}
      style={{ touchAction: "none" }}
    >
      {held ? (
        /* LA CASE OÙ IL TOMBERA : un rond en tirets, comme le repère des
           widgets (WidgetGrid) — même accent, même pointillé. */
        <>
          <span
            className="block w-full rounded-full border-2 border-dashed border-action/60 bg-action/10"
            style={{ aspectRatio: "1" }}
          />
          <span className="invisible block w-full">
            <Caption c={c} size={size} showFrom={showFrom} />
          </span>
        </>
      ) : (
        <>
          <Portrait c={c} sizes={z.img} ring="ring-white/20 group-hover:ring-white/40" />
          <Caption c={c} size={size} showFrom={showFrom} />
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onRemove(c)}
            aria-label={t("profile.blocks.characters.remove")}
            title={t("profile.blocks.characters.remove")}
            className="absolute right-[4%] top-0 grid h-6 w-6 place-items-center rounded-full bg-red-500/90 text-white shadow ring-1 ring-black/30 transition-colors hover:bg-red-500"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} className="h-3 w-3">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
});

function Portrait({ c, sizes, hover = false, ring = "" }: { c: ProfileCharacter; sizes: string; hover?: boolean; ring?: string }) {
  return (
    <span
      className={`relative block w-full overflow-hidden rounded-full bg-white/10 ring-2 transition-[box-shadow] duration-200 ${
        ring || (hover ? "ring-white/[0.08] group-hover:ring-white/30" : "ring-white/[0.08]")
      }`}
      style={{ aspectRatio: "1" }}
    >
      {c.image ? (
        <Image
          src={c.image}
          alt={c.name}
          width={230}
          height={230}
          draggable={false}
          sizes={sizes}
          className={`pointer-events-none h-full w-full object-cover transition-transform duration-300 ${
            hover ? "group-hover:scale-[1.06]" : ""
          }`}
        />
      ) : (
        <span className="grid h-full w-full place-items-center font-karla text-lg font-bold text-white/30">
          {c.name.charAt(0)}
        </span>
      )}
    </span>
  );
}

/**
 * Les cases `[data-char]` d'une grille GLISSENT vers leur nouvelle place
 * (FLIP). Mesurées par `offsetLeft/Top`, qui ignorent les `transform` : une
 * case encore en vol ne fausse pas la mesure suivante. Lectures groupées,
 * puis écritures, puis UNE remise en page forcée.
 */
function useFlip(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const boxes = useRef(new Map<string, { x: number; y: number }>());
  useIsoLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const now = new Map<string, { x: number; y: number }>();
    const moves: Array<[HTMLElement, number, number]> = [];
    for (const el of Array.from(grid.querySelectorAll<HTMLElement>("[data-char]"))) {
      const p = { x: el.offsetLeft, y: el.offsetTop };
      const k = el.dataset.char!;
      now.set(k, p);
      const was = boxes.current.get(k);
      if (was && (was.x !== p.x || was.y !== p.y)) moves.push([el, was.x - p.x, was.y - p.y]);
    }
    boxes.current = now;
    if (!moves.length) return;
    for (const [el, dx, dy] of moves) {
      el.style.transition = "none";
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    }
    void grid.offsetWidth;
    for (const [el] of moves) {
      el.style.transition = "transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** La liste réelle n'est relue qu'une fois par page. */
let liveLoaded = false;

/** Tout ce que fait le mode édition : AniList, et le glisser. */
function useEditor(
  list: ProfileCharacter[],
  editing: boolean,
  gridRef: React.RefObject<HTMLDivElement | null>,
) {
  const { data: session } = useSession();
  const token: string | null = (session?.user as any)?.token || null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const local = typeof window !== "undefined" && !anilistWritesAllowed();
  const latest = useRef(list);
  latest.current = list;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  /* On édite la liste RÉELLE : celle du serveur peut dater, et une bascule sur
     un personnage déjà retiré l'ajouterait de nouveau. */
  useEffect(() => {
    if (!editing || liveLoaded || !token) return;
    let live = true;
    setLoading(true);
    loadLiveFavChars(token).then((r) => {
      if (!live) return;
      if (r) {
        liveLoaded = true;
        setFavChars(r);
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [editing, token]);

  /* L'ordre part un instant après le dernier lâcher — et tout de suite quand
     on quitte l'édition entre-temps. */
  const orderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingOrder = useRef<number[] | null>(null);
  const flushOrder = () => {
    if (orderTimer.current) clearTimeout(orderTimer.current);
    orderTimer.current = null;
    const ids = pendingOrder.current;
    pendingOrder.current = null;
    const tk = tokenRef.current;
    if (ids && tk) saveFavCharOrder(tk, ids).then((ok) => !ok && setError(true));
  };
  useEffect(() => {
    if (!editing) flushOrder();
    return flushOrder;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /* Stables (useCallback sans dépendance, lisent les refs) : les cases sont
     mémoïsées et ne doivent pas se refaire parce qu'une fonction a changé. */
  const remove = useCallback(async (c: ProfileCharacter) => {
    const tk = tokenRef.current;
    if (!tk) return;
    const prev = latest.current;
    setFavChars(prev.filter((x) => x.id !== c.id));
    if (!(await toggleFavChar(tk, c.id))) {
      setFavChars(prev);
      setError(true);
    }
  }, []);

  const add = useCallback(async (c: ProfileCharacter) => {
    const tk = tokenRef.current;
    if (!tk || latest.current.some((x) => x.id === c.id)) return;
    const prev = latest.current;
    setFavChars([...prev, c]);
    if (!(await toggleFavChar(tk, c.id))) {
      setFavChars(prev);
      setError(true);
    }
  }, []);

  /* ── GLISSER POUR RÉORDONNER (souris et doigt), comme les widgets : une
     copie flottante suit le pointeur, sa case devient un rond en tirets.
     - UNE IMAGE, UN CALCUL : `pointermove` ne fait que noter la position ; un
       seul `requestAnimationFrame` pose la copie et cherche la case.
     - LA GÉOMÉTRIE EST MESURÉE UNE FOIS, à l'appui : rect du bloc et de la
       grille, échelle du studio (`k` < 1, la scène réduit la grille),
       colonnes et pas des cases. Les cases sont des emplacements fixes — les
       réordonner ne les déplace pas — donc la case visée se calcule
       (`ligne × colonnes + colonne`) sans relire le DOM à chaque mouvement.
     - Le stockage n'est écrit qu'au lâcher. */
  const [held, setHeld] = useState<number | null>(null);
  const heldRef = useRef<number | null>(null);
  const moved = useRef(false);
  const floatRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const geo = useRef({
    k: 1, gx: 0, gy: 0, bx: 0, by: 0, // origine écran de la grille et du bloc
    ox: 0, oy: 0, px: 1, py: 1, cols: 1, // 1re case, pas, colonnes (px de mise en page)
    grabX: 0, grabY: 0, w: 0, scrollTop0: 0,
  });
  const pointer = useRef({ x: 0, y: 0 });
  const raf = useRef(0);

  const frame = () => {
    raf.current = 0;
    const g = geo.current;
    const { x, y } = pointer.current;
    const f = floatRef.current;
    if (f) {
      f.style.transform = `translate3d(${(x - g.bx) / g.k - g.grabX}px, ${(y - g.by) / g.k - g.grabY}px, 0) scale(1.06)`;
    }
    const grid = gridRef.current;
    const id = heldRef.current;
    if (!grid || id == null) return;
    /* Le défilement de la grille depuis l'appui décale les cases à l'écran. */
    const sx = (x - g.gx) / g.k - g.ox;
    const sy = (y - g.gy) / g.k + (grid.scrollTop - g.scrollTop0) - g.oy;
    const cur = latest.current;
    const col = Math.min(g.cols - 1, Math.max(0, Math.floor(sx / g.px)));
    const row = Math.max(0, Math.floor(sy / g.py));
    const to = Math.min(cur.length - 1, row * g.cols + col);
    const from = cur.findIndex((c) => c.id === id);
    if (from < 0 || to < 0 || from === to) return;
    const next = cur.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    latest.current = next;
    moved.current = true;
    setFavChars(next, { persist: false });
  };

  const grab = useCallback((e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grid = gridRef.current;
    const box = boxRef.current;
    if (!grid || !box) return;
    const tile = e.currentTarget as HTMLElement;
    const tr = tile.getBoundingClientRect();
    const k = tile.offsetWidth ? tr.width / tile.offsetWidth || 1 : 1;
    const gr = grid.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const tiles = Array.from(grid.querySelectorAll<HTMLElement>("[data-char]"));
    const first = tiles[0];
    const ox = first?.offsetLeft ?? 0;
    const oy = first?.offsetTop ?? 0;
    let cols = 0;
    while (cols < tiles.length && tiles[cols].offsetTop === oy) cols++;
    cols = Math.max(1, cols);
    /* Le pas : d'une case à la suivante (écarts compris). Sur une seule ligne,
       la largeur de la grille divisée en colonnes égales. */
    const px = tiles[1] && cols > 1 ? tiles[1].offsetLeft - ox : first?.offsetWidth || 1;
    const py = tiles[cols] ? tiles[cols].offsetTop - oy : (first?.offsetHeight || 1) + 16;
    geo.current = {
      k, gx: gr.left, gy: gr.top, bx: br.left, by: br.top,
      ox, oy, px, py, cols,
      grabX: (e.clientX - tr.left) / k,
      grabY: (e.clientY - tr.top) / k,
      w: tile.offsetWidth,
      scrollTop0: grid.scrollTop,
    };
    pointer.current = { x: e.clientX, y: e.clientY };
    heldRef.current = id;
    setHeld(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* La copie flottante existe dès le rendu qui suit l'appui : la poser sous le
     doigt avant qu'elle ne se peigne. */
  useIsoLayoutEffect(() => {
    if (held != null) frame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  useEffect(() => {
    if (held == null) return;
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!raf.current) raf.current = requestAnimationFrame(frame);
    };
    const up = () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
      heldRef.current = null;
      setHeld(null);
      if (!moved.current) return;
      moved.current = false;
      setFavChars(latest.current); // écrit le stockage, une fois
      pendingOrder.current = latest.current.map((c) => c.id);
      if (orderTimer.current) clearTimeout(orderTimer.current);
      orderTimer.current = setTimeout(flushOrder, 800);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held]);

  return { token, loading, error, local, held, grab, remove, add, floatRef, boxRef, gripWidth: geo.current.w };
}

/** Le mode de recherche retenu pour la session. */
let lastMode: "char" | "anime" = "char";

/**
 * LA RECHERCHE, à la place de la grille, dans le widget — avec un SWITCH
 * « Personnage | Anime » (25/10/2026, Luc) : AniList ne cherche les
 * personnages que par leur nom (« one piece » n'en trouvait que deux). En mode
 * Anime, on cherche un titre, puis on pioche dans ses personnages — notre
 * copie Turso d'abord (`loadAnimeChars`, celle de l'onglet Avatar du studio),
 * principaux en tête.
 */
function CharacterSearch({
  have,
  onPick,
  onBack,
  size,
}: {
  have: Set<number>;
  onPick: (c: ProfileCharacter) => void;
  onBack: () => void;
  size: Size;
}) {
  const { t } = useTranslation();
  const z = SZ[size];
  const [mode, setModeState] = useState<"char" | "anime">(lastMode);
  const setMode = (m: "char" | "anime") => {
    lastMode = m;
    setModeState(m);
    setOpen(null);
  };
  const [q, setQ] = useState("");
  const [chars, setChars] = useState<ProfileCharacter[] | null>(null);
  const [animes, setAnimes] = useState<FoundAnime[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /* L'anime ouvert, et ses personnages qui arrivent par lots. */
  const [open, setOpen] = useState<FoundAnime | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const term = q.trim();
    setFailed(false);
    if (term.length < 2) {
      setChars(null);
      setAnimes(null);
      setBusy(false);
      return;
    }
    let live = true;
    setBusy(true);
    const id = setTimeout(async () => {
      if (mode === "char") {
        const r = await searchFavChars(term);
        if (!live) return;
        if (r) setChars(r);
        else setFailed(true);
      } else {
        const r = await searchAnimes(term);
        if (!live) return;
        if (r) setAnimes(r);
        else setFailed(true);
      }
      setBusy(false);
    }, 350);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [q, mode]);

  useEffect(() => {
    if (!open) return;
    void loadAnimeChars(open.id, () => setTick((n) => n + 1)).then(() => setTick((n) => n + 1));
  }, [open]);

  const note = (s: string, red = false) => (
    <p className={`py-6 text-center font-karla text-[13px] ${red ? "text-red-400" : "text-white/40"}`}>{s}</p>
  );

  const charGrid = (list: ProfileCharacter[]) => (
    <div
      className={`grid content-start ${z.gap}`}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${z.col}, 1fr))` }}
    >
      {list.map((c) => {
        const on = have.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            disabled={on}
            onClick={() => onPick(c)}
            title={on ? t("profile.blocks.characters.already") : t("profile.blocks.characters.add")}
            className={`group grid min-w-0 justify-items-center text-center disabled:cursor-default ${z.inner}`}
          >
            <span className="relative block w-full">
              <Portrait c={c} sizes={z.img} hover={!on} ring={on ? "ring-action" : ""} />
              <span
                className={`absolute right-[4%] top-0 grid h-6 w-6 place-items-center rounded-full shadow ring-1 ring-black/30 ${
                  on ? "bg-action text-white" : "bg-white/90 text-black/80"
                }`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="h-3 w-3">
                  {on ? (
                    <polyline points="20 6 9 17 4 12" />
                  ) : (
                    <>
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </>
                  )}
                </svg>
              </span>
            </span>
            <Caption c={c} size={size} showFrom />
          </button>
        );
      })}
    </div>
  );

  let body: React.ReactNode;
  if (failed) body = note(t("profile.blocks.characters.searchError"), true);
  else if (open) {
    const got = animeCharsCached(open.id);
    const list: ProfileCharacter[] | undefined = got?.map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      from: open.title,
    }));
    body = (
      <>
        <div className="mb-3 flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setOpen(null)}
            aria-label={t("profile.blocks.characters.back")}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-white/70 ring-1 ring-white/10 transition-colors hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="h-3 w-3">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="min-w-0 truncate font-karla text-[13px] font-bold text-white">{open.title}</span>
          {list ? (
            <span className="shrink-0 font-karla text-[12px] text-white/40">
              {t("profile.blocks.characters.animeChars", { count: list.length })}
            </span>
          ) : null}
        </div>
        {list == null
          ? note("…")
          : list.length
            ? charGrid(list)
            : note(t("profile.blocks.characters.noAnimeChars"))}
      </>
    );
  } else if (mode === "char") {
    body =
      chars == null
        ? note(busy ? "…" : t("profile.blocks.characters.searchHint"))
        : chars.length
          ? charGrid(chars)
          : note(t("profile.blocks.characters.noResult"));
  } else {
    body =
      animes == null ? (
        note(busy ? "…" : t("profile.blocks.characters.searchHint"))
      ) : animes.length ? (
        <div
          className={`grid content-start ${z.gap}`}
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${z.col}, 1fr))` }}
        >
          {animes.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(a)}
              title={a.title}
              className={`group grid min-w-0 content-start text-left ${z.inner}`}
            >
              <span className="relative block w-full overflow-hidden rounded-xl bg-white/10 ring-1 ring-white/[0.08] transition-[box-shadow] group-hover:ring-white/30" style={{ aspectRatio: "2 / 3" }}>
                {a.cover ? (
                  <Image
                    src={a.cover}
                    alt={a.title}
                    fill
                    sizes={z.img}
                    className="object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                  />
                ) : null}
              </span>
              <span className={`line-clamp-2 font-semibold leading-snug text-white ${z.name}`}>{a.title}</span>
            </button>
          ))}
        </div>
      ) : (
        note(t("profile.blocks.characters.noAnime"))
      );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("profile.blocks.characters.back")}
          title={t("profile.blocks.characters.back")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-white/70 ring-1 ring-white/10 transition-colors hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} className="h-3.5 w-3.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(null);
          }}
          onKeyDown={(e) => {
            /* La carte écoute le clavier pour se déplacer : taper un nom ne
               doit pas la faire bouger. */
            e.stopPropagation();
            if (e.key === "Escape") (open ? setOpen(null) : q ? setQ("") : onBack());
          }}
          placeholder={t(
            mode === "char"
              ? "profile.blocks.characters.searchPlaceholder"
              : "profile.blocks.characters.searchAnimePlaceholder",
          )}
          className="h-8 min-w-[8rem] max-w-sm flex-1 rounded-lg bg-white/[0.06] px-3 font-karla text-[13px] text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-action"
        />
        <div className="w-[12.5rem] shrink-0">
          <Segmented
            className=""
            label={t("profile.blocks.characters.searchTitle")}
            value={mode}
            choices={[
              { value: "char", label: t("profile.blocks.characters.modeChar") },
              { value: "anime", label: t("profile.blocks.characters.modeAnime") },
            ]}
            onPick={(v) => setMode(v as "char" | "anime")}
          />
        </div>
      </div>
      <div className="as-scroller min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-1 pr-2">{body}</div>
    </div>
  );
}
