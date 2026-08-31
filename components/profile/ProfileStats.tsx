import { useTranslation } from "react-i18next";

import {
  FormatsBlock,
  GenresBlock,
  ScoresBlock,
  StatusesBlock,
  StudiosBlock,
} from "./widgets/ListBlocks";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * L'onglet « Statistiques » : les mêmes widgets que l'aperçu, mais posés une
 * fois pour toutes et en grand.
 *
 * Volontairement les MÊMES composants — un chiffre ne doit pas pouvoir différer
 * d'un onglet à l'autre, et la question « pourquoi le radar est-il différent
 * ici ? » ne doit jamais pouvoir se poser.
 */

export default function ProfileStats({ entries }: { entries: ProfileEntry[] }) {
  const { t } = useTranslation();

  /* Les hauteurs suivent le contenu, pas une grille : mesuré le 31/08/2026 sur
     une liste de 824 titres, un panneau uniforme laissait la moitié du cadre
     vide sous les formats et sous les statuts. */
  const panels = [
    { key: "genres", h: "h-[22rem]", node: <GenresBlock entries={entries} />, wide: false },
    { key: "scores", h: "h-[14rem]", node: <ScoresBlock entries={entries} />, wide: false },
    { key: "formats", h: "h-[19rem]", node: <FormatsBlock entries={entries} />, wide: false },
    { key: "statuses", h: "h-[12rem]", node: <StatusesBlock entries={entries} />, wide: false },
    { key: "studios", h: "h-[15rem]", node: <StudiosBlock entries={entries} />, wide: true },
  ];

  return (
    <div className="grid gap-5 md:grid-cols-2">
      {panels.map((p) => (
        <section
          key={p.key}
          className={`as-stat-card rounded-[20px] px-5 py-5 ring-1 ring-white/10 ${
            p.wide ? "md:col-span-2" : ""
          }`}
        >
          <h2 className="mb-4 font-outfit text-[15px] font-bold text-white">
            {t(`profile.blocks.${p.key}.title`)}
          </h2>
          <div className={p.h}>{p.node}</div>
        </section>
      ))}
    </div>
  );
}
