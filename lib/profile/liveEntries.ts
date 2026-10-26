/**
 * SON PROPRE PROFIL MONTRE SES MODIFICATIONS TOUT DE SUITE (25/10/2026, Luc :
 * « bug » — l'éditeur disait ép. 3 / 3, « En cours de visionnage » ép. 2 ; puis
 * « la synchro ne se fait pas »).
 *
 * Le serveur sert la liste AniList depuis sa copie (jusqu'à 5 min sans
 * redemander, cf. cachedAniList, pages/en/profile/[user].tsx). Pour le
 * PROPRIÉTAIRE, deux sources du navigateur passent par-dessus, champ par champ
 * (avancement, statut, note, re-visionnages) :
 *
 *  1. la LISTE LOCALE de l'appareil (lib/list/localList), quand son entrée est
 *     plus récente que celle d'AniList (`updatedAt` des deux côtés). C'est elle
 *     qui porte ce qu'on fait en local et sur la dev, où rien ne part plus vers
 *     AniList (lib/anilist/writeGuard) — sans elle, le profil n'y verrait
 *     jamais un épisode regardé ni une correction faite dans l'éditeur ;
 *  2. sinon, la copie AniList du navigateur (lib/anilist/userListCache), que
 *     l'éditeur corrige à chaque enregistrement, tant qu'elle a moins de 5 min.
 *
 * Les autres visiteurs voient la liste du serveur.
 */
import { useEffect, useMemo, useState } from "react";
import {
  USER_LIST_EVENT,
  hasFreshUserList,
  peekListEntry,
} from "@/lib/anilist/userListCache";
import { LOCAL_LIST_EVENT, getLocalList } from "@/lib/list/localList";
import type { ProfileEntry } from "./types";

type Live = { progress: number; status: string | null; score: number | null; repeat: number };

export function useOwnLiveEntries(
  entries: ProfileEntry[],
  isOwner: boolean,
  anilistName: string | null | undefined,
): ProfileEntry[] {
  /* Lu APRÈS l'hydratation : le serveur n'a pas ces copies, et la page doit
     d'abord se rendre comme lui. */
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!isOwner) return;
    setVersion((v) => v + 1);
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(USER_LIST_EVENT, bump);
    window.addEventListener(LOCAL_LIST_EVENT, bump);
    return () => {
      window.removeEventListener(USER_LIST_EVENT, bump);
      window.removeEventListener(LOCAL_LIST_EVENT, bump);
    };
  }, [isOwner]);

  return useMemo(() => {
    if (!version || !isOwner) return entries;
    let local: ReturnType<typeof getLocalList> = {};
    try {
      local = getLocalList();
    } catch {
      /* stockage illisible : la copie AniList seule */
    }
    const cacheOk = !!anilistName && hasFreshUserList(anilistName);
    let changed = false;
    const out = entries.map((e) => {
      let live: Live | null = null;
      const l = local[e.mediaId];
      if (l && (l.updatedAt || 0) > (e.updatedAt || 0)) {
        live = { progress: l.progress || 0, status: l.status ?? null, score: l.score ?? null, repeat: l.repeat || 0 };
      } else if (cacheOk) {
        const c = peekListEntry(anilistName!, e.mediaId);
        if (c) live = { progress: c.progress, status: c.status, score: c.score ?? null, repeat: c.repeat || 0 };
      }
      if (
        !live ||
        (live.progress === e.progress &&
          (live.status ?? e.status) === e.status &&
          live.score === (e.score ?? null) &&
          live.repeat === (e.repeat || 0))
      ) {
        return e;
      }
      changed = true;
      return { ...e, progress: live.progress, status: live.status ?? e.status, score: live.score, repeat: live.repeat };
    });
    return changed ? out : entries;
  }, [entries, isOwner, anilistName, version]);
}
