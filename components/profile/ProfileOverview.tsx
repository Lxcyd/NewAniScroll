import { useEffect, useMemo, useState } from "react";
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
 * lib/profile/grid.ts, le stockage dans lib/prefs/profileLayout.ts (donc
 * localStorage ET, dès qu'un compte existe, la catégorie `prefs` de
 * cloudSync), et chaque widget dans son propre fichier.
 *
 * Un visiteur qui n'est pas le propriétaire voit la disposition PAR DÉFAUT :
 * la disposition stockée est celle de son appareil à lui, elle ne dit rien du
 * profil qu'il regarde.
 */

type Props = {
  entries: ProfileEntry[];
  characters: ProfileCharacter[];
  isOwner: boolean;
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

export default function ProfileOverview({ entries, characters, isOwner }: Props) {
  const { t } = useTranslation();
  const stored = useProfileLayout();
  const [editing, setEditing] = useState(false);
  const [library, setLibrary] = useState(false);
  /* La disposition vit ici pendant la session : le stockage n'est écrit qu'aux
     changements, et le relire à chaque déplacement ferait un aller-retour
     localStorage par pixel. */
  const [layout, setLayout] = useState<GridItem[] | null>(null);

  useEffect(() => {
    if (!stored.loaded) return;
    const base =
      isOwner && stored.layout
        ? sanitizeLayout(stored.layout, isKnownBlock)
        : defaultLayout(isOwner);
    /* Un bloc `device` posé par le propriétaire n'a rien à faire chez un
       visiteur — il montrerait la lecture du visiteur sous le nom d'un autre. */
    setLayout(compact(base.filter((o) => visibleTo(isOwner, o.i))));
  }, [stored.loaded, stored.layout, isOwner]);

  function commit(next: GridItem[]) {
    setLayout(next);
    if (isOwner) setProfileLayout(next);
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
              setProfileLayout(null);
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
            setProfileLayout(null);
            setLayout(defaultLayout(isOwner));
          }}
        />
      ) : null}
    </div>
  );
}
