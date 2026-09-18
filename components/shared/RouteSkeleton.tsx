import { useEffect, useState } from "react";
import Router from "next/router";
import Skeleton from "react-loading-skeleton";
import { peekPreview } from "@/lib/preview/previewStore";
import { getPrefetchedInfo } from "@/lib/watch/infoPrefetch";
import { pickTitle, useTitlePref } from "@/lib/prefs/titlePref";
import { installAnimeDataWarmer } from "@/lib/navigation/warmAnimeData";

/*
 * Le squelette de navigation.
 *
 * Dans le routeur pages, une page `getServerSideProps` ne s'affiche qu'une fois
 * ses donnees arrivees : jusque-la l'ANCIENNE page reste a l'ecran, figee, avec
 * pour seul signe la barre rose. Sur un MISS (fiche jamais vue, AniList lent)
 * ca peut durer des secondes, et c'est exactement ce que le visiteur ressent
 * comme « le site est lent ».
 *
 * Ce composant couvre cette fenetre, et elle seule : il apparait au
 * `routeChangeStart` vers une fiche ou une page de lecture et disparait au
 * `routeChangeComplete`, c'est-a-dire au moment precis ou la vraie page se
 * peint. Il ne remplace rien de la page d'arrivee.
 *
 * Pre-rempli avec ce que la session sait deja de l'anime (payload de l'apercu au
 * survol, ou fiche mise de cote par la page info) : la bonne banniere, la bonne
 * jaquette et le titre sont a l'ecran avant le premier octet du serveur.
 *
 * Exclus : navigations shallow, et lecture → lecture (changement d'episode, que
 * EpisodeTransitionOverlay couvre deja en plein ecran).
 */

type Target =
  | { kind: "info"; id: number }
  | { kind: "watch"; id: number };

const INFO_RE = /^\/(?:en|fr)\/anime\/(\d+)(?:[/?#]|$)/;
const WATCH_RE = /^\/(?:en|fr)\/anime\/watch\/(\d+)(?:[/?#]|$)/;

function parseTarget(url: string): Target | null {
  const path = url.split("?")[0].split("#")[0];
  const w = path.match(WATCH_RE);
  if (w) return { kind: "watch", id: Number(w[1]) };
  const i = path.match(INFO_RE);
  if (i) return { kind: "info", id: Number(i[1]) };
  return null;
}

type Known = {
  title: any;
  banner: string | null;
  cover: string | null;
};

function knownFor(id: number): Known | null {
  const p = peekPreview(id);
  if (p) {
    return {
      title: p.title,
      banner: p.bannerImage,
      cover: p.coverImage?.large ?? null,
    };
  }
  const info = getPrefetchedInfo(id);
  if (info) {
    return {
      title: info.title,
      banner: info.bannerImage ?? null,
      cover: info.coverImage?.extraLarge || info.coverImage?.large || null,
    };
  }
  return null;
}

export default function RouteSkeleton() {
  const [target, setTarget] = useState<Target | null>(null);
  const [mobile, setMobile] = useState(false);
  const titlePref = useTitlePref();

  useEffect(() => installAnimeDataWarmer(), []);

  useEffect(() => {
    const onStart = (url: string, opts?: { shallow?: boolean }) => {
      if (opts?.shallow) return;
      const next = parseTarget(url);
      if (!next) return setTarget(null);
      const here = parseTarget(window.location.pathname);
      // Lecture → lecture : changement d'episode, deja couvert ailleurs.
      if (next.kind === "watch" && here?.kind === "watch") return;
      // Meme fiche (retour sur un onglet, re-clic) : rien a couvrir.
      if (next.kind === "info" && here?.kind === "info" && here.id === next.id) return;
      setMobile(window.matchMedia("(max-width: 768px)").matches);
      setTarget(next);
    };
    const onEnd = () => setTarget(null);
    Router.events.on("routeChangeStart", onStart);
    Router.events.on("routeChangeComplete", onEnd);
    Router.events.on("routeChangeError", onEnd);
    return () => {
      Router.events.off("routeChangeStart", onStart);
      Router.events.off("routeChangeComplete", onEnd);
      Router.events.off("routeChangeError", onEnd);
    };
  }, []);

  if (!target) return null;
  const known = knownFor(target.id);
  const title = known?.title ? pickTitle(known.title, titlePref) : null;

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="as-route-skeleton"
      style={{
        position: "fixed",
        inset: 0,
        // Sous la navbar (z-[9999]) et la barre de progression, qui restent
        // visibles et identiques d'une page a l'autre ; au-dessus de tout le
        // reste de l'ancienne page.
        zIndex: 9000,
        overflow: "hidden",
        background: target.kind === "info" && mobile ? "#0a0b10" : "#0c0d10",
      }}
    >
      {target.kind === "info" ? (
        mobile ? (
          <InfoMobile known={known} title={title} />
        ) : (
          <InfoDesktop known={known} title={title} />
        )
      ) : (
        <Watch title={title} />
      )}
    </div>
  );
}

/* ── Fiche anime, desktop : calque sur Hero.tsx (banniere 360, contenu a -240,
      grille 240px | 1fr, jaquette + bouton regarder). ─────────────────────── */
function InfoDesktop({ known, title }: { known: Known | null; title: string | null }) {
  return (
    <>
      <div style={{ position: "relative", width: "100%", height: 360, overflow: "hidden" }}>
        {known?.banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={known.banner}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 35%",
            }}
          />
        )}
        <div style={{ position: "absolute", inset: 0, background: FADE_DESKTOP }} />
      </div>
      <div
        style={{
          maxWidth: 1380,
          margin: "-240px auto 0",
          padding: "0 28px",
          position: "relative",
          zIndex: 2,
          display: "grid",
          gridTemplateColumns: "240px minmax(0,1fr)",
          columnGap: 32,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {known?.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={known.cover}
              alt=""
              style={{
                width: 240,
                aspectRatio: "0.7",
                objectFit: "cover",
                display: "block",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.1)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.7)",
              }}
            />
          ) : (
            <Skeleton width={240} height={343} borderRadius={12} />
          )}
          <Skeleton height={70} borderRadius={12} />
        </div>
        <div style={{ paddingTop: 150, minWidth: 0 }}>
          {title ? (
            <div
              style={{
                fontFamily: '"Space Grotesk", "Inter", sans-serif',
                fontSize: 40,
                fontWeight: 700,
                lineHeight: 1.1,
                color: "#f4f5f8",
                letterSpacing: "-0.01em",
                textShadow: "0 8px 24px rgba(0,0,0,0.6)",
                marginBottom: 18,
              }}
            >
              {title}
            </div>
          ) : (
            <Skeleton width="55%" height={40} style={{ marginBottom: 18 }} />
          )}
          <Skeleton width={420} height={44} borderRadius={10} style={{ marginBottom: 16 }} />
          <div style={{ display: "flex", gap: 8 }}>
            {[72, 88, 64, 96].map((w) => (
              <Skeleton key={w} width={w} height={26} borderRadius={999} />
            ))}
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 1380, margin: "36px auto 0", padding: "0 28px" }}>
        <div style={{ display: "flex", gap: 18, borderBottom: "1px solid #252938", paddingBottom: 12, marginBottom: 18 }}>
          {[80, 90, 70, 100, 80].map((w, i) => (
            <Skeleton key={i} width={w} height={18} />
          ))}
        </div>
        <Skeleton count={3} height={16} style={{ marginBottom: 8 }} />
      </div>
    </>
  );
}

