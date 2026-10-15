import { useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { BY_ID } from "@/lib/badges/catalog";
import BadgeDefs from "./badges/BadgeDefs";
import BadgeToken from "./badges/BadgeToken";
import { FEATURED_MAX } from "./FeaturedBadges";

/**
 * Le choix des badges mis en avant, au GLISSER-DÉPOSER (maquette 10 de
 * l'artefact « Choisir ses badges », retenue le 15/10/2026).
 *
 * En haut, les trois places, dans l'ordre où les badges s'aligneront à côté
 * du pseudo ; dessous, les badges obtenus. On attrape un badge et on le
 * dépose sur une place : une place prise est remplacée, et un badge déjà
 * placé qu'on dépose ailleurs ÉCHANGE sa place avec l'occupant. Le clic reste
 * un raccourci complet — sur un badge, il le met à la première place libre ou
 * le retire ; sur la croix d'une place, il la vide — parce qu'un glisser ne
 * se fait ni au clavier ni au doigt (le DnD HTML5 est inerte sur mobile).
 */
/**
 * Le départ d'un glisser : l'id du badge, et un FANTÔME fait du seul jeton.
 * Sans `setDragImage`, le navigateur photographiait la case entière — bordure,
 * numéro, croix — et c'est la boîte qu'on voyait partir, pas le badge
 * (15/10/2026). Le jeton est cloné hors écran le temps que le navigateur en
 * prenne l'image, puis retiré.
 */
function startDrag(e: React.DragEvent<HTMLElement>, id: string) {
  e.dataTransfer.setData("text/plain", id);
  e.dataTransfer.effectAllowed = "move";
  const src = e.currentTarget.querySelector<HTMLElement>(".as-badge-token");
  if (!src) return;
  const ghost = src.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    pointerEvents: "none"
  });
  document.body.appendChild(ghost);
  /* Saisi par son centre — mesuré sur le clone, hors de la scène du studio
     qui est mise à l'échelle. */
  e.dataTransfer.setDragImage(
    ghost,
    ghost.offsetWidth / 2,
    ghost.offsetHeight / 2
  );
  requestAnimationFrame(() => ghost.remove());
}

