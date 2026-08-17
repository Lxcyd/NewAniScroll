/**
 * Popup de classement des langues de lecture.
 *
 * Affichee UNE fois, au premier episode ouvert (la page de lecture la declenche
 * quand `getLangOrder()` vaut `null`), et re-ouvrable depuis Reglages > Lecteur.
 *
 * Trois cartes — doublage VF, VOSTFR, lecteur multi-langue — posees sous des
 * numeros FIXES 1-2-3. On deplace une carte sous le numero voulu : l'ordre
 * obtenu devient l'ordre d'essai des lecteurs (cf. lib/prefs/langPref.ts).
 *
 * ── Le glisser-deposer ───────────────────────────────────────────────────────
 * Premiere version faite avec `Reorder` de framer-motion : inutilisable, les
 * cartes sautaient et ne suivaient pas le doigt. `Reorder` mesure des elements
 * qu'il reordonne lui-meme dans le DOM ; avec trois cartes `flex-1` de largeur
 * egale, chaque permutation change la mesure sous ses pieds.
 *
 * Ici, comme dans le gestionnaire de listes de l'ancienne AniScroll (Pointer
 * Events + placeholder, `startRowDrag` dans scroll-helpers.js), on pilote la
 * position a la main. En plus simple, parce que les trois emplacements sont
 * fixes et de largeur egale :
 *
 *   - l'ordre du DOM ne bouge JAMAIS (toujours vf, vo, multi) ;
 *   - chaque carte est posee sur son emplacement par un `translateX` de
 *     `(emplacement - position DOM) x pas` ;
 *   - pendant le glissement, la carte tiree ajoute le deplacement du pointeur
 *     et perd sa transition ; les autres gardent la leur, donc elles glissent
 *     toutes seules quand l'ordre change.
 *
 * Rien n'est mesure pendant le geste, donc rien ne peut sauter. Pointer Events
 * (+ `touch-action: none`) couvrent souris, tactile et stylet d'un seul jeu de
 * handlers, et `setPointerCapture` garde le geste meme si le doigt sort de la
 * carte. Les fleches restent le repli clavier / petit ecran.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_LANG_ORDER,
  getLangOrder,
  setLangOrder,
  type Lang,
} from "@/lib/prefs/langPref";

/** Ordre DOM, fige. Le classement de l'utilisateur ne bouge que les translations. */
const LANGS: Lang[] = ["vf", "vo", "multi"];
/** Doit rester synchro avec le `gap-3` de la rangee (12px). */
const GAP = 12;

/** Doublage : le micro de Material Symbols (fourni par le user). */
function DubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={className} aria-hidden>
      <path d="M395-435q-35-35-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35q-50 0-85-35Zm85-205Zm-40 520v-123q-104-14-172-93t-68-184h80q0 83 58.5 141.5T480-320q83 0 141.5-58.5T680-520h80q0 105-68 184t-172 93v123h-80Zm68.5-371.5Q520-503 520-520v-240q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760v240q0 17 11.5 28.5T480-480q17 0 28.5-11.5Z" />
    </svg>
  );
}

/** Sous-titres — meme famille (Material Symbols, viewBox 0 -960 960 960). */
function SubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={className} aria-hidden>
      <path d="M240-320h320v-80H240v80Zm400 0h80v-80h-80v80ZM240-480h80v-80h-80v80Zm160 0h320v-80H400v80ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-480H160v480Zm0 0v-480 480Z" />
    </svg>
  );
}

/** Multi-langue — le globe de Material Symbols. */
function MultiIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={className} aria-hidden>
      <path d="M325-111.5q-73-31.5-127.5-86t-86-127.5Q80-398 80-480.5t31.5-155q31.5-72.5 86-127t127.5-86Q398-880 480.5-880t155 31.5q72.5 31.5 127 86t86 127Q880-563 880-480.5T848.5-325q-31.5 73-86 127.5t-127 86Q563-80 480.5-80T325-111.5ZM480-162q26-36 45-75t31-83H404q12 44 31 83t45 75Zm-104-16q-18-33-31.5-68.5T322-320H204q29 50 72.5 87t99.5 55Zm208 0q56-18 99.5-55t72.5-87H638q-9 38-22.5 73.5T584-178ZM170-400h136q-3-20-4.5-39.5T300-480q0-21 1.5-40.5T306-560H170q-5 20-7.5 39.5T160-480q0 21 2.5 40.5T170-400Zm216 0h188q3-20 4.5-39.5T580-480q0-21-1.5-40.5T574-560H386q-3 20-4.5 39.5T380-480q0 21 1.5 40.5T386-400Zm268 0h136q5-20 7.5-39.5T800-480q0-21-2.5-40.5T790-560H654q3 20 4.5 39.5T660-480q0 21-1.5 40.5T654-400Zm-16-240h118q-29-50-72.5-87T584-782q18 33 31.5 68.5T638-640Zm-234 0h152q-12-44-31-83t-45-75q-26 36-45 75t-31 83Zm-200 0h118q9-38 22.5-73.5T376-782q-56 18-99.5 55T204-640Z" />
    </svg>
  );
}

