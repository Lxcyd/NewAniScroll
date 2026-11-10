/**
 * BLAGUE POUR DECHU (10/11/2026, Luc) — a supprimer quand elle a fait son temps.
 *
 * Pour la retirer : supprimer ce fichier, puis la ligne
 * `<DechuPrank />` et son import dans pages/_app.tsx. Rien d'autre n'y touche.
 *
 * Visible seulement pour les comptes de PRANK_USERS, une fois par onglet.
 *  - Trois fenetres : une au milieu (la seule qui se ferme), une longue sur
 *    toute la hauteur a droite, une en bas a gauche. Les deux dernieres
 *    restent tant qu'on n'a pas clique « YES ».
 *  - La croix de celle du milieu (ou « Non ») deverse une pile de fausses
 *    fenetres « virus », moches a dessein. Decor pur : rien n'est installe,
 *    rien ne part nulle part.
 *  - « YES » passe vraiment le site en anglais et ferme tout : c'est la SEULE
 *    sortie, et la blague ne revient pas tant que le site reste en anglais.
 *    Elle reapparait a chaque chargement sinon (plus de limite par onglet).
 *    `?prank=off` la coupe pour l'onglet, `?prank=1` la force.
 */
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { getLang, setLang } from "@/lib/i18n/languagePref";
import { isAdminSession } from "@/lib/auth/isAdmin";

const PRANK_USERS = ["dechu", "lucyd"];
const SEEN_KEY = "aniscroll:dechuPrank";

type Win = {
  id: number;
  x: number;
  y: number;
  w: number;
  rot: number;
  title: string;
  body: string;
  ok: string;
  bg: string;
  stop?: boolean;
};

const FAKES: Omit<Win, "id" | "x" | "y" | "w" | "rot">[] = [
  { title: "⚠ WARNING !!!", body: "VOTRE PC A ETE PIRATE PAR AniScroll !!! (c'est une blague)", ok: "OK", bg: "#ff0" },
  { title: "Windows Defender", body: "17 virus detectes : Dechu.exe, TrojanOmelette.dll, sao_isekai.vbs", ok: "Supprimer", bg: "#f66" },
  { title: "Language Error", body: "Your site is NOT in English. Please fix immediately!!!", ok: "FIX", bg: "#0ff" },
  { title: "FREE ROBUX", body: "Felicitations !!! Vous etes le 1 000 000e visiteur !!! Cliquez pour recuperer", ok: "RECUPERER", bg: "#f0f" },
  { title: "Error 404", body: "Cerveau introuvable. Reessayer ?", ok: "Reessayer", bg: "#9f9" },
  { title: "ALERTE !!!", body: "Des singles chaudes habitent pres de chez vous (non)", ok: "Voir", bg: "#fa0" },
  { title: "Adobe Flash Player", body: "Flash Player est obsolete depuis 2020. Mettre a jour quand meme ?", ok: "Oui", bg: "#ccc" },
  { title: "System32", body: "Suppression de System32 en cours... 99%", ok: "Annuler", bg: "#6cf" },
  { title: "Message de Luc", body: "Je t'avais dit de mettre le site en anglais.", ok: "Pardon", bg: "#fff" },
  { title: "Antivirus Pro 2009", body: "Votre licence a expire. Payez 0,00 € pour continuer", ok: "Payer", bg: "#fcf" },
  { title: "Dechu.exe a cesse de fonctionner", body: "Windows recherche une solution au probleme...", ok: "Fermer", bg: "#eee" },
  { title: "I MAY MARRY EN", body: "EN EN EN EN EN EN EN EN EN EN EN EN EN", ok: "YES", bg: "#f9f", stop: true },
];

/* Les couleurs de la surbrillance du screenshot : rose fluo sur tout. */
const PINK = "#ff1493";

const CSS = `
@keyframes dp-blink{0%,49%{opacity:1}50%,100%{opacity:.35}}
@keyframes dp-shake{0%{transform:translate(0,0)}25%{transform:translate(3px,-2px)}50%{transform:translate(-3px,2px)}75%{transform:translate(2px,3px)}100%{transform:translate(0,0)}}
@keyframes dp-rainbow{0%{background:#f00}20%{background:#ff0}40%{background:#0f0}60%{background:#0ff}80%{background:#00f}100%{background:#f0f}}
@keyframes dp-marquee{from{transform:translateX(100%)}to{transform:translateX(-100%)}}
`;

