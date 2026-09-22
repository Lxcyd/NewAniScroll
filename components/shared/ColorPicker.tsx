import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Le choix d'une couleur au doigt : carré saturation/valeur, rail de teinte,
 * pastilles, et la valeur en HEX / RGB / HSV / HSL. Partagé par le studio de
 * profil (couleur de plaque) et les réglages (couleur du thème) : c'est le même
 * geste des deux côtés, et le sélecteur natif du système ne ressemblait au site
 * dans aucun des deux.
 *
 * C'est le portage du sélecteur de l'AniScroll d'origine (le `ColorPickerPopup`
 * de la création de statut) — mêmes gestes, mêmes vingt-quatre pastilles, même
 * ordre des onglets, pour que la main qui connaît l'un connaisse l'autre. Deux
 * écarts assumés : la surface prend le langage du site (fond translucide, anneau
 * blanc à 10 %, `bg-action`) au lieu du gris #2b2b2b, et rien n'est en position
 * fixe — il s'insère dans un panneau, il ne flotte pas au-dessus.
 *
 * Aucune dépendance : un sélecteur de couleur, c'est deux conversions et un
 * glisser. Une librairie coûterait plus à habiller qu'à écrire.
 *
 * L'ÉTAT VIT EN HSV, pas en hexadécimal. C'est ce qui permet de traverser le
 * noir sans perdre sa teinte : en hexadécimal, descendre la valeur à zéro donne
 * #000000, et remonter repart du rouge. La teinte choisie doit survivre au
 * passage par le noir — d'où la conversion à sens unique vers le hex.
 */

type Rgb = { r: number; g: number; b: number };

const PRESETS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1",
  "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#ffffff", "#d1d5db", "#6b7280", "#374151",
  "#1f2937", "#111827", "#000000", "#713f12",
];

const TABS = ["HEX", "RGB", "HSV", "HSL"] as const;
type Tab = (typeof TABS)[number];

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const byte = (n: number) => Math.round(clamp01(n) * 255);

function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] :
    h < 120 ? [x, c, 0] :
    h < 180 ? [0, c, x] :
    h < 240 ? [0, x, c] :
    h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

function rgbToHsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}

/** HSV → HSL : les deux « S » ne veulent pas dire la même chose, d'où le calcul
    plutôt qu'un renommage. */
function hsvToHsl(h: number, s: number, v: number) {
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s: sl, l };
}

function hslToHsv(h: number, s: number, l: number) {
  const v = l + s * Math.min(l, 1 - l);
  return { h, s: v === 0 ? 0 : 2 * (1 - l / v), v };
}

