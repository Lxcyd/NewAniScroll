import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import WidgetGrid, { type BlockChrome } from "./WidgetGrid";
import BlockLibrary from "./BlockLibrary";
import { EmptyBlock } from "./widgets/common";
import {
  CharactersBlock,
  FavoritesBlock,
  FormatsBlock,
  GenresBlock,
  ScoresBlock,
  SeasonBlock,
  StatusesBlock,
  StudiosBlock,
} from "./widgets/ListBlocks";
import { RecentsBlock, ResumeBlock } from "./widgets/DeviceBlocks";
import {
  BLOCKS,
  DEFAULT_BLOCKS,
  blockDef,
  blockSize,
  isKnownBlock,
  visibleTo,
} from "@/lib/profile/blocks";
import {
  addItem,
  compact,
  sanitizeLayout,
  type GridItem,
} from "@/lib/profile/grid";
import { setProfileLayout, useProfileLayout } from "@/lib/prefs/profileLayout";
import type { ProfileCharacter, ProfileEntry } from "@/lib/profile/types";

/**
 * L'onglet « Aperçu » : la grille de widgets du profil, sa barre d'outils et
 * sa bibliothèque de blocs.
 *
 * Trois choses seulement vivent ici — quel bloc peint quoi, qui a le droit de
 * réorganiser, et d'où vient la disposition. La géométrie est dans
 * lib/profile/grid.ts et chaque widget dans son propre fichier.
 *
 * LA DISPOSITION APPARTIENT AU PROFIL, PAS AU LECTEUR.
 *
 * Elle vivait dans `aniscroll:profileLayout`, une clé locale sauvegardée avec
 * la catégorie `prefs` — c'est-à-dire chez celui qui REGARDE. Un visiteur
 * voyait donc, au mieux, sa propre disposition, et le code s'en protégeait en
 * lui servant la grille par défaut : ce que le propriétaire rangeait, personne
 * d'autre ne le voyait jamais, et deux propriétaires partageant un navigateur
 * se marchaient dessus. Elle est maintenant une colonne de `users`
 * (`profile_layout`), lue au rendu serveur et servie à tout le monde, à côté de
 * `profile_banner` qui est publique pour exactement la même raison.
 *
 * Le seul écart qui reste entre les deux vues est celui des blocs `device` :
 * voir le commentaire dans l'effet ci-dessous, c'est une question de vérité et
 * non de permission.
 *
 * `lib/prefs/profileLayout.ts` reste, pour le seul cas qui n'a pas de compte :
 * le profil local d'un invité (components/profile/LocalProfile.tsx).
 */

type Props = {
  entries: ProfileEntry[];
  characters: ProfileCharacter[];
  isOwner: boolean;
  /** La disposition rangée par le propriétaire DU PROFIL, lue sur sa ligne
   *  `users` au rendu serveur. `null` : rien de rangé, la disposition par
   *  défaut. `undefined` : il n'y a pas de compte derrière — le profil local
   *  d'un invité — et la disposition reste alors celle de l'appareil. */
  accountLayout?: GridItem[] | null;
};

function defaultLayout(isOwner: boolean): GridItem[] {
  let items: GridItem[] = [];
  for (const id of DEFAULT_BLOCKS) {
    if (!visibleTo(isOwner, id)) continue;
    const [w, h] = blockSize(id);
    items = addItem(items, id, w, h);
  }
  return items;
}