const CARDS: Record<
  Lang,
  {
    Icon: (p: { className?: string }) => JSX.Element;
    tag: string;
    titleKey: string;
    descKey: string;
  }
> = {
  vf: { Icon: DubIcon, tag: "VF", titleKey: "player.langPref.vfTitle", descKey: "player.langPref.vfDesc" },
  vo: { Icon: SubIcon, tag: "VOSTFR", titleKey: "player.langPref.voTitle", descKey: "player.langPref.voDesc" },
  multi: { Icon: MultiIcon, tag: "Multi", titleKey: "player.langPref.multiTitle", descKey: "player.langPref.multiDesc" },
};

/** Deplace `from` vers `to` dans une copie du tableau. */
function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = arr.slice();
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function LangPreferenceModal({
  open,
  onSave,
}: {
  open: boolean;
  /** Recoit l'ordre valide — deja persiste quand le callback est appele. */
  onSave?: (order: Lang[]) => void;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<Lang[]>(DEFAULT_LANG_ORDER);
  const rowRef = useRef<HTMLDivElement>(null);
  /** Largeur d'un emplacement, mesuree une fois (et a chaque resize). */
  const [slotW, setSlotW] = useState(0);
  /** Carte en cours de glissement + son deplacement courant, en px. */
  const [drag, setDrag] = useState<{ lang: Lang; dx: number } | null>(null);
  const dragRef = useRef<{ lang: Lang; startX: number } | null>(null);

  // Re-ouverture (Reglages) : repartir du classement enregistre, pas du defaut.
  useEffect(() => {
    if (open) setOrder(getLangOrder() || DEFAULT_LANG_ORDER);
  }, [open]);

  useEffect(() => {
    const el = rowRef.current;
    if (!open || !el) return;
    const measure = () => setSlotW((el.clientWidth - GAP * 2) / 3);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  if (!open) return null;

  const step = slotW + GAP;

  const move = (lang: Lang, dir: -1 | 1) => {
    setOrder((prev) => {
      const i = prev.indexOf(lang);
      const j = i + dir;
      return i === -1 || j < 0 || j >= prev.length ? prev : moveItem(prev, i, j);
    });
  };

  const onPointerDown = (e: React.PointerEvent, lang: Lang) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { lang, startX: e.clientX };
    setDrag({ lang, dx: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !step) return;
    const from = order.indexOf(d.lang);
    // Bride le deplacement aux emplacements existants : une carte ne peut pas
    // sortir de la rangee, meme si le doigt part au bout de l'ecran.
    const dx = clamp(e.clientX - d.startX, -from * step, (LANGS.length - 1 - from) * step);
    const target = clamp(Math.round(from + dx / step), 0, LANGS.length - 1);
    if (target !== from) {
      setOrder((prev) => moveItem(prev, from, target));
      // L'emplacement de la carte vient de changer, donc sa position de repos
      // aussi : on decale l'origine du geste d'autant, sinon elle sauterait
      // d'un cran sous le doigt.
      d.startX += (target - from) * step;
      setDrag({ lang: d.lang, dx: e.clientX - d.startX });
      return;
    }
    setDrag({ lang: d.lang, dx });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  const save = () => {
    setLangOrder(order);
    onSave?.(order);
  };

  const slotLabels = [
    t("player.langPref.slotFirst"),
    t("player.langPref.slotThen"),
    t("player.langPref.slotLast"),
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4">
      <div className="w-full max-w-2xl rounded-card bg-as-card ring-1 ring-white/10 shadow-poster p-6 sm:p-7">
        {/* En-tete : meme grammaire que les autres panneaux du lecteur —
            pastille d'accent, titre Outfit, sous-titre Karla en retrait. */}
        <div className="flex items-start gap-3.5 mb-5">
          <span className="flex-none grid place-items-center w-11 h-11 rounded-card bg-action/15 ring-1 ring-action/30 text-action">
            <MultiIcon className="w-6 h-6" />
          </span>
          <div className="min-w-0">
            <h3 className="font-outfit text-lg font-semibold leading-tight">
              {t("player.langPref.title")}
            </h3>
            <p className="font-karla text-sm text-white/55 mt-1">
              {t("player.langPref.body")}
            </p>
          </div>
        </div>

        {/* Numeros FIXES : ils ne bougent pas, ce sont les cartes qui glissent
            dessous. Meme rangee flex que les cartes pour rester alignes. */}
        <div className="flex gap-3 mb-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex-1 basis-0 flex flex-col items-center gap-1">
              <span
                className={`grid place-items-center w-7 h-7 rounded-full text-sm font-semibold transition-colors ${
                  i === 0
                    ? "bg-action text-white shadow-glow"
                    : "bg-white/5 text-white/45 ring-1 ring-white/10"
                }`}
              >
                {i + 1}
              </span>
              <span className="font-karla text-[10px] uppercase tracking-wider text-white/30">
                {slotLabels[i]}
              </span>
            </div>
          ))}
        </div>

        {/* Invisible tant que la largeur d'un emplacement n'est pas mesuree :
            avant ca les translations valent 0, donc un classement enregistre
            non-standard s'afficherait une frame dans l'ordre du DOM. */}
        <div
          ref={rowRef}
          style={{ opacity: slotW ? 1 : 0 }}
          className="relative flex gap-3 items-stretch"
        >
          {LANGS.map((lang, domIndex) => {
            const card = CARDS[lang];
            const slot = order.indexOf(lang);
            const dragging = drag?.lang === lang;
            const top = slot === 0;
            const x = (slot - domIndex) * step + (dragging ? drag!.dx : 0);
            return (
              <div
                key={lang}
                onPointerDown={(e) => onPointerDown(e, lang)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                style={{
                  transform: `translateX(${x}px)`,
                  transition: dragging ? "none" : "transform 220ms cubic-bezier(.2,.8,.2,1)",
                  zIndex: dragging ? 10 : 1,
                  touchAction: "none",
                }}
                className={`flex-1 basis-0 min-w-0 select-none rounded-card p-4 flex flex-col items-center text-center gap-2 ring-1 ${
                  dragging ? "cursor-grabbing" : "cursor-grab"
                } ${
                  top
                    ? "bg-action/10 ring-action/50 shadow-[0_0_20px_rgba(233,69,96,0.15)]"
                    : "bg-as-surface/60 ring-white/5 hover:ring-white/15"
                } ${dragging ? "shadow-poster brightness-110" : ""}`}
              >
                <span
                  className={`grid place-items-center w-12 h-12 rounded-card ring-1 ${
                    top
                      ? "bg-action/15 ring-action/25 text-action"
                      : "bg-white/5 ring-white/10 text-white/60"
                  }`}
                >
                  <card.Icon className="w-7 h-7" />
                </span>
                <span className="font-outfit text-sm font-semibold leading-tight">
                  {t(card.titleKey)}
                </span>
                <span className="font-karla text-[10px] uppercase tracking-wider text-white/35">
                  {card.tag}
                </span>
                <span className="font-karla text-[11px] leading-snug text-white/50">
                  {t(card.descKey)}
                </span>

                {/* Repli clavier / petit ecran du glisser-deposer. Le
                    `stopPropagation` evite qu'un clic sur une fleche demarre
                    un glissement. */}
                <span className="flex items-center gap-1.5 pt-1">
                  <button
                    type="button"
                    disabled={slot === 0}
                    aria-label={t("player.langPref.moveLeft") as string}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => move(lang, -1)}
                    className="w-7 h-7 grid place-items-center rounded-full bg-white/5 ring-1 ring-white/10 text-white/70 leading-none transition hover:bg-white/15 hover:text-white disabled:opacity-20 disabled:hover:bg-white/5"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    disabled={slot === LANGS.length - 1}
                    aria-label={t("player.langPref.moveRight") as string}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => move(lang, 1)}
                    className="w-7 h-7 grid place-items-center rounded-full bg-white/5 ring-1 ring-white/10 text-white/70 leading-none transition hover:bg-white/15 hover:text-white disabled:opacity-20 disabled:hover:bg-white/5"
                  >
                    ›
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 mt-6">
          <p className="font-karla text-xs text-white/35">
            {t("player.langPref.hint")}
          </p>
          <button
            type="button"
            onClick={save}
            className="shrink-0 rounded-card bg-action px-5 py-2.5 text-sm font-medium text-white shadow-glow transition hover:brightness-110"
          >
            {t("player.langPref.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
