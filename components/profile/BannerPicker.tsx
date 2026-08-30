import { useEffect, useState } from "react";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import { XMarkIcon, CheckIcon } from "@heroicons/react/24/solid";
import Modal from "@/components/modal";
import type { BannerOption } from "@/lib/profile/banner";

/**
 * "Change the banner" — the owner's override of the automatic pick.
 *
 * Automatic is the default and stays one click away: the rule
 * (lib/profile/favorite.ts) follows a list that keeps moving, so a profile
 * left alone re-dresses itself as its owner's taste changes. Pinning is what
 * freezes it.
 *
 * The gallery for an anime comes from /api/v2/profile-banner, the same shared,
 * edge-cached endpoint the /me profile resolves its plate with — so opening
 * this on your own profile usually costs nothing new.
 */

export type PickerAnime = {
  mediaId: number;
  title: string;
  cover?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** The titles worth offering, best first (the top of the ranked list). */
  animes: PickerAnime[];
  /** URL currently on the plate, to mark the selected tile. */
  current: string | null;
  /** True when the current plate is a manual pick rather than the automatic one. */
  pinned: boolean;
  onPick: (choice: { url: string; animeId: number; title: string }) => void;
  onReset: () => void;
};

export default function BannerPicker({
  open,
  onClose,
  animes,
  current,
  pinned,
  onPick,
  onReset,
}: Props) {
  const { t } = useTranslation();
  const [animeId, setAnimeId] = useState<number | null>(animes[0]?.mediaId ?? null);
  const [options, setOptions] = useState<BannerOption[]>([]);
  const [loading, setLoading] = useState(false);

  // Follow the list when it arrives (the /me profile has none on first render).
  useEffect(() => {
    setAnimeId((prev) =>
      prev != null && animes.some((a) => a.mediaId === prev)
        ? prev
        : animes[0]?.mediaId ?? null,
    );
  }, [animes]);

  useEffect(() => {
    if (!open || animeId == null) return;
    let alive = true;
    setLoading(true);
    fetch(`/api/v2/profile-banner?anime=${animeId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        setOptions(Array.isArray(json?.options) ? json.options : []);
      })
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, animeId]);

  const selected = animes.find((a) => a.mediaId === animeId);

  return (
    <Modal open={open} onClose={onClose}>
      <div className="max-h-[85vh] w-[92vw] max-w-3xl overflow-y-auto rounded-xl bg-secondary p-5 ring-1 ring-white/10">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-outfit text-xl font-bold">
              {t("profile.pickBanner")}
            </h2>
            <p className="mt-1 text-xs text-white/45">
              {t("profile.pickBannerHint")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", { defaultValue: "Close" })}
            className="rounded-lg p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {animes.length === 0 ? (
          <p className="py-10 text-center text-sm text-white/50">
            {t("profile.pickBannerEmpty")}
          </p>
        ) : (
          <>
            {/* Which anime to dress the profile in. */}
            <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-2 scrollbar-hide">
              {animes.map((a) => (
                <button
                  key={a.mediaId}
                  type="button"
                  onClick={() => setAnimeId(a.mediaId)}
                  title={a.title}
                  className={`flex shrink-0 items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-3 text-xs font-medium ring-1 transition-colors ${
                    a.mediaId === animeId
                      ? "bg-action/15 text-white ring-action"
                      : "bg-white/5 text-white/60 ring-white/10 hover:bg-white/10"
                  }`}
                >
                  {a.cover ? (
                    <Image
                      src={a.cover}
                      alt=""
                      width={28}
                      height={38}
                      className="h-9 w-7 rounded object-cover"
                    />
                  ) : null}
                  <span className="max-w-[9rem] truncate">{a.title}</span>
                </button>
              ))}
            </div>

            {loading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="aspect-video animate-pulse rounded-lg bg-white/5"
                  />
                ))}
              </div>
            ) : options.length === 0 ? (
              <p className="py-10 text-center text-sm text-white/50">
                {t("profile.pickBannerNoArt")}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {options.map((o) => {
                  const isCurrent = o.url === current;
                  return (
                    <button
                      key={o.url}
                      type="button"
                      onClick={() =>
                        selected &&
                        onPick({
                          url: o.url,
                          animeId: selected.mediaId,
                          title: selected.title,
                        })
                      }
                      className={`group relative aspect-video overflow-hidden rounded-lg ring-1 transition-transform hover:scale-[1.02] ${
                        isCurrent ? "ring-2 ring-action" : "ring-white/10"
                      }`}
                    >
                      <Image
                        src={o.url}
                        alt=""
                        fill
                        sizes="(max-width: 640px) 45vw, 30vw"
                        className={`object-cover ${
                          o.source === "cover" ? "scale-125 blur-md" : ""
                        }`}
                      />
                      {isCurrent ? (
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-action p-1 text-white">
                          <CheckIcon className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                      {o.likes > 0 ? (
                        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white/80 backdrop-blur-sm">
                          ♥ {o.likes}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
          <p className="text-[11px] text-white/40">
            {pinned ? t("profile.bannerPinned") : t("profile.bannerAuto")}
          </p>
          <button
            type="button"
            onClick={onReset}
            disabled={!pinned}
            className="rounded-lg px-3 py-1.5 text-xs font-bold ring-1 ring-white/15 transition-colors hover:bg-white/10 disabled:opacity-35 disabled:hover:bg-transparent"
          >
            {t("profile.bannerReset")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
