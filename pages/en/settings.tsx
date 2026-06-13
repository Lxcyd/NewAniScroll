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
import {
  downloadExportXml,
  importFromJson,
  importFromAniListUsername,
  importFromMalXml,
  readFileText,
  ImportResult,
} from "@/lib/list/importExport";
import { useLocalList } from "@/lib/list/localList";
import { fullSyncFromAniList, runAutoPauseSweep } from "@/lib/list/syncEngine";
import { useEffect, useRef, useState } from "react";
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

  const runPull = async () => {
    setSyncing(true);
    try {
      const r = await fullSyncFromAniList();
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

  // Confirmed enable: flip the toggle on, then pull AniList → local (overwrite).
  const enableSync = async () => {
    setConfirmSync(false);
    setSyncPrefs({ enabled: true });
    await runPull();
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

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex flex-col justify-center items-center min-h-screen md:py-0 py-16"
      >
        <div className="max-w-screen-md w-full px-4 py-10">
          <h1 className="text-4xl font-bold mb-2">{t("settings.title")}</h1>
          <p className="text-white/60 mb-10">
            {t("settings.storedLocally")}
          </p>

          {/* ── Anime title language ─────────────────────────────── */}
          <section className="mb-10">
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
          <section className="mb-10">
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

          {/* ── AniList synchronisation ──────────────────────────── */}
          <section className="mb-10">
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
              <Toggle
                label={t("settings.sync.autoProgress")}
                desc={t("settings.sync.autoProgressDesc")}
                checked={syncPrefs.autoProgress}
                onChange={(v) => setSyncPrefs({ autoProgress: v })}
                disabled={!isLoggedIn}
              />
              <Toggle
                label={t("settings.sync.autoWatching")}
                desc={t("settings.sync.autoWatchingDesc")}
                checked={syncPrefs.autoWatching}
                onChange={(v) => setSyncPrefs({ autoWatching: v })}
                disabled={!isLoggedIn}
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
                disabled={!isLoggedIn}
              />
              {/* Always shown so the delay is discoverable; disabled until the
                  auto-pause toggle is on (greyed, like the other gated rows) —
                  also locked entirely when not connected. */}
              <div
                className={`flex items-center justify-between gap-4 py-3 ${
                  isLoggedIn && syncPrefs.autoPause ? "" : "opacity-40"
                }`}
              >
                <div className="text-sm">{t("settings.sync.autoPauseDays")}</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    disabled={!isLoggedIn || !syncPrefs.autoPause}
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

          {/* ── My list (local) ──────────────────────────────────── */}
          <section className="mb-10">
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
          </section>
        </div>
      </motion.div>
      <Footer />
    </>
  );
}