export default function ProfileOverview({
  entries,
  characters,
  isOwner,
  accountLayout,
}: Props) {
  const { t } = useTranslation();
  /* Le compte l'emporte dès qu'il y en a un ; le hook n'est là que pour le
     profil local d'un invité. Il est appelé dans tous les cas — un hook ne se
     saute pas — mais son résultat est ignoré côté compte. */
  const onAccount = accountLayout !== undefined;
  const device = useProfileLayout();
  const source = onAccount ? accountLayout : device.layout;
  const loaded = onAccount || device.loaded;

  const [editing, setEditing] = useState(false);
  const [library, setLibrary] = useState(false);
  /* La disposition vit ici pendant la session : le stockage n'est écrit qu'aux
     changements, et le relire à chaque déplacement ferait un aller-retour par
     pixel. */
  const [layout, setLayout] = useState<GridItem[] | null>(null);

  /* La reprise des dispositions rangées AVANT que la grille ne devienne
     publique : elles sont dans le localStorage de leur auteur et nulle part sur
     son compte. Sans ça, tout le monde retrouverait la grille par défaut le
     jour du déploiement. Une seule fois, et seulement pour le propriétaire. */
  const migrated = useRef(false);

  useEffect(() => {
    if (!loaded) return;
    let base = source;
    if (onAccount && isOwner && !base && device.loaded && device.layout && !migrated.current) {
      migrated.current = true;
      base = device.layout;
      save(base);
    }
    const items = base ? sanitizeLayout(base, isKnownBlock) : defaultLayout(isOwner);
    /* Le SEUL écart entre ce que voit le propriétaire et ce que voit un
       visiteur. Les blocs `device` — reprendre la lecture, vu récemment — lisent
       la progression de l'appareil qui AFFICHE la page : servis à un visiteur,
       ils montreraient sa lecture à lui sous le nom d'un autre. Rien ne peut les
       remplacer par la donnée du profil, elle n'existe pas côté serveur. */
    setLayout(compact(items.filter((o) => visibleTo(isOwner, o.i))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, source, isOwner, onAccount, device.loaded, device.layout]);

  /* L'écriture est différée : `commit` est appelé à CHAQUE mouvement du
     pointeur, et une requête par pixel n'a pas de sens. Le dernier état gagne,
     ce qui est exactement la sémantique voulue. */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  function save(next: GridItem[] | null) {
    if (!isOwner) return;
    if (!onAccount) {
      setProfileLayout(next);
      return;
    }
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      fetch("/api/v2/account/profile-layout", {
        method: next ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: next ? JSON.stringify({ layout: next }) : undefined,
      }).catch(() => {
        /* La grille est déjà rangée à l'écran ; une écriture perdue se
           rattrape au geste suivant. */
      });
    }, 500);
  }

  function commit(next: GridItem[]) {
    setLayout(next);
    save(next);
  }

  const posed = useMemo(
    () => new Set((layout || []).map((o) => o.i)),
    [layout],
  );

  function renderBlock(id: string): BlockChrome | null {
    const def = blockDef(id);
    if (!def) return null;
    return {
      title: t(`profile.blocks.${id}.title`),
      meta: null,
      color: def.color,
      body: body(id),
    };
  }

  function body(id: string): React.ReactNode {
    switch (id) {
      case "resume":
        return <ResumeBlock />;
      case "recents":
        return <RecentsBlock />;
      case "favorites":
        return <FavoritesBlock entries={entries} />;
      case "statuses":
        return <StatusesBlock entries={entries} />;
      case "scores":
        return <ScoresBlock entries={entries} />;
      case "genres":
        return <GenresBlock entries={entries} />;
      case "formats":
        return <FormatsBlock entries={entries} />;
      case "studios":
        return <StudiosBlock entries={entries} />;
      case "season":
        return <SeasonBlock entries={entries} />;
      case "characters":
        return <CharactersBlock characters={characters} />;
      default:
        // Les blocs `soon` : la mise en page est là, et le bloc dit lui-même ce
        // qui lui manque plutôt que d'afficher un chiffre inventé.
        return <EmptyBlock note={t(`profile.blocks.${id}.soon`)} />;
    }
  }

  if (!layout) {
    // Tant que le stockage n'a pas répondu : la hauteur de la grille par défaut,
    // pour que la page ne saute pas au premier rendu client.
    return <div className="h-[30rem]" />;
  }

  return (
    <div>
      {isOwner ? (
        <div className="mb-5 flex flex-wrap items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => setLibrary(true)}
            className="inline-flex items-center gap-2 rounded-full bg-action px-4 py-2.5 font-karla text-xs font-bold text-white shadow-glow transition-transform hover:scale-105"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3.5 w-3.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("profile.widgets.add")}
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 font-karla text-xs font-bold text-white ring-1 transition-colors ${
              editing ? "bg-action ring-action" : "bg-white/5 ring-white/15 hover:ring-white/30"
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <polyline points="8 6 12 2 16 6" />
              <polyline points="16 18 12 22 8 18" />
              <line x1="12" y1="2" x2="12" y2="22" />
            </svg>
            {editing ? t("profile.widgets.done") : t("profile.widgets.rearrange")}
          </button>
        </div>
      ) : null}

      {editing ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-action/35 bg-action/[0.07] px-4 py-3">
          <p className="font-karla text-xs text-white/60">{t("profile.widgets.hint")}</p>
          <button
            type="button"
            onClick={() => {
              save(null);
              setLayout(defaultLayout(isOwner));
            }}
            className="rounded-full bg-white/5 px-3 py-1.5 font-karla text-[11px] font-bold text-white/60 ring-1 ring-white/10 transition-colors hover:text-white hover:ring-white/30"
          >
            {t("profile.widgets.reset")}
          </button>
        </div>
      ) : null}

      <WidgetGrid
        layout={layout}
        onLayout={commit}
        renderBlock={renderBlock}
        editing={editing && isOwner}
      />

      {isOwner ? (
        <BlockLibrary
          open={library}
          onClose={() => setLibrary(false)}
          blocks={BLOCKS.filter((b) => visibleTo(isOwner, b.id))}
          posed={posed}
          onToggle={(id) => {
            const cur = layout || [];
            if (posed.has(id)) {
              commit(compact(cur.filter((o) => o.i !== id)));
            } else {
              const [w, h] = blockSize(id);
              commit(addItem(cur, id, w, h));
            }
          }}
          onRearrange={() => {
            setLibrary(false);
            setEditing(true);
          }}
          onReset={() => {
            save(null);
            setLayout(defaultLayout(isOwner));
          }}
        />
      ) : null}
    </div>
  );
}
