import type { TFunction } from "i18next";
import type { RecReason } from "@/lib/recommend/types";

/**
 * Turn the engine's structured reasons into a localized prose sentence.
 * Keeps the UI dumb: the engine decides *why*, this formats it per language.
 */
export function reasonsToProse(reasons: RecReason[], t: TFunction): string[] {
  const out: string[] = [];
  for (const r of reasons) {
    switch (r.kind) {
      case "lovedSimilar":
        out.push(t("recommend.reason.lovedSimilar", { titles: r.titles.join(" · ") }));
        break;
      case "sequel":
        out.push(t("recommend.reason.sequel", { title: r.ofTitle }));
        break;
      case "studio":
        out.push(t("recommend.reason.studio", { studio: r.studio }));
        break;
      case "genres":
        out.push(t("recommend.reason.genres", { genres: r.genres.join(", ") }));
        break;
      case "tags":
        out.push(t("recommend.reason.tags", { tags: r.tags.join(", ") }));
        break;
      case "community":
        out.push(t("recommend.reason.community"));
        break;
      case "highlyRated":
        out.push(t("recommend.reason.highlyRated", { score: r.score }));
        break;
      case "binge":
        out.push(t("recommend.reason.binge"));
        break;
    }
  }
  return out;
}
