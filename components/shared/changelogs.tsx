import { Dialog, Transition } from "@headlessui/react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// localStorage key holding the changelog VERSION the user last dismissed.
// The popup's content lives in its own per-language markdown files
// (CHANGELOG_POPUP.fr.md / CHANGELOG_POPUP.en.md), served by
// /api/v2/changelog-popup. The FIRST line of that file is the version string,
// which is the auto-display trigger: the popup opens whenever it differs from
// the version the user last dismissed. To ship a release popup, bump that first
// line in both files. (The full CHANGELOG.md + its navbar button are separate.)
const SEEN_KEY = "changelog-seen-version";

/** Parse a CHANGELOG_POPUP.*.md: first line = version, then `---`, then the
 *  body (paragraphs separated by blank lines). */
function parsePopup(md: string): { version: string; body: string } | null {
  const text = md.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  const lines = text.split("\n");
  const version = (lines.shift() || "").trim();
  if (!version) return null;
  // Drop a leading `---` separator if present.
  if ((lines[0] || "").trim() === "---") lines.shift();
  const body = lines.join("\n").trim();
  return { version, body };
}

/** Render a paragraph with **bold** spans turned into <strong>. */
function renderBold(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <strong key={key++} className="font-semibold text-gray-100">
        {m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function ChangeLogs() {
  const { t, i18n } = useTranslation();
  let [isOpen, setIsOpen] = useState(false);
  let [version, setVersion] = useState<string | null>(null);
  let [body, setBody] = useState<string>("");
  let completeButtonRef = useRef(null);

  const lang = i18n.language?.startsWith("fr") ? "fr" : "en";

  function closeModal() {
    try {
      if (version) localStorage.setItem(SEEN_KEY, version);
    } catch {
      /* storage unavailable — popup will just show again next load */
    }
    setIsOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    // Fetch the per-language popup markdown. Cache-bust so a returning visitor
    // doesn't get a stale browser-cached copy and miss a new release.
    fetch(`/api/v2/changelog-popup?lang=${lang}&t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((md) => {
        if (cancelled) return;
        const parsed = parsePopup(md);
        if (!parsed) return;
        setVersion(parsed.version);
        setBody(parsed.body);
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(SEEN_KEY);
        } catch {
          /* storage unavailable → treat as unseen */
        }
        if (seen !== parsed.version) setIsOpen(true);
      })
      .catch(() => {
        /* popup changelog unavailable — silently skip */
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  return (
    <>
      <Transition appear show={isOpen} as={Fragment}>
        <Dialog
          as="div"
          // Must sit above the navbar (z-[9999]) and the mobile nav FAB
          // (z-[1000]) — at z-50 those were peeking through the overlay.
          className="relative z-[10000]"
          onClose={closeModal}
          initialFocus={completeButtonRef}
        >
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-200"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black/25" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300"
                enterFrom="opacity-0 scale-95"
                enterTo="opacity-100 scale-100"
                leave="ease-in duration-200"
                leaveFrom="opacity-100 scale-100"
                leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-lg transform overflow-hidden rounded bg-secondary p-6 text-left align-middle shadow-xl transition-all">
                  <Dialog.Title
                    as="h3"
                    className="text-lg font-medium leading-6 text-gray-100"
                  >
                    <div className="flex justify-between items-center gap-2">
                      <p className="text-xl">{t("changelog.title")}</p>
                      <div className="flex gap-2 items-center">
                        {/* Discord Icon */}
                        <Link
                          href="https://discord.gg/CbrFwstYfC"
                          target="_blank"
                          rel="noreferrer"
                          className="w-6 h-6 hover:opacity-75"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            preserveAspectRatio="xMidYMid"
                            viewBox="0 -28.5 256 256"
                          >
                            <path
                              fill="#fff"
                              d="M216.856 16.597A208.502 208.502 0 00164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.4-4.55-9.933-6.846-14.046a207.809 207.809 0 00-52.855 16.638C5.618 67.147-3.443 116.4 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193A161.094 161.094 0 0079.735 175.3a136.413 136.413 0 01-21.846-10.632 108.636 108.636 0 005.356-4.237c42.122 19.702 87.89 19.702 129.51 0a131.66 131.66 0 005.355 4.237 136.07 136.07 0 01-21.886 10.653c4.006 8.02 8.638 15.67 13.873 22.848 21.142-6.58 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.056-148.36zM85.474 135.095c-12.645 0-23.015-11.805-23.015-26.18s10.149-26.2 23.015-26.2c12.867 0 23.236 11.804 23.015 26.2.02 14.375-10.148 26.18-23.015 26.18zm85.051 0c-12.645 0-23.014-11.805-23.014-26.18s10.148-26.2 23.014-26.2c12.867 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18z"
                            ></path>
                          </svg>
                        </Link>
                      </div>
                    </div>
                  </Dialog.Title>
                  <div className="mt-4">
                    <p className="text-sm text-gray-400">{t("changelog.intro")}</p>
                  </div>

                  {/* Title + body come from the per-language popup markdown
                      (CHANGELOG_POPUP.<lang>.md): first line = version (the
                      title), the rest = paragraphs separated by blank lines. */}
                  <ChangelogsVersions
                    notes={null}
                    version={version || ""}
                    pre={true}
                  >
                    {body.split(/\n\s*\n/).map((para, index) => (
                      <p key={index} className="mb-2 last:mb-0">
                        {renderBold(para.replace(/\n/g, " ").trim())}
                      </p>
                    ))}
                  </ChangelogsVersions>

                  <div className="mt-2 text-gray-400 text-sm">
                    <p>{t("changelog.seeFull")}</p>
                  </div>

                  <div className="flex items-center gap-2 mt-4">
                    <div className="flex-1" />
                    <button
                      type="button"
                      className="inline-flex justify-center rounded-md border border-transparent bg-action/10 px-4 py-2 text-sm font-medium text-action/90 hover:bg-action/20 focus:outline-none"
                      onClick={closeModal}
                      ref={completeButtonRef}
                    >
                      {t("changelog.gotIt")}
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </>
  );
}

type ChangelogsVersionsProps = {
  version?: string;
  pre: boolean;
  notes?: string | null;
  highlights?: boolean;
  children: React.ReactNode;
};

export function ChangelogsVersions({
  version,
  pre,
  notes,
  highlights,
  children
}: ChangelogsVersionsProps) {
  return (
    <>
      <div className="my-2 flex items-center gap-2">
        <div className="flex-1 h-[1px] bg-gradient-to-r from-white/5 to-white/40" />
        <p className="relative flex shrink-0 items-center font-bold font-inter text-sm text-center">
          <span>{version}</span>
          {pre && (
            <span className="flex text-xs font-light font-roboto ml-1 italic">
              pre
            </span>
          )}
        </p>
        <div className="flex-1 h-[1px] bg-gradient-to-l from-white/5 to-white/40" />
      </div>

      <div className="flex flex-col gap-2 text-sm py-2 text-gray-200">
        <div>
          {notes && (
            <p className="inline-block italic mb-2 text-gray-400">*{notes}</p>
          )}
          {children}
        </div>
      </div>
    </>
  );
}
