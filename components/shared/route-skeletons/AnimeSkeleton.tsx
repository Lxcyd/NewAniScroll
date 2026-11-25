import { Bone } from "./Bone";

/*
 * LA FICHE ANIME, EN APERÇU REMPLI (25/11/2026, Luc).
 *
 * Le squelette gris de la fiche avait ete retire le 18/09 (« ca fait
 * bizarre ») : il remplacait une page connue par des blocs vides. Celui-ci
 * peint ce que la session sait DEJA du titre (la carte survolee, la carte
 * touchee, le payload de la page de lecture) a la place exacte ou la fiche le
 * peindra — banniere, couverture, titre, genres — et ne grise que le reste.
 *
 * Les cotes sont celles de Hero.tsx (hStyles) et de InfoPageMobile (MHero) :
 * a l'arrivee de la page, rien ne bouge, le gris se remplit. La banniere est la
 * meme image : la carte de survol passe par le meme resolveHeroBanner que le
 * SSR de la fiche (lib/images/heroBanner.ts), et l'a deja dans le cache HTTP.
 */

export type AnimePeek = {
  title: string | null;
  banner: string | null;
  cover: string | null;
  genres: string[];
};

const FADE_DESKTOP =
  "linear-gradient(180deg, rgba(12,13,16,0) 0%, rgba(12,13,16,0.06) 22%, rgba(12,13,16,0.16) 40%, rgba(12,13,16,0.34) 56%, rgba(12,13,16,0.58) 70%, rgba(12,13,16,0.82) 84%, #0c0d10 100%)";
const FADE_MOBILE =
  "linear-gradient(180deg, rgba(10,11,16,0) 0%, rgba(10,11,16,0.06) 22%, rgba(10,11,16,0.16) 40%, rgba(10,11,16,0.34) 56%, rgba(10,11,16,0.58) 70%, rgba(10,11,16,0.82) 84%, #0a0b10 100%)";

function Banner({ src, height, position, fade }: { src: string | null; height: number; position: string; fade: string }) {
  return (
    <div style={{ position: "relative", width: "100%", height, overflow: "hidden" }}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: position }}
        />
      ) : (
        <Bone className="absolute inset-0 !rounded-none" />
      )}
      <div style={{ position: "absolute", inset: 0, background: fade }} />
    </div>
  );
}

