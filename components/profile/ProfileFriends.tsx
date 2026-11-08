import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  FRIENDS_EVENT,
  friendAction,
  friendsOf,
  myFriends,
  searchPeople,
  watchFriends,
  type FriendCard,
  type FriendState,
} from "@/lib/friends/client";
import { FriendErrorNote } from "./FriendButton";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * L'ONGLET AMIS (03/11/2026, Luc : « fais un tab amis et tout ce qu'il faut »,
 * puis « l'interface est vraiment moche » — refaite le même jour).
 *
 * UNE SEULE CARTE, comme un widget : un en-tête (titre, compte, recherche et
 * identifiant à partager), les demandes reçues mises en avant, la grille des
 * amis classés par affinité, les demandes envoyées en pied. Chez un autre :
 * l'en-tête et la grille de ses amis.
 */
export default function ProfileFriends({
  isOwner,
  tag,
  name,
  entries,
}: {
  isOwner: boolean;
  tag: string | null;
  name: string;
  entries: ProfileEntry[];
}) {
  const { t } = useTranslation();
  if (!tag)
    return (
      <Shell title={t("profile.friends.title")}>
        <EmptyState title={t("profile.friends.title")} text={t("profile.friends.noAccount")} />
      </Shell>
    );
  return isOwner ? <Mine tag={tag} name={name} entries={entries} /> : <Theirs tag={tag} name={name} />;
}

/* ── Chez soi ─────────────────────────────────────────────────────────────── */

function Mine({ tag, name, entries }: { tag: string; name: string; entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Awaited<ReturnType<typeof myFriends>>>(null);
  const [loaded, setLoaded] = useState(false);
  /* « Ajouter un ami » ouvre une fenêtre de recherche (03/11/2026, Luc :
     « plus logique qu'un menu où l'on cherche quelqu'un »). */
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void myFriends().then((d) => {
        if (!alive) return;
        if (d) setData(d); // un échec réseau ne vide pas la liste affichée
        setLoaded(true);
      });
    const stop = watchFriends(load);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  /* Pas d'affinité dans l'onglet (08/11/2026, Luc : « juste avatar, nom ») :
     les amis par ordre alphabétique. */
  const friends = useMemo(
    () => (data?.friends ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );

  return (
    <Shell
      title={t("profile.friends.title")}
      count={loaded ? friends.length : undefined}
      tools={
        <>
          <AddButton onClick={() => setAdding(true)} />
          <CopyId tag={tag} name={name} />
        </>
      }
    >
      <FriendErrorNote />
      {data?.incoming.length ? (
        <Group label={t("profile.friends.incoming")} count={data.incoming.length} accent>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {data.incoming.map((c) => (
              <Request key={c.tag} card={c} />
            ))}
          </div>
        </Group>
      ) : null}

      {!loaded ? (
        <Grid>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-white/[0.05]" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </Grid>
      ) : friends.length ? (
        <Group label={data?.incoming.length ? t("profile.friends.mine") : null}>
          <Grid>
            {friends.map((c, i) => (
              <Friend key={c.tag} card={c} index={i} removable />
            ))}
          </Grid>
        </Group>
      ) : (
        <EmptyState
          title={t("profile.friends.emptyTitle")}
          text={t("profile.friends.noneOwner")}
          action={
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="rounded-full bg-action px-5 py-2.5 font-karla text-[13px] font-bold text-white shadow-glow transition-transform hover:scale-105"
            >
              {t("profile.friends.add")}
            </button>
          }
        />
      )}

      {data?.outgoing.length ? (
        <Group label={t("profile.friends.outgoing")} count={data.outgoing.length}>
          <div className="flex flex-wrap gap-2">
            {data.outgoing.map((c) => (
              <Pending key={c.tag} card={c} />
            ))}
          </div>
        </Group>
      ) : null}
      {adding ? <AddDialog onClose={() => setAdding(false)} /> : null}
    </Shell>
  );
}

/* ── Chez un autre ────────────────────────────────────────────────────────── */

function Theirs({ tag, name }: { tag: string; name: string }) {
  const { t } = useTranslation();
  const [list, setList] = useState<FriendCard[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void friendsOf(tag).then((f) => {
        if (alive) setList(f);
      });
    const stop = watchFriends(load, 60_000);
    return () => {
      alive = false;
      stop();
    };
  }, [tag]);
  return (
    <Shell title={t("profile.friends.theirs", { name })} count={list?.length}>
      {list == null ? (
        <Grid>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[72px] animate-pulse rounded-2xl bg-white/[0.05]" />
          ))}
        </Grid>
      ) : list.length ? (
        <Grid>
          {list.map((c, i) => (
            <Friend key={c.tag} card={c} index={i} />
          ))}
        </Grid>
      ) : (
        <EmptyState title={t("profile.friends.emptyTitle")} text={t("profile.friends.theirsNone", { name })} />
      )}
    </Shell>
  );
}

