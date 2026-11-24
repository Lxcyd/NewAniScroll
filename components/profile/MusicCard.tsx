import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { MdPause, MdPlayArrow } from "react-icons/md";
import HoverVolume from "@/components/shared/HoverVolume";
import { eqLevels, eqVoice, type EqVoice } from "@/lib/profile/eqMotion";
import TrailerAmbient from "@/components/shared/HoverPreview/TrailerAmbient";

/** Ce que le profil et le studio règlent sur la case : commandes et petit carré. */
export type MusicCardControls = {
  playing: boolean;
  muted: boolean;
  volume: number;
  onToggle: () => void;
  onMuted: (m: boolean) => void;
  onVolume: (v: number) => void;
  fallback?: number;
  /** Se tasse en petit carré hors survol, avec l'égaliseur (profil et studio). */
  minimizable?: boolean;
  /**
   * LE VERSO : LE FOND VIDÉO (24/11/2026, Luc). Quand une musique joue SUR un
   * fond vidéo, la case du fond n'existe pas — on ne pouvait arrêter que le
   * son. Un bouton en haut à gauche (au survol) retourne la carte : au dos,
   * l'image du fond et sa lecture / pause, indépendante de la musique.
   */
  back?: { art: string; playing: boolean; onToggle: () => void } | null;
};

type Props = MusicCardControls & {
  /** L'image de la case : vignette YouTube ou pochette de l'anime. Elle fait aussi la lumière. */
  art: string;
  /** L'image couvre la case : toujours, depuis que la vidéo n'y paraît plus (17/10/2026). */
  showArt: boolean;
  /** Le morceau a déjà joué : l'égaliseur paraît, les 5 s avant réduction commencent. */
  started: boolean;
  /** Ce qui donne au morceau son battement (l'identifiant de la vidéo, l'adresse du fichier). */
  eqKey: string;
  /** Le temps du lecteur, en secondes : l'égaliseur s'y cale. */
  clock: () => number;
  /** Le lecteur avance vraiment (par défaut : `playing`). */
  live?: () => boolean;
  /** Le gain du fondu de l'extrait, 0-1 : l'égaliseur le suit. */
  gain?: () => number;
  className?: string;
  /** La vidéo n'a pas de piste son (un fond animé muet) : ni égaliseur ni
      volume, il n'y a rien à écouter (24/10/2026, Luc). */
  silent?: boolean;
  /** Le média visible sous l'image (le lecteur YouTube), rogné à la case. */
  children?: ReactNode;
};

/** La case, grande (17/10/2026 : 240 px, un peu plus que le minimum de 200
    de YouTube) ; réduite, le petit carré. */
export const CARD = 240;
const MINI = 72;
/** Du centre de la grande case au centre du petit carré, calé au coin bas droit. */
const SHIFT = (CARD - MINI) / 2;

/** Le nombre de barres de l'égaliseur (mouvement : lib/profile/eqMotion). */
const EQ_BARS = 10;

/** La case grandit d'elle-même UNE fois par arrivée sur le profil : au
    chargement, puis à chaque retour du studio (`data-profile-enter`, posé par
    ProfileStage) — une boucle du morceau ne la refait pas grandir (23/10/2026,
    Luc). Le survol, lui, la fait toujours grandir. Gardé hors du composant :
    la case peut être remontée au passage. */
let grewFor: string | null = null;
/** La dernière case montée était-elle grande ? Lue par la suivante (profil ↔ studio). */
let lastBig = false;
const arrival = () => document.documentElement.dataset.profileEnter ?? "load";

