import { useEffect, useRef, useState, type ReactNode } from "react";
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
  children,
  ...card
}: Props) {
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
  const eqOn = canMini && started;
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
     grandit que quand la lecture part — jamais en pause —, reste grande 5 s,
     puis se retasse. Pendant le passage profil ↔ studio elle attend que le
     cadre soit posé (`sceneSettle`, ProfileStage) : grandir pendant qu'il
     bouge brouillait les deux mouvements. Un nouveau morceau refait de même. */
  const [mini, setMini] = useState(canMini);
  const shrinkAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shrinkIn = (ms: number) => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    shrinkAt.current = setTimeout(() => setMini(true), ms);
  };
  const grow = () => {
    if (shrinkAt.current) clearTimeout(shrinkAt.current);
    setMini(false);
  };
  useEffect(() => {
    if (!canMini || !card.playing) return;
    const settle = Number(document.documentElement.dataset.sceneSettle) || 0;
    const t = setTimeout(
      () => {
        grow();
        shrinkIn(5000);
      },
      Math.max(0, settle - performance.now()),
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grow/shrinkIn sont stables en pratique
  }, [canMini, card.playing, eqKey]);
  useEffect(
    () => () => {
      if (shrinkAt.current) clearTimeout(shrinkAt.current);
    },
    [],
  );
  const folded = canMini && mini;

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
      <div
        className="pointer-events-none absolute inset-0 -z-10 transition-[transform,opacity] duration-300 ease-out will-change-transform"
        style={{
          opacity: folded ? 0 : 1,
          transform: folded ? `translate(${SHIFT}px, ${SHIFT}px) scale(${MINI / CARD})` : "none",
        }}
      >
        {/* `playing` toujours faux : elle ne peint son image qu'à l'arrêt, et
            une lecture partie seule au montage l'aurait laissée éteinte. Il n'y
            a pas de vidéo à suivre ici. */}
        <TrailerAmbient banner={art} playing={false} />
      </div>
      {canMini ? (
        <img
          aria-hidden
          alt=""
          src={art}
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
        className="relative h-full w-full transition-transform duration-300 ease-out will-change-transform"
        style={canMini ? { transform: folded ? `scale(${MINI / CARD})` : "none", transformOrigin: "100% 100%" } : undefined}
        onPointerMove={() => wake()}
        onPointerEnter={() => {
          wake();
          if (canMini) grow();
        }}
        onPointerLeave={canMini ? () => shrinkIn(0) : undefined}
      >
        <div
          /* Pas de liseré : sur une image claire il se lisait comme un bord bleu.
             Réduite, le rayon l'est avec la case : 40 px ici font ~10 px à
             l'écran. Il glisse PENDANT la réduction, même durée, même courbe :
             posé à la fin, il sautait (17/10/2026). */
          className={`relative h-full w-full overflow-hidden bg-black shadow-2xl transition-[border-radius] duration-300 ease-out ${folded ? "rounded-[40px]" : "rounded-xl"}`}
        >
          {children}
          {showArt ? (
            <img
              alt=""
              src={art}
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
               sur le temps du lecteur. */
            <div
              className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent transition-opacity duration-200 ${card.playing ? "opacity-100" : "opacity-0"}`}
            >
              <div
                ref={eqRef}
                className="absolute inset-x-0 bottom-3 flex h-10 items-end justify-center gap-2.5 transition-transform duration-200"
                style={{
                  transform: `scaleY(calc(var(--eq-fade, 1) * ${card.playing && !card.muted ? 1 : 0.15}))`,
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
