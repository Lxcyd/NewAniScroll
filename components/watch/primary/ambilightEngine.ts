/**
 * Facade autour du moteur de rendu de « Ambient light for YouTube »
 * (lib/vendor/youtube-ambilight, MIT, copie sans modification).
 *
 * Leurs projecteurs attendent un orchestrateur, `ambientlight.js`, ecrit pour
 * le DOM de YouTube. On n'en garde que ce que les projecteurs lisent, et les
 * calculs qu'il fait autour d'eux — reportes ici a l'identique :
 *   - `updateSizes`      : taille du projecteur (pScale) et du tampon ;
 *   - `resizeCanvasses`  : nombre de niveaux et leurs echelles ;
 *   - `drawAmbientlight` : video -> tampon -> projecteur.
 *
 * WebGL d'abord, comme chez eux, et LEUR projecteur 2D en repli. Le repli sert
 * ici plus souvent que sur YouTube : un flux cross-origin sans CORS se dessine
 * en 2D mais `texImage2D` le refuse (SecurityError). `draw` le signale par
 * `false`, et LiveAmbient reconstruit le moteur en 2D.
 */
import ProjectorWebGL from "@/lib/vendor/youtube-ambilight/projector-webgl";
import Projector2d from "@/lib/vendor/youtube-ambilight/projector-2d";
import { WebGLOffscreenCanvas } from "@/lib/vendor/youtube-ambilight/canvas-webgl";
import {
  SafeOffscreenCanvas,
  ctxOptions,
} from "@/lib/vendor/youtube-ambilight/generic";

/** `innerStrength` de ambientlight.js : niveaux plus petits que la video. */
const INNER_STRENGTH = 2;

/** Leurs reglages par defaut (settings-config.js), ceux que lisent les
 *  projecteurs et ce fichier — SAUF `resolution`, `spread` et `edge`, repris
 *  de l'export des reglages de l'extension de Luc le 03/10 (defauts : 100, 17
 *  et 12). `edge` est un reglage avance, masque dans leur panneau mais actif :
 *  a 2, chaque anneau ne montre qu'un liseré du bord et la lumiere s'etire en
 *  trainees continues ; a 12 elle montrait une copie agrandie de l'image. Le
 *  flou (5) vient des preferences du site. */
const DEFAULT_SETTINGS = {
  webGL: true,
  resolution: 400,
  blur2: 30,
  edge: 2,
  spread: 100,
  spreadFadeStart: 15,
  spreadFadeCurve: 35,
  directionTopEnabled: true,
  directionRightEnabled: true,
  directionBottomEnabled: true,
  directionLeftEnabled: true,
  vibrance: 100,
  frameFading: 0,
  flickerReduction: 0,
  showResolutions: false,
  fixedPosition: false,
};

export class AmbilightEngine {
  /* ── Champs que leurs projecteurs lisent sur « ambientlight » ── */
  isPageHidden = false;
  atTop = true;
  buffersCleared = false;
  sizesChanged = true;
  shouldStyleVideoParentElem = false;
  barDetection = { clear() {} };
  videoElem: HTMLElement;
  videoContainerElem: HTMLElement;
  projector: any;
  projectorBuffer: any;

  settings: any;
  readonly webGL: boolean;
  private root: HTMLElement;
  private projectorsElem: HTMLDivElement;
  private projectorListElem: HTMLDivElement;
  private p = { w: 0, h: 0 };
  private srcKey = "";
  private onViewportChange = () => {
    if (this.projector) this.projector.cropped = false;
  };

  constructor(root: HTMLElement, blur2: number, webGL: boolean) {
    this.root = root;
    this.webGL = webGL;
    this.videoElem = root;
    this.videoContainerElem = root;
    this.settings = {
      ...DEFAULT_SETTINGS,
      webGL,
      blur2,
      setWarning: (text: string) => {
        if (text) console.warn("[ambilight]", text);
      },
      set: (name: string, value: unknown) => {
        this.settings[name] = value;
        this.sizesChanged = true;
      },
      handleWebGLCrash: () => {},
    };

    // Meme arborescence que la leur : projectors > projector-list.
    this.projectorsElem = document.createElement("div");
    this.projectorsElem.classList.add("ambientlight__projectors");
    this.projectorListElem = document.createElement("div");
    this.projectorListElem.classList.add("ambientlight__projector-list");
    this.projectorsElem.prepend(this.projectorListElem);
    root.prepend(this.projectorsElem);
  }

  setDrawWarning = (error: unknown) => console.warn("[ambilight]", error);
  optionalFrame = async () => {
    this.sizesChanged = true;
  };
  initProjectorListeners = () => {};

  /** Construit tampon et projecteur. `false` : WebGL indisponible ici. */
  async init(): Promise<boolean> {
    try {
      if (this.webGL) {
        const elem: any = new WebGLOffscreenCanvas(1, 1, this, this.settings);
        const ctx = await elem.getContext("2d", ctxOptions);
        if (!ctx) return false;
        this.projectorBuffer = { elem, ctx };
        this.projector = await new (ProjectorWebGL as any)(
          this,
          this.projectorListElem,
          this.initProjectorListeners,
          this.settings,
        );
        if (!this.projector?.ctx) return false;
      } else {
        const elem: any = new (SafeOffscreenCanvas as any)(1, 1, true);
        this.projectorBuffer = { elem, ctx: elem.getContext("2d", ctxOptions) };
        this.projector = new (Projector2d as any)(
          this,
          this.projectorListElem,
          this.initProjectorListeners,
          this.settings,
        );
      }
    } catch (ex) {
      console.warn("[ambilight] init", ex);
      return false;
    }
    // ambientlight.js : recreateProjectors()
    const levels = Math.max(
      2,
      Math.round(this.settings.spread / this.settings.edge) + INNER_STRENGTH + 1,
    );
    this.projector.recreate?.(levels);
    window.addEventListener("resize", this.onViewportChange);
    window.addEventListener("scroll", this.onViewportChange, { passive: true });
    return true;
  }