/**
 * UNE IMAGE NETTE DANS LA CASE (22/10/2026, Luc). La case fait 240 px (plus
 * sur un écran dense) ; les pochettes rangées avec la musique sont petites :
 *   — Apple Music : 120×120 (theme-covers) → on demande 600×600 ;
 *   — Deezer : 120×120 → 600×600 ;
 *   — TMDB (image d'épisode du fond vidéo) : w780 → w1280 / originale ;
 *   — Cover Art Archive : `front-250` → `front-500` ;
 *   — YouTube : `mqdefault` 320×180, rogné au carré = 180 px étirés → la HD
 *     (`maxresdefault`), puis `hq720`.
 * L'adresse rangée reste en dernier recours. Une vignette YouTube absente
 * répond par une image grise de 120×90 (404, mais image valide : pas
 * d'`error`) — c'est sa largeur qui la trahit.
 */
const YT_THUMB = /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/(?:mq|hq|sd|maxres)default\.jpg$/;
const APPLE_ART = /^(https:\/\/[\w.-]+\.mzstatic\.com\/.+\/)\d+x\d+bb\.(jpg|png|webp)$/;
/* Deezer : `…/cover/<hash>/120x120-000000-80-0-0.jpg` (la pochette du profil de
   Luc, 22/10/2026) — la taille est dans le nom, jusqu'à 1000. */
const DEEZER_ART = /^(https:\/\/cdn-images\.dzcdn\.net\/images\/cover\/[0-9a-f]+\/)\d+x\d+(-.+\.jpg)$/;
/* TMDB : l'image d'un épisode porté en fond (`videoCover`, w780 chez Luc le
   22/10/2026). Un 16:9 rogné au carré n'en garde que 440 px : on demande la
   w1280, puis l'originale. */
const TMDB_ART = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w\d+(\/[\w-]+\.(?:jpg|png|webp))$/;
const CAA_ART = /^(https:\/\/coverartarchive\.org\/release(?:-group)?\/[\w-]+\/front)-\d+$/;
function hiResCandidates(art: string): string[] {
  const yt = YT_THUMB.exec(art);
  if (yt) {
    const base = `https://i.ytimg.com/vi/${yt[1]}`;
    return [`${base}/maxresdefault.jpg`, `${base}/hq720.jpg`, art];
  }
  const ap = APPLE_ART.exec(art);
  if (ap) return [`${ap[1]}600x600bb.${ap[2]}`, art];
  const caa = CAA_ART.exec(art);
  if (caa) return [`${caa[1]}-500`, art];
  const dz = DEEZER_ART.exec(art);
  if (dz) return [`${dz[1]}600x600${dz[2]}`, art];
  const tm = TMDB_ART.exec(art);
  if (tm) return [`${tm[1]}w1280${tm[2]}`, `${tm[1]}original${tm[2]}`, art];
  return [art];
}
function useHiResArt(art: string) {
  const list = useMemo(() => hiResCandidates(art), [art]);
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [list]);
  const next = () => setI((k) => Math.min(k + 1, list.length - 1));
  return {
    src: list[Math.min(i, list.length - 1)],
    onLoad: (e: SyntheticEvent<HTMLImageElement>) => {
      if (e.currentTarget.naturalWidth <= 120 && i < list.length - 1) next();
    },
    onError: () => {
      if (i < list.length - 1) next();
    },
  };
}

/**
 * LA CASE MUSIQUE, en bas à droite du profil et de la scène du studio : la
 * même pour la version YouTube (le lecteur officiel, passé en `children`) et
 * pour le fichier d'AnimeThemes, qui n'a que sa pochette (17/10/2026 : sans
 * elle, un OP/ED n'avait rien à l'écran pour se lancer ni se couper).
 * Lumière d'ambiance, lecture au centre, volume en haut à droite, égaliseur
 * au pied, petit carré hors survol.
 */
