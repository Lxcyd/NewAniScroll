import { Dialog, Transition } from "@headlessui/react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// localStorage key holding the heading of the last release the user has
// already seen. We key off the heading text (e.g. "[2026-06-01] — Public
// Beta") rather than a hardcoded version string, so the popup re-displays
// automatically whenever a new top entry is added to CHANGELOG.md — no
// manual version bump required.
const SEEN_KEY = "changelog-seen";

type ParsedRelease = {
  /** Full heading text, used as the "seen" key, e.g. "[2026-06-01] — Public Beta". */
  heading: string;
  /** Human label shown in the modal (heading with surrounding brackets stripped). */
  title: string;
  /** Intro paragraph(s) directly under the heading, before the first subsection. */
  notes: string | null;
  /** Bullet lines, optionally grouped under "### Added / Changed / Fixed". */
  changes: string[];
};

/**
 * Pull the most-recent release section out of the raw CHANGELOG.md markdown.
 *
 * The changelog uses `# Changelog` for the document title and `## [...]` for
 * each release, so the latest release is the first `##` block. We collect its
 * intro paragraph and every bullet (`-`) until the next `##`.
 */
function parseLatestRelease(md: string): ParsedRelease | null {
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  // Find the first level-2 heading (first release section).
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const heading = lines[start].replace(/^##\s+/, "").trim();
  const title = heading.replace(/^\[/, "").replace(/\]/, "").trim();

  const notesLines: string[] = [];
  const changes: string[] = [];
  let seenBullet = false;

  for (let i = start + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (/^##\s+/.test(trimmed)) break; // next release → stop

    if (!trimmed) continue;
    if (/^###\s+/.test(trimmed)) continue; // skip Added/Changed/Fixed sub-headers

    if (/^[-*]\s+/.test(trimmed)) {
      seenBullet = true;
      // Strip the bullet marker and collapse markdown bold so the plain-text
      // modal reads cleanly.
      changes.push(trimmed.replace(/^[-*]\s+/, "").replace(/\*\*/g, ""));
      continue;
    }

    if (seenBullet) {
      // A non-bullet line after bullets have started is a wrapped
      // continuation of the previous bullet — append it so we don't drop
      // the tail of multi-line entries.
      if (changes.length) {
        changes[changes.length - 1] += " " + trimmed.replace(/\*\*/g, "");
      }
      continue;
    }

    // Non-bullet, non-heading line before the first bullet → intro note.
    notesLines.push(trimmed.replace(/\*\*/g, ""));
  }

  return {
    heading,
    title,
    notes: notesLines.length ? notesLines.join(" ") : null,
    changes,
  };
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
  const { t } = useTranslation();
  let [isOpen, setIsOpen] = useState(false);
  let [release, setRelease] = useState<ParsedRelease | null>(null);
  let completeButtonRef = useRef(null);

  function closeModal() {
    if (release) localStorage.setItem(SEEN_KEY, release.heading);
    setIsOpen(false);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v2/changelog")
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((md) => {
        if (cancelled) return;
        const latest = parseLatestRelease(md);
        if (!latest) return;
        setRelease(latest);
        // Show only if the user hasn't already dismissed this exact release.
        const seen = localStorage.getItem(SEEN_KEY);
        if (seen !== latest.heading) setIsOpen(true);
      })
      .catch(() => {
        /* changelog unavailable — silently skip the popup */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Transition appear show={isOpen} as={Fragment}>
        <Dialog
          as="div"
          className="relative z-50"
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

                  {/* Release content is pulled from the locale files (so it's
                      translated) rather than from the raw CHANGELOG.md. The
                      "seen" trigger above still keys off the file's latest
                      heading so the popup re-displays on every new release. */}
                  <ChangelogsVersions
                    notes={null}
                    version={t("changelog.releaseTitle")}
                    pre={true}
                  >
                    {t("changelog.releaseBody")
                      .split("\n\n")
                      .map((para, index) => (
                        <p key={index} className="mb-2 last:mb-0">
                          {renderBold(para)}
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