function Genres({ genres, center = true }: { genres: string[]; center?: boolean }) {
  if (!genres.length) {
    return (
      <div style={{ display: "flex", gap: 8, justifyContent: center ? "center" : "flex-start" }}>
        {[64, 80, 58].map((w, i) => (
          <Bone key={i} className="!rounded-full" style={{ width: w, height: 26 }} delay={i * 60} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: center ? "center" : "flex-start" }}>
      {genres.slice(0, 5).map((g) => (
        <span
          key={g}
          style={{
            padding: "5px 11px",
            background: "color-mix(in srgb, var(--brand-primary, #ff3b5c) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--brand-primary, #ff3b5c) 35%, transparent)",
            borderRadius: 999,
            color: "color-mix(in srgb, var(--brand-primary, #ff7a91) 75%, #fff)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {g}
        </span>
      ))}
    </div>
  );
}

function Desktop({ peek }: { peek: AnimePeek }) {
  return (
    <div style={{ background: "#0c0d10", minHeight: "100%" }}>
      <Banner src={peek.banner || peek.cover} height={360} position="center 35%" fade={FADE_DESKTOP} />
      <div style={{ maxWidth: 1380, margin: "-240px auto 0", padding: "0 28px 36px", position: "relative", zIndex: 2 }}>
        <div style={{ display: "grid", gridTemplateColumns: "240px minmax(0,1fr) auto", columnGap: 32 }}>
          {/* COL 1 — couverture + bouton Regarder */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {peek.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={peek.cover}
                alt=""
                style={{
                  width: 240,
                  aspectRatio: "2 / 3",
                  objectFit: "cover",
                  display: "block",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.1)",
                  boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
                }}
              />
            ) : (
              <Bone style={{ width: 240, aspectRatio: "2 / 3", borderRadius: 12 }} />
            )}
            <Bone style={{ width: "100%", height: 70, borderRadius: 12 }} />
          </div>

          {/* COL 2 — titre, chiffres, genres */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18, alignItems: "center", textAlign: "center", paddingTop: 75, minWidth: 0 }}>
            {/* La place du logo-titre (Hero : maxHeight 300, marginTop -40) :
                sans elle, chiffres et genres remontaient de ~200 px et
                sautaient a l'arrivee de la page. */}
            <div style={{ minHeight: 280, marginTop: -40, display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
            {peek.title ? (
              <h1
                style={{
                  fontSize: 56,
                  fontWeight: 800,
                  margin: 0,
                  color: "#fff",
                  letterSpacing: "-0.02em",
                  textShadow: "0 14px 36px rgba(0,0,0,0.7)",
                  fontFamily: "Space Grotesk, Inter, sans-serif",
                  lineHeight: 1.1,
                  maxWidth: "100%",
                }}
                className="line-clamp-2"
              >
                {peek.title}
              </h1>
            ) : (
              <Bone style={{ width: "60%", height: 56 }} />
            )}
            </div>
            <div style={{ display: "flex", gap: 24, justifyContent: "center" }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                  <Bone style={{ width: 54, height: 22 }} delay={i * 60} />
                  <Bone style={{ width: 70, height: 10 }} delay={i * 60} />
                </div>
              ))}
            </div>
            <Genres genres={peek.genres} />
          </div>

          {/* COL 3 — panneau d'actions */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 320, paddingTop: 144 }}>
            <Bone style={{ height: 48, borderRadius: 12 }} />
            <Bone style={{ height: 48, borderRadius: 12 }} delay={60} />
            <Bone style={{ height: 48, borderRadius: 12 }} delay={120} />
          </div>
        </div>
      </div>

      {/* Onglets + premier bloc */}
      <div style={{ maxWidth: 1380, margin: "0 auto", padding: "0 28px 48px", display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", gap: 10, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 12 }}>
          {[90, 96, 80, 110, 88].map((w, i) => (
            <Bone key={i} style={{ width: w, height: 30 }} delay={i * 50} />
          ))}
        </div>
        {/* Onglet Synopsis : intertitre, texte pleine largeur, puis les details */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Bone style={{ width: 80, height: 10 }} />
          {[100, 98, 100, 95, 60].map((w, i) => (
            <Bone key={i} style={{ width: `${w}%`, height: 14 }} delay={i * 50} />
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,3fr)", gap: 24 }}>
          <Bone style={{ height: 260, borderRadius: 14 }} />
          <Bone style={{ height: 260, borderRadius: 14 }} delay={80} />
        </div>
      </div>
    </div>
  );
}

function Mobile({ peek }: { peek: AnimePeek }) {
  return (
    <div style={{ background: "#0a0b10", minHeight: "100%" }}>
      <div style={{ position: "relative" }}>
        <Banner src={peek.banner || peek.cover} height={260} position="center 30%" fade={FADE_MOBILE} />
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 22, display: "flex", justifyContent: "center", padding: "0 24px" }}>
          {peek.title ? (
            <h1
              className="line-clamp-2"
              style={{
                fontFamily: "Outfit, sans-serif",
                fontSize: 28,
                fontWeight: 800,
                textAlign: "center",
                margin: 0,
                color: "#fff",
                textShadow: "0 12px 32px rgba(0,0,0,0.75)",
              }}
            >
              {peek.title}
            </h1>
          ) : (
            <Bone style={{ width: "60%", height: 30 }} />
          )}
        </div>
      </div>
      <div style={{ padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <Bone style={{ width: 50, height: 20 }} delay={i * 60} />
              <Bone style={{ width: 64, height: 9 }} delay={i * 60} />
            </div>
          ))}
        </div>
        <Genres genres={peek.genres} />
        {/* Couverture + actions (MHero : 120 px en 3/4, boutons a droite) */}
        <div style={{ display: "flex", gap: 14, marginTop: 2 }}>
          {peek.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={peek.cover}
              alt=""
              style={{
                width: 120,
                aspectRatio: "3 / 4",
                objectFit: "cover",
                flexShrink: 0,
                borderRadius: 11,
                border: "1px solid rgba(255,255,255,0.1)",
                boxShadow: "0 18px 40px rgba(0,0,0,0.6)",
              }}
            />
          ) : (
            <Bone style={{ width: 120, aspectRatio: "3 / 4", flexShrink: 0, borderRadius: 11 }} />
          )}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
            <Bone style={{ height: 60, borderRadius: 12 }} />
            <Bone style={{ height: 40, borderRadius: 10 }} delay={60} />
            <div style={{ display: "flex", gap: 10 }}>
              <Bone style={{ width: 40, height: 40, borderRadius: 10 }} delay={120} />
              <Bone style={{ width: 40, height: 40, borderRadius: 10 }} delay={150} />
              <Bone style={{ flex: 1, height: 40, borderRadius: 10 }} delay={180} />
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, overflow: "hidden" }}>
          {[78, 84, 70, 92].map((w, i) => (
            <Bone key={i} style={{ width: w, height: 30, flexShrink: 0 }} delay={i * 50} />
          ))}
        </div>
        <Bone style={{ height: 12 }} />
        <Bone style={{ width: "90%", height: 12 }} delay={60} />
        <Bone style={{ width: "75%", height: 12 }} delay={120} />
      </div>
    </div>
  );
}

export default function AnimeSkeleton({ peek, mobile }: { peek: AnimePeek; mobile: boolean }) {
  return mobile ? <Mobile peek={peek} /> : <Desktop peek={peek} />;
}
