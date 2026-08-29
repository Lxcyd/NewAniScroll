import { Dialog, Transition } from "@headlessui/react";
import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// localStorage key holding the set of changelog SIGNATURES the user has already
// dismissed. The popup's content lives in its own per-language markdown files
// (changelog/popup.fr.md / popup.en.md), served by /api/v2/changelog-popup.
//
// The auto-display trigger is a content hash of the whole file, NOT just the
// version line. So ANY edit to a popup file — fixing a typo, adding a line,
// bumping the version — re-shows the popup to returning visitors. You no longer
// have to bump the version to make a change visible. (Previously this keyed off
// the version string alone, so editing the body without bumping the version
// left returning users seeing nothing.)
//
// We store a *set* of dismissed signatures (one per content the user closed),
// so switching UI language shows that language's text once, then both stay
// dismissed. (The full CHANGELOG.md + its navbar button are separate.)
const SEEN_KEY = "changelog-seen-signatures";

/** Tiny stable string hash (djb2 → unsigned base36). Detects "file changed". */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Parse a popup.*.md: first line = version, then optional `---`, then the body
 *  (paragraphs separated by blank lines). `sig` is a content hash of the whole
 *  normalised file — the auto-display trigger. */
function parsePopup(
  md: string,
): { version: string; body: string; sig: string } | null {
  const text = md.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  // Hash the whole normalised file so any change (not only the version line)
  // re-triggers the popup.
  const sig = hashStr(text);
  const lines = text.split("\n");
  // First line is the version. Tolerate a leading markdown heading marker
  // (`#`, `##`, …) so the file reads nicely on its own and an edit like
  // "## v0.0.2" doesn't leak the hashes into the version / title.
  const version = (lines.shift() || "").replace(/^#+\s*/, "").trim();
  if (!version) return null;
  // Drop a leading `---` separator if present (optional).
  if ((lines[0] || "").trim() === "---") lines.shift();
  const body = lines.join("\n").trim();
  return { version, body, sig };
}

/** Read the dismissed-signature set from localStorage (comma-separated). */
function readSeenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? raw.split(",").filter(Boolean) : []);
  } catch {
    return new Set();
  }
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

/* Les deux popups de la release, demandes UNE fois par onglet.
 *
 * Ce composant se remonte a chaque navigation et son effet se rejoue a chaque
 * changement de langue ; sans cette memoire, chaque page de lecture partait en
 * quatre requetes pour deux fichiers markdown identiques (mesure : 4x
 * `/api/v2/changelog-popup` sur un seul chargement). Elles arrivaient toutes en
 * HIT au CDN, donc invisibles — mais quatre allers-retours pour un contenu qui
 * ne change qu'a la release, c'est quatre de trop.
 *
 * La promesse est mise en cache, pas seulement le resultat : deux montages
 * simultanes partagent le meme vol au lieu d'en lancer deux.
 *
 * Ce que ca coute : une release publiee pendant qu'un onglet est ouvert n'y
 * apparait qu'au rechargement. C'etait deja vrai a la minute pres (la route a
 * son propre `s-maxage`), et le popup se congedie par signature, donc une
 * arrivee tardive ne fait rien perdre. */
let popupsEnVol: Promise<{ l: string; parsed: PopupParse }[]> | null = null;

type PopupParse = ReturnType<typeof parsePopup>;

function chargePopups(): Promise<{ l: string; parsed: PopupParse }[]> {
  if (popupsEnVol) return popupsEnVol;
  const LANGS = ["en", "fr"] as const;
  popupsEnVol = Promise.all(
    LANGS.map((l) =>
      /* No cache-buster, no no-store: a unique `t=` made every one of these a
         fresh function invocation for a static markdown file — the CDN could
         never serve it. The route's own s-maxage handles freshness. */
      fetch(`/api/v2/changelog-popup?lang=${l}`)
        .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
        .then((md) => ({ l: l as string, parsed: parsePopup(md) }))
        .catch(() => ({ l: l as string, parsed: null })),
    ),
  ).catch((e) => {
    // Un echec ne doit pas figer le cache sur une promesse rejetee : le prochain
    // montage a le droit de reessayer.
    popupsEnVol = null;
    throw e;
  });
  return popupsEnVol;
}

export default function ChangeLogs() {
  const { t, i18n } = useTranslation();
  let [isOpen, setIsOpen] = useState(false);
  let [version, setVersion] = useState<string | null>(null);
  let [body, setBody] = useState<string>("");
  // Content signature of the currently-shown popup, used to record dismissal.
  let [sig, setSig] = useState<string | null>(null);
  let completeButtonRef = useRef(null);
  // Signatures of THIS release across every language (en + fr). Dismissing in
  // one language records all of them, so switching UI language afterwards does
  // NOT re-show the same release's popup in the other language. We still key off
  // a content hash per language (so editing a popup file re-triggers it), but a
  // single dismiss covers the whole release. See SEEN_KEY notes above.
  const allSigsRef = useRef<Set<string>>(new Set());

  const lang = i18n.language?.startsWith("fr") ? "fr" : "en";

  function markSeen(sigs: string[]) {
    try {
      const seen = readSeenSet();
      for (const s of sigs) if (s) seen.add(s);
      localStorage.setItem(SEEN_KEY, Array.from(seen).join(","));
    } catch {
      /* storage unavailable — popup will just show again next load */
    }
  }

  function closeModal() {
    // Record every language's signature for this release, not just the one
    // currently shown, so a language switch doesn't re-open it.
    const sigs = Array.from(allSigsRef.current);
    if (sig) sigs.push(sig);
    markSeen(sigs);
    setIsOpen(false);
  }

  // Load EVERY language's popup once on mount to collect all signatures for the
  // current release. This lets a single dismiss cover all languages, and lets
  // us decide visibility against the active language's content.
  useEffect(() => {
    let cancelled = false;
    chargePopups().then((results) => {
      if (cancelled) return;
      const sigs = new Set<string>();
      let active: ReturnType<typeof parsePopup> = null;
      for (const { l, parsed } of results) {
        if (parsed) {
          sigs.add(parsed.sig);
          if (l === lang) active = parsed;
        }
      }
      allSigsRef.current = sigs;
      if (active) {
        setVersion(active.version);
        setBody(active.body);
        setSig(active.sig);
      }
      // Show only if NONE of this release's signatures have been dismissed yet.
      const seen = readSeenSet();
      const alreadySeen = Array.from(sigs).some((s) => seen.has(s));
      if (active && !alreadySeen) setIsOpen(true);
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