export default function BadgePicker({
  owned,
  chosen,
  cols = 4,
  onChange,
  nameOf,
  toolbar,
  t
}: {
  /** Les badges obtenus à montrer, déjà filtrés et triés. */
  owned: string[];
  /** Les badges en avant, dans l'ordre des places. */
  chosen: string[];
  /** Badges par ligne (boutons − / + de l'en-tête du menu). */
  cols?: number;
  onChange: (next: string[]) => void;
  nameOf: (id: string) => string;
  /** Les tris, posés entre les places et la grille. */
  toolbar?: React.ReactNode;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [over, setOver] = useState<number | null>(null);
  const full = chosen.length >= FEATURED_MAX;

  const toggle = (id: string) =>
    onChange(
      chosen.includes(id)
        ? chosen.filter((b) => b !== id)
        : full
          ? chosen
          : [...chosen, id]
    );

  const drop = (id: string, at: number) => {
    const slots: (string | undefined)[] = Array.from(
      { length: FEATURED_MAX },
      (_, i) => chosen[i]
    );
    const from = slots.indexOf(id);
    if (from >= 0) slots[from] = slots[at];
    slots[at] = id;
    onChange(slots.filter((s): s is string => !!s));
  };

  const token = (id: string, size: number) => {
    const def = BY_ID[id];
    return (
      <BadgeToken
        id={id}
        rarity={def.rarity}
        icon={def.icon}
        tag={def.tag}
        unlocked
        animate={false}
        size={size}
      />
    );
  };

  /* Les places et la barre d'outils restent fixes ; seule la liste des badges
     défile (`min-h-0 flex-1 overflow-y-auto`), dans la hauteur que la colonne
     du studio donne au menu. */
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <BadgeDefs />
      <div className="grid shrink-0 grid-cols-3 gap-2 px-1">
        {Array.from({ length: FEATURED_MAX }, (_, i) => {
          const id = chosen[i];
          return (
            <div
              key={i}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver((o) => (o === i ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const dropped = e.dataTransfer.getData("text/plain");
                if (BY_ID[dropped]) drop(dropped, i);
              }}
              className={`relative grid h-28 place-items-center rounded-2xl border-[1.5px] transition-colors ${
                over === i
                  ? "border-action bg-action/10"
                  : id
                    ? "border-white/15 bg-white/[0.04]"
                    : "border-dashed border-white/20"
              }`}
            >
              {id ? (
                <>
                  <div
                    draggable
                    onDragStart={(e) => startDrag(e, id)}
                    title={nameOf(id)}
                    className="grid cursor-grab justify-items-center gap-1 active:cursor-grabbing"
                  >
                    {token(id, 56)}
                    <span className="line-clamp-1 max-w-full px-1 text-center font-karla text-[11px] font-bold text-white/80">
                      {nameOf(id)}
                    </span>
                  </div>
                  <span className="absolute left-2 top-1.5 font-outfit text-[11px] font-bold text-white/35">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => onChange(chosen.filter((b) => b !== id))}
                    aria-label={t("profile.studioBadgesRemove", {
                      name: nameOf(id)
                    })}
                    title={t("profile.studioBadgesRemove", {
                      name: nameOf(id)
                    })}
                    className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <span className="font-karla text-xs text-white/40">
                  {t("profile.studioBadgesDrop")}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="shrink-0">{toolbar}</div>

      {/* Deux catégories : les badges du catalogue, puis les secrets — ceux
          qu'on ne voit qu'une fois trouvés, et qu'on a souvent le plus envie
          de montrer. Une catégorie vide ne s'affiche pas. */}
      <div className="as-scroller -mx-1 grid min-h-0 flex-1 content-start gap-3 overflow-y-auto px-1 pb-1">
      {[
        { key: "normal", ids: owned.filter((id) => !BY_ID[id].secret) },
        { key: "secret", ids: owned.filter((id) => BY_ID[id].secret) }
      ].map((g) =>
        g.ids.length ? (
          <section key={g.key} className="grid gap-2">
            <p className="flex items-center gap-2 px-2 pt-1 font-karla text-[11px] font-bold uppercase tracking-[.12em] text-white/40">
              {t(g.key === "secret" ? "badges.ui.family.secret" : "profile.studioKind_badges")}
              <span className="text-white/25">{g.ids.length}</span>
            </p>
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {g.ids.map(tile)}
            </div>
          </section>
        ) : null
      )}
      </div>
    </div>
  );

  function tile(id: string) {
    const on = chosen.includes(id);
    return (
      <button
        key={id}
        type="button"
        draggable
        onDragStart={(e) => startDrag(e, id)}
        aria-pressed={on}
        title={nameOf(id)}
        onClick={() => toggle(id)}
        className={`relative flex cursor-grab flex-col items-center gap-1.5 rounded-xl px-1.5 pb-2 pt-3 transition-colors active:cursor-grabbing ${
          on
            ? "bg-action/15 ring-2 ring-action"
            : full
              ? "bg-white/[0.03] opacity-50 ring-1 ring-white/10 hover:opacity-100"
              : "bg-white/[0.04] ring-1 ring-white/10 hover:bg-white/[0.08]"
        }`}
      >
        {/* Le jeton suit la taille des cases : plus de colonnes, plus petit. */}
        {token(id, cols <= 3 ? 64 : cols <= 4 ? 52 : cols <= 6 ? 42 : 34)}
        <span className="line-clamp-2 text-center font-karla text-[11px] font-bold leading-tight text-white/75">
          {nameOf(id)}
        </span>
      </button>
    );
  }
}
