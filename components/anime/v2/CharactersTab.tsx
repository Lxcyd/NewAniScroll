import { CSSProperties } from "react";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import { useTranslation } from "react-i18next";

type Props = { info: AniListInfoTypes };

const ROLE_COLOR: Record<string, string> = {
  MAIN: "#ff7a91",
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
  const edges = info.characters?.edges || [];
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
