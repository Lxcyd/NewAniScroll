import Head from "next/head";
import Image from "next/image";
import { motion } from "framer-motion";
import { Navbar } from "@/components/shared/NavBar";
import Footer from "@/components/shared/footer";
import AniListLogo from "@/components/media/aniList";
import {
  getTitlePref,
  setTitlePref,
  TitlePref,
  useTitlePref,
} from "@/lib/prefs/titlePref";
import { getLang, setLang, Lang, LANG_EVENT } from "@/lib/i18n/languagePref";
import { useSyncPrefs, setSyncPrefs } from "@/lib/prefs/syncPrefs";
import { usePlayerPrefs, setPlayerPrefs } from "@/lib/prefs/playerPrefs";
import { useDataSaver, setDataSaver } from "@/lib/prefs/dataSaver";
import { useNotifPrefs, setNotifPrefs } from "@/lib/prefs/notifPrefs";
import { useClickTarget, setClickTarget, ClickTarget } from "@/lib/prefs/clickTarget";
import { useHideSpoilers, setHideSpoilers } from "@/lib/prefs/spoilerPrefs";
import { useAccent, setAccent, ACCENT_PRESETS, DEFAULT_ACCENT } from "@/lib/prefs/accentColor";
import {
  downloadExportXml,
  importFromJson,
  importFromAniListUsername,
  importFromMalXml,
  readFileText,
  ImportResult,
} from "@/lib/list/importExport";
import { useLocalList, clearLocalList } from "@/lib/list/localList";
import { fullSyncFromAniList, runAutoPauseSweep } from "@/lib/list/syncEngine";
import { useEffect, useRef, useState } from "react";
import {
  LanguageIcon,
  GlobeAltIcon,
  PlayCircleIcon,
  BoltIcon,
  SwatchIcon,
  ArrowPathIcon,
  LockClosedIcon,
  ListBulletIcon,
  BellIcon,
  CursorArrowRaysIcon,
} from "@heroicons/react/24/outline";
import { useSession, signIn, signOut } from "next-auth/react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/* Reusable segmented switch. Three-option flavour is used by the title
   preference picker; two-option by the UI language placeholder. Kept
   inline (not extracted) because it's the only place we render this
   widget and a generic abstraction would obscure the styling intent. */
