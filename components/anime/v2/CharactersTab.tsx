import { CSSProperties, useEffect, useState } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { useTranslation } from "react-i18next";

type Props = { info: AniListInfoTypes };

/* Resolved cast lists, keyed by AniList id, plus in-flight de-duplication.
   Module-level so switching tabs (or navigating away and back client-side)
   re-reads memory instead of the network. */
const MEMO = new Map<number, any>();
const INFLIGHT = new Map<number, Promise<any>>();

function fetchCharacters(id: number): Promise<any> {
  if (MEMO.has(id)) return Promise.resolve(MEMO.get(id));
  const pending = INFLIGHT.get(id);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await fetch(`/api/v2/characters/${id}`);
      if (!res.ok) return null;
      const json = await res.json();
      MEMO.set(id, json?.characters ?? null);
      return json?.characters ?? null;
    } catch {
      // Not memoised: a blip must not pin an empty cast for the session.
      return null;
    } finally {
      INFLIGHT.delete(id);
    }
  })();
  INFLIGHT.set(id, p);
  return p;
}

const ROLE_COLOR: Record<string, string> = {
  MAIN: "var(--accent)",
  SUPPORTING: "#5e6478",
  BACKGROUND: "#5e6478",
};

export default function CharactersTab({ info }: Props) {
  const { t } = useTranslation();
  const roleLabel = (role: string) => {
    const key: Record<string, string> = {
      MAIN: "anime.roleMain",
      SUPPORTING: "anime.roleSupporting",
      BACKGROUND: "anime.roleBackground",
    };
    return key[role] ? t(key[role]) : role;
  };
  /* The cast is no longer part of the SSR payload (it was 11.8 KB of every
     info-page HTML response, for a tab most visitors never open). This body
     only mounts once its tab is selected, so fetching here IS the lazy load.
     `info.characters` is still honoured as a seed so any caller that does have
     it inline renders without a round-trip. */
  const seeded = info.characters ?? null;
  const [characters, setCharacters] = useState<any>(
    seeded ?? (info.id != null ? MEMO.get(info.id) ?? null : null),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (seeded || info.id == null) return;
    if (MEMO.has(info.id)) {
      setCharacters(MEMO.get(info.id));
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchCharacters(info.id).then((res) => {
      if (cancelled) return;
      setCharacters(res);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [info.id, seeded]);

  const edges = characters?.edges || [];
  if (loading && edges.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 10,
          color: "var(--txt-3)",
          fontSize: 13,
        }}
      >
        {t("common.loading")}
      </div>
    );
  }
  if (edges.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          background: "var(--bg-2)",
          border: "1px solid var(--line)",
          borderRadius: 10,
          color: "var(--txt-3)",
          fontSize: 13,
        }}
      >
        {t("anime.noCharacterData")}
      </div>
    );
  }
  return (
    <div style={cStyles.grid}>
      {edges.map((e) => {
        const va = e.voiceActors?.[0];
        const role = (e.role || "").toUpperCase();
        return (
          <div key={e.node.id} style={cStyles.card}>
            <div style={cStyles.img}>
              {e.node.image?.large ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={e.node.image.large}
                  alt={e.node.name.full}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <span className="display" style={cStyles.initial}>
                  {(e.node.name.full || "?")
                    .split(" ")
                    .map((w) => w[0])
                    .join("")
                    .slice(0, 2)}
                </span>
              )}
            </div>
            <div style={cStyles.body}>
              <div
                style={{
                  ...cStyles.role,
                  color: ROLE_COLOR[role] || "var(--txt-3)",
                }}
              >
                {roleLabel(role)}
              </div>
              <div style={cStyles.name}>{e.node.name.full}</div>
              {va && <div style={cStyles.va}>VA · {va.name.full}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const cStyles: Record<string, CSSProperties> = {
  /* auto-fill with a 150px minimum keeps the cards reasonably small on
     wide viewports (~9 columns at 1380px content width) while still
     reflowing to fewer columns on narrower screens — no media queries
     needed. */
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
    gap: 10,
  },
  card: {
    background: "var(--bg-2)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    overflow: "hidden",
  },
  img: {
    aspectRatio: "3/4",
    background: "var(--bg-3)",
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
  },
  initial: {
    fontSize: 28,
    fontWeight: 700,
    color: "rgba(255,255,255,0.65)",
    letterSpacing: "0.02em",
  },
  body: { padding: 8 },
  role: { fontSize: 9, fontWeight: 700, letterSpacing: "0.1em" },
  name: { fontSize: 12, fontWeight: 600, marginTop: 2, color: "var(--txt-0)" },
  va: { fontSize: 10.5, color: "var(--txt-3)", marginTop: 2 },
};
