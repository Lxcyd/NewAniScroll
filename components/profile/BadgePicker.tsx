import { useState } from "react";
import { SparklesIcon, XMarkIcon } from "@heroicons/react/24/outline";
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
  hint,
  t
}: {
  /** La consigne, en tête de la zone des places. */
  hint?: React.ReactNode;
  /** Les badges obtenus à montrer, déjà filtrés et triés. */
  owned: string[];
  /** Les badges en avant, dans l'ordre des places. */
  chosen: string[];
  /** Badges par ligne (bouton de densité de l'en-tête du menu). */
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
  /* DEUX ZONES, deux boîtes au fond des sections du panneau du mur
     (`bg-white/[0.03]`, liseré `white/[0.07]`) : en haut ce qu'on compose (la
     consigne et les trois places), dessous ce dans quoi on pioche (le menu de
     rareté et la grille, seule partie qui défile). */
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <BadgeDefs />
      <section className="grid shrink-0 gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.07]">
      {hint}
      <div className="grid grid-cols-3 gap-2">
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

      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/[0.07]">
      <div className="shrink-0">{toolbar}</div>

      {/* Deux catégories : les badges du catalogue, puis les secrets — ceux
          qu'on ne voit qu'une fois trouvés, et qu'on a souvent le plus envie
          de montrer. Une catégorie vide ne s'affiche pas. */}
      <div className="as-scroller -mx-1 grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overflow-x-hidden px-1 pb-1 pt-1">
      {[
        { key: "normal", ids: owned.filter((id) => !BY_ID[id].secret) },
        { key: "secret", ids: owned.filter((id) => BY_ID[id].secret) }
      ].map((g) =>
        g.ids.length ? (
          /* Les secrets se DÉTACHENT : un filet au-dessus, puis leur propre
             boîte teintée de leur couleur — celle du « + n secrets » de
             l'onglet Badges (#FF7F57). Ce sont des trouvailles, pas un palier
             de plus. */
          <section
            key={g.key}
            className={
              g.key === "secret"
                ? "relative mt-4 grid gap-2 rounded-xl bg-[#FF7F57]/[0.06] p-2.5 ring-1 ring-[#FF7F57]/30 before:absolute before:-top-3.5 before:inset-x-1 before:h-px before:bg-white/10"
                : "grid gap-2"
            }
          >
            <p
              className={`flex items-center gap-2 px-2 pt-1 font-karla text-[11px] font-bold uppercase tracking-[.12em] ${
                g.key === "secret" ? "text-[#FF7F57]" : "text-white/40"
              }`}
            >
              {g.key === "secret" ? <SparklesIcon className="h-3.5 w-3.5" /> : null}
              {t(g.key === "secret" ? "badges.ui.family.secret" : "profile.studioKind_badges")}
              <span className={g.key === "secret" ? "text-[#FF7F57]/55" : "text-white/25"}>{g.ids.length}</span>
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
      </section>
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
        /* Aucun badge n'est terni, même les trois places prises : on peut
           toujours en glisser un sur une place pour la remplacer, et un jeton
           éteint se lisait comme « pas obtenu ». Seul l'anneau dit le choix. */
        /* Un par ligne, la case devient une LIGNE : le jeton à gauche, le nom
           à côté, lisible en entier. */
        /* `min-w-0` : un élément de grille ne descend pas d'office sous la
           largeur de son contenu — le nom débordait de sa colonne. */
        className={`relative flex min-w-0 cursor-grab rounded-xl transition-colors active:cursor-grabbing ${
          cols === 1 ? "items-center gap-4 px-3 py-2.5 text-left" : "flex-col items-center gap-1.5 px-1.5 pb-2 pt-3"
        } ${
          on
            ? /* Le fond gris des autres cases, en rose. En valeur explicite :
                 `bg-action/15` ne peignait rien. */
              "bg-[#E94560]/[0.12] ring-2 ring-action"
            : "bg-white/[0.04] ring-1 ring-white/10 hover:bg-white/[0.08]"
        }`}
      >
        {/* Le jeton suit la taille des cases : plus de colonnes, plus petit. */}
        {token(id, cols === 1 ? 80 : cols <= 3 ? 60 : cols <= 4 ? 52 : 40)}
        <span
          className={`font-karla font-bold leading-tight text-white/90 ${
            cols === 1
              ? "min-w-0 flex-1 text-[15px]"
              : "line-clamp-2 w-full break-words text-center text-[11px] [hyphens:auto]"
          }`}
        >
          {nameOf(id)}
        </span>
      </button>
    );
  }
}