function SegmentedPicker<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; sub?: string; disabled?: boolean }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg bg-white/5 ring-1 ring-white/10 p-1 gap-1">
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors min-w-[88px] ${
              opt.disabled
                ? "opacity-40 cursor-not-allowed"
                : selected
                ? "bg-action text-white"
                : "text-white/70 hover:text-white hover:bg-white/5"
            }`}
          >
            <div>{opt.label}</div>
            {opt.sub && (
              <div className="text-[10px] uppercase tracking-wider opacity-70 mt-0.5">
                {opt.sub}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* A labelled on/off switch used by the AniList sync section. `disabled` greys
   it out (master toggle off) while preserving its current visual state. */
function Toggle({
  checked,
  onChange,
  label,
  desc,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  desc?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-4 py-3 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-white/50 text-xs mt-0.5">{desc}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
          checked ? "bg-action" : "bg-white/15"
        } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

/* The settings sections, in document order. Each has a stable id (used as the
   scroll anchor + nav target) and an icon. `loggedInOnly` sections are hidden
   from the nav when signed out, mirroring the page body. */
type SectionDef = {
  id: string;
  labelKey: string;
  Icon: typeof LanguageIcon;
  loggedInOnly?: boolean;
};

const SECTIONS: SectionDef[] = [
  { id: "title-language", labelKey: "settings.animeTitleLanguage", Icon: LanguageIcon },
  { id: "interface-language", labelKey: "settings.interfaceLanguage", Icon: GlobeAltIcon },
  { id: "browsing", labelKey: "settings.browsing.title", Icon: CursorArrowRaysIcon },
  { id: "player", labelKey: "settings.player.title", Icon: PlayCircleIcon },
  { id: "data-saver", labelKey: "settings.dataSaver.title", Icon: BoltIcon },
  { id: "notifications", labelKey: "settings.notif.title", Icon: BellIcon },
  { id: "theme", labelKey: "settings.theme.title", Icon: SwatchIcon },
  { id: "sync", labelKey: "settings.sync.title", Icon: ArrowPathIcon },
  { id: "profile", labelKey: "settings.profile.title", Icon: LockClosedIcon, loggedInOnly: true },
  { id: "list", labelKey: "settings.list.title", Icon: ListBulletIcon },
];

/* Fixed left-rail navigation (Jikan-docs style): pinned to the left edge for
   the full viewport height and does NOT scroll with the page. Highlights the
   section currently in view (scroll-spy via IntersectionObserver) and
   smooth-scrolls to a section on click. Hidden on small screens, where the
   sections just stack. */
const SIDEBAR_WIDTH = 260; // px — kept in sync with the content's left margin

function SettingsNav({
  sections,
  active,
}: {
  sections: SectionDef[];
  active: string;
}) {
  const { t } = useTranslation();
  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav
      className="hidden md:flex flex-col gap-1 fixed left-[max(1rem,calc((100vw-48rem)/2-20.25rem))] top-44 z-30 max-h-[calc(100vh-12rem)] overflow-y-auto"
      style={{ width: SIDEBAR_WIDTH }}
    >
      {sections.map(({ id, labelKey, Icon }) => {
        const selected = active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            className={`flex items-start gap-3 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
              selected ? "text-action" : "text-white/60 hover:text-white hover:bg-white/5"
            }`}
          >
            <Icon className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{t(labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default function Settings() {
  /* Hydration guard: localStorage isn't available during SSR, so on the
     first render we display the default ("en") and immediately re-read
     after mount. Without this guard the SSR HTML would always show
     "en" selected and the client would flicker into the real value. */
  const livePref = useTitlePref();
  const { t } = useTranslation();
  // Session carries a custom `user.token` (AniList access token) not present in
  // next-auth's default Session type — `any` matches the codebase convention.
  const { data: session }: any = useSession();
  const syncPrefs = useSyncPrefs();
  const playerPrefs = usePlayerPrefs();
  const dataSaver = useDataSaver();
  const notifPrefs = useNotifPrefs();
  const clickTarget = useClickTarget();
  const hideSpoilers = useHideSpoilers();
  const accent = useAccent();
  const localList = useLocalList();
  const [titlePref, setTitlePrefState] = useState<TitlePref>("en");
  const [uiLang, setUiLangState] = useState<Lang>("en");
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    setTitlePrefState(getTitlePref());
    setUiLangState(getLang());
    const onLang = () => setUiLangState(getLang());
    window.addEventListener(LANG_EVENT, onLang);
    return () => window.removeEventListener(LANG_EVENT, onLang);
  }, []);
  // Re-sync when the live event fires (e.g. user opened settings in two
  // tabs). Doing this in a separate effect keeps the mount-time read
  // simple and avoids racing with `mounted`.
  useEffect(() => {
    if (mounted) setTitlePrefState(livePref);
  }, [livePref, mounted]);

  // ── Profile visibility (server-side, requires AniList login) ─────
  // Stored in the Prisma user `setting` JSON. When private, only the owner can
  // open /profile/<name>. We load the current value once the session resolves.
  const [profilePrivate, setProfilePrivate] = useState(false);
  const [profileSettings, setProfileSettings] = useState<any>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  useEffect(() => {
    const name = session?.user?.name;
    if (!name) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/user/profile?name=${encodeURIComponent(name)}`);
        if (!r.ok) return;
        const u = await r.json();
        if (cancelled) return;
        setProfileSettings(u?.setting || {});
        setProfilePrivate(u?.setting?.private === true);
      } catch {
        /* best-effort — toggle just stays at its default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.name]);

  const updateProfilePrivate = async (next: boolean) => {
    const name = session?.user?.name;
    if (!name || profileBusy) return;
    setProfilePrivate(next); // optimistic
    setProfileBusy(true);
    try {
      const settings = { ...(profileSettings || {}), private: next };
      const r = await fetch("/api/user/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, settings }),
      });
      if (!r.ok) throw new Error("save failed");
      setProfileSettings(settings);
    } catch {
      setProfilePrivate(!next); // revert
      toast.error(t("settings.profile.saveError"));
    } finally {
      setProfileBusy(false);
    }
  };

  const updateTitlePref = (next: TitlePref) => {
    setTitlePrefState(next);
    setTitlePref(next);
  };

  const updateUiLang = (next: Lang) => {
    setUiLangState(next);
    setLang(next);
  };

  // ── Import / export state ────────────────────────────────────────
  const isLoggedIn = !!session?.user?.token;
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const [aniUsername, setAniUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [malProgress, setMalProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  // ── AniList sync state ───────────────────────────────────────────
  // Enabling sync overwrites the local list with AniList, so we gate it behind
  // a confirmation dialog. Disabling needs no confirmation (local list stays).
  const [confirmSync, setConfirmSync] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // ── Delete-list confirmation ─────────────────────────────────────
  const [confirmClear, setConfirmClear] = useState(false);
  const handleClearList = () => {
    clearLocalList();
    setConfirmClear(false);
    toast.success(t("settings.list.clearDone"));
  };

  // ── Left-nav scroll-spy ──────────────────────────────────────────
  // Track which section is in view so the sticky nav can highlight it. The
  // section list adapts to login state (profile section is logged-in only).
  const navSections = SECTIONS.filter((s) => !s.loggedInOnly || isLoggedIn);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);
  useEffect(() => {
    const els = navSections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => !!el);
    if (els.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target?.id) setActiveSection(visible[0].target.id);
      },
      // Bias the active zone toward the upper third of the viewport.
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // Re-run when the section set changes (login) or the list section appears.
  }, [isLoggedIn]); // eslint-disable-line react-hooks/exhaustive-deps

  // `replace` = hard override (used when turning sync ON, after the user
  // confirms it replaces their local list). "Resync now" leaves it false so
  // local-only progress is reconciled, not wiped.
  const runPull = async (replace = false) => {
    setSyncing(true);
    try {
      const r = await fullSyncFromAniList({ replace });
      if (r.ok) {
        toast.success(t("settings.sync.synced", { count: r.count }));
        // Run the auto-pause sweep immediately on the freshly-pulled list so the
        // user sees stale CURRENT entries move to PAUSED right after syncing,
        // not only on the next page load.
        await runAutoPauseSweep().catch(() => {});
      } else toast.error(t("settings.sync.syncFailed"));
    } finally {
      setSyncing(false);
    }
  };

  // Confirmed enable: flip the toggle on, then HARD-OVERRIDE local with AniList
  // (the consequence the confirm dialog spelled out).
  const enableSync = async () => {
    setConfirmSync(false);
    setSyncPrefs({ enabled: true });
    await runPull(true);
  };

  const handleMasterToggle = (next: boolean) => {
    if (next) {
      // Turning ON: confirm first (it replaces the local list).
      if (isLoggedIn) setConfirmSync(true);
      else setSyncPrefs({ enabled: true }); // guest: nothing to pull/overwrite
    } else {
      setSyncPrefs({ enabled: false });
    }
  };

  const handleResyncNow = () => runPull();

  // Export as MyAnimeList XML (importable by AniList). Maps AniList ids -> MAL
  // ids first; entries without a MAL mapping can't be represented and are
  // skipped (reported in the toast).
  const handleExport = async () => {
    setBusy(true);
    setMalProgress(null);
    try {
      const r = await downloadExportXml((done, total) =>
        setMalProgress({ done, total }),
      );
      if (r.skipped > 0) {
        toast.success(
          t("settings.list.exportDoneSkipped", {
            exported: r.exported,
            skipped: r.skipped,
          }),
        );
      } else {
        toast.success(t("settings.list.exportDone", { exported: r.exported }));
      }
    } catch {
      toast.error(t("settings.list.exportError"));
    } finally {
      setBusy(false);
      setMalProgress(null);
    }
  };

  const reportResult = (r: ImportResult) => {
    toast.success(
      t("settings.list.importDone", { imported: r.imported, total: r.total }),
    );
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    setMalProgress(null);
    try {
      const text = await readFileText(file);
      const isXml =
        file.name.toLowerCase().endsWith(".xml") ||
        file.name.toLowerCase().endsWith(".xml.gz") ||
        text.trimStart().startsWith("<");
      if (isXml) {
        const r = await importFromMalXml(text, importMode, (done, total) =>
          setMalProgress({ done, total }),
        );
        reportResult(r);
      } else {
        reportResult(importFromJson(text, importMode));
      }
    } catch (e: any) {
      toast.error(t("settings.list.importError"));
    } finally {
      setBusy(false);
      setMalProgress(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleUsernameImport = async () => {
    if (!aniUsername.trim()) return;
    setBusy(true);
    try {
      reportResult(await importFromAniListUsername(aniUsername, importMode));
    } catch (e: any) {
      toast.error(
        e?.message === "user-not-found"
          ? t("settings.list.userNotFound")
          : t("settings.list.importError"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head>
        <title>AniScroll • Beta</title>
        <meta name="title" content="Settings" />
        <meta
          name="description"
          content="Customize how AniScroll looks and which language anime titles appear in."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <Navbar withNav={true} scrollP={5} shrink={true} />

      {/* Confirmation before enabling sync — it replaces the local list with
          the AniList list, so we make the consequence explicit. */}
      {confirmSync && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
          onClick={() => setConfirmSync(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-secondary ring-1 ring-white/10 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2">
              {t("settings.sync.confirmTitle")}
            </h3>
            <p className="text-white/70 text-sm mb-6">
              {t("settings.sync.confirmBody")}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmSync(false)}
                className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15"
              >
                {t("settings.sync.cancel")}
              </button>
              <button
                type="button"
                onClick={enableSync}
                className="px-4 py-2 rounded-lg bg-action text-white text-sm font-medium hover:opacity-90"
              >
                {t("settings.sync.confirmEnable")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation before deleting the local list — irreversible. */}
      {confirmClear && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
          onClick={() => setConfirmClear(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-secondary ring-1 ring-white/10 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2">
              {t("settings.list.clearConfirmTitle")}
            </h3>
            <p className="text-white/70 text-sm mb-6">
              {t("settings.list.clearConfirmBody", { count: localList.length })}
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15"
              >
                {t("settings.list.clearCancel")}
              </button>
              <button
                type="button"
                onClick={handleClearList}
                className="px-4 py-2 rounded-lg bg-red-500/90 text-white text-sm font-medium hover:bg-red-500"
              >
                {t("settings.list.clearConfirmButton")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fixed full-height left rail (desktop). Out of normal flow, so the
          content below is pushed right by a matching margin. */}
      <SettingsNav sections={navSections} active={activeSection} />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="min-h-screen py-16 md:py-0"
      >
        <div className="max-w-screen-md w-full mx-auto px-4 pt-28 pb-10">
          <h1 className="text-4xl font-bold mb-2 text-center">{t("settings.title")}</h1>
          <p className="text-white/60 mb-12 text-center">
            {t("settings.storedLocally")}
          </p>

          <div className="divide-y divide-white/10">
          {/* ── Anime title language ─────────────────────────────── */}
          <section id="title-language" className="pb-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.animeTitleLanguage")}</h2>
            <p className="text-white/60 text-sm mb-4">
              {t("settings.animeTitleLanguageDesc")}
            </p>
            <SegmentedPicker<TitlePref>
              value={titlePref}
              onChange={updateTitlePref}
              options={[
                { value: "en", label: t("language.en"), sub: t("settings.default") },
                { value: "romaji", label: "Romaji", sub: t("settings.romajiSub") },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              {t("settings.titleLangNote")}
            </p>
          </section>

          {/* ── Interface language ───────────────────────────────── */}
          <section id="interface-language" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.interfaceLanguage")}</h2>
            <p className="text-white/60 text-sm mb-4">
              {t("settings.interfaceLanguageDesc")}
            </p>
            <SegmentedPicker<Lang>
              value={uiLang}
              onChange={updateUiLang}
              options={[
                { value: "en", label: t("language.en") },
                { value: "fr", label: t("language.fr") },
              ]}
            />
            <p className="text-white/40 text-xs mt-3">
              {t("settings.interfaceLangNote")}
            </p>
          </section>

          {/* ── Browsing (click target, spoilers) ────────────────── */}
          <section id="browsing" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.browsing.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.browsing.desc")}</p>

            <div className="mb-2 text-sm font-medium">
              {t("settings.browsing.openOn")}
            </div>
            <div className="text-white/50 text-xs mb-3">
              {t("settings.browsing.openOnDesc")}
            </div>
            <SegmentedPicker<ClickTarget>
              value={clickTarget}
              onChange={setClickTarget}
              options={[
                { value: "info", label: t("settings.browsing.infoPage") },
                { value: "watch", label: t("settings.browsing.watchPage") },
              ]}
            />

            <div className="mt-4 rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
              <Toggle
                label={t("settings.browsing.hideSpoilers")}
                desc={t("settings.browsing.hideSpoilersDesc")}
                checked={hideSpoilers}
                onChange={setHideSpoilers}
              />
            </div>
          </section>

          {/* ── Video player ─────────────────────────────────────── */}
          <section id="player" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.player.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.player.desc")}</p>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
              <Toggle
                label={t("settings.player.rateOnComplete")}
                desc={t("settings.player.rateOnCompleteDesc")}
                checked={playerPrefs.rateOnComplete}
                onChange={(v) => setPlayerPrefs({ rateOnComplete: v })}
              />
            </div>
            <p className="text-white/40 text-xs mt-3">{t("settings.player.note")}</p>
          </section>

          {/* ── Data saver ───────────────────────────────────────── */}
          <section id="data-saver" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.dataSaver.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.dataSaver.desc")}</p>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
              <Toggle
                label={t("settings.dataSaver.toggle")}
                desc={t("settings.dataSaver.toggleDesc")}
                checked={dataSaver}
                onChange={setDataSaver}
              />
            </div>
            <p className="text-white/40 text-xs mt-3">{t("settings.dataSaver.note")}</p>
          </section>

          {/* ── Notifications ────────────────────────────────────── */}
          <section id="notifications" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.notif.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.notif.desc")}</p>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
              <Toggle
                label={t("settings.notif.newEpisode")}
                desc={t("settings.notif.newEpisodeDesc")}
                checked={notifPrefs.newEpisode}
                onChange={(v) => setNotifPrefs({ newEpisode: v })}
              />
              <Toggle
                label={t("settings.notif.nextSeason")}
                desc={t("settings.notif.nextSeasonDesc")}
                checked={notifPrefs.nextSeason}
                onChange={(v) => setNotifPrefs({ nextSeason: v })}
              />
              <Toggle
                label={t("settings.notif.resume")}
                desc={t("settings.notif.resumeDesc")}
                checked={notifPrefs.resume}
                onChange={(v) => setNotifPrefs({ resume: v })}
              />
            </div>
            <p className="text-white/40 text-xs mt-3">{t("settings.notif.note")}</p>
          </section>

          {/* ── Theme (accent colour) ────────────────────────────── */}
          <section id="theme" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.theme.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.theme.desc")}</p>
            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-4">
              <div className="flex flex-wrap items-center gap-3">
                {ACCENT_PRESETS.map((c) => {
                  const active = accent.toLowerCase() === c.toLowerCase();
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setAccent(c)}
                      aria-label={c}
                      className={`w-9 h-9 rounded-full transition-transform hover:scale-110 ${
                        active ? "ring-2 ring-white ring-offset-2 ring-offset-secondary" : ""
                      }`}
                      style={{ background: c }}
                    />
                  );
                })}
                {/* Free colour picker */}
                <label
                  className="w-9 h-9 rounded-full grid place-items-center cursor-pointer ring-1 ring-white/20 relative overflow-hidden"
                  title={t("settings.theme.custom")}
                  style={{
                    background:
                      "conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)",
                  }}
                >
                  <input
                    type="color"
                    value={accent}
                    onChange={(e) => setAccent(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                </label>
                {accent.toLowerCase() !== DEFAULT_ACCENT.toLowerCase() && (
                  <button
                    type="button"
                    onClick={() => setAccent(DEFAULT_ACCENT)}
                    className="ml-1 text-xs text-white/60 hover:text-white underline"
                  >
                    {t("settings.theme.reset")}
                  </button>
                )}
              </div>
            </div>
            <p className="text-white/40 text-xs mt-3">{t("settings.theme.note")}</p>
          </section>

          {/* ── AniList synchronisation ──────────────────────────── */}
          <section id="sync" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.sync.title")}</h2>
            <p className="text-white/60 text-sm mb-4">{t("settings.sync.desc")}</p>

            {/* Connected AniList account card */}
            <div className="mb-4 rounded-xl bg-white/5 ring-1 ring-white/10 p-4 flex items-center gap-4">
              {isLoggedIn ? (
                <>
                  {session?.user?.image?.large ? (
                    <Image
                      src={session.user.image.large}
                      alt={session?.user?.name || "avatar"}
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded-full object-cover ring-2 ring-white/10 shrink-0"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-white/10 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold truncate">
                        {session?.user?.name}
                      </span>
                      <span className="scale-[55%] origin-left -ml-1">
                        <AniListLogo />
                      </span>
                    </div>
                    <div className="text-white/50 text-xs">
                      {t("settings.sync.connected")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => signOut({ redirect: false })}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm hover:bg-white/15"
                  >
                    {t("nav.signOut")}
                  </button>
                </>
              ) : (
                <>
                  <span className="scale-[70%] origin-left shrink-0">
                    <AniListLogo />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">
                      {t("settings.sync.notConnected")}
                    </div>
                    <div className="text-white/50 text-xs">
                      {t("settings.sync.connectPrompt")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => signIn("AniListProvider")}
                    className="shrink-0 px-4 py-2 rounded-lg bg-action text-white text-sm font-medium hover:opacity-90"
                  >
                    {t("nav.signInWithAniList")}
                  </button>
                </>
              )}
            </div>

            <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
              {/* All AniList sync settings are gated behind a connected
                  account — when not signed in they're shown but locked
                  (greyed/disabled) since they only push to AniList. */}
              <Toggle
                label={t("settings.sync.master")}
                desc={
                  isLoggedIn
                    ? t("settings.sync.masterDesc")
                    : t("settings.sync.masterDescGuest")
                }
                checked={syncPrefs.enabled}
                onChange={handleMasterToggle}
                disabled={!isLoggedIn}
              />
              {/* Auto-progress + auto-watching always apply to the LOCAL list,
                  so they stay usable when signed out (only the AniList PUSH is
                  gated by the master toggle / login — see syncEngine). */}
              <Toggle
                label={t("settings.sync.autoProgress")}
                desc={t("settings.sync.autoProgressDesc")}
                checked={syncPrefs.autoProgress}
                onChange={(v) => setSyncPrefs({ autoProgress: v })}
              />
              {/* Sync threshold — how far into an episode counts as "watched"
                  (progress +1 / AniList update). Sits right after the progress
                  toggle since it defines WHEN that progress is recorded; applies
                  to the local list too, so it isn't gated by login. */}
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {t("settings.sync.threshold")}
                  </div>
                  <div className="text-white/50 text-xs mt-0.5">
                    {t("settings.sync.thresholdDesc")}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(syncPrefs.syncThreshold * 100)}
                    onChange={(e) => {
                      const pct = parseInt(e.target.value, 10);
                      if (Number.isFinite(pct))
                        setSyncPrefs({ syncThreshold: pct / 100 });
                    }}
                    className="w-32 accent-action cursor-pointer"
                  />
                  <span className="text-sm tabular-nums text-white/80 w-10 text-right">
                    {Math.round(syncPrefs.syncThreshold * 100)}%
                  </span>
                </div>
              </div>
              <Toggle
                label={t("settings.sync.autoWatching")}
                desc={t("settings.sync.autoWatchingDesc")}
                checked={syncPrefs.autoWatching}
                onChange={(v) => setSyncPrefs({ autoWatching: v })}
              />
              <Toggle
                label={t("settings.sync.autoPause")}
                desc={t("settings.sync.autoPauseDesc")}
                checked={syncPrefs.autoPause}
                onChange={(v) => {
                  setSyncPrefs({ autoPause: v });
                  // Apply right away when turning it on (don't wait for a reload).
                  if (v) runAutoPauseSweep().catch(() => {});
                }}
              />
              {/* Always shown so the delay is discoverable; disabled only until
                  the auto-pause toggle is on. The rule runs on the local list,
                  so it isn't gated by login. */}
              <div
                className={`flex items-center justify-between gap-4 py-3 ${
                  syncPrefs.autoPause ? "" : "opacity-40"
                }`}
              >
                <div className="text-sm">{t("settings.sync.autoPauseDays")}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    disabled={!syncPrefs.autoPause}
                    value={syncPrefs.autoPauseDays}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (Number.isFinite(v) && v > 0)
                        setSyncPrefs({ autoPauseDays: v });
                    }}
                    className="w-20 bg-white/10 rounded-md px-2 py-1 text-sm text-center ring-1 ring-white/10 focus:outline-none focus:ring-action disabled:cursor-not-allowed"
                  />
                  <span className="text-white/50 text-sm">
                    {t("settings.sync.days")}
                  </span>
                </div>
              </div>
            </div>

            {/* Resync now — pull AniList → local on demand (only useful when
                sync is on and connected). */}
            {isLoggedIn && syncPrefs.enabled && (
              <button
                type="button"
                onClick={handleResyncNow}
                disabled={syncing}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                {syncing ? t("settings.sync.syncing") : t("settings.sync.resyncNow")}
              </button>
            )}
            <p className="text-white/40 text-xs mt-3">{t("settings.sync.note")}</p>
          </section>

          {/* ── Profile visibility (logged-in only) ──────────────── */}
          {isLoggedIn && (
            <section id="profile" className="py-10 scroll-mt-24">
              <h2 className="text-xl font-semibold mb-1">{t("settings.profile.title")}</h2>
              <p className="text-white/60 text-sm mb-4">{t("settings.profile.desc")}</p>
              <div className="rounded-xl bg-white/5 ring-1 ring-white/10 px-4 divide-y divide-white/5">
                <Toggle
                  label={t("settings.profile.private")}
                  desc={t("settings.profile.privateDesc")}
                  checked={profilePrivate}
                  onChange={updateProfilePrivate}
                  disabled={profileBusy}
                />
              </div>
              <p className="text-white/40 text-xs mt-3">{t("settings.profile.note")}</p>
            </section>
          )}

          {/* ── My list (local) ──────────────────────────────────── */}
          <section id="list" className="py-10 scroll-mt-24">
            <h2 className="text-xl font-semibold mb-1">{t("settings.list.title")}</h2>
            <p className="text-white/60 text-sm mb-4">
              {t("settings.list.desc", { count: localList.length })}
            </p>

            {/* Import mode */}
            <div className="mb-4">
              <SegmentedPicker<"merge" | "replace">
                value={importMode}
                onChange={setImportMode}
                options={[
                  { value: "merge", label: t("settings.list.merge") },
                  { value: "replace", label: t("settings.list.replace") },
                ]}
              />
            </div>

            <div className="flex flex-wrap gap-3 mb-4">
              <button
                type="button"
                onClick={handleExport}
                disabled={localList.length === 0 || busy}
                className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                {t("settings.list.export")}
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                {t("settings.list.importFile")}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.xml,.gz,application/json,application/xml,application/gzip"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
            </div>

            {/* AniList username import */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={aniUsername}
                onChange={(e) => setAniUsername(e.target.value)}
                placeholder={t("settings.list.anilistUserPlaceholder")}
                className="flex-1 min-w-[180px] bg-white/10 rounded-md px-3 py-2 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-action"
              />
              <button
                type="button"
                onClick={handleUsernameImport}
                disabled={busy || !aniUsername.trim()}
                className="px-4 py-2 rounded-lg bg-white/10 ring-1 ring-white/10 text-sm font-medium hover:bg-white/15 disabled:opacity-40"
              >
                {t("settings.list.importUser")}
              </button>
            </div>

            {malProgress && (
              <p className="text-white/50 text-xs mt-3">
                {t("settings.list.mapping", {
                  done: malProgress.done,
                  total: malProgress.total,
                })}
              </p>
            )}
            <p className="text-white/40 text-xs mt-3">{t("settings.list.note")}</p>

            {/* Danger zone — wipe the whole local list (gated by a confirm). */}
            <div className="mt-6 pt-6 border-t border-white/10">
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                disabled={localList.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-red-300 ring-1 ring-red-400/30 hover:bg-red-500/10 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {t("settings.list.clear")}
              </button>
            </div>
          </section>
          </div>
        </div>
      </motion.div>
      <Footer />
    </>
  );
}
