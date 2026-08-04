import { useEffect, useState, useCallback, useRef } from "react";
import { notify } from "@/lib/notifications/noticeStore";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { useTranslation } from "react-i18next";
import { peekListEntry, patchListEntry, UserListEntry } from "@/lib/anilist/userListCache";
import {
  peekLocalEntry,
  upsertLocalEntry,
  removeLocalEntry,
} from "@/lib/list/localList";
/* This file used to import inputToFuzzy under an alias AND define its own
   identical copy under the real name, so two call sites used one and two used
   the other. One import, one implementation. */
import {
  fuzzyToInput,
  inputToFuzzy,
  type FuzzyDate,
} from "@/lib/list/types";
import { useSyncPrefs } from "@/lib/prefs/syncPrefs";

/**
 * Full list editor — layout/design adapted from the AniScroll reference editor
 * (status dropdown, score with ± + colour bar, episode progress with bar,
 * start/finish dates, rewatches, options, notes), with the modal background +
 * accent retuned to our site theme (see styles/listEditor.css).
 *
 * Renders its OWN full-screen overlay (the design is a bottom-sheet/centered
 * modal), so the caller no longer wraps it in <Modal>. It writes everything in
 * one AniList SaveMediaListEntry mutation on Save and prefills from the user's
 * existing entry fetched on open.
 */

interface ListEditorProps {
  animeId: number;
  session: any;
  /** Current AniList status label (e.g. "CURRENT"); seeds the dropdown. */
  stats?: string;
  /** Current progress; seeds the episode field. */
  prg?: number;
  /** Total episodes (caps the progress field). */
  max?: number;
  info?: AniListInfoTypes;
  close: () => void;
  /** Called after a successful save/remove with the new state so the parent can
   *  update the page in place (no full reload). When omitted the editor just
   *  closes. */
  onSaved?: (next: {
    status: string | null;
    progress: number;
    score: number;
    removed: boolean;
  }) => void;
  /** Called whenever the favourite heart is toggled, so the info-page heart
   *  stays in sync (the heart is independent of the Save flow). */
  onFavouriteChange?: (fav: boolean) => void;
}

type Status = "CURRENT" | "PLANNING" | "COMPLETED" | "DROPPED" | "PAUSED" | "REPEATING";

const STATUS_ORDER: Status[] = [
  "CURRENT",
  "REPEATING",
  "COMPLETED",
  "PLANNING",
  "PAUSED",
  "DROPPED",
];

// Map each status to the CSS class suffix used by listEditor.css dots/triggers.
const STATUS_KEY: Record<Status, string> = {
  CURRENT: "current",
  REPEATING: "repeating",
  COMPLETED: "completed",
  PLANNING: "planning",
  PAUSED: "paused",
  DROPPED: "dropped",
};

// AniList stores dates as { year, month, day }. Helpers to/from <input type=date>.

// Score (0-10, step 0.5) → bar colour class. Matches the reference tiers.
function scoreColorClass(score: number): string {
  if (score <= 0) return "";
  if (score < 4) return "red";
  if (score < 6) return "orange";
  if (score < 7) return "yellow";
  if (score < 8) return "lime";
  return "green";
}
function scoreHexColor(score: number): string {
  const c = scoreColorClass(score);
  return (
    { red: "#ef4444", orange: "#f97316", yellow: "#eab308", lime: "#84cc16", green: "#22c55e" }[
      c
    ] || "rgba(255,255,255,0.2)"
  );
}

