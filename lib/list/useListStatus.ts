import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { getUserList, peekListEntry, hasUserList } from "@/lib/anilist/userListCache";
import { peekLocalEntry, LOCAL_LIST_EVENT } from "@/lib/list/localList";

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

  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [resolved, setResolved] = useState(false);

  const id = Number(aniId);

  /* ── `enabled` NE GOUVERNE PAS LA LECTURE ──────────────────────────────────
   *
   * Cet effet était gardé par `if (!syncEnabled) return;` et c'était un bug de
   * sens. Le réglage dit, dans sa propre documentation (lib/prefs/syncPrefs.ts),
   * qu'il « gate whether anything is PUSHED to AniList » — il parle d'écriture.
   * Le code s'en servait AUSSI pour ne plus lire, et comme il est éteint par
   * défaut, un compte AniList lié tombait dans un site à deux mémoires : le
   * profil montrait la liste AniList (lue au rendu serveur), pendant que la
   * page d'anime, les cartes et les badges lisaient une liste locale vide.
   *
   * Symptôme exact, et il a fallu le voir pour le croire : « 381 animés, 5 261
   * épisodes » en tête du profil, et la fiche d'Overlord qui propose l'épisode 1
   * d'une série terminée depuis des mois.
   *
   * On lit donc AniList dès qu'un compte est lié. Ce qui reste derrière
   * `enabled` : tout ce qui ÉCRIT chez AniList, et le miroir AniList → local de
   * `fullSyncFromAniList` — qui, lui, supprime les entrées purement locales et
   * n'a rien à faire sans l'accord explicite de l'utilisateur.
   */
  useEffect(() => {
    const token = session?.user?.token;
    const userName = session?.user?.name;
    if (!token || !userName || !Number.isFinite(id)) return;
    let cancelled = false;

    /* LE LOCAL PRIME, ET IL FAUT LE REDIRE ICI. La lecture AniList est
       asynchrone : sans ce garde-fou, elle arriverait APRÈS l'effet local et
       écraserait une entrée que l'utilisateur vient d'éditer sur ce poste. */
    const applique = (e: { status: string | null; progress: number } | undefined) => {
      if (peekLocalEntry(id)) return;
      setStatus(e?.status ?? null);
      setProgress(e?.progress || 0);
      setResolved(true);
    };

    // Amorcage synchrone sur ce qui est deja en cache → statut instantane.
    const cached = peekListEntry(userName, id);
    if (cached) applique(cached);
    // Liste en cache et cet anime n'y est pas → absence CONFIRMEE.
    else if (hasUserList(userName)) applique(undefined);

    (async () => {
      const map = await getUserList(userName, token);
      if (cancelled) return;
      applique(map.get(id));
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.token, session?.user?.name, id]);

  /* ── Liste locale ──────────────────────────────────────────────────────────
   *
   * Seule source pour un invité, et elle PRIME sur AniList pour un compte lié :
   * l'éditeur de liste écrit localement dans les deux cas (que la synchro soit
   * allumée ou non), donc une entrée locale est forcément plus récente que ce
   * qu'AniList renvoie. Sans cette priorité, éditer sa liste synchro coupée
   * verrait sa modification écrasée à la lecture suivante.
   *
   * L'ABSENCE d'entrée locale ne dit plus rien, en revanche, et c'est ce qui
   * change : elle ne signifie plus « pas dans la liste » mais « rien à dire
   * ici ». On ne touche donc à l'état que si l'entrée existe — sauf pour un
   * invité, chez qui l'absence reste une réponse.
   *
   * On ne traite l'absence de session comme « invité » qu'une fois next-auth
   * FIXÉ dessus : pendant la phase « loading », un utilisateur connecté n'a pas
   * encore de session, et agir là ferait clignoter « Ajouter à la liste »
   * par-dessus son vrai statut.
   */
  useEffect(() => {
    if (!Number.isFinite(id)) return;
    const invite = sessionStatus === "unauthenticated";
    const read = () => {
      const e = peekLocalEntry(id);
      if (!e && !invite) return;
      setStatus(e?.status ?? null);
      setProgress(e?.progress || 0);
      setResolved(true);
    };
    read();
    window.addEventListener(LOCAL_LIST_EVENT, read);
    return () => window.removeEventListener(LOCAL_LIST_EVENT, read);
  }, [sessionStatus, id]);

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
