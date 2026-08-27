import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { getUserList, peekListEntry, hasUserList } from "@/lib/anilist/userListCache";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";

export type ListStatus = {
  /** AniList status code ("CURRENT", "PLANNING", …) or null when off-list. */
  status: string | null;
  progress: number;
  /** false tant qu'on ne SAIT pas : le bouton doit alors afficher un neutre
   *  plutot que « Ajouter a la liste », qui serait un mensonge le temps que
   *  la liste revienne. */
  resolved: boolean;
  /** A appeler avec le resultat de l'editeur pour recaler l'affichage sans
   *  rechargement. */
  apply: (next: { status: string | null; progress: number; removed?: boolean }) => void;
};

/**
 * Statut de liste de l'utilisateur pour UN anime, resolu comme la page d'info
 * le fait : jamais une requete AniList par anime ouvert, mais une lecture dans
 * la liste complete mise en cache une fois par session
 * (lib/anilist/userListCache), et la liste locale
 * (lib/list/localList) pour les invites et ceux qui ont coupe la synchro.
 *
 * La page d'info garde sa propre copie de cette logique : elle y melange le
 * seed SSR et le drapeau « favori », qui ne servent qu'a elle. Ce hook est la
 * part commune, celle dont la page de lecture a besoin pour afficher le meme
 * bouton.
 */
export function useListStatus(aniId: number | string | undefined): ListStatus {
  const { data: session, status: sessionStatus }: any = useSession();
  const syncEnabled = useSyncPrefs().enabled;

  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [resolved, setResolved] = useState(false);

  const id = Number(aniId);

  // ── Compte AniList, synchro active ───────────────────────────
  useEffect(() => {
    const token = session?.user?.token;
    const userName = session?.user?.name;
    if (!syncEnabled) return;
    if (!token || !userName || !Number.isFinite(id)) return;
    let cancelled = false;

    // Amorcage synchrone sur ce qui est deja en cache → statut instantane.
    const cached = peekListEntry(userName, id);
    if (cached) {
      setStatus(cached.status ?? null);
      setProgress(cached.progress || 0);
      setResolved(true);
    } else if (hasUserList(userName)) {
      // Liste en cache et cet anime n'y est pas → absence CONFIRMEE.
      setStatus(null);
      setProgress(0);
      setResolved(true);
    }

    (async () => {
      const map = await getUserList(userName, token);
      if (cancelled) return;
      const e = map.get(id);
      setStatus(e?.status ?? null);
      setProgress(e?.progress || 0);
      setResolved(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.token, session?.user?.name, id, syncEnabled]);

  // ── Liste locale (invites, et connectes synchro coupee) ──────
  // On ne traite l'absence de session comme « invite » qu'une fois next-auth
  // FIXE dessus : pendant la phase « loading » un utilisateur connecte n'a pas
  // encore de session, et agir la ferait clignoter « Ajouter a la liste » par
  // dessus son vrai statut.
  useEffect(() => {
    const useLocal = !syncEnabled || sessionStatus === "unauthenticated";
    if (!useLocal || !Number.isFinite(id)) return;
    const read = () => {
      const e = peekLocalEntry(id);
      setStatus(e?.status ?? null);
      setProgress(e?.progress || 0);
      setResolved(true);
    };
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    return () => window.removeEventListener(LOCAL_LIST_EVENT, read);
  }, [sessionStatus, syncEnabled, id]);

  return {
    status,
    progress,
    resolved,
    apply: (next) => {
      setStatus(next.removed ? null : next.status);
      setProgress(next.progress);
      setResolved(true);
    },
  };
}