/* ── La carte et ses morceaux ─────────────────────────────────────────────── */

function Shell({
  title,
  count,
  tools,
  children,
}: {
  title: string;
  count?: number;
  tools?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="as-stat-card rounded-[20px] px-5 py-5 ring-1 ring-white/10 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-action" style={{ background: "color-mix(in srgb, var(--brand-primary, #E94560) 16%, transparent)" }}>
            <PeopleIcon className="h-5 w-5" />
          </span>
          <h2 className="truncate font-outfit text-[18px] font-bold text-white">{title}</h2>
          {count != null ? (
            <span className="rounded-full bg-white/[0.07] px-2.5 py-0.5 font-karla text-[12px] font-bold tabular-nums text-white/60">
              {count}
            </span>
          ) : null}
        </div>
        {tools ? <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{tools}</div> : null}
      </header>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  );
}

function Group({
  label,
  count,
  accent = false,
  children,
}: {
  label: string | null;
  count?: number;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      {label ? (
        <p
          className={`mb-2.5 flex items-center gap-2 font-karla text-[11px] font-bold uppercase tracking-[.1em] ${
            accent ? "text-action" : "text-white/45"
          }`}
        >
          {accent ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-action" /> : null}
          {label}
          {count != null ? <span className="tabular-nums opacity-70">{count}</span> : null}
          <span className="h-px flex-1 bg-white/[0.07]" />
        </p>
      ) : null}
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

/** Un ami : avatar, nom, identifiant. */
function Friend({ card, index, removable = false }: { card: FriendCard; index: number; removable?: boolean }) {
  return (
    <div
      className="as-swap-row group relative rounded-2xl bg-white/[0.035] ring-1 ring-white/[0.07] transition-[background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:bg-white/[0.06] hover:ring-white/15"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
    >
      <Link href={card.href} className="flex min-w-0 items-center gap-3 p-3 pr-9">
        <Avatar card={card} size={48} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-outfit text-[19px] font-bold leading-tight text-white">{card.name}</span>
          <span className="mt-0.5 block font-karla text-[11px] text-white/35">#{card.tag}</span>
        </span>
      </Link>
      {removable ? <RemoveFriend tag={card.tag} /> : null}
    </div>
  );
}

/** Une demande reçue : mise en avant, deux boutons. */
function Request({ card }: { card: FriendCard }) {
  const { t } = useTranslation();
  return (
    <div
      className="as-swap-row flex min-w-0 items-center gap-3 rounded-2xl p-3"
      style={{
        background: "color-mix(in srgb, var(--brand-primary, #E94560) 9%, transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) 30%, transparent)",
      }}
    >
      <Link href={card.href} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar card={card} size={44} />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-white">{card.name}</span>
          <span className="block font-karla text-[11px] text-white/45">{t("profile.friends.wantsYou")}</span>
        </span>
      </Link>
      <div className="flex shrink-0 items-center gap-1.5">
        <ActionButton tag={card.tag} action="accept" primary label={t("profile.friends.accept")} />
        <IconAction tag={card.tag} action="remove" label={t("profile.friends.decline")} />
      </div>
    </div>
  );
}

/** Une demande envoyée : une pastille, annulable. */
function Pending({ card }: { card: FriendCard }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-2 rounded-full bg-white/[0.04] py-1 pl-1 pr-1.5 ring-1 ring-white/[0.07]">
      <Avatar card={card} size={26} />
      <Link href={card.href} className="max-w-[10rem] truncate font-karla text-[12px] font-semibold text-white/75 hover:text-white">
        {card.name}
      </Link>
      <IconAction tag={card.tag} action="remove" label={t("profile.friends.cancel")} small />
    </span>
  );
}

/* ── Ajouter un ami : un bouton, une fenêtre de recherche ── */

function AddButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-full bg-action py-2 pl-3 pr-4 font-karla text-[13px] font-bold text-white shadow-glow transition-transform hover:scale-105"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
        <path d="M19 8v6M16 11h6" />
      </svg>
      {t("profile.friends.add")}
    </button>
  );
}

function AddDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<(FriendCard & { state: FriendState | "none" })[] | null>(null);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const [tick, setTick] = useState(0);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setRes(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const n = ++seq.current;
    const id = setTimeout(() => {
      void searchPeople(text).then((r) => {
        if (n !== seq.current) return;
        setRes(r);
        setSearching(false);
      });
    }, 250);
    return () => clearTimeout(id);
  }, [q, tick]);
  /* Après une action, les états des résultats se relisent. */
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener(FRIENDS_EVENT, again);
    return () => window.removeEventListener(FRIENDS_EVENT, again);
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={`fixed inset-0 z-[10060] flex items-start justify-center px-4 pt-[12vh] transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("profile.friends.add")}
    >
      <button
        type="button"
        aria-label={t("common.close", { defaultValue: "Close" })}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
      />
      <div
        className={`relative w-full max-w-md overflow-hidden rounded-[22px] bg-[#15161d] shadow-[0_28px_80px_rgba(0,0,0,.7)] ring-1 ring-white/10 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          shown ? "translate-y-0 scale-100" : "translate-y-3 scale-[0.98]"
        }`}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <h3 className="font-outfit text-[18px] font-bold text-white">{t("profile.friends.add")}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", { defaultValue: "Close" })}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="h-4 w-4">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="px-5">
          <div className="relative">
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/40">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className="h-[18px] w-[18px]">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            </span>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("profile.friends.searchPlaceholder")}
              className="w-full rounded-2xl bg-white/[0.05] py-3 pl-11 pr-10 font-karla text-[15px] text-white outline-none ring-1 ring-white/10 transition-shadow placeholder:text-white/35 focus:ring-2 focus:ring-white/25"
            />
            {searching ? (
              <span className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-white/15 border-t-white/70" />
            ) : null}
          </div>
        </div>

        <div className="px-5 pt-2 empty:hidden">
          <FriendErrorNote />
        </div>
        <div className="as-scroller max-h-[46vh] min-h-[7rem] overflow-y-auto px-3 py-3">
          {res == null ? (
            <p className="px-3 py-6 text-center font-karla text-[13px] leading-relaxed text-white/45">{t("profile.friends.searchHint")}</p>
          ) : res.length ? (
            res.map((c) => (
              <div key={c.tag} className="as-swap-row flex items-center gap-3 rounded-2xl p-2.5 hover:bg-white/[0.05]">
                <Link href={c.href} onClick={onClose} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar card={c} size={40} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold text-white">{c.name}</span>
                    <span className="block font-karla text-[11px] text-white/35">#{c.tag}</span>
                  </span>
                </Link>
                {c.state === "friend" ? (
                  <span className="px-2 font-karla text-[12px] font-bold text-white/45">{t("profile.friends.already")}</span>
                ) : c.state === "out" ? (
                  <ActionButton tag={c.tag} action="remove" label={t("profile.friends.cancel")} />
                ) : c.state === "in" ? (
                  <ActionButton tag={c.tag} action="accept" primary label={t("profile.friends.accept")} />
                ) : (
                  <ActionButton tag={c.tag} action="request" primary label={t("profile.friends.requestShort")} />
                )}
              </div>
            ))
          ) : (
            <p className="px-3 py-6 text-center font-karla text-[13px] text-white/45">{t("profile.friends.noResult")}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Briques ── */

function Avatar({ card, size }: { card: FriendCard; size: number }) {
  return card.avatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={card.avatar}
      alt=""
      className="shrink-0 rounded-full object-cover ring-2 ring-white/10"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-white/[0.14] to-white/[0.04] font-outfit font-bold text-white ring-2 ring-white/10"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {card.name.charAt(0).toUpperCase()}
    </span>
  );
}

function ActionButton({
  tag,
  action,
  label,
  primary = false,
}: {
  tag: string;
  action: "request" | "accept" | "remove";
  label: string;
  primary?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await friendAction(tag, action);
        setBusy(false);
      }}
      className={`shrink-0 rounded-full px-3.5 py-1.5 font-karla text-[12px] font-bold transition-[filter,background-color,color] disabled:opacity-50 ${
        primary ? "bg-action text-white hover:brightness-110" : "bg-white/[0.07] text-white/75 ring-1 ring-white/10 hover:bg-white/[0.12] hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

/** Un ✕ rond (refuser, annuler). */
function IconAction({ tag, action, label, small = false }: { tag: string; action: "remove"; label: string; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await friendAction(tag, action);
        setBusy(false);
      }}
      className={`flex shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/[0.1] hover:text-white disabled:opacity-50 ${
        small ? "h-6 w-6" : "h-8 w-8 bg-white/[0.05] ring-1 ring-white/10"
      }`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className={small ? "h-3 w-3" : "h-3.5 w-3.5"}>
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

/** Retirer un ami : un ✕ au survol de la carte, puis une confirmation. */
function RemoveFriend({ tag }: { tag: string }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      aria-label={t("profile.friends.remove")}
      title={t("profile.friends.remove")}
      disabled={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        await friendAction(tag, "remove");
        setBusy(false);
      }}
      className={`absolute right-2 top-2 flex h-6 items-center justify-center rounded-full font-karla text-[11px] font-bold transition-[opacity,background-color,color,width] ${
        armed
          ? "bg-action px-2.5 text-white opacity-100"
          : "w-6 text-white/40 opacity-0 hover:bg-white/[0.1] hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
      }`}
    >
      {armed ? (
        t("profile.friends.confirmRemove")
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" className="h-3 w-3">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      )}
    </button>
  );
}

/** Son identifiant, en pastille : un clic le copie. */
function CopyId({ tag, name }: { tag: string; name: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={t("profile.friends.myIdHint")}
      onClick={() => {
        void navigator.clipboard?.writeText(`${name}#${tag}`).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="flex shrink-0 items-center gap-2 rounded-full bg-white/[0.06] py-2 pl-3.5 pr-3 ring-1 ring-white/10 transition-colors hover:bg-white/[0.1]"
    >
      <span className="font-karla text-[12px] text-white/50">{t("profile.friends.myId")}</span>
      <span className="font-outfit text-[13px] font-bold tabular-nums text-white">#{tag}</span>
      <span className={`transition-colors ${done ? "text-emerald-400" : "text-white/45"}`}>
        {done ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <path d="m5 12 5 5 9-10" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </span>
    </button>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.05] text-white/40 ring-1 ring-white/[0.08]">
        <PeopleIcon className="h-8 w-8" />
      </span>
      <p className="font-outfit text-[16px] font-bold text-white">{title}</p>
      <p className="max-w-sm font-karla text-[13px] leading-relaxed text-white/50">{text}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

function PeopleIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
      <path d="M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </svg>
  );
}
