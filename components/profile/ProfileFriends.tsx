import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FRIENDS_EVENT,
  friendAction,
  friendTastes,
  friendsOf,
  myFriends,
  searchPeople,
  type FriendCard,
  type FriendState,
} from "@/lib/friends/client";
import { affinity, tasteOf } from "@/lib/profile/affinity";
import type { ProfileEntry } from "@/lib/profile/types";

/**
 * L'ONGLET AMIS (03/11/2026, Luc : « fais un tab amis et tout ce qu'il faut »).
 *
 * Chez soi : chercher quelqu'un, les demandes reçues, ses amis (avec l'affinité
 * de goûts), les demandes envoyées, et son identifiant à partager. Chez un
 * autre : ses amis. Réciproques, sur demande acceptée ; les invités n'en ont
 * pas (lib/auth/friends.ts).
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
  if (!tag) return <Card title={t("profile.friends.title")}>{<Empty text={t("profile.friends.noAccount")} />}</Card>;
  return isOwner ? <Mine tag={tag} name={name} entries={entries} /> : <Theirs tag={tag} name={name} />;
}

function Mine({ tag, name, entries }: { tag: string; name: string; entries: ProfileEntry[] }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Awaited<ReturnType<typeof myFriends>>>(null);
  const [tastes, setTastes] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void myFriends().then((d) => {
        if (!alive) return;
        setData(d);
        setLoaded(true);
      });
      void friendTastes().then((f) => {
        if (!alive || !f || !entries.length) return;
        const me = tasteOf(entries);
        setTastes(new Map(f.map((x) => [x.tag, affinity(me, x.taste).pct])));
      });
    };
    load();
    window.addEventListener(FRIENDS_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FRIENDS_EVENT, load);
    };
  }, [entries]);

  const friends = useMemo(
    () =>
      (data?.friends ?? [])
        .slice()
        .sort((a, b) => (tastes.get(b.tag) ?? -1) - (tastes.get(a.tag) ?? -1) || a.name.localeCompare(b.name)),
    [data, tastes],
  );

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-5">
        {data?.incoming.length ? (
          <Card title={t("profile.friends.incoming")} count={data.incoming.length}>
            <div className="grid gap-2 sm:grid-cols-2">
              {data.incoming.map((c) => (
                <Person key={c.tag} card={c}>
                  <ActionButton tag={c.tag} action="accept" primary label={t("profile.friends.accept")} />
                  <ActionButton tag={c.tag} action="remove" label={t("profile.friends.decline")} />
                </Person>
              ))}
            </div>
          </Card>
        ) : null}

        <Card title={t("profile.friends.mine")} count={loaded ? friends.length : undefined}>
          {!loaded ? (
            <Skeleton />
          ) : friends.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {friends.map((c) => (
                <Person key={c.tag} card={c} pct={tastes.get(c.tag)}>
                  <RemoveFriend tag={c.tag} />
                </Person>
              ))}
            </div>
          ) : (
            <Empty text={t("profile.friends.none")} />
          )}
        </Card>

        {data?.outgoing.length ? (
          <Card title={t("profile.friends.outgoing")} count={data.outgoing.length}>
            <div className="grid gap-2 sm:grid-cols-2">
              {data.outgoing.map((c) => (
                <Person key={c.tag} card={c}>
                  <ActionButton tag={c.tag} action="remove" label={t("profile.friends.cancel")} />
                </Person>
              ))}
            </div>
          </Card>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-5">
        <Search />
        <Card title={t("profile.friends.myId")}>
          <p className="mb-3 font-karla text-[13px] text-txt">{t("profile.friends.myIdHint")}</p>
          <CopyId text={`${name}#${tag}`} />
        </Card>
      </div>
    </div>
  );
}

function Theirs({ tag, name }: { tag: string; name: string }) {
  const { t } = useTranslation();
  const [list, setList] = useState<FriendCard[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void friendsOf(tag).then((f) => {
        if (alive) setList(f);
      });
    load();
    window.addEventListener(FRIENDS_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(FRIENDS_EVENT, load);
    };
  }, [tag]);
  return (
    <Card title={t("profile.friends.theirs", { name })} count={list?.length}>
      {list == null ? (
        <Skeleton />
      ) : list.length ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <Person key={c.tag} card={c} />
          ))}
        </div>
      ) : (
        <Empty text={t("profile.friends.theirsNone", { name })} />
      )}
    </Card>
  );
}

/* ── Chercher quelqu'un ── */
function Search() {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<(FriendCard & { state: FriendState | "none" })[] | null>(null);
  const seq = useRef(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setRes(null);
      return;
    }
    const n = ++seq.current;
    const id = setTimeout(() => {
      void searchPeople(text).then((r) => {
        if (n === seq.current) setRes(r);
      });
    }, 250);
    return () => clearTimeout(id);
  }, [q, tick]);
  /* Après une action, la recherche relit les états. */
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    window.addEventListener(FRIENDS_EVENT, again);
    return () => window.removeEventListener(FRIENDS_EVENT, again);
  }, []);
  return (
    <Card title={t("profile.friends.add")}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("profile.friends.searchPlaceholder")}
        className="w-full rounded-xl bg-black/30 px-3.5 py-2.5 font-karla text-[14px] text-white outline-none ring-1 ring-white/10 placeholder:text-white/35 focus:ring-white/30"
      />
      {res ? (
        <div className="mt-3 flex flex-col gap-2">
          {res.length ? (
            res.map((c) => (
              <Person key={c.tag} card={c} compact>
                {c.state === "friend" ? (
                  <span className="font-karla text-[12px] font-bold text-white/50">{t("profile.friends.already")}</span>
                ) : c.state === "out" ? (
                  <ActionButton tag={c.tag} action="remove" label={t("profile.friends.cancel")} />
                ) : c.state === "in" ? (
                  <ActionButton tag={c.tag} action="accept" primary label={t("profile.friends.accept")} />
                ) : (
                  <ActionButton tag={c.tag} action="request" primary label={t("profile.friends.request")} />
                )}
              </Person>
            ))
          ) : (
            <p className="px-1 font-karla text-[13px] text-white/45">{t("profile.friends.noResult")}</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

/* ── Briques ── */

function Card({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="as-stat-card rounded-[20px] px-5 py-5 ring-1 ring-white/10">
      <h2 className="mb-4 flex items-baseline gap-2 font-outfit text-[15px] font-bold text-white">
        {title}
        {count != null ? <span className="font-karla text-[13px] font-semibold text-white/40">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Person({
  card,
  pct,
  compact = false,
  children,
}: {
  card: FriendCard;
  pct?: number;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl bg-white/[0.04] p-2.5 ring-1 ring-white/[0.06] transition-colors hover:bg-white/[0.06]">
      <Link href={card.href} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar card={card} size={compact ? 36 : 44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-white">{card.name}</span>
          {pct != null ? (
            <span className="mt-1 flex items-center gap-2" title={t("profile.friends.affinityTitle")}>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.09]">
                <span className="block h-full rounded-full bg-action" style={{ width: `${pct}%` }} />
              </span>
              <span className="font-outfit text-[12px] font-bold tabular-nums text-white">{pct}%</span>
            </span>
          ) : (
            <span className="block truncate font-karla text-[11px] text-white/40">#{card.tag}</span>
          )}
        </span>
      </Link>
      {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
    </div>
  );
}

function Avatar({ card, size }: { card: FriendCard; size: number }) {
  return card.avatar ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={card.avatar} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-outfit font-bold text-white"
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
      className={`rounded-full px-3.5 py-1.5 font-karla text-[12px] font-bold transition-colors disabled:opacity-50 ${
        primary ? "bg-action text-white hover:brightness-110" : "bg-white/[0.07] text-white/75 ring-1 ring-white/10 hover:bg-white/[0.12] hover:text-white"
      }`}
    >
      {label}
    </button>
  );
}

/** Retirer un ami : un premier clic demande confirmation. */
function RemoveFriend({ tag }: { tag: string }) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  if (armed) return <ActionButton tag={tag} action="remove" label={t("profile.friends.confirmRemove")} />;
  return (
    <button
      type="button"
      aria-label={t("profile.friends.remove")}
      title={t("profile.friends.remove")}
      onClick={() => setArmed(true)}
      className="flex h-8 w-8 items-center justify-center rounded-full text-white/35 transition-colors hover:bg-white/[0.08] hover:text-white"
    >
      ✕
    </button>
  );
}

function CopyId({ text }: { text: string }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="flex w-full items-center justify-between gap-3 rounded-xl bg-black/30 px-3.5 py-2.5 text-left ring-1 ring-white/10 transition-colors hover:ring-white/25"
    >
      <span className="truncate font-outfit text-[15px] font-bold text-white">{text}</span>
      <span className="shrink-0 font-karla text-[12px] font-bold text-white/55">
        {done ? t("profile.friends.copied") : t("profile.friends.copy")}
      </span>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center font-karla text-[14px] text-white/45">{text}</p>;
}

function Skeleton() {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[66px] animate-pulse rounded-2xl bg-white/[0.05]" />
      ))}
    </div>
  );
}