function toHex(h: number, s: number, v: number): string {
  const { r, g, b } = hsvToRgb(h, s, v);
  return `#${[r, g, b].map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const n = parseInt(s, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

const FIELD =
  "w-full rounded-lg bg-black/40 px-1 py-1.5 text-center font-karla text-[12px] font-bold text-white outline-none ring-1 ring-white/10 transition-colors focus:ring-action/60";

export default function ColorPicker({
  value,
  onChange,
  wide = false,
  header,
}: {
  value: string;
  onChange: (hex: string) => void;
  /**
   * La disposition large : le carré passe à gauche en 160 px, tout le reste se
   * range à sa droite. C'est ce qui rend le sélecteur tenable dans un panneau
   * de 768 px — en pleine largeur, son carré au rapport 5/3 fait 438 px de haut
   * à lui seul, et pousse le reste hors de l'écran. Repliée (le popover des
   * réglages, 280 px), la disposition d'origine reste la bonne.
   */
  wide?: boolean;
  /** Un bloc à poser en tête de la colonne de droite (les couleurs de base du
      studio, avec leur intitulé — que ce composant ne traduit pas lui-même). */
  header?: ReactNode;
}) {
  const [hsv, setHsv] = useState(() => {
    const rgb = parseHex(value) ?? { r: 0.91, g: 0.27, b: 0.38 };
    return rgbToHsv(rgb.r, rgb.g, rgb.b);
  });
  const [tab, setTab] = useState<Tab>("HEX");
  /* Le champ hexadécimal se tape caractère par caractère : tant qu'il n'est pas
     complet on garde la frappe telle quelle, sinon « #ff » se ferait réécrire
     sous les doigts. */
  const [typed, setTyped] = useState<string | null>(null);

  const hex = toHex(hsv.h, hsv.s, hsv.v);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  /* Une couleur reçue de l'extérieur (une pastille cliquée dans la liste
     au-dessus) doit se voir ici — mais seulement si elle diffère VRAIMENT de ce
     qu'on affiche, sans quoi chaque frappe se ferait renvoyer sa propre valeur
     arrondie et la teinte sauterait. */
  useEffect(() => {
    if (value.toLowerCase() === hex.toLowerCase()) return;
    const rgb = parseHex(value);
    if (rgb) setHsv(rgbToHsv(rgb.r, rgb.g, rgb.b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = useCallback(
    (next: { h: number; s: number; v: number }) => {
      setHsv(next);
      setTyped(null);
      onChange(toHex(next.h, next.s, next.v));
    },
    [onChange],
  );

  const drag = useCallback(
    (ref: typeof svRef, e: React.PointerEvent, fn: (x: number, y: number) => void) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      fn(clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height));
    },
    [],
  );

  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
  const hsl = hsvToHsl(hsv.h, hsv.s, hsv.v);

  /* Les pièces, montées plus bas dans l'une ou l'autre disposition. Elles sont
     déclarées une seule fois : deux mises en page, mais un seul rendu à tenir
     à jour. */

  /* Le carré saturation / valeur. `touch-none` : sur mobile le glisser doit
     peindre, pas faire défiler la palette sous le doigt. */
  const svBlock = (
      <div
        ref={svRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(svRef, e, (x, y) => commit({ ...hsv, s: x, v: 1 - y }));
        }}
        onPointerMove={(e) => {
          if (!(e.buttons & 1)) return;
          drag(svRef, e, (x, y) => commit({ ...hsv, s: x, v: 1 - y }));
        }}
        className={`relative w-full cursor-crosshair touch-none rounded-lg ${
          wide ? "h-40" : "aspect-[5/3]"
        }`}
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <span
          className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.5)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
        />
      </div>
  );

  const hueBlock = (
      <div
        ref={hueRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(hueRef, e, (x) => commit({ ...hsv, h: x * 360 }));
        }}
        onPointerMove={(e) => {
          if (!(e.buttons & 1)) return;
          drag(hueRef, e, (x) => commit({ ...hsv, h: x * 360 }));
        }}
        className="relative h-3.5 w-full cursor-pointer touch-none rounded-full"
        style={{
          background:
            "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
      >
        <span
          className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black/25 bg-white shadow-[0_1px_4px_rgba(0,0,0,.5)]"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
        />
      </div>
  );

  /* L'aperçu, la pastille de la couleur courante. Son anneau est la couleur
     ASSOMBRIE d'un tiers, teinte et saturation intactes : de la même famille
     que le disque, mais franchement plus foncé.

     Assombri et non éclairci, parce qu'un anneau clair disparaît exactement là
     où on en a besoin — sur un jaune ou un blanc, il n'y a rien de plus clair à
     mettre autour. Un noir, lui, n'a rien de plus foncé : c'est le seul cas où
     l'anneau s'éclaircit, sans quoi la pastille n'aurait plus de bord du tout
     sur le fond sombre du panneau. */
  const ringHex = toHex(hsv.h, hsv.s, hsv.v > 0.28 ? hsv.v * 0.65 : hsv.v + 0.22);
  const dot = (
    <span
      className="h-8 w-8 shrink-0 rounded-full"
      style={{ background: hex, boxShadow: `0 0 0 2px ${ringHex}` }}
    />
  );

  /* Le mur de nuances. Douze colonnes en large, huit en replié : les mêmes
     vingt-quatre couleurs, en deux ou trois rangées selon la place. */
  const swatchBlock = (
        <div className={`grid flex-1 gap-1 ${wide ? "grid-cols-12" : "grid-cols-8"}`}>
          {PRESETS.map((p) => {
            const c = parseHex(p)!;
            return (
              <button
                key={p}
                type="button"
                title={p}
                aria-label={p}
                onClick={() => commit(rgbToHsv(c.r, c.g, c.b))}
                className="aspect-square w-full rounded transition-transform hover:scale-125 hover:ring-2 hover:ring-white/40"
                style={{ background: p }}
              />
            );
          })}
        </div>
  );

  /* Les onglets de format */
  const tabsBlock = (
      <div className="flex gap-0.5 rounded-lg bg-white/[0.06] p-0.5">
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            className={`flex-1 rounded-md py-1 font-karla text-[11px] font-bold transition-colors ${
              tab === x ? "bg-action text-white" : "text-white/45 hover:text-white"
            }`}
          >
            {x}
          </button>
        ))}
      </div>
  );

  const inputsBlock = (
      <div className="min-w-0 flex-1">
        {tab === "HEX" ? (
          <div className="flex gap-1.5">
            <input
              value={typed ?? hex}
              maxLength={7}
              spellCheck={false}
              onChange={(e) => {
                setTyped(e.target.value);
                const parsed = parseHex(e.target.value);
                if (parsed) {
                  const next = rgbToHsv(parsed.r, parsed.g, parsed.b);
                  /* Une saisie noire ou grise ne dit rien de la teinte : on garde
                     celle du rail, sinon le curseur du haut saute à zéro. */
                  setHsv({ h: next.v === 0 || next.s === 0 ? hsv.h : next.h, s: next.s, v: next.v });
                  onChange(toHex(next.v === 0 || next.s === 0 ? hsv.h : next.h, next.s, next.v));
                }
              }}
              onBlur={() => setTyped(null)}
              className={`${FIELD} flex-1 font-mono uppercase tracking-wider`}
            />
            <button
              type="button"
              onClick={() => commit({ h: hsv.h, s: 0, v: 0 })}
              title="#000000"
              className="grid w-9 shrink-0 place-items-center rounded-lg bg-black/40 text-white/45 ring-1 ring-white/10 transition-colors hover:text-white"
            >
              {/* L'icône « effacer » de Material, en `currentColor` pour suivre
                  le survol du bouton. */}
              <svg viewBox="0 -960 960 960" className="h-[18px] w-[18px]" fill="currentColor">
                <path d="m456-320 104-104 104 104 56-56-104-104 104-104-56-56-104 104-104-104-56 56 104 104-104 104 56 56Zm-96 160q-19 0-36-8.5T296-192L80-480l216-288q11-15 28-23.5t36-8.5h440q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H360ZM180-480l180 240h440v-480H360L180-480Zm400 0Z" />
              </svg>
            </button>
          </div>
        ) : (
          <div className="flex gap-1.5">
            {(tab === "RGB"
              ? ([
                  ["R", byte(rgb.r), 255, (n: number) => rgbToHsv(n / 255, rgb.g, rgb.b)],
                  ["G", byte(rgb.g), 255, (n: number) => rgbToHsv(rgb.r, n / 255, rgb.b)],
                  ["B", byte(rgb.b), 255, (n: number) => rgbToHsv(rgb.r, rgb.g, n / 255)],
                ] as const)
              : tab === "HSV"
                ? ([
                    ["H", Math.round(hsv.h), 360, (n: number) => ({ ...hsv, h: n })],
                    ["S", Math.round(hsv.s * 100), 100, (n: number) => ({ ...hsv, s: n / 100 })],
                    ["V", Math.round(hsv.v * 100), 100, (n: number) => ({ ...hsv, v: n / 100 })],
                  ] as const)
                : ([
                    ["H", Math.round(hsl.h), 360, (n: number) => hslToHsv(n, hsl.s, hsl.l)],
                    ["S", Math.round(hsl.s * 100), 100, (n: number) => hslToHsv(hsl.h, n / 100, hsl.l)],
                    ["L", Math.round(hsl.l * 100), 100, (n: number) => hslToHsv(hsl.h, hsl.s, n / 100)],
                  ] as const)
            ).map(([name, val, max, apply]) => (
              <label key={name} className="flex flex-1 flex-col items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={max}
                  value={val}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) commit(apply(Math.min(max, Math.max(0, n))));
                  }}
                  className={FIELD}
                  aria-label={name}
                />
                <span className="font-karla text-[10px] font-bold text-white/35">{name}</span>
              </label>
            ))}
          </div>
        )}
      </div>
  );

  /* ── Large : le carré à gauche, tout le reste à sa droite ──────────── */
  if (wide) {
    return (
      <div className="grid gap-3.5 rounded-xl bg-black/25 p-3 ring-1 ring-white/10 sm:grid-cols-[10rem_1fr]">
        {/* Le rail prend la place qui reste sous le carré et s'y centre : la
            colonne de droite est plus haute, et un rail collé sous le carré
            laissait un vide en bas de la gauche. */}
        <div className="flex flex-col gap-2.5">
          {svBlock}
          <div className="flex flex-1 items-center">{hueBlock}</div>
        </div>
        <div className="grid content-start gap-2.5">
          {header}
          {swatchBlock}
          {/* La ligne du bas tient l'aperçu, la valeur et les formats : c'est ce
              qui permet au bloc entier de finir sous les 250 px. */}
          <div className="flex items-center gap-2">
            {dot}
            {inputsBlock}
            <div className="w-[13.5rem] shrink-0">{tabsBlock}</div>
          </div>
        </div>
      </div>
    );
  }

  /* ── Replié : la colonne d'origine, pour un popover de 280 px ──────── */
  return (
    <div className="grid gap-2.5 rounded-xl bg-black/25 p-3 ring-1 ring-white/10">
      {svBlock}
      {hueBlock}
      <div className="flex items-center gap-2.5">
        {dot}
        {swatchBlock}
      </div>
      {tabsBlock}
      <div className="flex">{inputsBlock}</div>
    </div>
  );
}
