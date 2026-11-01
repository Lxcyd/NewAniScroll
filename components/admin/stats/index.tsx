/**
 * Onglet « Statistiques » du panneau admin, en CINQ sections (refonte du
 * 01/11/2026, maquette validee par Luc) : vue d'ensemble (tuiles + pannes),
 * lecteurs video (sources, recouvrement, trous, fiche par anime), images &
 * musique, audience, technique. Le diagnostic (`diagnostiquer`) dit ok / a
 * surveiller / panne pour chaque controle ; seules les pannes remontent sur la
 * vue d'ensemble, le reste s'affiche en tete de sa section.
 *
 * Les chiffres viennent de l'instantane calcule par tools/stats/instantane.mjs
 * (GitHub Actions, chaque jour ; catalogue et images chaque semaine), servi par
 * /api/v2/admin/site-stats, historique 90 jours pour les courbes. La fiche par
 * anime interroge /api/v2/admin/anime-sources a la demande.
 *
 * Graphiques : une seule teinte (l'accent du site) par graphique ; les etats
 * portent une icone et un mot, jamais la couleur seule.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, XCircleIcon, ClockIcon, InformationCircleIcon, MinusCircleIcon } from "@heroicons/react/24/outline";

type Ligne = { nom: string | number; n: number; [k: string]: any };
type Section = { data: any; calculeLe: number | null; cout: number | null; dureeMs: number | null; erreur: string | null };
type Reponse = { sections: Record<string, Section>; historique: Record<string, any>[]; vide?: boolean };

/* ── Formats ─────────────────────────────────────────────────────────────── */
const nf = new Intl.NumberFormat("fr-FR");
const fmt = (n: any) => (n == null || Number.isNaN(Number(n)) ? "—" : nf.format(Number(n)));
const compact = (n: any) => (n == null ? "—" : new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(n)));
const pct = (a: any, b: any) => (b ? `${Math.round((Number(a) / Number(b)) * 100)} %` : "—");
function octets(n: any) {
  if (n == null) return "—";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let v = Number(n), i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}
/** Accepte des millisecondes ou des secondes (certaines tables datent en secondes). */
function depuis(ms: any) {
  if (!ms) return "jamais";
  const t = Number(ms) < 1e12 ? Number(ms) * 1000 : Number(ms);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 90) return "a l'instant";
  if (s < 5400) return `il y a ${Math.round(s / 60)} min`;
  if (s < 172800) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
function duree(s: any) {
  if (s == null) return "—";
  s = Number(s);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}
const pays = (() => {
  try { const d = new Intl.DisplayNames(["fr"], { type: "region" }); return (c: string) => { try { return d.of(c) || c; } catch { return c; } }; } catch { return (c: string) => c; }
})();
const tsDate = (v: any) => (v ? new Date(Number(v) < 1e12 ? Number(v) * 1000 : Number(v)).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "—");

/** Une colonne par mois, du premier au mois courant : un mois vide compte zero au lieu de disparaitre. */
function parMois(l: { mois: string; n: number }[] | undefined): Ligne[] {
  if (!l?.length) return [];
  const m = new Map(l.filter((x) => x.mois).map((x) => [x.mois, x.n]));
  const out: Ligne[] = [];
  const [a, b] = l.find((x) => x.mois)!.mois.split("-").map(Number);
  const fin = new Date();
  for (let d = new Date(a, b - 1, 1); d <= fin; d.setMonth(d.getMonth() + 1)) {
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ nom: k, n: m.get(k) || 0 });
  }
  return out;
}

/* ── Briques ─────────────────────────────────────────────────────────────── */
function Carte({ titre, children, className = "", note }: { titre?: string; children: React.ReactNode; className?: string; note?: string }) {
  return (
    <div className={`bg-secondary rounded-md p-4 min-w-0 ${className}`}>
      {titre && <h4 className="font-outfit font-semibold text-white text-sm mb-3">{titre}</h4>}
      {children}
      {note && <p className="mt-3 text-[11px] text-white/40 font-karla">{note}</p>}
    </div>
  );
}

/** Une infobulle qui suit la souris, sans le delai de l'attribut `title`. */
function Survol({ contenu, children, className = "", style }: { contenu: React.ReactNode; children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <div className={className} style={style} onMouseMove={(e) => setPos({ x: e.clientX, y: e.clientY })} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && (
        <div className="pointer-events-none fixed z-50 px-2 py-1 rounded bg-black/90 border border-white/10 text-[11px] font-karla text-white whitespace-nowrap shadow-lg"
          style={{ left: pos.x + 12, top: pos.y + 14 }}>
          {contenu}
        </div>
      )}
    </div>
  );
}

/** Une tuile : un chiffre, son contexte, et sa tendance si l'historique la connait. */
function Tuile({ label, valeur, sous, serie, jours, format = fmt }: { label: string; valeur: React.ReactNode; sous?: React.ReactNode; serie?: (number | null)[]; jours?: string[]; format?: (n: any) => string }) {
  return (
    <div className="bg-secondary rounded-md p-4 flex flex-col gap-1 min-w-0">
      <p className="font-karla text-[11px] text-white/55 uppercase tracking-wider truncate" title={label}>{label}</p>
      <p className="font-karla text-2xl font-bold text-white leading-tight">{valeur}</p>
      {sous && <p className="font-karla text-xs text-white/50">{sous}</p>}
      {serie && serie.filter((x) => x != null).length >= 2 && <Etincelle serie={serie} jours={jours} format={format} />}
    </div>
  );
}

/** La tendance d'une tuile : survoler donne le jour et sa valeur. */
function Etincelle({ serie, jours, format = fmt }: { serie: (number | null)[]; jours?: string[]; format?: (n: any) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [i, setI] = useState<number | null>(null);
  const pts = serie.map((v, k) => [k, v] as const).filter(([, v]) => v != null) as [number, number][];
  const min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1]));
  const W = 120, H = 28;
  const x = (k: number) => (k / Math.max(1, serie.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4);
  const bouge = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const k = Math.round(((e.clientX - r.left) / r.width) * (serie.length - 1));
    setI(Math.min(serie.length - 1, Math.max(0, k)));
  };
  const v = i != null ? serie[i] : null;
  return (
    <div ref={ref} className="relative mt-1 cursor-crosshair" onMouseMove={bouge} onMouseLeave={() => setI(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-7" preserveAspectRatio="none" aria-hidden>
        <polyline fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" className="text-action" points={pts.map(([k, w]) => `${x(k)},${y(w)}`).join(" ")} />
        {i != null && v != null && <line x1={x(i)} x2={x(i)} y1={0} y2={H} stroke="currentColor" className="text-white/40" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      {i != null && (
        <div className="pointer-events-none absolute -top-7 px-2 py-0.5 rounded bg-black/90 text-[11px] text-white whitespace-nowrap"
          style={{ left: `${(i / Math.max(1, serie.length - 1)) * 100}%`, transform: `translateX(${i > serie.length / 2 ? "-100%" : "0"})` }}>
          <span className="text-white/60">{jours?.[i] || ""}</span> {format(v)}
        </div>
      )}
    </div>
  );
}

/** Barres horizontales triees : une seule mesure, une seule teinte, la part en clair. */
function Barres({ lignes, max = 12, format = fmt, libelle = (x: any) => String(x), total, large = false }: { lignes: Ligne[]; max?: number; format?: (n: any) => string; libelle?: (x: any) => string; total?: number; large?: boolean }) {
  const [tout, setTout] = useState(false);
  if (!lignes?.length) return <p className="text-xs text-white/40 font-karla">Aucune donnee.</p>;
  const somme = total ?? lignes.reduce((s, l) => s + (Number(l.n) || 0), 0);
  // Avec un total donne (part d'un ensemble), la barre est cette part ; sinon, relative au plus grand.
  const haut = total ?? (Math.max(...lignes.map((l) => Number(l.n) || 0)) || 1);
  const vues = tout ? lignes : lignes.slice(0, max);
  return (
    <div className="flex flex-col gap-1.5">
      {vues.map((l) => (
        <Survol key={String(l.nom)} contenu={<><span className="text-white/60">{libelle(l.nom)}</span> · {format(l.n)} · {pct(l.n, somme)}</>}
          className={`group grid ${large ? "grid-cols-[minmax(0,20rem)_1fr_auto]" : "grid-cols-[minmax(0,9rem)_1fr_auto]"} items-center gap-2 text-xs font-karla rounded hover:bg-white/[0.04] -mx-1 px-1 py-0.5 cursor-default`}>
          <span className="text-white/70 truncate group-hover:text-white">{libelle(l.nom)}</span>
          <span className="h-2.5 rounded-sm bg-white/5 overflow-hidden">
            <span className="block h-full rounded-sm bg-action opacity-70 group-hover:opacity-100 transition-opacity" style={{ width: `${Math.max(1.5, ((Number(l.n) || 0) / haut) * 100)}%` }} />
          </span>
          <span className="text-white tabular-nums text-right">{format(l.n)} <span className="text-white/40">{pct(l.n, somme)}</span></span>
        </Survol>
      ))}
      {lignes.length > max && (
        <button type="button" onClick={() => setTout(!tout)} className="self-start mt-1 text-[11px] text-action hover:underline">
          {tout ? "Reduire" : `Voir les ${lignes.length} lignes`}
        </button>
      )}
    </div>
  );
}

/** Courbe d'une mesure dans le temps, avec reticule et infobulle au survol. */
function Courbe({ points, format = fmt, hauteur = 160 }: { points: { x: string; y: number | null }[]; format?: (n: any) => string; hauteur?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [survol, setSurvol] = useState<number | null>(null);
  const valides = points.filter((p) => p.y != null);
  if (valides.length < 2) return <p className="text-xs text-white/40 font-karla">Pas encore assez de jours pour une courbe — l'historique se remplit a chaque calcul.</p>;
  const W = 600, H = hauteur, G = 36, B = 18;
  const max = Math.max(...valides.map((p) => p.y as number)) || 1;
  const x = (i: number) => G + (i / Math.max(1, points.length - 1)) * (W - G - 4);
  const y = (v: number) => H - B - (v / max) * (H - B - 8);
  const ligne = points.map((p, i) => (p.y == null ? null : `${x(i)},${y(p.y)}`)).filter(Boolean).join(" ");
  const aire = `${x(points.findIndex((p) => p.y != null))},${H - B} ${ligne} ${x(points.length - 1 - [...points].reverse().findIndex((p) => p.y != null))},${H - B}`;
  const graduations = [0, 0.5, 1].map((f) => Math.round(max * f));
  const bouge = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - G) / (W - G - 4)) * (points.length - 1));
    setSurvol(Math.min(points.length - 1, Math.max(0, i)));
  };
  const s = survol != null ? points[survol] : null;
  return (
    <div ref={ref} className="relative" onMouseMove={bouge} onMouseLeave={() => setSurvol(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: hauteur }} preserveAspectRatio="none" role="img">
        {graduations.map((g) => (
          <g key={g}>
            <line x1={G} x2={W} y1={y(g)} y2={y(g)} stroke="currentColor" className="text-white/10" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <text x={G - 6} y={y(g) + 4} textAnchor="end" className="fill-white/40" style={{ fontSize: 10 }}>{compact(g)}</text>
          </g>
        ))}
        <polygon points={aire} fill="currentColor" fillOpacity={0.15} className="text-action" />
        <polyline points={ligne} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" className="text-action" />
        {s && s.y != null && (
          <>
            <line x1={x(survol!)} x2={x(survol!)} y1={4} y2={H - B} stroke="currentColor" className="text-white/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(survol!)} cy={y(s.y)} r={4} className="fill-action stroke-secondary" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </>
        )}
        <text x={G} y={H - 3} className="fill-white/40" style={{ fontSize: 10 }}>{points[0].x}</text>
        <text x={W - 4} y={H - 3} textAnchor="end" className="fill-white/40" style={{ fontSize: 10 }}>{points[points.length - 1].x}</text>
      </svg>
      {s && (
        <div className="pointer-events-none absolute top-1 px-2 py-1 rounded bg-black/85 text-[11px] font-karla text-white whitespace-nowrap"
          style={{ left: `${(x(survol!) / W) * 100}%`, transform: `translateX(${survol! > points.length / 2 ? "-105%" : "5%"})` }}>
          <span className="text-white/60">{s.x}</span> · {format(s.y)}
        </div>
      )}
    </div>
  );
}

