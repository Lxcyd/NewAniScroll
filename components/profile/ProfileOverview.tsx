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
import { customListColor, listLabel, LIST_COLORS } from "@/components/anime/v2/helpers";
import { CUSTOM_PREFIX, customListNames } from "@/lib/profile/insights";
import type { ActivityRow } from "@/lib/profile/activity";
import {
  BLOCKS,
  DEFAULT_BLOCKS,
  blockBounds,
  blockDef,
  blockOption,
  blockOptionRange,
  blockOptionValue,
  blockOptions,
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
import type { ProfileCharacter, ProfileEntry, ProfileTitle } from "@/lib/profile/types";

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
 * Les deux vues montrent maintenant les MÊMES blocs, activité de lecture
 * comprise : celle-ci arrive par la prop `activity`, reconstruite au rendu
 * serveur depuis la sauvegarde du propriétaire. Ce qui change d'un côté à
 * l'autre n'est donc plus la liste des blocs mais la source de deux d'entre
 * eux, et la formulation des textes qui tutoyaient le lecteur.
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
  /** L'activité de lecture DU PROPRIÉTAIRE, reconstruite au rendu serveur
   *  depuis sa sauvegarde de compte. Sert aux blocs `resume` et `recents` quand
   *  le lecteur n'est pas chez lui : sans elle ils liraient le localStorage de
   *  CE navigateur et afficheraient sa lecture à lui sous le nom d'un autre.
   *  Le propriétaire, lui, garde sa source locale — elle est plus fraîche que
   *  la dernière synchronisation, et elle se met à jour pendant qu'il regarde. */
  activity?: ActivityRow[] | null;
  /** Les jours consécutifs de lecture DU PROPRIÉTAIRE, comptés au rendu serveur
   *  en même temps que `activity`. Chez lui, le bloc les recompte dans son
   *  navigateur : un jour de série est un jour de calendrier, donc il dépend du
   *  fuseau, et celui du serveur n'est pas le sien. */
  streak?: number | null;
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
  activity,
  streak,
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
    const items = base
      ? sanitizeLayout(base, isKnownBlock, blockBounds)
      : defaultLayout(isOwner);
    /* `visibleTo` ne retire plus rien à un visiteur : les blocs d'activité sont
       désormais nourris par la sauvegarde du propriétaire (prop `activity`) et
       non par le localStorage du lecteur. Le filtre reste comme point de
       branchement d'un futur réglage de visibilité — il n'y en a aucun
       aujourd'hui, on retire le bloc pour ne rien publier. */
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
    /* « Reprendre la lecture » est écrit pour celui qui lit. Sur le profil d'un
       autre, c'est lui qui regarde, pas nous. */
    const other = !isOwner && id === "resume";
    return {
      title: blockTitle(id, other),
      meta: null,
      /* La vitrine pose ses flèches dans le coin de l'en-tête, « Vu récemment »
         sa flamme, « Notes attribuées » sa moyenne : il faut leur garder la
         place (cf. `endRoom` dans WidgetGrid.tsx). Pour la flamme, seulement
         quand elle est allumée — sinon le titre perdrait 56 px pour rien. La
         moyenne, elle, n'est pas réglable : elle est là dès qu'une note existe,
         et la réservation ne coûte que sur un profil qui n'a rien noté. */
      endRoom:
        id === "favorites" ||
        id === "scores" ||
        (id === "recents" && optionOn("recents", "streak")),
      body: body(id),
    };
  }

  /* Les réglages du bloc `id` : ce que le propriétaire a rangé dans la
     disposition, sinon les défauts du catalogue. */
  function saved(id: string) {
    return layout?.find((o) => o.i === id)?.s;
  }
  function optionOn(id: string, key: string): boolean {
    return blockOption(id, key, saved(id));
  }
  function optionValue(id: string, key: string): string {
    return blockOptionValue(id, key, saved(id), customValues);
  }

  /* Les listes personnalisées de CE profil, telles que sa liste les porte. Elles
     ne sont dans aucun catalogue — chacun invente les siennes — donc elles se
     lisent dans les entrées, et le préfixe les empêche de se confondre avec une
     liste de statut qui porterait le même nom. */
  /**
   * LES VARIANTES DE TITRE, par `mediaId`, pour les deux widgets d'activité.
   *
   * L'historique du lecteur ne garde qu'une chaîne — le titre tel qu'il
   * s'affichait pendant la lecture — donc ces deux blocs étaient les seuls du
   * site à ignorer le réglage « romaji / anglais ». La liste du profil, elle,
   * porte les variantes : il suffisait de les leur passer, sans rien demander au
   * réseau et sans dépendre d'AniList au moment du rendu.
   */
  const titlesById = useMemo(() => {
    const map = new Map<number, ProfileTitle | null>();
    for (const e of entries) map.set(e.mediaId, e.title);
    return map;
  }, [entries]);

  const customLists = useMemo(() => customListNames(entries), [entries]);
  const customValues = useMemo(
    () => customLists.map((n) => `${CUSTOM_PREFIX}${n}`),
    [customLists],
  );

  /** Un réglage changé, écrit dans la disposition et sauvegardé. */
  function setOption(id: string, key: string, value: boolean | string) {
    commit(
      (layout || []).map((o) =>
        o.i === id ? { ...o, s: { ...(o.s ?? {}), [key]: value } } : o,
      ),
    );
  }

  /**
   * Les réglages d'un bloc, traduits et résolus, pour le panneau de la grille.
   *
   * Le catalogue n'est traversé qu'ICI : ni la grille ni son panneau ne savent
   * ce qu'une clé signifie. Les choix d'un menu déroulant portent déjà leur
   * libellé — pour `source`, ce sont les noms de listes du reste du site
   * (`listLabel`), donc « Terminés » veut dire ici ce qu'il veut dire ailleurs.
   */
  function widgetOptions(id: string) {
    const def = blockDef(id);
    return blockOptions(id).map((o) => {
      const common = {
        key: o.key,
        label: t(`profile.widgets.options.${o.key}`),
        desc: t(`profile.widgets.options.${o.key}Desc`),
      };
      if ("range" in o) {
        const [from, to] = blockOptionRange(id, o.key, saved(id));
        return { ...common, min: o.range[0], max: o.range[1], step: o.step, from, to };
      }
      return "choices" in o
        ? {
            ...common,
            value: optionValue(id, o.key),
            /* Les listes de statut d'abord, dans l'ordre du site, puis les
               listes personnalisées À LA SUITE — c'est l'ordre de l'éditeur de
               liste, où les listes inventées viennent aussi après. Chacune
               porte SA couleur : celle du site pour les six listes de statut,
               celle déduite de son nom pour les autres (`customListColor`),
               exactement les pastilles de l'éditeur. */
            choices: [
              ...o.choices.map((c) => ({
                value: c,
                label:
                  c === "favourites"
                    ? t("profile.widgets.options.sourceFavourites")
                    : listLabel(t, c),
                color: c === "favourites" ? def?.color : LIST_COLORS[c],
                heart: c === "favourites",
              })),
              ...customLists.map((n) => ({
                value: `${CUSTOM_PREFIX}${n}`,
                label: n,
                color: customListColor(n),
              })),
            ],
          }
        : { ...common, on: optionOn(id, o.key) };
    });
  }

  /**
   * Le nom d'un bloc, tel que son en-tête l'affiche.
   *
   * Il n'est plus toujours celui du catalogue : la vitrine des favoris peut
   * montrer une AUTRE liste que les favoris, et garder alors le titre
   * « Animés favoris » serait un mensonge sur son contenu. Le titre suit donc le
   * réglage — « Animes favoris Terminé » — en reprenant le NOM DE LISTE du
   * reste du site plutôt qu'un mot à lui.
   *
   * Le nom est POSÉ à la suite, sans l'annoncer. Il l'a d'abord été derrière un
   * « · Liste : », qui disait à quoi servait ce mot mais coûtait trois mots sur
   * cinq à un titre déjà coupé sur un bloc de deux colonnes. Une liste
   * personnalisée suit la même forme, sous son propre nom — le français s'en
   * accommode parce que le libellé y est un nom (« Terminés », « Prévus »), là
   * où l'anglais garde son point médian (« Favourite anime · Planning ») faute
   * de quoi le libellé se lirait comme un adjectif.
   *
   * LE LIBELLÉ EST AU PLURIEL, et il vient donc d'une table à lui
   * (`favorites.listPlural`) plutôt que de `listLabel`. Ailleurs sur le site le
   * nom d'une liste titre UNE liste — « Terminé » — alors qu'ici il qualifie
   * plusieurs animes. Traduire les deux avec la même clé aurait forcé à choisir
   * un nombre pour tous les emplois. Une liste personnalisée garde son nom tel
   * que son auteur l'a écrit : lui accorder quoi que ce soit serait deviner.
   */
  /**
   * Le titre d'un bloc — un nœud, parce que celui de la vitrine a DEUX FORMES.
   *
   * « Animes favoris · En cours » tient sur une carte large ; sur un téléphone,
   * où la carte fait toute la largeur de l'écran soit à peine plus de 300 px, il
   * touchait les flèches du carrousel. La carte étroite garde donc UNE SEULE
   * moitié, et laquelle dépend de ce que la vitrine montre :
   *
   *   — les cœurs (`favourites`) gardent « Animes favoris », leur nom propre ;
   *   — toute autre liste garde SON nom — « En cours », « Terminés », ou celui
   *     que le propriétaire a donné à sa liste personnalisée.
   *
   * Autrement dit, l'en-tête nomme toujours ce qu'on regarde, en un seul mot
   * quand il n'y a la place que pour un. Un nom trop long s'arrête sur trois
   * points : c'est le `truncate` de l'en-tête (WidgetGrid.tsx), et la place des
   * flèches lui est déjà réservée par `endRoom`.
   *
   * Les deux formes sont rendues et c'est le CSS qui choisit, sur une REQUÊTE DE
   * CONTENEUR (`.as-head-full` / `.as-head-short`, globals.css) : ce qui décide
   * est la largeur de la CARTE, pas celle de l'écran — la même carte est étroite
   * en 1×1 et large en 2×4 dans la même fenêtre.
   */
  function blockTitle(id: string, other: boolean): React.ReactNode {
    if (id === "favorites") {
      const src = optionValue("favorites", "source");
      if (src && src !== "favourites") {
        const custom = src.startsWith(CUSTOM_PREFIX);
        const list = custom
          ? src.slice(CUSTOM_PREFIX.length)
          : t(`profile.blocks.favorites.listPlural.${src}`, listLabel(t, src));
        return (
          <>
            <span className="as-head-full">
              {t("profile.blocks.favorites.titleList", { list })}
            </span>
            {/* La forme courte n'a besoin d'AUCUNE traduction de plus : c'est le
                nom de la liste, déjà traduit juste au-dessus. Les cœurs, eux, ne
                passent jamais ici — sans liste choisie, le titre du bloc est
                rendu tel quel, plus bas, et il est déjà court. */}
            <span className="as-head-short">{list}</span>
          </>
        );
      }
    }
    /* Le bloc ne compte plus des statuts : son nom doit le dire. Sans ça,
       « Répartition par statut » chapeautait une liste de noms inventés. */
    if (id === "statuses" && optionOn("statuses", "customLists")) {
      return t("profile.blocks.statuses.titleCustom");
    }
    return t(other ? "profile.blocks.resume.titleOther" : `profile.blocks.${id}.title`);
  }

  function body(id: string): React.ReactNode {
    const served = isOwner ? undefined : (activity ?? undefined);
    switch (id) {
      /* `served` reste indéfini chez soi, et c'est délibéré : les deux blocs
         retombent alors sur le localStorage de cet appareil, qui est plus frais
         que la dernière synchronisation et qui se met à jour PENDANT qu'on
         regarde (PROGRESS_EVENT). Servir sa propre sauvegarde au propriétaire
         lui montrerait un épisode en retard sur ce qu'il vient de lancer. */
      case "resume":
        return (
          <ResumeBlock
            rows={served}
            other={!isOwner}
            titles={titlesById}
            ambient={optionOn("resume", "ambient")}
          />
        );
      case "recents":
        return (
          <RecentsBlock
            rows={served}
            other={!isOwner}
            titles={titlesById}
            streak={streak ?? 0}
            streakOn={optionOn("recents", "streak")}
            editing={editing}
          />
        );
      case "favorites":
        return (
          <FavoritesBlock
            entries={entries}
            source={optionValue("favorites", "source")}
            scores={blockOptionRange("favorites", "scores", saved("favorites"))}
            unrated={optionOn("favorites", "unrated")}
            trailer={optionOn("favorites", "trailer")}
            editing={editing && isOwner}
          />
        );
      case "statuses":
        return (
          <StatusesBlock entries={entries} custom={optionOn("statuses", "customLists")} />
        );
      case "scores":
        return (
          <ScoresBlock
            entries={entries}
            completedOnly={optionOn("scores", "completedOnly")}
            editing={editing}
          />
        );
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
        limits={blockBounds}
        options={widgetOptions}
        onOption={setOption}
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