export default function MusicCard({
  art,
  showArt,
  started,
  eqKey,
  clock,
  live,
  gain,
  className,
  silent = false,
  children,
  ...card
}: Props) {
  const hiArt = useHiResArt(art);
  /* Les dernières fonctions, lues par la boucle sans la relancer. */
  const fn = useRef({ clock, live, gain });
  fn.current = { clock, live, gain };
  const playingRef = useRef(card.playing);
  playingRef.current = card.playing;
  const keyRef = useRef(eqKey);
  keyRef.current = eqKey;

  /* L'égaliseur : hauteurs écrites à même le style à chaque image de lecture
     (dix `transform`, composités), voix refaite au changement de morceau. Le
     fondu, lui, en variable CSS, seulement quand il bouge d'un vingtième.
     Rien n'est calculé en pause : les barres y sont cachées. */
  const eqRef = useRef<HTMLDivElement | null>(null);
  const eqFade = useRef(-1);
  const eqBarEls = useRef<(HTMLElement | null)[]>([]);
  const eqLevelsBuf = useRef(new Float32Array(EQ_BARS));
  const eqVoiceRef = useRef<{ id: string; v: EqVoice } | null>(null);
  const canMini = !!card.minimizable;
  const eqOn = canMini && started && !silent;
  useEffect(() => {
    if (!eqOn) return;
    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const frame = performance.now();
      const dt = Math.min(0.1, (frame - last) / 1000);
      last = frame;
      const f = fn.current;
      const moving = f.live ? f.live() : playingRef.current;
      const el = eqRef.current;
      if (moving && el) {
        const id = keyRef.current;
        if (eqVoiceRef.current?.id !== id) eqVoiceRef.current = { id, v: eqVoice(id, EQ_BARS) };
        const lv = eqLevelsBuf.current;
        eqLevels(eqVoiceRef.current.v, f.clock(), dt, lv);
        eqBarEls.current.forEach((b, i) => {
          if (b) b.style.transform = `scaleY(${lv[i].toFixed(3)})`;
        });
        const q = Math.round((f.gain ? f.gain() : 1) * 20) / 20;
        if (q !== eqFade.current) {
          eqFade.current = q;
          el.style.setProperty("--eq-fade", String(q));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [eqOn]);

  /* Les commandes de la case : là quand la main bouge, parties après 3 s
     d'immobilité. À l'arrêt, elles restent. La PREMIÈRE fois qu'elle joue,
     elles restent 5 s même sans la main (17/10/2026 : on doit les voir avant
     qu'elles partent). */
  const [awake, setAwake] = useState(false);
  const sleep = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = (ms = 3000) => {
    setAwake(true);
    if (sleep.current) clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), ms);
  };
  const greeted = useRef(false);
  useEffect(() => {
    if (!card.playing || greeted.current) return;
    greeted.current = true;
    wake(5000);
  }, [card.playing]);
  useEffect(
    () => () => {
      if (sleep.current) clearTimeout(sleep.current);
    },
    [],
  );

  /* LE PETIT CARRÉ (17/10/2026, choix de Luc) : grande 5 s à l'arrivée, puis
     elle se tasse en carré de 72 px (48 puis 64 le 17/10, trop petit) aux bords arrondis ; le survol la rend
     grande, la quitter la retasse. Pas de bouton. La musique ne s'arrête
     jamais : c'est le même lecteur, seule la boîte change de taille. */
  /* PETITE PAR DÉFAUT, GRANDE QUAND ÇA JOUE (22/10/2026, Luc) : la case ne
     grandit que quand la lecture part — jamais en pause —, reste grande 3 s,
     puis se retasse. Pendant le passage profil ↔ studio elle attend que le
     cadre soit posé (`sceneSettle`, ProfileStage) : grandir pendant qu'il
     bouge brouillait les deux mouvements. Un nouveau morceau refait de même. */
  /* LA TAILLE PASSE D'UNE CASE À L'AUTRE (24/10/2026, Luc) : ouvrir le studio
     remplace la case du profil par celle de la scène. Elle naissait petite :
     une case grande à ce moment-là se réduisait D'UN COUP, sans animation. La
     nouvelle reprend la taille de l'ancienne (`lastBig`, hors composant), puis
     se tasse en douceur une fois le cadre posé. */
  const [mini, setMini] = useState(() => canMini && !lastBig);
  const shrinkAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shrinkIn = (ms: number) => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    shrinkAt.current = setTimeout(() => setMini(true), ms);
  };
  useEffect(() => {
    if (canMini) lastBig = !mini;
  }, [canMini, mini]);
  useEffect(() => {
    if (!canMini || mini) return;
    /* Née grande (héritée) : elle se tasse après le passage du cadre. */
    const settle = Number(document.documentElement.dataset.sceneSettle) || 0;
    shrinkIn(Math.max(0, settle - performance.now()) + 1200);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- au montage seulement
  }, []);
  const grow = () => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    setMini(false);
  };
  const [enterTick, setEnterTick] = useState(0);
  useEffect(() => {
    const on = () => setEnterTick((n) => n + 1);
    window.addEventListener("as-profile-enter", on);
    return () => window.removeEventListener("as-profile-enter", on);
  }, []);
  useEffect(() => {
    if (!canMini || !card.playing || grewFor === arrival()) return;
    const settle = Number(document.documentElement.dataset.sceneSettle) || 0;
    const t = setTimeout(
      () => {
        /* Marqué ici, pas avant le minuteur : un effet rejoué (React en dev)
           l'annule et ne doit pas perdre l'agrandissement. */
        grewFor = arrival();
        grow();
        shrinkIn(3000);
      },
      Math.max(0, settle - performance.now()),
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grow/shrinkIn sont stables en pratique
  }, [canMini, card.playing, eqKey, enterTick]);
  useEffect(
    () => () => {
      if (shrinkAt.current) clearTimeout(shrinkAt.current);
    },
    [],
  );
  const folded = canMini && mini;

  /* Le verso : CHAQUE SURVOL DE L'ICÔNE RETOURNE LA CARTE (24/11/2026, Luc :
     « un icône à hover, pas la case »). L'icône paraît au survol de la case,
     en haut à gauche ; passer dessus retourne, la quitter puis y revenir
     retourne encore. La face montrée reste jusque-là, petit carré compris. */
  const back = card.back ?? null;
  const backArt = useHiResArt(back?.art ?? "");
  const [flipped, setFlipped] = useState(false);
  const [hovered, setHovered] = useState(false);
  const flippedAt = useRef(0);
  const hasBack = !!back;
  useEffect(() => {
    if (!hasBack) setFlipped(false);
  }, [hasBack]);

  const chrome = `transition-opacity duration-200 ${awake || !card.playing ? "opacity-100" : "pointer-events-none opacity-0"}`;
  return (
    <div className={`relative isolate ${className ?? ""}`}>
      {/* LA LUMIÈRE, SANS SECOND LECTEUR (17/10/2026). C'était une copie muette
         de la vidéo, floutée à 34 px : deux décodeurs YouTube et un flou
         recalculé à chaque image — la case faisait ramer le studio. Puis une
         seule image floutée, trop terne. C'est maintenant la lumière de
         l'aperçu au survol en économie de données (TrailerAmbient) : la pile
         de copies qui s'étale autour de la case, prise de son image.
         Le petit carré a SA lumière, à sa taille : la grande réduite au zoom
         laissait un voile gris dans le coin (17/10/2026). On passe de l'une à
         l'autre en fondu d'opacité, sans jamais animer de flou. Et chacune
         SUIT la case pendant qu'elle change de taille (même durée, même
         courbe, en transform) : la grande se replie vers le coin en
         s'éteignant, la petite part de la taille de la grande. */}
      {/* LE CARRÉ CLAIR AUTOUR DE LA CASE (07/11/2026, Luc). La pile est faite
          de rectangles : sur un fond de la même image, son pourtour se lisait
          en carré à bords droits. Un masque RADIAL l'arrondit — posé sur une
          boîte plus grande que la case (`-inset-16`, la lumière se rend à
          ~55 px), car un masque efface tout ce qui dépasse sa propre boîte.
          Même centre que la case : le repli (scale) ne bouge pas. */}
      {/* UNE LUMIÈRE PAR FACE (24/11/2026, Luc). Au retournement, celle de la
          face qui part s'éteint en rétrécissant pendant la première moitié du
          demi-tour ; celle de la face qui arrive grandit en s'allumant pendant
          la seconde (le délai est porté par l'état d'arrivée : l'extinction,
          elle, part tout de suite). */}
      {(back ? [false, true] : [false]).map((isBack) => {
        const shown = !folded && isBack === flipped;
        return (
          <div
            key={isBack ? "back" : "front"}
            className="pointer-events-none absolute -inset-16 -z-10 will-change-transform"
            style={{
              opacity: shown ? 1 : 0,
              transform: folded
                ? `translate(${SHIFT}px, ${SHIFT}px) scale(${MINI / CARD})`
                : shown
                  ? "none"
                  : "scale(0.8)",
              transitionProperty: "transform, opacity",
              transitionDuration: back ? "250ms" : "300ms",
              transitionTimingFunction: shown ? "ease-out" : "ease-in",
              transitionDelay: back && shown ? "250ms" : "0ms",
              maskImage: "radial-gradient(closest-side, #000 55%, transparent 100%)",
              WebkitMaskImage: "radial-gradient(closest-side, #000 55%, transparent 100%)",
            }}
          >
            <div className="absolute inset-16">
              {/* `playing` toujours faux : elle ne peint son image qu'à l'arrêt, et
                  une lecture partie seule au montage l'aurait laissée éteinte. Il
                  n'y a pas de vidéo à suivre ici. */}
              <TrailerAmbient banner={isBack ? back?.art || art : art} playing={false} />
            </div>
          </div>
        );
      })}
      {canMini ? (
        <img
          aria-hidden
          alt=""
          /* La face visible : le petit carré garde celle sur laquelle on l'a quitté. */
          src={flipped && back?.art ? back.art : art}
          /* À peine visible (17/10/2026) : 4 px de débord, 8 px de flou. */
          className={`pointer-events-none absolute -bottom-1 -right-1 -z-10 object-cover blur-[8px] transition-[transform,opacity] duration-300 ease-out will-change-transform ${folded ? "opacity-30" : "opacity-0"}`}
          style={{
            width: MINI + 8,
            height: MINI + 8,
            transform: folded ? "none" : `translate(${-SHIFT}px, ${-SHIFT}px) scale(${CARD / (MINI + 8)})`,
          }}
        />
      ) : null}
      <div
        /* En TRANSFORM, pas en width/height : animer la taille remettait en
           page à chaque image une iframe 200 fois plus grande (saccades,
           17/10/2026). La boîte garde sa taille (CARD) ; la carte graphique la
           réduit vers le coin bas droit. */
        /* L'ombre est ICI, avec l'arrondi de la case : le masque de la case
           (ci-dessous) la couperait. */
        className={`pointer-events-auto relative h-full w-full shadow-2xl transition-[transform,border-radius] duration-300 ease-out will-change-transform ${folded ? "rounded-[40px]" : "rounded-xl"}`}
        style={canMini ? { transform: folded ? `scale(${MINI / CARD})` : "none", transformOrigin: "100% 100%" } : undefined}
        onPointerMove={() => wake()}
        onPointerEnter={() => {
          wake();
          setHovered(true);
          if (canMini) grow();
        }}
        onPointerLeave={() => {
          setHovered(false);
          if (canMini) shrinkIn(0);
        }}
      >
        {/* Le retournement : un plan 3D, deux faces dos à dos. Sans verso,
            aucune 3D — la case reste exactement celle d'avant. */}
        <div
          className="relative h-full w-full transition-transform duration-500 ease-[cubic-bezier(.2,.7,.2,1)]"
          style={
            back
              ? { transformStyle: "preserve-3d", transform: `perspective(900px) rotateY(${flipped ? 180 : 0}deg)` }
              : undefined
          }
        >
        <div
          /* Pas de liseré : sur une image claire il se lisait comme un bord bleu.
             Réduite, le rayon l'est avec la case : 40 px ici font ~10 px à
             l'écran. Il glisse PENDANT la réduction, même durée, même courbe :
             posé à la fin, il sautait (17/10/2026). */
          /* LE LISERÉ SOMBRE DES COINS (28/10/2026, Luc). La case avait un fond
             NOIR sous son image : au bord lissé de l'arrondi, ce noir passait
             au travers, en trait foncé le long de la courbe — net dès que la
             lumière d'ambiance éclaire le dessous (vérifié trait présent / absent
             en ne retirant QUE ce fond). L'image couvre toujours toute la case :
             le fond noir ne servait à rien, il est retiré. Un seul masque
             (`clip-path`) découpe le tout. */
          className="relative h-full w-full transition-[clip-path] duration-300 ease-out"
          style={{
            clipPath: `inset(0 round ${folded ? 40 : 12}px)`,
            /* La face cachée ne prend pas les clics : seule celle qu'on voit répond. */
            ...(back
              ? { backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", pointerEvents: flipped ? "none" : undefined }
              : null),
          }}
        >
          {children}
          {showArt ? (
            <img
              alt=""
              src={hiArt.src}
              onLoad={hiArt.onLoad}
              onError={hiArt.onError}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            />
          ) : null}
          {eqOn ? (
            /* LE TÉMOIN DE LECTURE (17/10/2026) : dix barres au pied de la
               case, en grand comme en petit (la case réduite les réduit avec
               elle). Elles ne suivent PAS le son : celui d'une iframe d'un autre
               site est hors d'atteinte (copie analysée et estimation essayées
               puis retirées, devlog/site.md). Elles suivent ce qu'on sait : la
               pause les cache, le muet les couche, le fondu les baisse. Leur
               mouvement est calculé à chaque image (lib/profile/eqMotion), calé
               sur le temps du lecteur. En muet, elles disparaissent (23/10/2026,
               Luc : couchées, elles se lisaient encore comme une lecture). */
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent transition-opacity duration-200 ${card.playing && !card.muted ? "opacity-100" : "opacity-0"}`}
            >
              <div
                ref={eqRef}
                className="absolute inset-x-0 bottom-3 flex h-10 items-end justify-center gap-2.5 transition-transform duration-200"
                style={{
                  transform: `scaleY(calc(var(--eq-fade, 1) * ${card.playing ? 1 : 0.15}))`,
                  transformOrigin: "bottom",
                }}
              >
                {Array.from({ length: EQ_BARS }, (_, i) => (
                  <i
                    key={i}
                    ref={(el) => {
                      eqBarEls.current[i] = el;
                    }}
                    className="block h-full w-3 origin-bottom rounded-sm bg-white/90"
                    style={{ transform: "scaleY(0.2)" }}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {folded ? null : (
            <>
              {/* Au-dessus du média : la case se pilote par ses propres commandes. */}
              <div className="absolute inset-0 grid place-items-center">
                <button
                  type="button"
                  onClick={card.onToggle}
                  aria-label={card.playing ? "Pause" : "Play"}
                  className={`as-preview-videobtn h-11 w-11 ${chrome}`}
                >
                  {card.playing ? <MdPause size={28} /> : <MdPlayArrow size={28} />}
                </button>
              </div>
              {silent ? null : (
                <div className={`absolute right-2 top-2 ${chrome}`}>
                  <HoverVolume
                    muted={card.muted}
                    volume={card.volume}
                    onMuted={card.onMuted}
                    onVolume={card.onVolume}
                    fallback={card.fallback}
                    placement="down"
                  />
                </div>
              )}
            </>
          )}
        </div>
        {back ? (
          /* LE DOS : l'image du fond, sa lecture au centre. La musique, elle,
             continue — on ne touche ici qu'au fond. */
          <div
            aria-hidden={!flipped}
            className="absolute inset-0"
            style={{
              clipPath: `inset(0 round ${folded ? 40 : 12}px)`,
              transform: "rotateY(180deg)",
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              pointerEvents: flipped ? undefined : "none",
            }}
          >
            {back.art ? (
              <img
                alt=""
                src={backArt.src}
                onLoad={backArt.onLoad}
                onError={backArt.onError}
                className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-[filter] duration-300 ${back.playing ? "" : "brightness-75 saturate-75"}`}
              />
            ) : (
              <div className="absolute inset-0 bg-[#15171d]" />
            )}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
            {flipped && !folded ? (
              <>
                <div className="absolute inset-0 grid place-items-center">
                  <button
                    type="button"
                    onClick={back.onToggle}
                    aria-label={back.playing ? "Pause du fond" : "Lecture du fond"}
                    className="as-preview-videobtn h-11 w-11"
                  >
                    {back.playing ? <MdPause size={28} /> : <MdPlayArrow size={28} />}
                  </button>
                </div>
                <span className="pointer-events-none absolute bottom-3 left-3 font-outfit text-[12px] font-bold uppercase tracking-[0.12em] text-white/85">
                  Fond
                </span>
              </>
            ) : null}
          </div>
        ) : null}
        </div>
        {back && !folded ? (
          /* HORS DU PLAN QUI TOURNE : posée sur une face, l'icône partirait de
             sous la souris pendant le demi-tour et y reviendrait — un nouveau
             survol, un nouveau retournement, sans fin. Ici elle ne bouge pas. */
          /* Le clic retourne aussi (24/11/2026, Luc) — sauf celui qui suit de
             près le survol qui vient de retourner : sans ça, arriver et cliquer
             (ou un tap sur téléphone, qui fait les deux) remettait la carte à
             l'endroit. */
          <button
            type="button"
            onPointerEnter={() => {
              flippedAt.current = performance.now();
              setFlipped((f) => !f);
            }}
            onClick={() => {
              if (performance.now() - flippedAt.current < 400) return;
              setFlipped((f) => !f);
            }}
            aria-label={flipped ? "Revenir à la musique" : "Lecture / pause du fond"}
            title={flipped ? "Musique" : "Fond"}
            className={`as-preview-videobtn absolute left-2 top-2 z-10 h-7 w-7 transition-opacity duration-200 ${hovered ? "opacity-100" : "pointer-events-none opacity-0"}`}
          >
            {/* L'icône choisie par Luc (24/11/2026), deux flèches en arc. */}
            <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4" fill="currentColor">
              <path d="M6,12.05q0,1.13 0.43,2.19T7.75,16.2L8,16.45V15q0-0.43 0.29-0.71Q8.58,14 9,14q0.43,0 0.71,0.29T10,15v4q0,0.43-0.29,0.71T9,20H5q-0.42,0-0.71-0.29Q4,19.43 4,19t0.29-0.71T5,18H6.75l-0.4-0.35q-1.3-1.15-1.83-2.62T4,12.05Q4,9.7 5.2,7.79Q6.4,5.88 8.43,4.85q0.35-0.2 0.74-0.02T9.68,5.4Q9.8,5.77 9.66,6.15T9.18,6.72Q7.73,7.52 6.86,8.94T6,12.05Zm12-0.1q0-1.13-0.43-2.19T16.25,7.8L16,7.55V9q0,0.42-0.29,0.71T15,10T14.29,9.71T14,9V5q0-0.43 0.29-0.71T15,4h4q0.43,0 0.71,0.29T20,5T19.71,5.71T19,6H17.25l0.4,0.35q1.22,1.23 1.79,2.66T20,11.95q0,2.35-1.2,4.26t-3.22,2.94q-0.35,0.2-0.74,0.03T14.33,18.6q-0.13-0.38 0.01-0.75t0.49-0.58q1.45-0.8 2.31-2.21T18,11.95Z" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  );
}