/** Colonnes verticales (une par periode), infobulle au survol de chacune. */
function Colonnes({ lignes, format = fmt }: { lignes: Ligne[]; format?: (n: any) => string }) {
  if (!lignes?.length) return <p className="text-xs text-white/40 font-karla">Aucune donnee.</p>;
  const max = Math.max(...lignes.map((l) => Number(l.n) || 0)) || 1;
  return (
    <div>
      <div className="flex items-end gap-[2px] h-32">
        {lignes.map((l) => (
          <Survol key={String(l.nom)} contenu={<><span className="text-white/60">{l.nom}</span> · {format(l.n)}</>} className="group relative flex-1 h-full flex items-end cursor-default">
            <div className="w-full rounded-t-[3px] bg-action opacity-60 group-hover:opacity-100 transition-opacity" style={{ height: `${Math.max(1, ((Number(l.n) || 0) / max) * 100)}%` }} />
          </Survol>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-white/40 font-karla mt-1">
        <span>{lignes[0].nom}</span><span>{lignes[lignes.length - 1].nom}</span>
      </div>
    </div>
  );
}

function Tableau({ colonnes, lignes, vide = "Aucune donnee.", max = 1e9 }: { colonnes: { titre: string; rendu: (l: any) => React.ReactNode; droite?: boolean }[]; lignes: any[]; vide?: string; max?: number }) {
  const [tout, setTout] = useState(false);
  if (!lignes?.length) return <p className="text-xs text-white/40 font-karla">{vide}</p>;
  const vues = tout ? lignes : lignes.slice(0, max);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-karla">
        <thead>
          <tr className="text-white/45 text-left">
            {colonnes.map((c) => <th key={c.titre} className={`font-normal pb-2 pr-3 ${c.droite ? "text-right" : ""}`}>{c.titre}</th>)}
          </tr>
        </thead>
        <tbody>
          {vues.map((l, i) => (
            <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03]">
              {colonnes.map((c) => <td key={c.titre} className={`py-1.5 pr-3 text-white/85 ${c.droite ? "text-right tabular-nums" : ""}`}>{c.rendu(l)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {lignes.length > max && (
        <button type="button" onClick={() => setTout(!tout)} className="mt-2 text-[11px] text-action hover:underline">
          {tout ? "Reduire" : `Voir les ${lignes.length} lignes`}
        </button>
      )}
    </div>
  );
}

/** Une jauge de quota : la part consommee, et la projection en fin de periode. */
function Jauge({ label, part, projection, detail }: { label: string; part: number | null; projection?: number | null; detail?: React.ReactNode }) {
  if (part == null && projection == null) {
    return (
      <div className="flex flex-col gap-1.5 text-xs font-karla">
        <span className="text-white/70">{label}</span>
        <span className="text-white/40">Non mesure dans ce calcul (identifiants absents ou API injoignable).</span>
      </div>
    );
  }
  const etat = (projection ?? part ?? 0) >= 100 ? "critique" : (projection ?? part ?? 0) >= 70 ? "attention" : "ok";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs font-karla">
        <span className="text-white/70">{label}</span>
        <span className="text-white tabular-nums">{part == null ? "—" : `${part} %`}{projection != null && <span className="text-white/45"> · projection {projection} %</span>}</span>
      </div>
      <div className="h-2.5 rounded-sm bg-white/5 overflow-hidden">
        <div className="h-full rounded-sm bg-action" style={{ width: `${Math.min(100, part || 0)}%` }} />
      </div>
      <div className="flex items-center gap-1.5 text-[11px] font-karla text-white/50">
        <Etat etat={etat === "ok" ? "success" : etat === "attention" ? "warning" : "failure"} texte={etat === "ok" ? "dans les clous" : etat === "attention" ? "a surveiller" : "plafond atteint en fin de periode"} />
        {detail}
      </div>
    </div>
  );
}

/** Un etat porte une icone ET un mot : jamais la couleur seule. */
function Etat({ etat, texte }: { etat: string | null | undefined; texte?: string }) {
  const m: Record<string, [any, string, string]> = {
    success: [CheckCircleIcon, "text-emerald-400", "reussi"],
    failure: [XCircleIcon, "text-rose-400", "echec"],
    warning: [ExclamationTriangleIcon, "text-amber-400", "attention"],
    cancelled: [XCircleIcon, "text-white/40", "annule"],
    skipped: [ClockIcon, "text-white/40", "saute"],
    in_progress: [ArrowPathIcon, "text-sky-300", "en cours"],
    queued: [ClockIcon, "text-sky-300", "en file"],
  };
  const [Icone, couleur, mot] = m[etat || ""] || [ClockIcon, "text-white/40", etat || "—"];
  return <span className={`inline-flex items-center gap-1 ${couleur}`}><Icone className="w-3.5 h-3.5" /><span className="text-white/75">{texte || mot}</span></span>;
}

/* ── Le diagnostic : chaque controle dit « ok », « a surveiller » ou « panne » ─ */
type Niveau = "panne" | "attention" | "info" | "ok";
type Controle = { domaine: string; onglet: string; nom: string; niveau: Niveau; detail: React.ReactNode; lien?: string };
const RANG: Record<Niveau, number> = { panne: 0, attention: 1, info: 2, ok: 3 };
const ageS = (v: any) => (v ? (Date.now() - (Number(v) < 1e12 ? Number(v) * 1000 : Number(v))) / 1000 : Infinity);
const H = 3600;
const MOT_PASSAGE: Record<string, string> = { success: "reussi", in_progress: "en cours depuis", queued: "en file depuis", cancelled: "annule", skipped: "saute" };



function diagnostiquer(r: Reponse): Controle[] {
  const S = (id: string) => r.sections?.[id]?.data || {};
  const out: Controle[] = [];
  const c = (x: Controle) => out.push(x);

  /* Les chiffres eux-memes : un instantane perime ment sur tout le reste. */
  for (const [id, s] of Object.entries(r.sections)) {
    const hebdo = ["catalogue", "images"].includes(id);
    const limite = id === "automatisations" ? 3 * H : hebdo ? 8 * 24 * H : 30 * H;
    const age = ageS(s.calculeLe);
    c({
      domaine: "Statistiques", onglet: "infra", nom: `Section « ${id} »`,
      niveau: s.erreur ? "attention" : age > limite ? "attention" : "ok",
      detail: s.erreur ? `dernier calcul en erreur : ${s.erreur}` : age > limite ? `pas recalculee depuis ${depuis(s.calculeLe).replace("il y a ", "")}` : `calculee ${depuis(s.calculeLe)}`,
    });
  }

  /* GitHub Actions. */
  const auto = S("automatisations");
  for (const wf of auto.workflows || []) {
    if (!wf.actif) { c({ domaine: "GitHub Actions", onglet: "github", nom: wf.nom, niveau: "info", detail: "desactive" }); continue; }
    if (!wf.dernier) continue;
    const echecs7 = (wf.passages || []).filter((x: any) => x.etat === "failure" && ageS(Date.parse(x.quand)) < 7 * 24 * H).length;
    const echec = (auto.echecs || []).find((e: any) => e.id === wf.dernier.id);
    const pourquoi = echec?.jobs?.length ? ` — ${echec.jobsRates}/${echec.jobsTotal} job(s) : ${echec.jobs[0].nom}${echec.jobs[0].etape ? ` (etape « ${echec.jobs[0].etape} »)` : ""}` : "";
    if (wf.dernier.etat === "failure") c({ domaine: "GitHub Actions", onglet: "github", nom: wf.nom, niveau: "panne", detail: `dernier passage en echec ${depuis(Date.parse(wf.dernier.quand))}${pourquoi}`, lien: wf.dernier.url });
    else if (wf.enRetard) c({ domaine: "GitHub Actions", onglet: "github", nom: wf.nom, niveau: "panne", detail: `ne tourne plus : dernier passage ${depuis(Date.parse(wf.dernier.quand))}, attendu toutes les ${duree(wf.rythme)}`, lien: wf.dernier.url });
    else if (echecs7) c({ domaine: "GitHub Actions", onglet: "github", nom: wf.nom, niveau: "attention", detail: `${echecs7} echec(s) en 7 jours, le dernier passage a reussi`, lien: wf.dernier.url });
    else c({ domaine: "GitHub Actions", onglet: "github", nom: wf.nom, niveau: "ok", detail: `${MOT_PASSAGE[wf.dernier.etat] || wf.dernier.etat} ${depuis(Date.parse(wf.dernier.quand))}`, lien: wf.dernier.url });
  }

  /* Le site vu par Cloudflare : les 5xx du site, separes de ceux du proxy video. */
  const au = S("audience");
  if (au.indisponible) c({ domaine: "Site", onglet: "audience", nom: "Mesures Cloudflare", niveau: "attention", detail: au.indisponible });
  else if (au.hotes24h) {
    const req = (h: string) => (au.hotes24h || []).filter((x: any) => x.nom === h).reduce((s: number, x: any) => s + x.n, 0);
    const err = (h: string) => (au.erreurs24h || []).filter((x: any) => x.hote === h).reduce((s: number, x: any) => s + x.n, 0);
    for (const h of ["aniscroll.com", "www.aniscroll.com", "dev.aniscroll.com"]) {
      const n = req(h), e = err(h);
      if (!n) continue;
      const p = (e / n) * 100;
      c({ domaine: "Site", onglet: "audience", nom: `Erreurs serveur · ${h}`, niveau: p > 1 ? "panne" : p > 0.2 ? "attention" : "ok", detail: `${fmt(e)} reponse(s) 5xx sur ${fmt(n)} requetes en 24 h (${p.toFixed(2)} %)` });
    }
    const n = req("proxy.aniscroll.com"), e = err("proxy.aniscroll.com");
    if (n) {
      const p = (e / n) * 100;
      c({ domaine: "Site", onglet: "audience", nom: "Proxy video · erreurs des lecteurs", niveau: p > 30 ? "attention" : "ok",
        detail: `${p.toFixed(0)} % des requetes en 5xx sur 24 h — le proxy relaie l'echec du lecteur source (504 : trop lent, 503 : refus)` });
    }
  }

  /* Les chaines de donnees. */
  const fr = S("fraicheur");
  if (fr.fanarts) {
    const f = fr.fanarts, b = f.bilan;
    const age = ageS(f.dernierPassage);
    c({ domaine: "Donnees", onglet: "donnees", nom: "Fanarts · rafraichissement quotidien", niveau: age > 30 * H ? "panne" : b?.latestFailed ? "attention" : "ok",
      detail: age > 30 * H ? `aucun passage depuis ${depuis(f.dernierPassage).replace("il y a ", "")}` : b ? `${depuis(b.at)} : ${fmt(b.refreshed)} anime(s) revu(s), ${fmt(b.added)} image(s) ajoutee(s)${b.errors ? `, ${b.errors} erreur(s)` : ""}` : `passage ${depuis(f.dernierPassage)} (bilan detaille au prochain passage)` });
    if (b && b.tvLatest === 0 && b.tvRotation) c({ domaine: "Donnees", onglet: "donnees", nom: "Fanarts · series TV", niveau: "info", detail: `fanart.tv ne liste plus les series modifiees : rotation active (${b.tvRotation}), tout le catalogue en 7 jours` });
    c({ domaine: "Donnees", onglet: "donnees", nom: "Fanarts · classement NSFW", niveau: (f.nonClasses || 0) > 500 ? "attention" : "ok", detail: `${fmt(f.nonClasses)} image(s) en attente de classement` });
  }
  if (fr.wallhaven) {
    const w = fr.wallhaven, cat = (w.progres || []).find((p: any) => p.tache === "catalogue"), tags = (w.progres || []).find((p: any) => p.tache === "tags");
    const fini = cat?.curseur === "fini";
    c({ domaine: "Donnees", onglet: "donnees", nom: "Wallhaven · catalogue Anime", niveau: cat && ageS(cat.maj_at) > 30 * H && !fini ? "attention" : "ok",
      detail: fini ? `complet, ${fmt(w.brut)} images` : cat ? `page ${fmt(cat.curseur)} sur 3 693 (${fmt(w.brut)} images), avance ${depuis(cat.maj_at)}` : "pas commence" });
    c({ domaine: "Donnees", onglet: "donnees", nom: "Wallhaven · etiquetage", niveau: (w.aEtiqueter || 0) > 0 && tags && ageS(tags.maj_at) > 30 * H ? "attention" : "ok",
      detail: `${fmt(w.aEtiqueter)} image(s) encore a etiqueter, ${fmt(w.aAttribuer)} a attribuer` });
  }
  for (const [nom, x] of [["Copie anime-sama", fr.animeSama], ["Copie voir-anime", fr.voirAnime]] as const) {
    if (!x?.maj) continue;
    c({ domaine: "Donnees", onglet: "donnees", nom, niveau: ageS(x.maj) > 30 * H ? "panne" : "ok", detail: `${fmt(x.n)} pages, derniere ecriture ${depuis(x.maj)}` });
  }
  if (fr.playerMap?.maj) c({ domaine: "Donnees", onglet: "donnees", nom: "Correspondances (player_map)", niveau: ageS(fr.playerMap.maj) > 48 * H ? "attention" : "ok", detail: `derniere verification ${depuis(fr.playerMap.maj)}` });
  if (fr.animesPerimes != null) c({ domaine: "Donnees", onglet: "donnees", nom: "Fiches AniList en cache", niveau: fr.animesPerimes > 3000 ? "attention" : "ok", detail: `${fmt(fr.animesPerimes)} fiche(s) perimee(s), rafraichies a la demande` });

  /* Quotas. */
  const inf = S("infra");
  const quota = (nom: string, proj: number | null | undefined, part: number | null | undefined) => {
    if (proj == null && part == null) return c({ domaine: "Quotas", onglet: "infra", nom, niveau: "info", detail: "non mesure dans ce calcul" });
    const v = proj ?? part ?? 0;
    c({ domaine: "Quotas", onglet: "infra", nom, niveau: v >= 100 ? "panne" : v >= 85 ? "attention" : "ok", detail: `${part ?? "—"} % consomme${proj != null ? `, projection ${proj} % en fin de periode` : ""}` });
  };
  quota("Turso · lignes lues du mois", inf.turso?.projection, inf.turso?.pct);
  if (inf.upstash?.plafondAtteint) c({ domaine: "Quotas", onglet: "infra", nom: "Upstash · cache Redis coupe", niveau: "panne", detail: "plafond mensuel de commandes atteint : Upstash refuse tout jusqu'au 1er du mois, le site tourne sans cache (CPU Vercel en hausse)" });
  else quota("Upstash · commandes du mois", inf.upstash?.projection, null);

  /* Moderation. */
  const mo = S("moderation");
  if (mo.signalements) c({ domaine: "Moderation", onglet: "moderation", nom: "Signalements", niveau: mo.signalements.ouverts ? "attention" : "ok", detail: `${fmt(mo.signalements.ouverts)} ouvert(s), ${fmt(mo.signalements.nouveaux7j)} nouveau(x) en 7 jours` });

  return out.sort((a, b) => RANG[a.niveau] - RANG[b.niveau]);
}

const NIVEAU: Record<Niveau, [any, string, string]> = {
  panne: [XCircleIcon, "text-rose-400", "panne"],
  attention: [ExclamationTriangleIcon, "text-amber-400", "a surveiller"],
  info: [InformationCircleIcon, "text-sky-300", "info"],
  ok: [CheckCircleIcon, "text-emerald-400", "ok"],
};
function Pastille({ niveau }: { niveau: Niveau }) {
  const [Icone, couleur, mot] = NIVEAU[niveau];
  return <span className={`inline-flex items-center gap-1 shrink-0 ${couleur}`}><Icone className="w-4 h-4" /><span className="text-[11px] text-white/70 w-[5.5rem]">{mot}</span></span>;
}

function LigneControle({ x, aller }: { x: Controle; aller: (o: string) => void }) {
  return (
    <div className="flex items-start gap-3 py-2 border-t border-white/5 first:border-t-0 text-sm">
      <Pastille niveau={x.niveau} />
      <div className="min-w-0 flex-1">
        <p className="text-white">{x.nom}</p>
        <p className="text-xs text-white/55 break-words">{x.detail}</p>
      </div>
      <div className="shrink-0 flex items-center gap-2 text-[11px]">
        {x.lien && <a href={x.lien} target="_blank" rel="noreferrer" className="text-white/50 hover:text-white underline-offset-2 hover:underline">GitHub ↗</a>}
        <button type="button" onClick={() => aller(x.onglet)} className="text-action hover:underline">detail</button>
      </div>
    </div>
  );
}

/* ── Les cinq sections (refonte du 01/11/2026) ───────────────────────────────
   Onze onglets devenus cinq : la vue d'ensemble (tuiles + VRAIES pannes), les
   lecteurs video (sources, recouvrement, trous, fiche par anime), les images
   et la musique, l'audience, la technique (automatisations, quotas, bases,
   moderation). Chaque controle du diagnostic est range dans la section qui
   montre son detail ; « a surveiller » ne s'affiche que la. */
const SECTIONS: { id: string; titre: string }[] = [
  { id: "apercu", titre: "Vue d'ensemble" },
  { id: "video", titre: "Lecteurs video" },
  { id: "images", titre: "Images & musique" },
  { id: "audience", titre: "Audience" },
  { id: "tech", titre: "Technique" },
];
const CLE_ONGLET = "admin-stats-section";
function sectionDe(x: Controle): string {
  if (x.onglet === "donnees") return /Copie|Correspondances|Fiches/.test(x.nom) ? "video" : "images";
  if (x.onglet === "lecteurs" || x.onglet === "catalogue") return "video";
  return "tech";
}

export default function AdminStats() {
  const [r, setR] = useState<Reponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [charge, setCharge] = useState(true);
  const [onglet, setOngletBrut] = useState("apercu");
  useEffect(() => { try { const o = localStorage.getItem(CLE_ONGLET); if (o && SECTIONS.some((x) => x.id === o)) setOngletBrut(o); } catch {} }, []);
  const setOnglet = useCallback((o: string) => { setOngletBrut(o); try { localStorage.setItem(CLE_ONGLET, o); } catch {} }, []);
  const charger = useCallback(async () => {
    setCharge(true); setErreur(null);
    try {
      const res = await fetch("/api/v2/admin/site-stats");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setR(j);
    } catch (e: any) { setErreur(String(e?.message || e)); } finally { setCharge(false); }
  }, []);
  useEffect(() => { charger(); }, [charger]);
  const controles = useMemo(() => (r && !r.vide ? diagnostiquer(r).map((x) => ({ ...x, onglet: sectionDe(x) })) : []), [r]);
  const serie = useCallback((cle: string) => (r?.historique || []).map((h) => (h[cle] == null ? null : Number(h[cle]))), [r]);

  if (charge && !r) return <div className="px-6 py-8 text-white/60 font-karla">Chargement des statistiques…</div>;
  if (erreur) return <div className="px-6 py-8 text-rose-300 font-karla">Erreur : {erreur}</div>;
  if (!r || r.vide || !Object.keys(r.sections).length) {
    return (
      <div className="px-6 py-8 font-karla text-white/70">
        Aucun instantane pour l'instant. Il est calcule chaque matin par le workflow « stats-site » ; pour le lancer tout de suite :
        <code className="ml-1 bg-white/10 px-1 rounded">node tools/stats/instantane.mjs --tout</code>
      </div>
    );
  }

  const alertes = (o: string) => controles.filter((x) => x.onglet === o && (x.niveau === "panne" || x.niveau === "attention"));
  const calcule = (...ids: string[]) => {
    const x = ids.map((i) => r.sections[i]).filter(Boolean);
    if (!x.length) return null;
    return (
      <p className="text-[11px] text-white/40">
        Calcule {depuis(Math.min(...x.map((s) => s.calculeLe || 0)))}
        {x.some((s) => s.erreur) && <span className="text-amber-300"> · dernier calcul en erreur : {x.find((s) => s.erreur)!.erreur}</span>}
      </p>
    );
  };
  const jours = (r.historique || []).map((h) => String(h.jour).slice(5));
  const props = { r, serie, jours, aller: setOnglet, calcule, alertes };

  return (
    <div className="px-4 md:px-6 py-6 flex flex-col gap-6 font-karla">
      <nav className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-2 bg-primary/95 backdrop-blur flex items-center gap-1 overflow-x-auto scrollbar-hide border-b border-white/5" role="tablist">
        {SECTIONS.map((o) => {
          const a = o.id === "apercu" ? controles.filter((x) => x.niveau === "panne") : alertes(o.id);
          const panne = a.some((x) => x.niveau === "panne");
          return (
            <button key={o.id} type="button" role="tab" aria-selected={onglet === o.id} onClick={() => setOnglet(o.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded font-semibold transition-colors ${onglet === o.id ? "bg-action text-black" : "text-white/65 hover:text-white hover:bg-white/5"}`}>
              {o.titre}
              {a.length > 0 && <span className={`text-[10px] font-bold px-1.5 rounded-full ${panne ? "bg-rose-500 text-white" : "bg-amber-400 text-black"}`}>{a.length}</span>}
            </button>
          );
        })}
        <span className="ml-auto shrink-0 text-[11px] text-white/40 hidden md:inline">instantane {depuis(Math.min(...Object.values(r.sections).map((s) => s.calculeLe || Date.now())))}</span>
        <button type="button" onClick={charger} className="shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20" title="Relire l'instantane">
          <ArrowPathIcon className={`w-3.5 h-3.5 ${charge ? "animate-spin" : ""}`} /> Relire
        </button>
      </nav>

      {onglet === "apercu" && <SectionApercu {...props} controles={controles} />}
      {onglet === "video" && <SectionVideo {...props} />}
      {onglet === "images" && <SectionImages {...props} />}
      {onglet === "audience" && <SectionAudience {...props} />}
      {onglet === "tech" && <SectionTech {...props} />}
    </div>
  );
}

type PropsSection = {
  r: Reponse;
  serie: (k: string) => (number | null)[];
  jours: string[];
  aller: (o: string) => void;
  calcule: (...ids: string[]) => React.ReactNode;
  alertes: (o: string) => Controle[];
};
const donnees = (r: Reponse, id: string) => r.sections?.[id]?.data || {};

/** Le titre d'une section, quand ses chiffres ont ete calcules, et ses alertes en tete. */
function Panneau({ titre, sous, alertes, aller, children }: { titre: string; sous?: React.ReactNode; alertes?: Controle[]; aller?: (o: string) => void; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-outfit text-xl font-bold text-white">{titre}</h2>
        {sous}
      </div>
      {!!alertes?.length && aller && (
        <div className="bg-secondary rounded-md px-4 py-1 border border-amber-400/30">
          {alertes.map((x, i) => <LigneControle key={i} x={x} aller={aller} />)}
        </div>
      )}
      {children}
    </section>
  );
}

/** Un bloc replie par defaut : le detail qu'on ne regarde pas tous les jours. */
function Repli({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <details className="bg-secondary rounded-md group">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-white/80 hover:text-white list-none flex items-center gap-2">
        <span className="transition-transform group-open:rotate-90">›</span>{titre}
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-3">{children}</div>
    </details>
  );
}

/* ── Vue d'ensemble ──────────────────────────────────────────────────────── */
function SectionApercu({ r, serie, jours, aller, controles }: PropsSection & { controles: Controle[] }) {
  const vi = donnees(r, "video"), au = donnees(r, "audience"), co = donnees(r, "comptes"), inf = donnees(r, "infra"), fr = donnees(r, "fraicheur");
  const pannes = controles.filter((x) => x.niveau === "panne");
  const attention = controles.filter((x) => x.niveau === "attention");
  const vivantes = vi.resume?.videosVivantes, mortes = vi.resume?.videosMortes;
  const quotas = [["Turso", inf.turso?.projection ?? inf.turso?.pct], ["Upstash", inf.upstash?.projection]].filter(([, v]) => v != null) as [string, number][];
  const pire = quotas.sort((a, b) => b[1] - a[1])[0];
  const w = fr.wallhaven || {};
  return (
    <section className="flex flex-col gap-5">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Tuile label="Animes jouables" valeur={fmt(vi.resume?.animesJouables)} sous={`dont ${fmt(vi.resume?.avecVf)} avec VF`} jours={jours} serie={serie("video.animesJouables")} />
        <Tuile label="Videos vivantes" valeur={fmt(vivantes)} sous={`${pct(vivantes, (vivantes || 0) + (mortes || 0))} des liens · ${fmt(mortes)} morts`} jours={jours} serie={serie("video.videosVivantes")} />
        <Tuile label="Visiteurs hier" valeur={fmt(au.resume?.visiteursHier)} sous={`${fmt(au.resume?.visiteurs7j)} sur 7 jours`} jours={jours} serie={serie("audience.visiteursHier")} />
        <Tuile label="Comptes" valeur={fmt(co.comptes?.total)} sous={`${fmt(co.comptes?.actifs7j)} actifs sur 7 jours`} jours={jours} serie={serie("comptes.comptes")} />
        <Tuile label="Quota le plus haut" valeur={pire ? `${pire[1]} %` : "—"} sous={pire ? `${pire[0]}, projection fin de mois` : "non mesure"} />
        <Tuile label="Pannes" valeur={fmt(pannes.length)} sous={`${fmt(attention.length)} point(s) a surveiller`} />
      </div>

      <Carte titre={pannes.length ? `A corriger maintenant (${pannes.length})` : "Rien a corriger"}>
        {pannes.length
          ? pannes.map((x, i) => <LigneControle key={i} x={x} aller={aller} />)
          : <p className="text-sm text-white/60 flex items-center gap-2"><CheckCircleIcon className="w-5 h-5 text-emerald-400" />Aucune panne. Les points a surveiller sont dans leur section, signales par une pastille orange.</p>}
      </Carte>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[
          ["video", "Lecteurs video", `${fmt(vi.sources?.animeSama?.fiches)} fiches anime-sama, ${fmt(vi.sources?.voirAnime?.pages)} pages voir-anime. Top 500 AniList : ${fmt(vi.resume?.top500SansVideo)} sans video, ${fmt(vi.resume?.top500Incomplets)} incomplets ; ${fmt(vi.resume?.enCoursEnRetard)} anime(s) en cours en retard.`],
          ["images", "Images & musique", `Wallhaven : ${fmt(w.brut)} images cataloguees, ${fmt(w.aEtiqueter)} a etiqueter. Fanarts, TMDB, AniList, musiques.`],
          ["audience", "Audience", `${fmt(au.resume?.visiteursHier)} visiteurs hier, ${compact(au.resume?.pages30j)} pages vues sur 30 jours. Pays, appareils, comptes.`],
          ["tech", "Technique", `${fmt(donnees(r, "automatisations").resume?.automatisationsEnEchec)} automatisation(s) en echec, ${fmt(donnees(r, "automatisations").resume?.echecs7j)} echec(s) sur 7 jours. Quotas, bases, moderation.`],
        ].map(([id, titre, texte]) => (
          <button key={id} type="button" onClick={() => aller(id)} className="text-left bg-secondary hover:bg-white/[0.07] rounded-md p-4 flex flex-col gap-1.5 transition-colors">
            <span className="text-white font-semibold">{titre} →</span>
            <span className="text-sm text-white/60 leading-relaxed">{texte}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* ── Lecteurs video ──────────────────────────────────────────────────────── */
function SectionVideo({ r, serie, jours, aller, calcule, alertes }: PropsSection) {
  const vi = donnees(r, "video"), le = donnees(r, "lecteurs"), op = donnees(r, "oped");
  const as = vi.sources?.animeSama || {}, va = vi.sources?.voirAnime || {}, rec = vi.recouvrement || {}, t = vi.trous || {}, ra = vi.rattachement || {};
  if (!vi.sources) return <Panneau titre="Lecteurs video" sous={calcule("video")}><p className="text-sm text-white/50">La section « video » n'a pas encore ete calculee (prochain passage du workflow stats-site, ou <code>node tools/stats/instantane.mjs --sections=video</code>).</p></Panneau>;
  const perf: Record<string, any> = (le.perf || []).reduce((m: any, x: any) => { (m[x.nom] ||= {})[x.crit] = { ewma: Number(x.ewma), n: x.n }; return m; }, {});
  const mesures = Object.values(perf).reduce((s: number, p: any) => s + (p.t?.n || 0), 0);
  const lecteurs = [
    { nom: "Ansembed", via: "anime-sama", ids: ["animesama-ansembed", "animesama-ansembed-vo"], videos: as.vivants, total: (as.vivants || 0) + (as.morts || 0) },
    { nom: "Vidmoly (myTV)", via: "voir-anime", ids: ["voiranime-vidmoly", "voiranime-vidmoly-vo"], videos: va.vivants, total: (va.vivants || 0) + (va.morts || 0) },
    { nom: "Frembed", via: `${fmt(vi.sources?.frembed?.animes)} animes`, ids: ["frembed", "frembed-vo"], videos: null, total: null },
    { nom: "Sendvid", via: `anime-sama · ${fmt(vi.part?.sendvid?.panneaux)} panneaux, ${fmt(vi.part?.sendvid?.seulLecteur)} ou il est seul`, ids: ["animesama-sendvid", "animesama-sendvid-vo"], videos: vi.part?.sendvid?.liens ?? null, total: null },
    { nom: "Megaplay", via: "iframe, repli", ids: ["megaplay"], videos: null, total: null },
  ].map((l) => {
    const p = l.ids.map((id) => perf[id]).filter(Boolean);
    const n = p.reduce((s, x) => s + (x.t?.n || 0), 0);
    const demarrage = n ? p.reduce((s, x) => s + (x.t ? x.t.ewma * x.t.n : 0), 0) / n : null;
    return { ...l, mesures: n, demarrage, part: mesures ? n / mesures : null };
  });
  const listeTrou = (lignes: any[], rendu: (x: any) => React.ReactNode, max = 8) => <ListeCourte lignes={lignes} rendu={rendu} max={max} />;
  return (
    <Panneau titre="Lecteurs video" sous={calcule("video", "lecteurs")} alertes={alertes("video")} aller={aller}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tuile label="Animes jouables" valeur={fmt(rec.total)} sous={`${fmt(rec.avecVf)} avec VF`} jours={jours} serie={serie("video.animesJouables")} />
        <Tuile label="Videos vivantes" valeur={fmt(vi.resume?.videosVivantes)} sous={`${fmt(vi.resume?.videosMortes)} mortes`} jours={jours} serie={serie("video.videosVivantes")} />
        <Tuile label="Top 500 sans video" valeur={fmt(t.sansVideo?.length)} sous={`${fmt(t.sansVf)} sans VF`} jours={jours} serie={serie("video.top500SansVideo")} />
        <Tuile label="En cours en retard" valeur={fmt(vi.resume?.enCoursEnRetard)} sous="episode sorti, absent en VOSTFR" jours={jours} serie={serie("video.enCoursEnRetard")} />
      </div>

      <Carte titre="Sites sources" note="« Animes » : ids AniList qu'une ligne player_map verifiee (ou une page ancree) sert depuis ce site. Episodes : liens de la copie de la nuit, toutes langues.">
        <Tableau colonnes={[
          { titre: "Source", rendu: (l) => <span><span className="text-white font-semibold">{l.nom}</span><br /><span className="text-white/40">{l.sous}</span></span> },
          { titre: "Animes", rendu: (l) => fmt(l.animes), droite: true },
          { titre: "Pages / saisons", rendu: (l) => fmt(l.pages), droite: true },
          { titre: "VOSTFR / VF", rendu: (l) => (l.vostfr == null ? "—" : `${fmt(l.vostfr)} / ${fmt(l.vf)}`), droite: true },
          { titre: "Episodes", rendu: (l) => fmt(l.episodes), droite: true },
          { titre: "Vivants", rendu: (l) => <span className="text-emerald-300">{fmt(l.vivants)}</span>, droite: true },
          { titre: "Morts", rendu: (l) => <span className="text-rose-300">{fmt(l.morts)}</span>, droite: true },
          { titre: "Sans AniList", rendu: (l) => fmt(l.sansAnilist), droite: true },
        ]} lignes={[
          { nom: "anime-sama", sous: `${fmt(as.fiches)} fiches · ansembed + sendvid`, animes: as.animes, pages: as.panneaux, vostfr: as.vostfr, vf: as.vf, episodes: as.episodes, vivants: as.vivants, morts: as.morts, sansAnilist: as.sansAnilist },
          { nom: "voir-anime", sous: "myTV (vidmoly-va)", animes: va.animes, pages: va.pages, vostfr: va.vostfr, vf: va.vf, episodes: va.episodes, vivants: va.vivants, morts: va.morts, sansAnilist: va.sansAnilist },
          { nom: "Frembed", sous: `${fmt(vi.part?.frembed?.heberges)} titres heberges sur ${fmt(vi.part?.frembed?.sondes)} sondes · un flux par titre, VF + VOSTFR`, animes: vi.sources?.frembed?.animes, pages: vi.part?.frembed?.heberges, vostfr: null, episodes: null, vivants: null, morts: null, sansAnilist: vi.part?.frembed?.heberges == null ? null : vi.part.frembed.heberges - (vi.sources?.frembed?.animes || 0) },
        ]} />
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs text-white/70">Recouvrement : {fmt(rec.total)} animes AniList distincts (survoler une couleur)</p>
          <div className="flex h-7 rounded overflow-hidden text-[11px] font-semibold">
            {[["Sur les deux sites", rec.deux, "bg-sky-400 text-black"], ["anime-sama seul", rec.asSeul, "bg-action text-black"], ["voir-anime seul", rec.vaSeul, "bg-amber-400 text-black"], ["Frembed seul", rec.frembedSeul, "bg-emerald-400 text-black"]].map(([nom, n, c]) => (
              <Survol key={nom as string} contenu={<>{nom} · {fmt(n)} animes · {pct(n, rec.total)}</>} className={`${c} flex items-center px-2 truncate hover:brightness-110 cursor-default`} style={{ flex: Number(n) || 0 }}>
                {Number(n) / (rec.total || 1) > 0.08 ? `${nom} · ${fmt(n)}` : ""}
              </Survol>
            ))}
          </div>
          <p className="text-[11px] text-white/45">les deux {fmt(rec.deux)} · anime-sama seul {fmt(rec.asSeul)} · voir-anime seul {fmt(rec.vaSeul)} · Frembed seul {fmt(rec.frembedSeul)}</p>
        </div>
      </Carte>

      <PartCatalogues part={vi.part} />

      <Carte titre="Par lecteur" note="Videos : liens vivants de la copie. Demarrage et part : mesures des visiteurs (server_perf, moyenne glissante) ; la part est celle des mesures de demarrage, faute de compteur de lectures. Le taux d'echec n'est pas encore mesure.">
        <Tableau colonnes={[
          { titre: "Lecteur", rendu: (l) => <span><span className="text-white font-semibold">{l.nom}</span> <span className="text-white/40">{l.via}</span></span> },
          { titre: "Videos vivantes", rendu: (l) => fmt(l.videos), droite: true },
          { titre: "Taux vivant", rendu: (l) => (l.total ? pct(l.videos, l.total) : "—"), droite: true },
          { titre: "Demarrage", rendu: (l) => (l.demarrage == null ? "—" : `${(l.demarrage / 1000).toFixed(1)} s`), droite: true },
          { titre: "Part des mesures", rendu: (l) => (l.part == null ? "—" : (
            <Survol contenu={<>{l.nom} · {fmt(l.mesures)} mesures de demarrage sur {fmt(mesures)}</>} className="inline-flex items-center gap-2 justify-end cursor-default">
              <span className="w-20 h-2 rounded-sm bg-white/5 overflow-hidden"><span className="block h-full bg-action" style={{ width: `${l.part * 100}%` }} /></span>{Math.round(l.part * 100)} %
            </Survol>
          )), droite: true },
          { titre: "Mesures", rendu: (l) => fmt(l.mesures), droite: true },
        ]} lignes={lecteurs} />
        <p className="mt-3 text-xs text-white/55">Skips OP/ED : {fmt(op.resume?.skips)} episode(s) avec saut d'opening/ending (le detecteur tourne encore, pas de pourcentage fiable pour l'instant).</p>
      </Carte>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Carte titre={`Populaires sans video · ${fmt(t.sansVideo?.length)}`} note="Les 500 animes les plus populaires d'AniList (deja en cache) qu'aucune source ne sert, ni VF ni VOSTFR.">
          {listeTrou(t.sansVideo || [], (x) => <LigneTrou x={x} droite={`${x.format} ${x.annee || ""}`} />)}
          <p className="mt-3 text-xs text-white/55">{fmt(t.sansVf)} autres n'ont que la VOSTFR (pas de VF nulle part).</p>
          {!!t.sansVfListe?.length && <Repli titre={`Les ${fmt(t.sansVf)} sans VF`}>{listeTrou(t.sansVfListe, (x) => <LigneTrou x={x} droite={`VOSTFR ${x.vostfr} ep.`} />, 40)}</Repli>}
        </Carte>
        <Carte titre={`Episodes manquants · ${fmt(t.nbIncomplets)}`} note="Top 500, series terminees : les episodes qu'AUCUNE source ne sert vivants dans une langue servie (toutes pages confondues). « VF absente » : pas de VF du tout, pour info.">
          {listeTrou(t.incomplets || [], (x) => (
            <span className="flex flex-col gap-0.5">
              <LigneTrou x={x} droite={`${x.episodes} ep.`} />
              <span className="flex flex-wrap gap-x-4 gap-y-0.5 pl-8">
                <Manque lang="VOSTFR" m={x.vostfrManque} />
                <Manque lang="VF" m={x.vfManque} />
              </span>
            </span>
          ), 10)}
        </Carte>
        <Carte titre={`Saison en cours · ${fmt(vi.resume?.enCoursEnRetard)} en retard`} note="Animes en diffusion (cache AniList) : episodes sortis contre episodes jouables. Le cache d'une fiche peut dater de quelques jours.">
          {listeTrou([...(t.enCours || [])].sort((a: any, b: any) => b.retard - a.retard || a.rang - b.rang), (x) => (
            <LigneTrou x={x} droite={<span className={x.retard ? "text-amber-300" : "text-emerald-300"}>{x.sortis} sorti(s) · VOSTFR {x.vostfr} · VF {x.vf}</span>} />
          ), 10)}
        </Carte>
        <Carte titre="Erreurs de rattachement" note="Pages voir-anime sans id AniList (jamais servies), fiches anime-sama sans lien AniList, et lignes que la parite de la nuit a retirees parce qu'elles servaient la page d'un autre anime.">
          <div className="grid grid-cols-3 gap-3 text-sm mb-3">
            <Fait label="voir-anime sans AniList" valeur={fmt(ra.vaSansId)} />
            <Fait label="anime-sama sans AniList" valeur={fmt(ra.asSansId)} />
            <Fait label="retirees par la parite" valeur={fmt(ra.parite)} />
          </div>
          <Barres lignes={ra.sautees || []} />
          <Repli titre="Le detail">
            <p className="text-xs text-white/50">Retirees par la parite (les plus recentes)</p>
            <ListeCourte lignes={ra.pariteListe || []} rendu={(x) => <span className="flex justify-between gap-3"><span>#{x.id} · {x.lang}</span><span className="text-white/50 truncate">{x.note}</span></span>} max={15} />
            <p className="text-xs text-white/50 mt-2">Pages voir-anime sans AniList</p>
            <ListeCourte lignes={ra.vaSansIdListe || []} rendu={(x) => <span className="flex justify-between gap-3"><span>{x.titre || x.slug}</span><span className="text-white/50">{x.ep} ep.</span></span>} max={15} />
            <p className="text-xs text-white/50 mt-2">Fiches anime-sama sans AniList</p>
            <ListeCourte lignes={ra.asSansIdListe || []} rendu={(x) => <span>{x.titre || x.slug} <span className="text-white/40">({x.slug})</span></span>} max={25} />
          </Repli>
        </Carte>
      </div>

      <FicheAnime />

      <Repli titre="Details techniques des lecteurs (registre, player_map, performance)">
        <Carte titre="Registre des lecteurs (lib/lecteurs.json)">
          <Tableau colonnes={[
            { titre: "Lecteur", rendu: (l) => l.nom },
            { titre: "Etat", rendu: (l) => <Etat etat={l.etat === "actif" ? "success" : l.etat === "mort" ? "failure" : "cancelled"} texte={l.etat} /> },
            { titre: "Site", rendu: (l) => (l.site ? "oui" : "non") }, { titre: "Lot OP/ED", rendu: (l) => (l.lot ? "oui" : "non") },
            { titre: "Note", rendu: (l) => <span className="text-white/50">{l.raison || l.note || ""}</span> },
          ]} lignes={Object.entries(le.lecteurs || {}).map(([nom, v]: any) => ({ nom, ...v })).sort((a: any, b: any) => (a.etat === "actif" ? 0 : 1) - (b.etat === "actif" ? 0 : 1))} max={12} />
        </Carte>
        <Carte titre="Correspondances (player_map) par source, langue et etat">
          <Tableau colonnes={[
            { titre: "Source · langue", rendu: (l) => l.cle },
            { titre: "verified", rendu: (l) => fmt(l.verified), droite: true }, { titre: "heuristic", rendu: (l) => fmt(l.heuristic), droite: true },
            { titre: "broken", rendu: (l) => fmt(l.broken), droite: true }, { titre: "absent", rendu: (l) => fmt(l.absent), droite: true },
          ]} lignes={Object.values((le.carte || []).reduce((m: any, x: any) => { const k = `${x.source} · ${x.lang}`; (m[k] ||= { cle: k })[x.status] = x.n; return m; }, {}))} />
        </Carte>
        <Carte titre="Performance detaillee (tous visiteurs)" note="Demarrage, coupures, avance et seek : plus bas = mieux ; qualite : plus haut = mieux. Entre parentheses : nombre de mesures.">
          <Tableau colonnes={[
            { titre: "Lecteur", rendu: (l) => l.nom },
            ...([["t", "Demarrage", (v: number) => `${(v / 1000).toFixed(1)} s`], ["s", "Coupures / min", (v: number) => `${v.toFixed(1)} s`],
              ["b", "20 s d'avance en", (v: number) => `${(v / 1000).toFixed(1)} s`], ["k", "Seek", (v: number) => `${(v / 1000).toFixed(1)} s`],
              ["q", "Qualite", (v: number) => `${Math.round(v)}p`]] as const).map(([c, titre, f]) => ({
              titre, droite: true,
              rendu: (l: any) => (l[c] ? <span>{f(l[c].ewma)} <span className="text-white/35">({fmt(l[c].n)})</span></span> : "—"),
            })),
          ]} lignes={Object.entries(perf).map(([nom, p]: any) => ({ nom, ...p })).sort((a: any, b: any) => (b.t?.n || 0) - (a.t?.n || 0))} />
        </Carte>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Carte titre="Pourquoi une source est sautee (broken / absent)"><Barres lignes={le.notes} max={10} large /></Carte>
          <Carte titre="voir-anime : types de pages"><Barres lignes={le.voirAnime?.types} /></Carte>
        </div>
      </Repli>
    </Panneau>
  );
}

/** « 3, 7, 12-24 » : des numeros d'episodes, les suites regroupees. */
function plages(n: number[]) {
  const out: string[] = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `${n[i]}–${n[j]}` : String(n[i]));
    i = j;
  }
  return out.join(", ");
}

/** Ce qui manque dans une langue : les episodes, « absente », ou rien (complete). */
function Manque({ lang, m }: { lang: string; m: any }) {
  if (m === "absente") return <span className="text-white/40">{lang} absente</span>;
  if (!Array.isArray(m)) return null;
  if (!m.length) return <span className="text-emerald-300/80">{lang} complete</span>;
  return <span className="text-amber-300">{lang} : il manque {m.length > 1 ? "les ep." : "l'ep."} {plages(m)}</span>;
}

/** La part de chaque catalogue qu'on sert, hors ce qu'on ne prend pas. */
function PartCatalogues({ part }: { part: any }) {
  if (!part) return null;
  const ligne = (nom: string, p: any, unite: string, nonPris: React.ReactNode) => (
    <div className="flex flex-col gap-2 py-3 border-t border-white/5 first:border-t-0">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="text-white font-semibold">{nom}</span>
        <span className="text-white tabular-nums">{fmt(p.servis)} / {fmt(p.eligibles)} {unite} servis · <strong>{pct(p.servis, p.eligibles)}</strong></span>
      </div>
      <Survol contenu={<>{fmt(p.servis)} servis · {fmt(p.eligibles - p.servis)} jouables mais non servis · {fmt(p.nonPris)} non pris</>} className="flex h-3 rounded-sm overflow-hidden bg-white/5 cursor-default">
        <div className="bg-action" style={{ flex: p.servis }} />
        <div className="bg-amber-400/70" style={{ flex: p.eligibles - p.servis }} />
        <div className="bg-white/10" style={{ flex: p.nonPris }} />
      </Survol>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/55">
        <span><span className="inline-block w-2 h-2 rounded-sm bg-action mr-1" />servis {fmt(p.servis)}</span>
        <span><span className="inline-block w-2 h-2 rounded-sm bg-amber-400/70 mr-1" />jouables non servis {fmt(p.eligibles - p.servis)}</span>
        <span><span className="inline-block w-2 h-2 rounded-sm bg-white/10 mr-1" />non pris {fmt(p.nonPris)} {nonPris}</span>
        <span>episodes : {fmt(p.episodesServis)} / {fmt(p.episodesEligibles)} ({pct(p.episodesServis, p.episodesEligibles)})</span>
      </div>
      {!!p.nonServis?.length && (
        <Repli titre={`Les plus gros ${unite} jouables non servis`}>
          <ListeCourte lignes={p.nonServis} rendu={(x) => <span className="flex justify-between gap-3"><span className="truncate">{x.titre || x.page} <span className="text-white/40">{x.page}</span></span><span className="text-white/60 shrink-0">{fmt(x.ep)} ep.</span></span>} max={15} />
        </Repli>
      )}
    </div>
  );
  const f = part.frembed || {};
  return (
    <Carte titre="Part de chaque catalogue qu'on sert" note="« Non pris » : ce qu'on ecarte volontairement — panneau ou page sans aucun lien vivant d'un lecteur valide (ansembed, myTV), versions « sans fillers » d'anime-sama. « Jouables non servis » : un lecteur valide, mais aucune correspondance AniList verifiee — c'est le reservoir a rattacher.">
      {ligne("anime-sama", part.animeSama, "panneaux", <span className="text-white/40">({fmt(part.animeSama?.sansLecteur)} sans lecteur valide, {fmt(part.animeSama?.sansFillers)} sans fillers)</span>)}
      {ligne("voir-anime", part.voirAnime, "pages", <span className="text-white/40">(sans lien myTV vivant)</span>)}
      <div className="flex flex-col gap-2 py-3 border-t border-white/5">
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span className="text-white font-semibold">Frembed</span>
          <span className="text-white tabular-nums">{fmt(f.heberges)} / {fmt(f.sondes)} titres TMDB sondes heberges · <strong>{pct(f.heberges, f.sondes)}</strong></span>
        </div>
        <Survol contenu={<>{fmt(f.heberges)} titres heberges · {fmt((f.sondes || 0) - (f.heberges || 0))} sondes sans flux · {fmt(f.mappes)} animes AniList couverts</>} className="flex h-3 rounded-sm overflow-hidden bg-white/5 cursor-default">
          <div className="bg-action" style={{ flex: f.heberges || 0 }} />
          <div className="bg-white/10" style={{ flex: (f.sondes || 0) - (f.heberges || 0) }} />
        </Survol>
        <p className="text-[11px] text-white/55">Ces {fmt(f.heberges)} titres couvrent {fmt(f.mappes)} animes AniList (plusieurs saisons partagent un id TMDB). Frembed sert un flux par titre, VF et VOSTFR : pas de compte par episode.</p>
      </div>
    </Carte>
  );
}

function LigneTrou({ x, droite }: { x: any; droite: React.ReactNode }) {
  return (
    <span className="flex justify-between gap-3">
      <a href={`/en/anime/${x.id}`} target="_blank" rel="noreferrer" className="truncate hover:underline"><span className="text-white/40 tabular-nums">#{x.rang}</span> {x.titre}</a>
      <span className="shrink-0 text-white/60 tabular-nums">{droite}</span>
    </span>
  );
}

function ListeCourte({ lignes, rendu, max = 8 }: { lignes: any[]; rendu: (x: any) => React.ReactNode; max?: number }) {
  const [tout, setTout] = useState(false);
  if (!lignes?.length) return <p className="text-xs text-white/40">Aucun.</p>;
  return (
    <div className="flex flex-col text-xs">
      {(tout ? lignes : lignes.slice(0, max)).map((x, i) => <div key={i} className="py-1.5 border-t border-white/5 first:border-t-0 text-white/85">{rendu(x)}</div>)}
      {lignes.length > max && <button type="button" onClick={() => setTout(!tout)} className="self-start mt-1 text-[11px] text-action hover:underline">{tout ? "Reduire" : `Voir les ${lignes.length}`}</button>}
    </div>
  );
}

/** La fiche d'un anime : recherche, puis chaque page qui le sert, episode par episode. */
function FicheAnime() {
  const [q, setQ] = useState("");
  const [candidats, setCandidats] = useState<any[]>([]);
  const [fiche, setFiche] = useState<any>(null);
  const [charge, setCharge] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const appel = async (qs: string) => {
    setCharge(true); setErr(null);
    try {
      const res = await fetch(`/api/v2/admin/anime-sources?${qs}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    } catch (e: any) { setErr(String(e?.message || e)); return null; } finally { setCharge(false); }
  };
  const chercher = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (/^\d+$/.test(v)) { setCandidats([]); setFiche(await appel(`id=${v}`)); return; }
    const j = await appel(`q=${encodeURIComponent(v)}`);
    setFiche(null);
    setCandidats(j?.candidats || []);
  };
  const ouvrir = async (id: number) => { setCandidats([]); setFiche(await appel(`id=${id}`)); };
  const couleur: Record<string, string> = { vivant: "bg-emerald-400", present: "bg-sky-400", mort: "bg-rose-400" };
  return (
    <Carte titre="Fiche d'un anime" note="Recherche par titre (pages voir-anime) ou par id AniList. Une case par episode : vert = lien vivant, bleu = lien present non controle (Sendvid), rouge = mort, gris = rien.">
      <form onSubmit={chercher} className="flex flex-wrap gap-2 items-center">
        <label htmlFor="fiche-anime-q" className="sr-only">Titre ou id AniList</label>
        <input id="fiche-anime-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titre ou id AniList (ex. Baki, 97888)"
          className="bg-black/30 border border-white/10 rounded px-3 py-2 text-sm text-white w-80 max-w-full focus:outline-none focus:border-action" />
        <button type="submit" className="px-4 py-2 rounded bg-action text-black text-sm font-semibold">{charge ? "…" : "Chercher"}</button>
        {err && <span className="text-xs text-rose-300">{err}</span>}
      </form>
      {!!candidats.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {candidats.map((c) => (
            <button key={c.id} type="button" onClick={() => ouvrir(c.id)} className="text-xs px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 text-white/85">
              {c.titre} <span className="text-white/40">#{c.id} · {c.langues}</span>
            </button>
          ))}
        </div>
      )}
      {fiche && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm text-white">
            <a href={`/en/anime/${fiche.anime.id}`} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{fiche.anime.titre || `#${fiche.anime.id}`}</a>
            <span className="text-white/50"> · AniList {fiche.anime.id}{fiche.anime.format ? ` · ${fiche.anime.format}` : ""}{fiche.anime.annee ? ` ${fiche.anime.annee}` : ""}{fiche.anime.episodes ? ` · ${fiche.anime.episodes} episodes` : ""}{fiche.anime.statut ? ` · ${fiche.anime.statut}` : ""}</span>
          </p>
          {!fiche.lignes.length && <p className="text-xs text-white/50">Aucune source ne sert cet anime.</p>}
          {fiche.lignes.map((l: any, i: number) => (
            <div key={i} className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-2 py-2 border-t border-white/5">
              <div className="text-xs">
                <p className="text-white font-semibold">{l.source} · {l.lang.toUpperCase()}</p>
                <p className="text-white/50">{l.lecteur} · <span className="break-all">{l.page}</span></p>
                <p className="text-white/50">{l.statut}{l.note ? ` · ${l.note}` : ""}</p>
                <p className="text-white/70 tabular-nums">{l.vivants} vivant(s) · {l.morts} mort(s) · {l.nbEp} lien(s)</p>
              </div>
              <div className="flex flex-wrap gap-[3px] content-start">
                {l.eps.map((e: any) => <span key={e.n} title={`ep. ${e.n} : ${e.etat}`} className={`w-4 h-4 rounded-[3px] ${couleur[e.etat] || "bg-white/20"}`} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Carte>
  );
}

/* ── Images & musique ────────────────────────────────────────────────────── */
function SectionImages({ r, serie, aller, calcule, alertes }: PropsSection) {
  const im = donnees(r, "images"), fr = donnees(r, "fraicheur"), ca = donnees(r, "catalogue"), op = donnees(r, "oped");
  const f = fr.fanarts || {}, b = f.bilan, w = fr.wallhaven || {};
  const cat = (w.progres || []).find((p: any) => p.tache === "catalogue");
  const pages = cat?.curseur === "fini" ? 3693 : Number(cat?.curseur) || 0;
  return (
    <Panneau titre="Images & musique" sous={calcule("images", "fraicheur", "catalogue")} alertes={alertes("images")} aller={aller}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Carte titre="Wallhaven · fonds et galerie" note="Trois creneaux par jour : la categorie Anime entiere, puis l'etiquetage (une requete par image), puis l'attribution aux animes par les tags.">
          <div className="flex flex-col gap-3">
            <Progression label="Catalogue Anime" fait={pages} total={3693} detail={cat?.curseur === "fini" ? "complet" : `page ${fmt(pages)} / 3 693 · ${fmt(w.brut)} images · ${depuis(cat?.maj_at)}`} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <Fait label="Images cataloguees" valeur={fmt(w.brut)} />
              <Fait label="A etiqueter" valeur={fmt(w.aEtiqueter)} />
              <Fait label="A attribuer" valeur={fmt(w.aAttribuer)} />
              <Fait label="Animes avec images" valeur={fmt(im.wallhaven?.animes)} />
            </div>
            {serie("fraicheur.wallhavenBrut").filter((x) => x != null).length >= 2 && <div><p className="text-xs text-white/50 mb-1">Images cataloguees par jour</p><Courbe points={(r.historique || []).map((h) => ({ x: h.jour.slice(5), y: h["fraicheur.wallhavenBrut"] ?? null }))} hauteur={110} /></div>}
          </div>
        </Carte>
        <Carte titre="fanart.tv · logos et fanarts" note="Chaque jour a 04:00 UTC ; le classifieur NSFW passe sur les nouvelles images.">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Fait label="Images" valeur={fmt(im.fanarts?.total)} />
            <Fait label="Animes" valeur={fmt(im.fanarts?.animes)} />
            <Fait label="Dernier passage" valeur={depuis(f.dernierPassage)} />
            <Fait label="Ajoutees au dernier passage" valeur={b ? fmt(b.added) : "—"} />
            <Fait label="En attente NSFW" valeur={fmt(f.nonClasses)} />
            <Fait label="Derniere image" valeur={depuis(f.derniereImage)} />
          </div>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            <Barres lignes={im.fanarts?.types} />
            <Barres lignes={im.fanarts?.labels} />
          </div>
        </Carte>
        <Carte titre="TMDB · backdrops et logos" note="Art seulement (backdrop, logo) ; fanart.tv garde la priorite sur les logos.">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Fait label="Images en cache" valeur={fmt(im.tmdb?.images)} />
            <Fait label="Animes avec un id TMDB" valeur={`${fmt(ca.identifiants?.tmdb)} (${pct(ca.identifiants?.tmdb, ca.identifiants?.n)})`} />
          </div>
        </Carte>
        <Carte titre="AniList · fiches, couvertures, personnages">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Fait label="Fiches en cache" valeur={fmt(ca.total)} />
            <Fait label="A rafraichir" valeur={`${fmt(ca.perimes)} (${pct(ca.perimes, ca.total)})`} />
            <Fait label="Personnages en cache" valeur={fmt(ca.personnages?.n)} />
            <Fait label="Listes de personnages completes" valeur={fmt(ca.personnages?.complets)} />
          </div>
        </Carte>
        <Carte titre="Musique · OST et openings" note="Titres d'AniPlaylist par anime ; videos YouTube examinees pour les openings et endings officiels.">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Fait label="Animes avec musiques" valeur={`${fmt(ca.musiques?.avecMusiques)} / ${fmt(ca.musiques?.n)}`} />
            <Fait label="Titres" valeur={fmt(ca.musiques?.titres)} />
          </div>
          <div className="mt-4"><p className="text-xs text-white/50 mb-1">Verdicts YouTube (OP/ED officiels)</p><Barres lignes={op.youtube} /></div>
        </Carte>
        <Carte titre="Wallhaven · contenu">
          <Barres lignes={[
            { nom: "avec personnage", n: im.wallhaven?.personnages || 0 }, { nom: "decors", n: im.wallhaven?.decors || 0 },
            { nom: "serie confirmee", n: im.wallhaven?.serieOk || 0 }, { nom: "serie refusee", n: im.wallhaven?.serieRefusee || 0 },
          ]} total={im.wallhaven?.n} />
        </Carte>
      </div>
    </Panneau>
  );
}

/* ── Audience ────────────────────────────────────────────────────────────── */
function SectionAudience({ r, serie, jours, aller, calcule, alertes }: PropsSection) {
  const au = donnees(r, "audience"), co = donnees(r, "comptes");
  return (
    <Panneau titre="Audience" sous={calcule("audience", "comptes")} alertes={alertes("audience")} aller={aller}>
      {au.indisponible ? <p className="text-sm text-white/50">{au.indisponible}</p> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Tuile label="Visiteurs hier" valeur={fmt(au.resume?.visiteursHier)} sous={`aujourd'hui ${fmt(au.resume?.visiteursAujourdhui)}`} jours={jours} serie={serie("audience.visiteursHier")} />
            <Tuile label="Visiteurs · 7 jours" valeur={fmt(au.resume?.visiteurs7j)} sous="somme des uniques par jour" />
            <Tuile label="Pages vues · 30 j" valeur={compact(au.resume?.pages30j)} />
            <Tuile label="Cache Cloudflare · 30 j" valeur={au.resume?.cache30j == null ? "—" : `${au.resume.cache30j} %`} />
            <Tuile label="Menaces bloquees · 30 j" valeur={fmt(au.resume?.menaces30j)} />
            <Tuile label="Donnees servies · 30 j" valeur={octets(au.resume?.octets30j)} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Carte titre="Visiteurs uniques par jour (30 j)" note="Toutes adresses de la zone (site, dev, proxy video). Un visiteur = une IP distincte dans la journee.">
              <Courbe points={(au.parJour || []).map((d: any) => ({ x: d.jour.slice(5), y: d.visiteurs }))} />
            </Carte>
            <Carte titre="Pages vues par jour (30 j)">
              <Courbe points={(au.parJour || []).map((d: any) => ({ x: d.jour.slice(5), y: d.pages }))} />
            </Carte>
          </div>
          <Carte titre="Animes les plus regardes">
            <p className="text-sm text-white/60">Pas de mesure fiable aujourd'hui : Cloudflare echantillonne le detail par adresse (quelques dizaines de pages de lecture vues sur 24 h pour ~1 200 visiteurs), son plan gratuit ne donne pas les parametres d'URL, et l'historique des comptes ne couvre que quelques comptes. Il faut un compteur dedie (une ligne par anime et par jour).</p>
          </Carte>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <Carte titre="Pays (requetes, 30 j)"><Barres lignes={au.pays} libelle={pays} max={10} /></Carte>
            <Carte titre="Appareils (24 h)"><Barres lignes={au.appareils24h} /></Carte>
            <Carte titre="Systemes (24 h)"><Barres lignes={au.os24h} /></Carte>
            <Carte titre="Navigateurs (pages vues, 30 j)"><Barres lignes={au.navigateurs} max={8} /></Carte>
          </div>
        </>
      )}

      <h3 className="font-outfit text-lg font-bold text-white mt-2">Comptes</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        <Tuile label="Comptes" valeur={fmt(co.comptes?.total)} jours={jours} serie={serie("comptes.comptes")} />
        <Tuile label="E-mail verifie" valeur={fmt(co.comptes?.verifies)} sous={pct(co.comptes?.verifies, co.comptes?.total)} />
        <Tuile label="Lies a AniList" valeur={fmt(co.comptes?.anilist)} sous={pct(co.comptes?.anilist, co.comptes?.total)} />
        <Tuile label="Nouveaux · 7 j" valeur={fmt(co.comptes?.nouveaux7j)} />
        <Tuile label="Nouveaux · 30 j" valeur={fmt(co.comptes?.nouveaux30j)} />
        <Tuile label="Actifs · 24 h" valeur={fmt(co.comptes?.actifs24h)} />
        <Tuile label="Actifs · 7 j" valeur={fmt(co.comptes?.actifs7j)} jours={jours} serie={serie("comptes.actifs7j")} />
        <Tuile label="Actifs · 30 j" valeur={fmt(co.comptes?.actifs30j)} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Carte titre="Inscriptions par mois"><Colonnes lignes={parMois(co.inscriptions)} /></Carte>
        <Carte titre="Donnees synchronisees des comptes">
          <Tableau colonnes={[
            { titre: "Type", rendu: (l) => l.nom }, { titre: "Comptes", rendu: (l) => fmt(l.n), droite: true },
            { titre: "Taille", rendu: (l) => octets(l.octets), droite: true }, { titre: "Derniere ecriture", rendu: (l) => depuis(l.dernier), droite: true },
          ]} lignes={co.donnees} />
        </Carte>
      </div>
    </Panneau>
  );
}

/* ── Technique ───────────────────────────────────────────────────────────── */
function SectionTech({ r, aller, calcule, alertes }: PropsSection) {
  const au = donnees(r, "audience"), mo = donnees(r, "moderation"), inf = donnees(r, "infra"), auto = donnees(r, "automatisations"), tb = donnees(r, "tables"), fr = donnees(r, "fraicheur");
  return (
    <Panneau titre="Technique" sous={calcule("automatisations", "infra", "tables")} alertes={alertes("tech")} aller={aller}>
      <div className="grid grid-cols-1 xl:grid-cols-[3fr_2fr] gap-3">
        <Carte titre="Automatisations" note="Un feu par automatisation : rouge = dernier passage en echec ou ne tourne plus ; orange = echec(s) dans la semaine ; vert = tout va bien. Cliquer pour l'historique.">
          <Feux auto={auto} />
        </Carte>
        <div className="flex flex-col gap-3">
          <Carte titre="Quotas du mois">
            <div className="flex flex-col gap-4">
              <Jauge label={`Turso · ${compact(inf.turso?.lus)} lignes lues / ${compact(inf.turso?.plafond)}`} part={inf.turso?.pct ?? null} projection={inf.turso?.projection ?? null} />
              {inf.upstash?.plafondAtteint
                ? <p className="text-xs text-rose-300">Upstash : plafond mensuel atteint, le cache Redis est coupe jusqu'au 1er du mois.</p>
                : <Jauge label={`Upstash · ${fmt(inf.upstash?.moyenne7j)} commandes / jour`} part={inf.upstash?.projection ?? null} />}
              <p className="text-[11px] text-white/45">Vercel (Fluid CPU) n'est pas lisible sur le plan Hobby : voir tools/infra-health/check.mjs.</p>
            </div>
          </Carte>
          <Carte titre="Moderation">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Fait label="Signalements ouverts" valeur={fmt(mo.signalements?.ouverts)} />
              <Fait label="Nouveaux · 7 j" valeur={fmt(mo.signalements?.nouveaux7j)} />
              <Fait label="IP bannies" valeur={fmt(mo.bans)} />
            </div>
          </Carte>
        </div>
      </div>

      <Carte titre="Erreurs serveur (5xx) des dernieres 24 h" note="proxy.aniscroll.com relaie le code du lecteur source : un 504 la-bas veut dire qu'un hebergeur video a ete trop lent, pas que le site est casse.">
        <Tableau colonnes={[
          { titre: "Adresse", rendu: (l) => l.hote }, { titre: "Chemin", rendu: (l) => <span className="break-all text-white/60">{l.chemin}</span> },
          { titre: "Code", rendu: (l) => l.code, droite: true }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true },
        ]} lignes={au.erreurs24h || []} vide="Aucune erreur 5xx en 24 h." max={8} />
      </Carte>

      <Repli titre="Echecs des 7 derniers jours (job et etape)"><OngletGithub auto={auto} /></Repli>
      <Repli titre="Chaines de donnees et fraicheur"><OngletDonnees fr={fr} serie={() => []} /></Repli>
      <Repli titre="Moderation en detail">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Carte titre="Signalements par mois"><Colonnes lignes={parMois(mo.parMois)} /></Carte>
          <Carte titre="Par gravite"><Barres lignes={mo.gravites} /></Carte>
          <Carte titre="Actions d'administration"><Barres lignes={mo.audit} /></Carte>
        </div>
        <Carte titre="Derniers evenements du journal">
          <Tableau colonnes={[
            { titre: "Quand", rendu: (l) => tsDate(l.created_at) }, { titre: "Action", rendu: (l) => l.action },
            { titre: "Par", rendu: (l) => l.actor }, { titre: "Cible", rendu: (l) => <span className="break-all text-white/60">{l.target}</span> },
          ]} lignes={mo.derniers} />
        </Carte>
      </Repli>
      <Repli titre="Bases : taille des tables et cout de ces statistiques">
        <Carte titre="Taille des tables (lignes)" note={`${fmt(tb.resume?.lignesEnBase)} lignes au total.`}>
          <Tableau colonnes={[
            { titre: "Base", rendu: (l) => <span className="text-white/50">{l.base}</span> }, { titre: "Table", rendu: (l) => l.nom },
            { titre: "Lignes", rendu: (l) => fmt(l.n), droite: true },
          ]} lignes={tb.tables || []} max={15} />
        </Carte>
        <Carte titre="Cout de chaque section" note="tools/stats/instantane.mjs (workflow stats-site) : tout chaque matin, l'etat GitHub chaque heure, catalogue et images chaque semaine. Historique garde 90 jours.">
          <Tableau colonnes={[
            { titre: "Section", rendu: (l) => l.id }, { titre: "Calculee", rendu: (l) => depuis(l.calculeLe) },
            { titre: "Lignes lues", rendu: (l) => fmt(l.cout), droite: true }, { titre: "Duree", rendu: (l) => (l.dureeMs == null ? "—" : `${(l.dureeMs / 1000).toFixed(1)} s`), droite: true },
            { titre: "Etat", rendu: (l) => (l.erreur ? <Etat etat="warning" texte={l.erreur} /> : <Etat etat="success" texte="ok" />) },
          ]} lignes={Object.entries(r.sections).map(([id, s]) => ({ id, ...s }))} />
        </Carte>
      </Repli>
    </Panneau>
  );
}

/** Une ligne par automatisation : feu, nom, dernier passage ; l'historique au clic. */
function Feux({ auto }: { auto: any }) {
  const wfs: any[] = auto.workflows || [];
  if (!wfs.length) return <p className="text-sm text-white/50">Pas encore d'etat GitHub dans l'instantane.</p>;
  const feu = (w: any): [Niveau, string] => {
    if (!w.actif) return ["info", "desactive"];
    const echecs7 = (w.passages || []).filter((x: any) => x.etat === "failure" && Date.now() - Date.parse(x.quand) < 7 * 86400e3).length;
    if (w.dernier?.etat === "failure") return ["panne", `echec ${depuis(Date.parse(w.dernier.quand))}`];
    if (w.enRetard) return ["panne", `ne tourne plus (${depuis(Date.parse(w.dernier.quand))})`];
    if (echecs7) return ["attention", `${echecs7} echec(s) / 7 j, dernier ${MOT_PASSAGE[w.dernier?.etat] || w.dernier?.etat || "—"}`];
    return ["ok", w.dernier ? `${MOT_PASSAGE[w.dernier.etat] || w.dernier.etat} ${depuis(Date.parse(w.dernier.quand))}` : "jamais lance"];
  };
  const lignes = wfs.map((w) => ({ w, f: feu(w) })).sort((a, b) => RANG[a.f[0]] - RANG[b.f[0]] || a.w.nom.localeCompare(b.w.nom));
  return (
    <div className="flex flex-col">
      {lignes.map(({ w, f }) => (
        <details key={w.fichier} className="border-t border-white/5 first:border-t-0 group">
          <summary className="list-none cursor-pointer flex items-center gap-3 py-2 text-sm hover:bg-white/[0.03] -mx-2 px-2 rounded">
            <Pastille niveau={f[0]} />
            <span className={`flex-1 min-w-0 truncate ${w.actif ? "text-white" : "text-white/40"}`}>{w.nom}</span>
            <span className="text-xs text-white/55 text-right">{f[1]}</span>
          </summary>
          <div className="pb-3 pl-[7.5rem] flex flex-wrap items-center gap-3 text-xs text-white/60">
            <Historique passages={w.passages || []} />
            <span>{w.rythme ? `toutes les ${duree(w.rythme)}` : "a la demande"}</span>
            <span>duree {duree(w.dernier?.duree)}</span>
            {w.dernier?.url && <a href={w.dernier.url} target="_blank" rel="noreferrer" className="text-action hover:underline">dernier passage ↗</a>}
          </div>
        </details>
      ))}
    </div>
  );
}

/* ── GitHub Actions ──────────────────────────────────────────────────────── */
function OngletGithub({ auto }: { auto: any }) {
  const wfs: any[] = auto.workflows || [];
  if (!wfs.length) return <p className="text-sm text-white/50">Pas encore d'etat GitHub dans l'instantane.</p>;
  const actifs = wfs.filter((w) => w.actif);
  const enEchec = actifs.filter((w) => w.dernier?.etat === "failure");
  const enRetard = actifs.filter((w) => w.enRetard && w.dernier?.etat !== "failure");
  const echecs: any[] = auto.echecs || [];
  const rang = (w: any) => (!w.actif ? 4 : w.dernier?.etat === "failure" ? 0 : w.enRetard ? 1 : (w.passages || []).some((x: any) => x.etat === "failure") ? 2 : 3);
  const tries = [...wfs].sort((a, b) => rang(a) - rang(b) || a.nom.localeCompare(b.nom));
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tuile label="Workflows actifs" valeur={fmt(actifs.length)} sous={`${fmt(wfs.length - actifs.length)} desactive(s)`} />
        <Tuile label="Dernier passage en echec" valeur={fmt(enEchec.length)} sous={enEchec.map((w) => w.nom).join(", ") || "aucun"} />
        <Tuile label="Ne tournent plus" valeur={fmt(enRetard.length)} sous={enRetard.map((w) => w.nom).join(", ") || "aucun"} />
        <Tuile label="Echecs · 7 jours" valeur={fmt(echecs.length)} sous="passages en echec, tous workflows" />
      </div>

      <Carte titre="Echecs des 7 derniers jours" note="Le job et l'etape qui ont casse, pour chaque passage en echec. Un workflow a plusieurs machines (copies anime-sama / voir-anime) compte les machines tombees.">
        <Tableau colonnes={[
          { titre: "Quand", rendu: (l) => <span title={tsDate(Date.parse(l.quand))}>{depuis(Date.parse(l.quand))}</span> },
          { titre: "Workflow", rendu: (l) => l.workflow },
          { titre: "Ce qui a casse", rendu: (l) => (l.jobs?.length ? (
            <span className="text-white/70">
              {l.jobsRates > 1 && <span className="text-white">{l.jobsRates}/{l.jobsTotal} jobs · </span>}
              {l.jobs[0].nom}{l.jobs[0].etape && <span className="text-white/45"> → {l.jobs[0].etape}</span>}
            </span>
          ) : <span className="text-white/40">detail indisponible</span>) },
          { titre: "Declenche par", rendu: (l) => <span className="text-white/50">{l.evenement === "schedule" ? "programme" : l.evenement === "workflow_dispatch" ? "a la main" : l.evenement}</span> },
          { titre: "", rendu: (l) => <a href={l.url} target="_blank" rel="noreferrer" className="text-action hover:underline">ouvrir ↗</a>, droite: true },
        ]} lignes={echecs} vide="Aucun echec en 7 jours." max={10} />
      </Carte>

      <Carte titre="Tous les workflows" note="Historique : les 20 derniers passages, le plus recent a droite. Rythme : l'ecart habituel entre deux passages programmes.">
        <Tableau colonnes={[
          { titre: "Workflow", rendu: (w) => <span className={w.actif ? "" : "text-white/40"} title={w.fichier}>{w.nom}</span> },
          { titre: "Etat", rendu: (w) => (!w.actif ? <Etat etat="cancelled" texte="desactive" />
            : w.dernier?.etat === "failure" ? <Etat etat="failure" texte="en echec" />
            : w.enRetard ? <Etat etat="warning" texte="ne tourne plus" />
            : w.dernier ? <Etat etat={w.dernier.etat} /> : "—") },
          { titre: "Historique", rendu: (w) => <Historique passages={w.passages || []} /> },
          { titre: "Dernier passage", rendu: (w) => (w.dernier ? <a href={w.dernier.url} target="_blank" rel="noreferrer" className="hover:underline">{depuis(Date.parse(w.dernier.quand))}</a> : "—"), droite: true },
          { titre: "Duree", rendu: (w) => duree(w.dernier?.duree), droite: true },
          { titre: "Rythme", rendu: (w) => (w.rythme ? `toutes les ${duree(w.rythme)}` : "a la demande"), droite: true },
          { titre: "Reussite", rendu: (w) => { const f = (w.passages || []).filter((x: any) => ["success", "failure"].includes(x.etat)); return f.length ? pct(f.filter((x: any) => x.etat === "success").length, f.length) : "—"; }, droite: true },
        ]} lignes={tries} />
      </Carte>
    </>
  );
}

/** Les derniers passages d'un workflow, du plus ancien au plus recent : une icone par passage. */
function Historique({ passages }: { passages: any[] }) {
  if (!passages.length) return <span className="text-white/40">—</span>;
  const m: Record<string, [any, string]> = {
    success: [CheckCircleIcon, "text-emerald-400"], failure: [XCircleIcon, "text-rose-400"],
    cancelled: [MinusCircleIcon, "text-white/30"], skipped: [MinusCircleIcon, "text-white/20"],
    in_progress: [ArrowPathIcon, "text-sky-300"], queued: [ClockIcon, "text-sky-300"],
  };
  return (
    <span className="inline-flex items-center gap-[1px]">
      {[...passages].reverse().map((p) => {
        const [Icone, couleur] = m[p.etat] || [ClockIcon, "text-white/30"];
        return (
          <a key={p.id} href={p.url} target="_blank" rel="noreferrer" title={`${tsDate(Date.parse(p.quand))} · ${p.etat}${p.duree ? ` · ${duree(p.duree)}` : ""}`} className="hover:scale-125 transition-transform">
            <Icone className={`w-3.5 h-3.5 ${couleur}`} />
          </a>
        );
      })}
    </span>
  );
}

/* ── Donnees ─────────────────────────────────────────────────────────────── */
function OngletDonnees({ fr, serie }: { fr: any; serie: (k: string) => (number | null)[] }) {
  const f = fr.fanarts || {}, b = f.bilan, w = fr.wallhaven || {};
  const cat = (w.progres || []).find((p: any) => p.tache === "catalogue");
  const pages = cat?.curseur === "fini" ? 3693 : Number(cat?.curseur) || 0;
  // Les fanarts ajoutes par jour : l'ecart du dernier identifiant d'un jour a l'autre.
  const ids = serie("fraicheur.fanartsDernierId");
  const parJour = ids.map((v, i) => (i && v != null && ids[i - 1] != null ? v - (ids[i - 1] as number) : null));
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Carte titre="Fanarts (fanart.tv)" note="Chaque jour a 04:00 UTC : les animes dont fanart.tv signale des images nouvelles sont revus, puis le classifieur NSFW passe sur les nouvelles. Ecrit dans la base fanarts, celle que lit le site.">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Fait label="Dernier passage" valeur={depuis(f.dernierPassage)} />
            <Fait label="Derniere image arrivee" valeur={depuis(f.derniereImage)} />
            <Fait label="Animes revus au dernier passage" valeur={b ? fmt(b.refreshed) : "—"} />
            <Fait label="Images ajoutees au dernier passage" valeur={b ? fmt(b.added) : "—"} />
            <Fait label="Signalees par fanart.tv" valeur={b ? `${b.tvLatest == null ? "series : liste indisponible" : `${fmt(b.tvLatest)} series`} · ${b.moviesLatest == null ? "films : indisponible" : `${fmt(b.moviesLatest)} films`}` : "—"} />
            <Fait label="En attente de classement NSFW" valeur={fmt(f.nonClasses)} />
          </div>
          {b?.tvRotation && <p className="mt-3 text-xs text-sky-200/80">fanart.tv ne renvoie plus la liste des series modifiees : chaque jour, un septieme des series est revu (aujourd'hui {b.tvRotation}).</p>}
          {parJour.filter((x) => x != null).length >= 2 && <div className="mt-4"><p className="text-xs text-white/50 mb-1">Images ajoutees par jour</p><Courbe points={parJour.map((y, i) => ({ x: String(i), y }))} hauteur={110} /></div>}
        </Carte>

        <Carte titre="Wallhaven" note="Trois creneaux par jour : la categorie Anime entiere, puis l'etiquetage (une requete par image), puis l'attribution aux animes par les tags.">
          <div className="flex flex-col gap-3">
            <Progression label="Catalogue Anime" fait={pages} total={3693} detail={cat?.curseur === "fini" ? "complet" : `page ${fmt(pages)} / 3 693 · ${fmt(w.brut)} images · ${depuis(cat?.maj_at)}`} />
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Fait label="A etiqueter (≥ 4 favoris)" valeur={fmt(w.aEtiqueter)} />
              <Fait label="A attribuer aux animes" valeur={fmt(w.aAttribuer)} />
              <Fait label="Lignes de galerie" valeur={fmt(w.lignesGalerie)} />
            </div>
          </div>
        </Carte>
      </div>

      <Carte titre="Les autres chaines">
        <Tableau colonnes={[
          { titre: "Chaine", rendu: (l) => l.nom }, { titre: "Volume", rendu: (l) => l.volume, droite: true },
          { titre: "Derniere ecriture", rendu: (l) => (l.maj ? depuis(l.maj) : "—"), droite: true }, { titre: "Rythme attendu", rendu: (l) => <span className="text-white/50">{l.rythme}</span>, droite: true },
        ]} lignes={[
          { nom: "Copie anime-sama (ansembed)", volume: `${fmt(fr.animeSama?.n)} panneaux`, maj: fr.animeSama?.maj, rythme: "chaque nuit" },
          { nom: "Copie voir-anime (myTV)", volume: `${fmt(fr.voirAnime?.n)} pages`, maj: fr.voirAnime?.maj, rythme: "chaque nuit" },
          { nom: "Correspondances player_map", volume: "—", maj: fr.playerMap?.maj, rythme: "chaque nuit" },
          { nom: "Fiches AniList perimees", volume: fmt(fr.animesPerimes), maj: null, rythme: "a la demande" },
        ]} />
      </Carte>
    </>
  );
}

function Fait({ label, valeur }: { label: string; valeur: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-white/50 uppercase tracking-wider">{label}</p>
      <p className="text-white">{valeur}</p>
    </div>
  );
}

function Progression({ label, fait, total, detail }: { label: string; fait: number; total: number; detail?: string }) {
  const p = total ? Math.min(100, (fait / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs"><span className="text-white/70">{label}</span><span className="text-white tabular-nums">{Math.round(p)} %</span></div>
      <div className="h-2.5 rounded-sm bg-white/5 overflow-hidden"><div className="h-full rounded-sm bg-action" style={{ width: `${p}%` }} /></div>
      {detail && <p className="text-[11px] text-white/50">{detail}</p>}
    </div>
  );
}