// Deterministic, vivid colour for a custom-list chip derived from its name —
// same list always gets the same colour, but each list a different one. We hash
// the name to a hue and use a fixed pleasant saturation/lightness so every
// colour reads well on the dark modal (no muddy/near-black hues).
function customListColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 58%)`;
}

const ListEditor: React.FC<ListEditorProps> = ({
  animeId,
  session,
  stats = "CURRENT",
  prg = 0,
  max,
  info = undefined,
  close,
  onSaved,
  onFavouriteChange,
}) => {
  const { t } = useTranslation();
  const isAnime = info?.type !== "MANGA";
  // Episode total: prefer the AniList `episodes` count, fall back to `max`, then
  // to the next-airing episode minus one (releasing shows have episodes:null on
  // AniList until they finish — that's why One Piece showed no "/total"). 0 when
  // genuinely unknown (the progress bar then just tracks raw progress).
  const totalEp =
    info?.episodes ??
    max ??
    (info?.nextAiringEpisode?.episode
      ? info.nextAiringEpisode.episode - 1
      : 0) ??
    0;

  // Names of the user's AniList custom lists (synced into the session at login).
  const availableCustomLists: string[] = Array.isArray(session?.user?.list)
    ? session.user.list
    : [];

  // null = "not in list". We do NOT seed from the caller's `stats` prop: that
  // value comes from the info page's own (sometimes stale / not-yet-resolved)
  // status and caused the editor to show e.g. "Watching" for an anime that's
  // actually not in the list. The prefill effect below is the single source of
  // truth — it sets the real status (or null) straight from the user's AniList
  // entry. Until it resolves we show null ("Not in list") as the safe default.
  const [status, setStatus] = useState<Status | null>(null);
  const [score, setScore] = useState<number>(0);
  const [progress, setProgress] = useState<number>(prg ?? 0);
  const [startDate, setStartDate] = useState<string>("");
  const [finishDate, setFinishDate] = useState<string>("");
  const [rewatches, setRewatches] = useState<number>(0);
  const [hideFromLists, setHideFromLists] = useState<boolean>(false);
  const [isPrivate, setIsPrivate] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>("");
  const [favorited, setFavorited] = useState<boolean>(false);
  // Names of the custom lists this entry is currently on (toggled by chips).
  const [customLists, setCustomLists] = useState<string[]>([]);

  const [statusOpen, setStatusOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // The AniList mediaListEntry id — needed to DeleteMediaListEntry when the
  // user sets status to "Not in list" or clicks "Remove from list". null = the
  // anime isn't on the user's list yet.
  const [entryId, setEntryId] = useState<number | null>(null);

  const ddRef = useRef<HTMLDivElement>(null);

  // ── Prefill from the user's existing AniList entry ───────────────
  // We seed SYNCHRONOUSLY from the whole-list cache (lib/anilist/userListCache)
  // so every field — including the score / episode progress bars — is already
  // correct on the first paint instead of animating up from 0 when the modal
  // opens. We then refresh from a full per-entry query (the cache omits a couple
  // of fields the editor uses) to pick up anything stale.
  const seedFromEntry = useCallback((e: Partial<UserListEntry> | null | undefined) => {
    if (e && (e.status || e.id)) {
      setEntryId(typeof e.id === "number" ? e.id : null);
      setStatus((e.status as Status) ?? null);
      setScore(typeof e.score === "number" ? e.score! : 0);
      setProgress(typeof e.progress === "number" ? e.progress! : 0);
      setRewatches(typeof e.repeat === "number" ? e.repeat! : 0);
      setHideFromLists(!!e.hiddenFromStatusLists);
      setIsPrivate(!!e.private);
      setNotes(e.notes || "");
      setStartDate(fuzzyToInput(e.startedAt));
      setFinishDate(fuzzyToInput(e.completedAt));
      setCustomLists(Array.isArray(e.customLists) ? e.customLists : []);
    } else {
      // Genuinely NOT in the list — force the authoritative "not in list" state.
      setEntryId(null);
      setStatus(null);
    }
  }, []);

  // Operate on the LOCAL list (lib/list/localList.ts) instead of AniList when
  // EITHER the user has no AniList session OR they've turned the AniList sync
  // master toggle off. "Sync off" means "don't touch my AniList account" — so
  // even an explicit manual edit here stays local until they re-enable sync.
  const syncEnabled = useSyncPrefs().enabled;
  const isLocal = !session?.user?.token || !syncEnabled;

  useEffect(() => {
    if (!animeId) return;
    let cancelled = false;

    // ── Local mode: seed straight from the local list, no network. ──
    if (isLocal) {
      const e = peekLocalEntry(animeId);
      if (e) {
        setEntryId(null);
        setStatus((e.status as Status) ?? null);
        setScore(typeof e.score === "number" ? e.score : 0);
        setProgress(typeof e.progress === "number" ? e.progress : 0);
        setRewatches(typeof e.repeat === "number" ? e.repeat : 0);
        setNotes(e.notes || "");
        setStartDate(fuzzyToInput(e.startedAt));
        setFinishDate(fuzzyToInput(e.completedAt));
      } else {
        setEntryId(null);
        setStatus(null);
      }
      return;
    }

    const token = session?.user?.token;
    const userName = session?.user?.name;
    if (!token) return;

    // 1. Instant seed from the cached whole-list entry (no network).
    if (userName) seedFromEntry(peekListEntry(userName, animeId));

    // 2. Authoritative refresh — full per-entry query (customLists included).
    (async () => {
      try {
        const res = await fetch("https://graphql.anilist.co/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            query: `query ($id: Int) {
              Media(id: $id) {
                isFavourite
                mediaListEntry {
                  id status score(format: POINT_10_DECIMAL) progress repeat
                  private hiddenFromStatusLists notes customLists
                  startedAt { year month day }
                  completedAt { year month day }
                }
              }
            }`,
            variables: { id: animeId },
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        const media = json?.data?.Media;
        const e = media?.mediaListEntry;
        setFavorited(media?.isFavourite === true);
        // customLists arrives as { name: bool } — flatten to enabled names.
        const cl =
          e?.customLists && typeof e.customLists === "object"
            ? Object.entries(e.customLists)
                .filter(([, v]) => v === true)
                .map(([k]) => k)
            : [];
        seedFromEntry(e ? { ...e, customLists: cl } : null);
      } catch {
        /* best-effort — the cache seed (or "not in list") already applied */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [animeId, isLocal, session?.user?.token, session?.user?.name, seedFromEntry]);

  // Close the status dropdown on outside click.
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(ev.target as Node)) {
        setStatusOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [statusOpen]);

  // Lock body scroll while the editor is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const clampScore = (n: number) => Math.max(0, Math.min(10, Math.round(n * 2) / 2));
  const changeScore = (delta: number) => setScore((s) => clampScore(s + delta));
  const changeProgress = (delta: number) =>
    setProgress((p) => {
      const next = Math.max(0, p + delta);
      return totalEp > 0 ? Math.min(totalEp, next) : next;
    });

  // Click/drag the score bar to set a value (0-10).
  const scoreBarRef = useRef<HTMLDivElement>(null);
  const setScoreFromPointer = useCallback((clientX: number) => {
    const el = scoreBarRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setScore(clampScore(ratio * 10));
  }, []);

  // Click/drag the episode bar to set progress.
  const epBarRef = useRef<HTMLDivElement>(null);
  const setEpFromPointer = useCallback(
    (clientX: number) => {
      const el = epBarRef.current;
      if (!el || totalEp <= 0) return;
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      setProgress(Math.round(ratio * totalEp));
    },
    [totalEp]
  );

  const handleToggleFavourite = async () => {
    const token = session?.user?.token;
    if (!token) return;
    const next = !favorited;
    setFavorited(next); // optimistic
    onFavouriteChange?.(next); // keep the info-page heart in sync immediately
    try {
      await fetch("https://graphql.anilist.co/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation ($animeId: Int, $mangaId: Int) {
            ToggleFavourite(animeId: $animeId, mangaId: $mangaId) { anime { nodes { id } } }
          }`,
          variables: isAnime ? { animeId } : { mangaId: animeId },
        }),
      });
    } catch {
      setFavorited(!next); // revert on failure
      onFavouriteChange?.(!next);
    }
  };

  // Delete the user's entry for this media (used by "Remove from list" and by
  // saving with status = "Not in list"). No-op when the anime isn't on the
  // list. Returns true on success.
  const deleteEntry = async (): Promise<boolean> => {
    const token = session?.user?.token;
    if (!token || !entryId) return true; // nothing to delete
    try {
      const res = await fetch("https://graphql.anilist.co/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query: `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
          variables: { id: entryId },
        }),
      });
      const json = await res.json();
      return !!json?.data?.DeleteMediaListEntry?.deleted;
    } catch {
      return false;
    }
  };

  const handleRemove = async () => {
    // Local mode: just drop the local entry and update the page.
    if (isLocal) {
      removeLocalEntry(animeId);
      onSaved?.({ status: null, progress: 0, score: 0, removed: true });
      notify.success(t("listEditor.removed"));
      close();
      return;
    }
    const token = session?.user?.token;
    if (!token) return;
    // Optimistic: drop from the cache, update the page, and close immediately;
    // the delete mutation runs in the background.
    if (session?.user?.name) patchListEntry(session.user.name, animeId, null);
    removeLocalEntry(animeId); // keep the local mirror in sync with the delete
    onSaved?.({ status: null, progress: 0, score: 0, removed: true });
    notify.success(t("listEditor.removed"));
    close();
    deleteEntry().then((ok) => {
      if (!ok) notify.error(t("listEditor.error"));
    });
  };

  const handleSave = async () => {
    // ── Local mode: write to the local list, no AniList call. ──
    if (isLocal) {
      if (status === null) {
        removeLocalEntry(animeId);
        onSaved?.({ status: null, progress: 0, score: 0, removed: true });
        notify.success(t("listEditor.saved"));
        close();
        return;
      }
      upsertLocalEntry(animeId, {
        status,
        score: score || null,
        progress,
        total: totalEp > 0 ? totalEp : null,
        title: info?.title,
        coverImage:
          info?.coverImage?.large || info?.coverImage?.extraLarge || null,
        notes: notes || null,
        repeat: rewatches,
        startedAt: startDate ? inputToFuzzy(startDate) : null,
        completedAt: finishDate ? inputToFuzzy(finishDate) : null,
      });
      onSaved?.({ status, progress, score, removed: false });
      notify.success(t("listEditor.saved"));
      close();
      return;
    }

    const token = session?.user?.token;
    if (!token) return;
    setSaving(true);

    // Status set to "Not in list" → delete the entry (optimistic, like remove).
    if (status === null) {
      if (session?.user?.name) patchListEntry(session.user.name, animeId, null);
      removeLocalEntry(animeId); // mirror the delete locally
      onSaved?.({ status: null, progress: 0, score: 0, removed: true });
      notify.success(entryId ? t("listEditor.removed") : t("listEditor.saved"));
      close();
      deleteEntry().then((ok) => {
        if (!ok) notify.error(t("listEditor.error"));
      });
      return;
    }

    // OPTIMISTIC SAVE — the AniList mutation can take a second or two, and
    // making the user stare at the modal that whole time is what felt "très
    // longue". Instead we apply the change immediately (cache patch + notify
    // the page) and close, then fire the mutation in the background. On the
    // rare failure we surface a toast; the next whole-list refresh reconciles.
    const startedAt = inputToFuzzy(startDate);
    const completedAt = inputToFuzzy(finishDate);
    const userName = session?.user?.name;

    if (userName) {
      patchListEntry(userName, animeId, {
        id: entryId ?? 0,
        mediaId: animeId,
        status,
        score: score || null,
        progress,
        repeat: rewatches,
        private: isPrivate,
        hiddenFromStatusLists: hideFromLists,
        notes: notes || null,
        startedAt: startDate ? inputToFuzzy(startDate) : null,
        completedAt: finishDate ? inputToFuzzy(finishDate) : null,
        customLists,
      });
    }
    onSaved?.({ status, progress, score, removed: false });
    notify.success(t("listEditor.saved"));
    close();

    // Background mutation — fire-and-forget. We still patch the cache with the
    // authoritative server response (entry id, etc.) when it returns.
    fetch("https://graphql.anilist.co/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: `mutation (
          $mediaId: Int!, $status: MediaListStatus, $score: Float, $progress: Int,
          $repeat: Int, $private: Boolean, $hiddenFromStatusLists: Boolean,
          $notes: String, $startedAt: FuzzyDateInput, $completedAt: FuzzyDateInput,
          $customLists: [String]
        ) {
          SaveMediaListEntry(
            mediaId: $mediaId, status: $status, score: $score, progress: $progress,
            repeat: $repeat, private: $private, hiddenFromStatusLists: $hiddenFromStatusLists,
            notes: $notes, startedAt: $startedAt, completedAt: $completedAt,
            customLists: $customLists
          ) {
            id mediaId status score(format: POINT_10_DECIMAL) progress repeat
            private hiddenFromStatusLists notes customLists
            startedAt { year month day } completedAt { year month day }
          }
        }`,
        variables: {
          mediaId: animeId,
          status,
          score,
          progress,
          repeat: rewatches,
          private: isPrivate,
          hiddenFromStatusLists: hideFromLists,
          notes: notes || null,
          startedAt,
          completedAt,
          customLists,
        },
      }),
    })
      .then((res) => res.json())
      .then((json) => {
        const saved = json?.data?.SaveMediaListEntry;
        if (!saved) {
          notify.error(t("listEditor.error"));
          return;
        }
        // Reconcile the cache with the server's authoritative record.
        if (userName) {
          const cl =
            saved.customLists && typeof saved.customLists === "object"
              ? Object.entries(saved.customLists)
                  .filter(([, v]) => v === true)
                  .map(([k]) => k)
              : customLists;
          patchListEntry(userName, animeId, {
            id: Number(saved.id),
            mediaId: animeId,
            status: saved.status ?? null,
            score: typeof saved.score === "number" ? saved.score : null,
            progress: Number(saved.progress) || 0,
            repeat: Number(saved.repeat) || 0,
            private: !!saved.private,
            hiddenFromStatusLists: !!saved.hiddenFromStatusLists,
            notes: saved.notes || null,
            startedAt: saved.startedAt || null,
            completedAt: saved.completedAt || null,
            customLists: cl,
          });
        }
        // Recopy AniList's authoritative record into the local mirror so the
        // local list stays usable when AniList is later unavailable.
        upsertLocalEntry(animeId, {
          status: (saved.status as Status) ?? null,
          score: typeof saved.score === "number" && saved.score > 0 ? saved.score : null,
          progress: Number(saved.progress) || 0,
          total: totalEp > 0 ? totalEp : null,
          title: info?.title,
          coverImage: info?.coverImage?.large || info?.coverImage?.extraLarge || null,
          notes: saved.notes || null,
          startedAt: saved.startedAt || null,
          completedAt: saved.completedAt || null,
        });
      })
      .catch(() => notify.error(t("listEditor.error")));
  };

  const statusLabel = (s: Status): string => {
    switch (s) {
      case "CURRENT":
        return isAnime ? t("listEditor.watching") : t("listEditor.reading");
      case "PLANNING":
        return isAnime ? t("listEditor.planToWatch") : t("listEditor.planToRead");
      case "COMPLETED":
        return t("listEditor.completed");
      case "REPEATING":
        return t("listEditor.repeating");
      case "PAUSED":
        return t("listEditor.paused");
      case "DROPPED":
        return t("listEditor.dropped");
    }
  };

  const banner = info?.bannerImage || info?.coverImage?.extraLarge || info?.coverImage?.large;
  const poster = info?.coverImage?.extraLarge || info?.coverImage?.large;
  const title = info?.title?.english || info?.title?.romaji || "";

  const epInputVal = totalEp > 0 ? `${progress}/${totalEp}` : String(progress);
  const epPct = totalEp > 0 ? Math.min(100, Math.round((progress / totalEp) * 100)) : 0;

  return (
    <div className="list-editor-overlay" onClick={close}>
      <div className="list-editor-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="list-editor-header">
          {banner && (
            <div className="list-editor-banner" style={{ backgroundImage: `url('${banner}')` }} />
          )}
          <div className="list-editor-header-content">
            {poster && (
              <div className="list-editor-poster" style={{ backgroundImage: `url('${poster}')` }} />
            )}
            <span className="list-editor-title">{title}</span>
            {!isLocal && (
            <button
              type="button"
              aria-label={t("listEditor.favourite")}
              className={`list-editor-fav-btn ${favorited ? "is-fav" : ""}`}
              onClick={handleToggleFavourite}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill={favorited ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
              </svg>
            </button>
            )}
            <button
              type="button"
              className="list-editor-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {t("listEditor.save")}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="list-editor-body">
          {/* STATUS */}
          <div className="le-dd-field" ref={ddRef}>
            <span className="list-editor-label">{t("listEditor.status")}</span>
            <button
              type="button"
              className={`le-dd-trigger ${status ? `le-dd-trigger-${STATUS_KEY[status]}` : ""}`}
              onClick={() => setStatusOpen((o) => !o)}
            >
              <span className={`le-dd-dot le-dd-dot-${status ? STATUS_KEY[status] : "none"}`} />
              <span className="le-dd-trigger-text">
                {status ? statusLabel(status) : t("listEditor.notInList")}
              </span>
              <svg
                className={`le-dd-chevron ${statusOpen ? "open" : ""}`}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {statusOpen && (
              <div className="le-dd-list">
                {STATUS_ORDER.map((s) => {
                  const sel = status === s;
                  return (
                    <button
                      type="button"
                      key={s}
                      className={`le-dd-option ${sel ? `selected le-opt-${STATUS_KEY[s]}` : ""}`}
                      onClick={() => {
                        setStatus(s);
                        if (s === "COMPLETED" && totalEp > 0) setProgress(totalEp);
                        setStatusOpen(false);
                      }}
                    >
                      <span className={`le-dd-dot le-dd-dot-${STATUS_KEY[s]}`} />
                      <span className="le-dd-option-text">{statusLabel(s)}</span>
                      {sel && (
                        <svg
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          strokeLinecap="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* CUSTOM LISTS — toggle chips for each of the user's AniList custom
              lists. Only shown when the account has at least one. */}
          {availableCustomLists.length > 0 && (
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.customLists")}</span>
              <div className="le-custom-lists">
                {availableCustomLists.map((name) => {
                  const on = customLists.includes(name);
                  const color = customListColor(name);
                  return (
                    <button
                      type="button"
                      key={name}
                      className={`le-custom-chip ${on ? "on" : ""}`}
                      style={
                        on
                          ? {
                              // Tinted background + solid border in the list's colour.
                              background: `color-mix(in srgb, ${color} 18%, transparent)`,
                              borderColor: color,
                              color,
                            }
                          : undefined
                      }
                      onClick={() =>
                        setCustomLists((prev) =>
                          prev.includes(name)
                            ? prev.filter((n) => n !== name)
                            : [...prev, name],
                        )
                      }
                    >
                      <span
                        className="le-custom-chip-dot"
                        style={{
                          background: color,
                          // Always glow in the list's colour; brighter when selected.
                          boxShadow: on
                            ? `0 0 8px ${color}, 0 0 3px ${color}`
                            : `0 0 6px ${color}`,
                        }}
                      />
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* SCORE + EPISODE PROGRESS */}
          <div className="list-editor-grid-2">
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.score")}</span>
              <div className="le-score-controls">
                <button type="button" className="le-score-step-btn" onClick={() => changeScore(-0.5)}>
                  −
                </button>
                <input
                  type="text"
                  inputMode="decimal"
                  className={`le-score-input ${score > 0 ? `le-score-input-${scoreColorClass(score)}` : ""}`}
                  value={score > 0 ? String(score) : ""}
                  placeholder="—"
                  onChange={(e) => {
                    const v = parseFloat(e.target.value.replace(",", "."));
                    setScore(Number.isFinite(v) ? clampScore(v) : 0);
                  }}
                />
                <button type="button" className="le-score-step-btn" onClick={() => changeScore(0.5)}>
                  +
                </button>
              </div>
              <div
                ref={scoreBarRef}
                className="le-score-bar-click"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setScoreFromPointer(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) setScoreFromPointer(e.clientX);
                }}
              >
                <div
                  className="le-score-bar-fill-click"
                  style={{ width: `${(score / 10) * 100}%`, background: scoreHexColor(score) }}
                />
              </div>
            </div>

            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.episodeProgress")}</span>
              <div className="le-score-controls">
                <button
                  type="button"
                  className="le-score-step-btn"
                  onClick={() => changeProgress(-1)}
                >
                  −
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="le-score-input le-ep-input"
                  value={epInputVal}
                  placeholder="0"
                  onChange={(e) => {
                    const v = parseInt(e.target.value.replace(/\D/g, ""), 10);
                    if (!Number.isFinite(v)) return setProgress(0);
                    setProgress(totalEp > 0 ? Math.min(totalEp, v) : v);
                  }}
                />
                <button
                  type="button"
                  className="le-score-step-btn"
                  onClick={() => changeProgress(1)}
                >
                  +
                </button>
              </div>
              <div
                ref={epBarRef}
                className={`list-editor-ep-bar ${totalEp > 0 ? "le-ep-bar-clickable" : "le-ep-bar-disabled"}`}
                onPointerDown={(e) => {
                  if (totalEp <= 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setEpFromPointer(e.clientX);
                }}
                onPointerMove={(e) => {
                  if (e.buttons === 1) setEpFromPointer(e.clientX);
                }}
              >
                <div className="list-editor-ep-fill" style={{ width: `${epPct}%` }} />
              </div>
            </div>
          </div>

          {/* DATES + REWATCHES + OPTIONS */}
          <div className="list-editor-grid">
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.startDate")}</span>
              <div className="list-editor-date-wrapper">
                <input
                  type="date"
                  className="list-editor-date-input"
                  min="1900-01-01"
                  max="2099-12-31"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
            </div>
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.finishDate")}</span>
              <div className="list-editor-date-wrapper">
                <input
                  type="date"
                  className="list-editor-date-input"
                  min="1900-01-01"
                  max="2099-12-31"
                  value={finishDate}
                  onChange={(e) => setFinishDate(e.target.value)}
                />
              </div>
            </div>
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.rewatches")}</span>
              <div className="le-score-controls">
                <button
                  type="button"
                  className="le-score-step-btn"
                  onClick={() => setRewatches((r) => Math.max(0, r - 1))}
                >
                  −
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="le-score-input le-rewatch-input"
                  value={rewatches}
                  onChange={(e) => {
                    const v = parseInt(e.target.value.replace(/\D/g, ""), 10);
                    setRewatches(Number.isFinite(v) ? Math.max(0, v) : 0);
                  }}
                />
                <button
                  type="button"
                  className="le-score-step-btn"
                  onClick={() => setRewatches((r) => r + 1)}
                >
                  +
                </button>
              </div>
            </div>
            <div className="list-editor-field">
              <span className="list-editor-label">{t("listEditor.options")}</span>
              <div className="list-editor-custom-lists">
                <label className="list-editor-checkbox-row">
                  <input
                    type="checkbox"
                    checked={hideFromLists}
                    onChange={(e) => setHideFromLists(e.target.checked)}
                  />
                  {t("listEditor.hideFromLists")}
                </label>
                <label className="list-editor-checkbox-row">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  {t("listEditor.private")}
                </label>
              </div>
            </div>
          </div>

          {/* NOTES */}
          <div className="list-editor-field">
            <span className="list-editor-label">{t("listEditor.notes")}</span>
            <textarea
              className="list-editor-textarea"
              placeholder={t("listEditor.addNotes")}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* REMOVE FROM LIST — only when the anime is on the user's list
              (status set or an existing entry). Deletes the entry. */}
          {(status !== null || entryId !== null) && (
            <button
              type="button"
              className="le-delete-btn"
              onClick={handleRemove}
              disabled={saving}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <line x1="10" y1="11" x2="10" y2="17" />
                <line x1="14" y1="11" x2="14" y2="17" />
              </svg>
              {t("listEditor.removeFromList")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ListEditor;
