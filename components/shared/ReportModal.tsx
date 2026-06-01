import { Fragment, useEffect, useRef, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

/* Two-tab report form.
 *
 *   - "Site bug" tab: free-form title + description + severity, same
 *     thing the site has had for a while.
 *   - "Anime bug" tab: tied to the anime / episode page the user is
 *     currently on (preset via the `animeContext` prop). User ticks
 *     one or more pre-defined issues (wrong title, wrong show, skip
 *     timing wrong, etc.) and optionally adds notes.
 *
 * Both feed the same `bug_reports` table; we just encode the
 * structured anime bits into the existing `title` / `description`
 * columns so the admin dashboard keeps working with no schema
 * migration. Title prefixes (`[SITE]` / `[ANIME]`) make the two
 * cleanly filterable in the dashboard.
 */

const SITE_SEVERITY = ["Low", "Medium", "High", "Critical"] as const;
type Severity = (typeof SITE_SEVERITY)[number];

const ANIME_ISSUES = [
  { id: "wrong_show", label: "Wrong show (anime / episode mismatch)" },
  { id: "wrong_title", label: "Wrong title or metadata" },
  { id: "wrong_skip", label: "Skip Intro / Outro timestamps are wrong" },
  { id: "missing_servers", label: "Missing or broken video servers" },
  { id: "wont_play", label: "Selected episode won't play" },
  { id: "missing_download", label: "Missing download link" },
  { id: "wrong_subs", label: "Wrong / missing subtitles" },
] as const;
type AnimeIssueId = (typeof ANIME_ISSUES)[number]["id"];

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type AnimeReportContext = {
  /** AniList id of the anime currently being viewed. */
  animeId: number | string;
  /** Display title (English / Romaji depending on user pref). */
  animeTitle: string;
  /** Optional — only when reporting from the watch page. */
  episode?: number;
};

interface Props {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  /** When provided, the modal opens directly on the "Anime bug" tab
   *  and prefills the anime + episode. Pass null on the navbar /
   *  generic surface so the user lands on "Site bug" instead. */
  animeContext?: AnimeReportContext | null;
}

type TabId = "site" | "anime";

const ReportModal: React.FC<Props> = ({ isOpen, setIsOpen, animeContext }) => {
  const { t } = useTranslation();
  // Default to the anime tab when an animeContext is supplied — that's
  // almost always why the user opened the modal in that surface.
  const [tab, setTab] = useState<TabId>(animeContext ? "anime" : "site");

  // Re-sync the active tab whenever the modal TRANSITIONS from closed to
  // open. We deliberately do NOT depend on `animeContext` — callers build
  // that object inline (`animeContext={info ? { ... } : null}`), so its
  // reference changes on every parent render. Keeping it in the deps reset
  // the tab back to "anime" mid-edit any time the parent re-rendered for an
  // unrelated reason — which on mobile happens the moment the soft keyboard
  // opens (viewport-resize → context re-render → new animeContext object).
  // Reported as: cannot enter a [SITE] report from a watch page on mobile.
  useEffect(() => {
    if (isOpen) setTab(animeContext ? "anime" : "site");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ─ Site-bug state ─────────────────────────────────────────────
  const [siteTitle, setSiteTitle] = useState("");
  const [siteDesc, setSiteDesc] = useState("");
  const [siteSeverity, setSiteSeverity] = useState<Severity>("Low");

  // ─ Anime-bug state ────────────────────────────────────────────
  const [animeIssues, setAnimeIssues] = useState<Set<AnimeIssueId>>(new Set());
  const [animeNotes, setAnimeNotes] = useState("");

  // ─ Shared ─────────────────────────────────────────────────────
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const closeModal = () => {
    setIsOpen(false);
    // Reset everything so the next open is fresh.
    setSiteTitle("");
    setSiteDesc("");
    setSiteSeverity("Low");
    setAnimeIssues(new Set());
    setAnimeNotes("");
    setImages([]);
  };

  // ── Image attachments ──────────────────────────────────────
  const fileToDataUrl = (file: File): Promise<string | null> =>
    new Promise((resolve) => {
      if (!file.type.startsWith("image/")) return resolve(null);
      if (file.size > MAX_IMAGE_BYTES) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) {
      toast.error(t("report.errors.tooManyImages", { max: MAX_IMAGES }));
      return;
    }
    const chosen = Array.from(files).slice(0, slots);
    const encoded = await Promise.all(chosen.map(fileToDataUrl));
    const valid = encoded.filter((x): x is string => Boolean(x));
    const rejected = encoded.length - valid.length;
    if (rejected > 0) {
      toast.error(t("report.errors.filesSkipped", { count: rejected }));
    }
    if (valid.length) setImages((cur) => [...cur, ...valid]);
  };

  const removeImage = (i: number) =>
    setImages((cur) => cur.filter((_, idx) => idx !== i));

  // ── Issue checkbox toggle ──────────────────────────────────
  const toggleIssue = (id: AnimeIssueId) => {
    setAnimeIssues((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Submit ─────────────────────────────────────────────────
  // Encodes the form into the existing { title, desc, severity }
  // schema. Prefixes make site vs anime reports trivially filterable
  // in the admin dashboard ([SITE] / [ANIME]).
  const buildPayload = (): {
    title: string;
    desc: string;
    severity: string;
  } | null => {
    if (tab === "site") {
      if (!siteTitle.trim() || !siteDesc.trim()) {
        toast.error(t("report.errors.titleDescRequired"));
        return null;
      }
      return {
        title: `[SITE] ${siteTitle.trim()}`,
        desc: siteDesc.trim(),
        severity: siteSeverity,
      };
    }
    // anime tab
    if (animeIssues.size === 0) {
      toast.error(t("report.errors.pickIssue"));
      return null;
    }
    const ctxBits: string[] = [];
    if (animeContext?.animeTitle) {
      ctxBits.push(`Anime: ${animeContext.animeTitle}`);
    }
    if (animeContext?.animeId != null) {
      ctxBits.push(`AniList ID: ${animeContext.animeId}`);
    }
    if (animeContext?.episode != null) {
      ctxBits.push(`Episode: ${animeContext.episode}`);
    }
    const labels = ANIME_ISSUES.filter((i) => animeIssues.has(i.id)).map(
      (i) => `• ${i.label}`
    );
    const desc = [
      ctxBits.join("\n"),
      "Issues:",
      labels.join("\n"),
      animeNotes.trim() ? `\nNotes:\n${animeNotes.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const titleSuffix = animeContext?.animeTitle
      ? animeContext.animeTitle
      : `anime ${animeContext?.animeId ?? "?"}`;
    const epSuffix =
      animeContext?.episode != null ? ` · EP ${animeContext.episode}` : "";
    return {
      title: `[ANIME] ${titleSuffix}${epSuffix}`,
      desc,
      severity: "anime",
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const payload = buildPayload();
    if (!payload) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/v2/admin/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            ...payload,
            url: window.location.href,
            createdAt: new Date().toISOString(),
            images,
          },
        }),
      });
      const json = await res.json();
      if (res.status === 429) {
        toast.error(json.message || t("report.errors.tooManyReports"));
        return;
      }
      if (!res.ok) {
        toast.error(json.error || t("report.errors.submissionFailed"));
        return;
      }
      toast.success(json.message || t("report.success"));
      closeModal();
    } catch (err: any) {
      console.error(err);
      toast.error(t("report.errors.somethingWrong", { message: err.message }));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Tab pill ───────────────────────────────────────────────
  const TabBtn = ({
    id,
    children,
    disabled,
  }: {
    id: TabId;
    children: React.ReactNode;
    disabled?: boolean;
  }) => {
    const active = tab === id && !disabled;
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setTab(id)}
        className={`flex-1 px-4 py-2 text-sm font-semibold rounded-md transition-colors ${
          active
            ? "bg-action text-white"
            : disabled
            ? "text-white/30 cursor-not-allowed"
            : "text-white/60 hover:text-white hover:bg-white/5"
        }`}
        title={disabled ? t("report.openThisFromAnimePage") : undefined}
      >
        {children}
      </button>
    );
  };

  // The anime tab is only meaningful when we have a context; on the
  // navbar surface (no context) we still show it but greyed out so
  // the user knows the feature exists.
  const animeTabDisabled = !animeContext;

  return (
    <Transition appear show={isOpen} as={Fragment}>
      {/* Navbar sits at z-[9999] (cf. NavBar.tsx), so the modal must
          beat it. */}
      <Dialog as="div" className="relative z-[10000]" onClose={closeModal}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black bg-opacity-90" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <Dialog.Panel className="relative w-full max-w-md transition-all">
                {/* Cap to viewport-ish so the inner form scrolls inside the
                    modal (instead of relying on the outer overflow-y-auto,
                    which on mobile hides its scrollbar entirely and made
                    users miss the Submit button hidden below the fold).
                    `scrollbar-thin` is from tailwind-scrollbar — gives a
                    visible thin track on desktop. iOS Safari only shows
                    scrollbars during active scroll, so we also draw a fade
                    gradient at the bottom of the panel (see below) as a
                    discoverability hint. */}
                <div
                  className="bg-secondary p-6 rounded-lg shadow-xl max-h-[85dvh] overflow-y-auto scrollbar-thin scrollbar-thumb-white/25 scrollbar-track-transparent"
                >
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-action text-2xl font-semibold">
                      {t("report.title")}
                    </h2>
                    <button
                      type="button"
                      onClick={closeModal}
                      className="text-white/40 hover:text-white text-xl px-2 leading-none"
                      aria-label="Close"
                    >
                      ×
                    </button>
                  </div>

                  {/* Tab switcher */}
                  <div className="flex gap-1 mb-5 bg-image rounded-lg p-1">
                    <TabBtn id="site">{t("report.siteBug")}</TabBtn>
                    <TabBtn id="anime" disabled={animeTabDisabled}>
                      {t("report.animeBug")}
                    </TabBtn>
                  </div>

                  <form onSubmit={handleSubmit}>
                    {tab === "site" ? (
                      <SiteTab
                        title={siteTitle}
                        setTitle={setSiteTitle}
                        desc={siteDesc}
                        setDesc={setSiteDesc}
                        severity={siteSeverity}
                        setSeverity={setSiteSeverity}
                      />
                    ) : (
                      <AnimeTab
                        context={animeContext}
                        issues={animeIssues}
                        toggleIssue={toggleIssue}
                        notes={animeNotes}
                        setNotes={setAnimeNotes}
                      />
                    )}

                    {/* Shared: screenshot attachments */}
                    <div className="mt-4">
                      <label className="block text-txt text-sm font-medium mb-2">
                        {t("report.screenshots", { count: images.length, max: MAX_IMAGES })}
                      </label>
                      <div className="flex flex-wrap gap-2">
                        {images.map((src, i) => (
                          <div key={i} className="relative">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={src}
                              alt=""
                              className="w-16 h-16 object-cover rounded ring-1 ring-white/10"
                            />
                            <button
                              type="button"
                              onClick={() => removeImage(i)}
                              className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-600 text-white text-xs flex-center hover:bg-rose-500"
                              aria-label="Remove"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        {images.length < MAX_IMAGES && (
                          <label className="w-16 h-16 rounded ring-1 ring-white/15 hover:ring-action cursor-pointer flex-center text-white/40 hover:text-white text-2xl transition-colors">
                            +
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              hidden
                              onChange={(e) => handleFiles(e.target.files)}
                            />
                          </label>
                        )}
                      </div>
                      <p className="mt-1 text-[10px] text-white/40">
                        {t("report.maxImageSize")}
                      </p>
                    </div>

                    <div className="mt-5">
                      <button
                        type="submit"
                        disabled={submitting}
                        className="w-full bg-action text-white py-2 px-4 rounded-md font-semibold hover:bg-action/80 focus:ring focus:ring-action focus:outline-none transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {submitting ? t("report.submitting") : t("report.submit")}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Bottom-edge "more below" hint — sits over the scroll
                    container, fades into bg-secondary so partially-clipped
                    content reads as continuing past the fold. Hidden once
                    the user scrolls within ~16 px of the bottom so it never
                    obscures the Submit button. pointer-events:none keeps
                    the button below clickable through the fade. */}
                <BottomScrollFade />
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
};

export default ReportModal;

// Gradient fade overlay rendered as the LAST child of a `relative` parent
// whose first child is a scrollable container. Watches that sibling's scroll
// position and fades itself out once the user is within ~16 px of the
// bottom — that way the Submit button never sits under a darkening overlay
// when it's actually fully visible.
function BottomScrollFade() {
  const ref = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = el.previousElementSibling as HTMLElement | null;
    if (!scroller) return;

    const check = () => {
      const overflowing = scroller.scrollHeight > scroller.clientHeight + 1;
      setOverflows(overflowing);
      if (!overflowing) {
        setAtBottom(true);
        return;
      }
      const remaining =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      setAtBottom(remaining <= 16);
    };

    check();
    scroller.addEventListener("scroll", check, { passive: true });
    // Resize observer covers the soft-keyboard / image-attachment case where
    // the inner form grows or shrinks without a scroll event firing.
    const ro = new ResizeObserver(check);
    ro.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-gradient-to-t from-secondary to-transparent transition-opacity duration-200"
      style={{ opacity: overflows && !atBottom ? 1 : 0 }}
    />
  );
}

// ── Site bug tab ───────────────────────────────────────────────
function SiteTab({
  title,
  setTitle,
  desc,
  setDesc,
  severity,
  setSeverity,
}: {
  title: string;
  setTitle: (s: string) => void;
  desc: string;
  setDesc: (s: string) => void;
  severity: Severity;
  setSeverity: (s: Severity) => void;
}) {
  const { t } = useTranslation();
  const severityLabel: Record<Severity, string> = {
    Low: t("report.severityLow"),
    Medium: t("report.severityMedium"),
    High: t("report.severityHigh"),
    Critical: t("report.severityCritical"),
  };
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-txt text-sm font-medium mb-2">
          {t("report.titleLabel")}
        </label>
        <input
          type="text"
          maxLength={120}
          className="w-full bg-image text-txt rounded-md border border-txt focus:ring-action focus:border-action transition duration-300 focus:outline-none py-2 px-3"
          placeholder={t("report.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="block text-txt text-sm font-medium mb-2">
          {t("report.descriptionLabel")}
        </label>
        <textarea
          rows={4}
          className="w-full bg-image text-txt rounded-md border border-txt focus:ring-action focus:border-action transition duration-300 focus:outline-none py-2 px-3"
          placeholder={t("report.descriptionPlaceholder")}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="block text-txt text-sm font-medium mb-2">
          {t("report.severity")}
        </label>
        <div className="flex gap-2">
          {SITE_SEVERITY.map((s) => {
            const active = severity === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  active
                    ? "bg-action text-white"
                    : "bg-image text-white/60 hover:text-white"
                }`}
              >
                {severityLabel[s]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Anime bug tab ──────────────────────────────────────────────
function AnimeTab({
  context,
  issues,
  toggleIssue,
  notes,
  setNotes,
}: {
  context?: AnimeReportContext | null;
  issues: Set<AnimeIssueId>;
  toggleIssue: (id: AnimeIssueId) => void;
  notes: string;
  setNotes: (s: string) => void;
}) {
  const { t } = useTranslation();
  if (!context) {
    return (
      <p className="text-white/60 text-sm">
        {t("report.openFromAnimePage")}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="text-sm">
        <div className="text-white/40 text-xs uppercase tracking-wider mb-1">
          {t("report.reporting")}
        </div>
        <div className="text-white font-medium">{context.animeTitle}</div>
        {context.episode != null && (
          <div className="text-white/60 text-xs">
            {t("common.episode")} {context.episode}
          </div>
        )}
      </div>

      <div>
        <label className="block text-txt text-sm font-medium mb-2">
          {t("report.whatsTheIssue")}
        </label>
        <div className="space-y-1.5">
          {ANIME_ISSUES.map((iss) => {
            const checked = issues.has(iss.id);
            return (
              <button
                key={iss.id}
                type="button"
                onClick={() => toggleIssue(iss.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left text-sm transition-colors ${
                  checked
                    ? "bg-action/10 ring-1 ring-action/40 text-white"
                    : "bg-image text-white/70 hover:bg-white/5 hover:text-white"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex-center shrink-0 ${
                    checked ? "bg-action border-action" : "border-white/30"
                  }`}
                >
                  {checked && (
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="white"
                      strokeWidth="3"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                {t(`report.issues.${iss.id}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="block text-txt text-sm font-medium mb-2">
          {t("report.notesLabel")}
        </label>
        <textarea
          rows={3}
          maxLength={500}
          className="w-full bg-image text-txt rounded-md border border-txt focus:ring-action focus:border-action transition duration-300 focus:outline-none py-2 px-3"
          placeholder={t("report.notesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
    </div>
  );
}