/* ── Fiche anime, mobile : calque sur MHero (banniere 260, titre centre). ── */
function InfoMobile({ known, title }: { known: Known | null; title: string | null }) {
  return (
    <>
      <div style={{ position: "relative", height: 260, overflow: "hidden" }}>
        {known?.banner && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={known.banner}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 30%",
            }}
          />
        )}
        <div style={{ position: "absolute", inset: 0, background: FADE_MOBILE }} />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 22,
            display: "flex",
            justifyContent: "center",
            padding: "0 24px",
          }}
        >
          {title ? (
            <div
              style={{
                fontFamily: "Outfit, sans-serif",
                fontSize: 28,
                fontWeight: 800,
                textAlign: "center",
                color: "#f4f5f8",
                textShadow: "0 12px 32px rgba(0,0,0,0.75)",
              }}
            >
              {title}
            </div>
          ) : (
            <Skeleton width={220} height={30} />
          )}
        </div>
      </div>
      <div style={{ padding: "16px" }}>
        <Skeleton height={52} borderRadius={12} style={{ marginBottom: 14 }} />
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[64, 80, 56].map((w) => (
            <Skeleton key={w} width={w} height={24} borderRadius={999} />
          ))}
        </div>
        <Skeleton count={4} height={14} style={{ marginBottom: 8 }} />
      </div>
    </>
  );
}

/* ── Page de lecture : meme grille que #default (lecteur 16/9 dont la largeur
      part de la hauteur d'ecran, liste d'episodes a droite a partir de lg). ── */
function Watch({ title }: { title: string | null }) {
  return (
    <div className="mx-auto pt-16 lg:pt-20">
      <div className="lg:max-w-[calc(100%_-_2.25rem)] [--player-col:min(100%_-_26rem,(100dvh_-_143px_-_1.125rem)_*_16_/_9)] lg:grid-cols-[var(--player-col)_minmax(0,1fr)] mx-auto flex w-full flex-col lg:grid">
        <div className="w-full min-w-0">
          <div className="flex-center aspect-video w-full bg-black rounded-card ring-1 ring-white/5" />
          <div className="mt-3 px-3 lg:px-0">
            <Skeleton height={45} borderRadius={12} />
          </div>
          <div className="mt-4 px-3 lg:px-0 lg:hidden">
            {title ? (
              <div className="font-outfit text-xl font-semibold text-white line-clamp-2">{title}</div>
            ) : (
              <Skeleton width="60%" height={24} />
            )}
          </div>
        </div>
        <div className="relative pt-4 lg:pt-0 lg:pl-4 px-3 lg:px-0">
          <div className="hidden lg:block mb-3">
            {title ? (
              <div className="font-outfit text-lg font-semibold text-white line-clamp-1">{title}</div>
            ) : (
              <Skeleton width="70%" height={22} />
            )}
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="mb-2 flex gap-3">
              <Skeleton width={120} height={68} borderRadius={8} />
              <div className="flex-1">
                <Skeleton width="80%" height={14} />
                <Skeleton width="40%" height={12} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const FADE_DESKTOP =
  "linear-gradient(180deg, rgba(12,13,16,0) 0%, rgba(12,13,16,0.06) 22%, rgba(12,13,16,0.16) 40%, rgba(12,13,16,0.34) 56%, rgba(12,13,16,0.58) 70%, rgba(12,13,16,0.82) 84%, #0c0d10 100%)";
const FADE_MOBILE =
  "linear-gradient(180deg, rgba(10,11,16,0) 0%, rgba(10,11,16,0.06) 22%, rgba(10,11,16,0.16) 40%, rgba(10,11,16,0.34) 56%, rgba(10,11,16,0.58) 70%, rgba(10,11,16,0.82) 84%, #0a0b10 100%)";