export default function DechuPrank() {
  const { data: session } = useSession();
  const name = String((session as any)?.user?.name || "").toLowerCase();
  const [phase, setPhase] = useState<"off" | "ask" | "chaos">("off");
  const [wins, setWins] = useState<Win[]>([]);

  useEffect(() => {
    /* `?prank=1` force la blague (test), meme pour un autre compte. Luc est
       reconnu comme admin du site, sans deviner son pseudo. */
    const q = new URLSearchParams(window.location.search).get("prank");
    const forced = q === "1";
    try {
      /* Le seul interrupteur de Luc : `?prank=off` la coupe pour cet onglet. */
      if (q === "off") sessionStorage.setItem(SEEN_KEY, "off");
      if (sessionStorage.getItem(SEEN_KEY) === "off") return;
    } catch {
      /* sans stockage : pas d'interrupteur, la blague reste */
    }
    if (!forced && !PRANK_USERS.includes(name) && !isAdminSession(session)) return;
    /* EN CONTINU, SUR TOUS LES ONGLETS (10/11/2026) : a chaque chargement tant
       que le site n'est pas en anglais. « YES » le passe en anglais — c'est la
       seule sortie. */
    if (!forced && getLang() === "en") return;
    const id = window.setTimeout(() => setPhase("ask"), 2000);
    return () => window.clearTimeout(id);
  }, [name, session]);

  const stopAll = () => {
    setWins([]);
    setPhase("off");
  };
  const yes = () => {
    setLang("en");
    stopAll();
  };

  /* La pile : une fenetre toutes les 110 ms, quarante au total, et on
     recommence tant que la blague n'est pas arretee (plafond 60 a l'ecran). */
  useEffect(() => {
    if (phase !== "chaos") return;
    let n = 0;
    const id = window.setInterval(() => {
      const f = FAKES[n % FAKES.length];
      const win: Win = {
        ...f,
        id: Date.now() + n,
        x: Math.random() * 78,
        y: Math.random() * 80,
        w: 230 + Math.random() * 200,
        rot: Math.random() * 10 - 5,
      };
      setWins((w) => [...w.slice(-59), win]);
      n++;
    }, 110);
    return () => window.clearInterval(id);
  }, [phase]);

  if (phase === "off") return null;

  const win98: React.CSSProperties = {
    fontFamily: '"Comic Sans MS", "Comic Sans", cursive',
    border: "4px outset #fff",
    boxShadow: "8px 8px 0 #000",
    color: "#000",
  };
  const bar = (bg: string, anim?: string): React.CSSProperties => ({
    background: bg,
    padding: "3px 8px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontWeight: 900,
    fontSize: 14,
    color: "#fff",
    textShadow: "2px 2px #000",
    animation: anim,
  });
  const btn: React.CSSProperties = {
    border: "3px outset #fff",
    background: "#c0c0c0",
    padding: "3px 16px",
    fontFamily: "inherit",
    fontWeight: 700,
    cursor: "pointer",
    color: "#000",
  };
  const x: React.CSSProperties = { ...btn, padding: "0 7px", fontSize: 13 };
  const hl = (extra: React.CSSProperties): React.CSSProperties => ({
    position: "fixed",
    border: `6px solid ${PINK}`,
    background: "rgba(255,20,147,.12)",
    boxShadow: `0 0 0 3px #fff, 0 0 30px ${PINK}`,
    fontFamily: '"Comic Sans MS", "Comic Sans", cursive',
    color: PINK,
    textShadow: "2px 2px #fff",
    pointerEvents: "auto",
    ...extra,
  });

  return (
    <>
      <style>{CSS}</style>
      <div style={{ position: "fixed", inset: 0, zIndex: 2147483000, background: phase === "ask" ? "rgba(0,0,0,.55)" : "transparent", pointerEvents: phase === "ask" ? "auto" : "none" }}>
        {/* PERMANENTE : la longue, sur toute la hauteur, a droite. */}
        <div style={hl({ top: 0, right: 0, bottom: 0, width: 270, borderRight: 0, borderTop: 0, borderBottom: 0, animation: "dp-blink 1s steps(1) infinite", padding: 14, textAlign: "center", overflow: "hidden" })}>
          <div style={{ fontSize: 56, lineHeight: 1 }}>♥</div>
          <div style={{ fontSize: 44, fontWeight: 900, lineHeight: 1.05, margin: "18px 0", transform: "rotate(-4deg)" }}>I MAY MARRY EN</div>
          <button type="button" onClick={yes} style={{ ...btn, fontSize: 38, padding: "6px 30px", background: PINK, color: "#fff", borderColor: "#fff" }}>
            YES
          </button>
          <div style={{ fontSize: 56, lineHeight: 1, margin: "26px 0" }}>♥</div>
          <div style={{ fontSize: 30, fontWeight: 900, transform: "rotate(3deg)" }}>EN EN EN EN EN EN</div>
          <div style={{ fontSize: 56, lineHeight: 1, margin: "26px 0" }}>♥</div>
          <button type="button" onClick={yes} style={{ ...btn, fontSize: 30, background: PINK, color: "#fff", borderColor: "#fff" }}>
            YES
          </button>
        </div>

        {/* PERMANENTE : en bas a gauche. */}
        <div style={hl({ left: 0, bottom: 0, width: 320, height: 130, borderLeft: 0, borderBottom: 0, padding: 12, animation: "dp-shake .4s linear infinite" })}>
          <div style={{ fontSize: 32, fontWeight: 900, transform: "rotate(-3deg)" }}>CLIKE EN</div>
          <button type="button" onClick={yes} style={{ ...btn, fontSize: 30, marginTop: 8, background: PINK, color: "#fff", borderColor: "#fff" }}>
            YES
          </button>
        </div>

        {/* LA SEULE QUI SE FERME — et ce n'est pas une bonne idee. */}
        {phase === "ask" ? (
          <div style={{ ...win98, position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%)", width: 420, background: "#c0c0c0", pointerEvents: "auto" }}>
            <div style={bar("#000080")}>
              <span>AniScroll — Langue</span>
              <button type="button" aria-label="Fermer" style={x} onClick={() => setPhase("chaos")}>
                X
              </button>
            </div>
            <div style={{ padding: 18, fontSize: 18 }}>
              <p style={{ margin: "0 0 6px", fontSize: 40, fontWeight: 900, color: PINK, textShadow: "2px 2px #000" }}>EN ?</p>
              <p style={{ margin: "0 0 16px" }}>Voulez-vous passer le site en anglais ?</p>
              <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
                <button type="button" style={{ ...btn, fontSize: 24, background: PINK, color: "#fff" }} onClick={yes}>
                  YES
                </button>
                <button type="button" style={btn} onClick={() => setPhase("chaos")}>
                  Non
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {wins.map((w) => (
          <div key={w.id} style={{ ...win98, position: "absolute", left: `${w.x}%`, top: `${w.y}%`, width: w.w, background: w.bg, transform: `rotate(${w.rot}deg)`, pointerEvents: "auto" }}>
            <div style={bar("#a00", "dp-rainbow .6s steps(1) infinite")}>
              <span>{w.title}</span>
              <button type="button" aria-label="Fermer" style={x} onClick={() => setWins((l) => l.filter((o) => o.id !== w.id))}>
                X
              </button>
            </div>
            <div style={{ padding: 12, fontSize: 15 }}>
              <div style={{ overflow: "hidden", whiteSpace: "nowrap", background: "#000", color: "#0f0", marginBottom: 8, fontFamily: "monospace" }}>
                <div style={{ animation: "dp-marquee 4s linear infinite", display: "inline-block" }}>!!! EN !!! YES !!! EN !!! YES !!! EN !!! YES !!!</div>
              </div>
              <p style={{ margin: "0 0 10px", animation: "dp-blink .8s steps(1) infinite" }}>{w.body}</p>
              <button
                type="button"
                style={btn}
                onClick={() => {
                  if (w.stop) return yes();
                  setWins((l) => l.filter((o) => o.id !== w.id));
                }}
              >
                {w.ok}
              </button>
            </div>
          </div>
        ))}

      </div>
    </>
  );
}