  setBlur(blur2: number) {
    if (this.settings.blur2 === blur2) return;
    this.settings.blur2 = blur2;
    this.sizesChanged = true;
  }

  /** ambientlight.js : updateSizes() (sans barres noires ni zoom video). */
  private updateSizes(srcW: number, srcH: number) {
    const s = this.settings;
    let pScale: number;
    if (s.webGL) {
      const relativeBlur = (s.resolution / 100) * s.blur2;
      let pMinSize =
        (s.resolution / 100) *
        (relativeBlur >= 20 ? 128 : relativeBlur >= 10 ? 192 : 256);
      if (s.spread > 200) pMinSize = pMinSize / 2;
      pScale = Math.min(
        0.5,
        Math.max(pMinSize / srcW, pMinSize / srcH),
        Math.min(1024 / srcW, 1024 / srcH),
      );
    } else {
      const pMinSize = Math.max(257, Math.min(512, srcW, srcH));
      pScale = Math.max(pMinSize / srcW, pMinSize / srcH);
    }
    this.p = { w: Math.ceil(srcW * pScale), h: Math.ceil(srcH * pScale) };
    this.projector.resize(this.p.w, this.p.h);

    const buf = this.projectorBuffer.elem;
    if (this.projector.webGLVersion === 1) {
      const pbSize = Math.min(512, Math.max(srcW, srcH));
      const pow2 = Math.pow(2, 1 + Math.ceil(Math.log(pbSize / 2) / Math.log(2)));
      buf.width = pow2;
      buf.height = pow2;
    } else if (this.projector.webGLVersion === 2) {
      if (buf.width !== this.p.w * 2) buf.width = this.p.w * 2;
      if (buf.height !== this.p.h * 2) buf.height = this.p.h * 2;
    } else {
      buf.width = this.p.w;
      buf.height = this.p.h;
    }

    // Leur flou 2D est un filtre CSS sur l'element parent des projecteurs.
    this.root.style.filter =
      !s.webGL && s.blur2 != 0
        ? `blur(${Math.round(this.root.clientHeight * 0.0025 * s.blur2)}px)`
        : "";

    this.resizeCanvasses();
    this.projector.cropped = false;
  }

  /** ambientlight.js : resizeCanvasses(). */
  private resizeCanvasses() {
    const projectorSize = { w: this.p.w, h: this.p.h };
    const ratio =
      this.p.w > this.p.h
        ? { x: 1, y: projectorSize.w / projectorSize.h }
        : { x: projectorSize.h / projectorSize.w, y: 1 };
    const lastScale = { x: 1, y: 1 };
    const minScale = { x: 1 / projectorSize.w, y: 1 / projectorSize.h };
    const levels = Math.max(
      2,
      Math.round(this.settings.spread / this.settings.edge) + INNER_STRENGTH + 1,
    );
    const scaleStep = this.settings.edge / 100;
    const scales: { x: number; y: number }[] = [];
    for (let i = 0; i < levels; i++) {
      const pos = i - INNER_STRENGTH;
      let scaleX = 1;
      let scaleY = 1;
      if (pos > 0) {
        scaleX = 1 + scaleStep * ratio.x * pos;
        scaleY = 1 + scaleStep * ratio.y * pos;
      }
      if (pos < 0) {
        scaleX = Math.max(0, 1 - scaleStep * ratio.x * -pos);
        scaleY = Math.max(0, 1 - scaleStep * ratio.y * -pos);
      }
      lastScale.x = scaleX;
      lastScale.y = scaleY;
      scales.push({
        x: Math.max(minScale.x, scaleX),
        y: Math.max(minScale.y, scaleY),
      });
    }
    this.projector.rescale(scales, lastScale, projectorSize, [0, 0], this.settings);
  }

  /** ambientlight.js : drawAmbientlight(), branche sans fondu d'images.
   *  `false` = la source est refusee (flux cross-origin teinte en WebGL). */
  draw(src: CanvasImageSource, srcW: number, srcH: number): boolean {
    if (!this.projector || !srcW || !srcH) return true;
    const key = `${srcW}x${srcH}|${this.root.clientHeight}`;
    if (this.sizesChanged || key !== this.srcKey) {
      this.srcKey = key;
      this.sizesChanged = false;
      this.updateSizes(srcW, srcH);
    }
    const buf = this.projectorBuffer;
    try {
      buf.ctx.drawImage(src, 0, 0, buf.elem.width, buf.elem.height);
      this.projector.draw(buf.elem);
    } catch (ex: any) {
      if (ex?.name === "SecurityError") return false;
      console.warn("[ambilight] draw", ex);
    }
    return true;
  }

  destroy() {
    window.removeEventListener("resize", this.onViewportChange);
    window.removeEventListener("scroll", this.onViewportChange);
    this.projectorsElem.remove();
    this.root.style.filter = "";
  }
}
