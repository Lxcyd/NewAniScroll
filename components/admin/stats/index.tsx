/**
 * Onglet « Statistiques » du panneau admin : TOUT le site, dans un ordre fixe.
 *
 * Les chiffres viennent de l'instantane calcule par tools/stats/instantane.mjs
 * (GitHub Actions, chaque jour ; catalogue et images chaque semaine), servi par
 * /api/v2/admin/site-stats. Ouvrir cette page ne lit qu'une centaine de lignes.
 *
 * Graphiques : une seule teinte (l'accent du site) par graphique — chaque
 * graphique montre UNE mesure ; les etats (reussi / echec) portent une icone et
 * un mot, jamais la couleur seule. Chaque barre et chaque point a son infobulle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, XCircleIcon, ClockIcon } from "@heroicons/react/24/outline";

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
function depuis(ms: any) {
  if (!ms) return "jamais";
  const s = Math.round((Date.now() - Number(ms)) / 1000);
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

/** Une tuile : un chiffre, son contexte, et sa tendance si l'historique la connait. */
function Tuile({ label, valeur, sous, serie }: { label: string; valeur: React.ReactNode; sous?: React.ReactNode; serie?: (number | null)[] }) {
  return (
    <div className="bg-secondary rounded-md p-4 flex flex-col gap-1 min-w-0">
      <p className="font-karla text-[11px] text-white/55 uppercase tracking-wider truncate" title={label}>{label}</p>
      <p className="font-karla text-2xl font-bold text-white leading-tight">{valeur}</p>
      {sous && <p className="font-karla text-xs text-white/50">{sous}</p>}
      {serie && serie.filter((x) => x != null).length >= 2 && <Etincelle serie={serie} />}
    </div>
  );
}

function Etincelle({ serie }: { serie: (number | null)[] }) {
  const pts = serie.map((v, i) => [i, v] as const).filter(([, v]) => v != null) as [number, number][];
  const min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1]));
  const W = 120, H = 28;
  const x = (i: number) => (i / Math.max(1, serie.length - 1)) * W;
  const y = (v: number) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-7 mt-1" preserveAspectRatio="none" aria-hidden>
      <polyline fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" className="text-action" points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(" ")} />
    </svg>
  );
}

/** Barres horizontales triees : une seule mesure, une seule teinte, la part en clair. */
function Barres({ lignes, max = 12, format = fmt, libelle = (x: any) => String(x), total }: { lignes: Ligne[]; max?: number; format?: (n: any) => string; libelle?: (x: any) => string; total?: number }) {
  const [tout, setTout] = useState(false);
  if (!lignes?.length) return <p className="text-xs text-white/40 font-karla">Aucune donnee.</p>;
  const somme = total ?? lignes.reduce((s, l) => s + (Number(l.n) || 0), 0);
  const haut = Math.max(...lignes.map((l) => Number(l.n) || 0)) || 1;
  const vues = tout ? lignes : lignes.slice(0, max);
  return (
    <div className="flex flex-col gap-1.5">
      {vues.map((l) => (
        <div key={String(l.nom)} className="group grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs font-karla" title={`${libelle(l.nom)} : ${format(l.n)} (${pct(l.n, somme)})`}>
          <span className="text-white/70 truncate">{libelle(l.nom)}</span>
          <span className="h-2.5 rounded-sm bg-white/5 overflow-hidden">
            <span className="block h-full rounded-sm bg-action/80 group-hover:bg-action transition-colors" style={{ width: `${Math.max(1.5, ((Number(l.n) || 0) / haut) * 100)}%` }} />
          </span>
          <span className="text-white tabular-nums text-right">{format(l.n)} <span className="text-white/40">{pct(l.n, somme)}</span></span>
        </div>
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
        <polygon points={aire} className="fill-action/15" />
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
          <div key={String(l.nom)} className="group relative flex-1 h-full flex items-end" title={`${l.nom} : ${format(l.n)}`}>
            <div className="w-full rounded-t-[3px] bg-action/75 group-hover:bg-action transition-colors" style={{ height: `${Math.max(1, ((Number(l.n) || 0) / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-white/40 font-karla mt-1">
        <span>{lignes[0].nom}</span><span>{lignes[lignes.length - 1].nom}</span>
      </div>
    </div>
  );
}

function Tableau({ colonnes, lignes, vide = "Aucune donnee." }: { colonnes: { titre: string; rendu: (l: any) => React.ReactNode; droite?: boolean }[]; lignes: any[]; vide?: string }) {
  if (!lignes?.length) return <p className="text-xs text-white/40 font-karla">{vide}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-karla">
        <thead>
          <tr className="text-white/45 text-left">
            {colonnes.map((c) => <th key={c.titre} className={`font-normal pb-2 pr-3 ${c.droite ? "text-right" : ""}`}>{c.titre}</th>)}
          </tr>
        </thead>
        <tbody>
          {lignes.map((l, i) => (
            <tr key={i} className="border-t border-white/5 hover:bg-white/[0.03]">
              {colonnes.map((c) => <td key={c.titre} className={`py-1.5 pr-3 text-white/85 ${c.droite ? "text-right tabular-nums" : ""}`}>{c.rendu(l)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Une jauge de quota : la part consommee, et la projection en fin de periode. */
function Jauge({ label, part, projection, detail }: { label: string; part: number | null; projection?: number | null; detail?: React.ReactNode }) {
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

/* ── La page ─────────────────────────────────────────────────────────────── */
const ORDRE: { id: string; titre: string; source: string[] }[] = [
  { id: "ensemble", titre: "Vue d'ensemble", source: [] },
  { id: "audience", titre: "Audience", source: ["audience"] },
  { id: "comptes", titre: "Comptes", source: ["comptes"] },
  { id: "catalogue", titre: "Catalogue", source: ["catalogue"] },
  { id: "lecteurs", titre: "Lecteurs & sources", source: ["lecteurs"] },
  { id: "oped", titre: "Openings & endings", source: ["oped"] },
  { id: "images", titre: "Images", source: ["images"] },
  { id: "moderation", titre: "Moderation", source: ["moderation"] },
  { id: "infra", titre: "Infrastructure & quotas", source: ["infra"] },
  { id: "automatisations", titre: "Automatisations", source: ["automatisations"] },
  { id: "coulisses", titre: "Coulisses des chiffres", source: [] },
];

export default function AdminStats() {
  const [r, setR] = useState<Reponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [charge, setCharge] = useState(true);
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

  const S = (id: string) => r?.sections?.[id]?.data || {};
  const serie = useCallback((cle: string) => (r?.historique || []).map((h) => (h[cle] == null ? null : Number(h[cle]))), [r]);

  if (charge && !r) return <div className="px-6 py-8 text-white/60 font-karla">Chargement des statistiques…</div>;
  if (erreur) return <div className="px-6 py-8 text-rose-300 font-karla">Erreur : {erreur}</div>;
  if (!r || r.vide || !Object.keys(r.sections).length) {
    return (
      <div className="px-6 py-8 font-karla text-white/70">
        Aucun instantane pour l'instant. Il est calcule chaque nuit par le workflow « stats-site » ; pour le lancer tout de suite :
        <code className="ml-1 bg-white/10 px-1 rounded">node tools/stats/instantane.mjs --tout</code>
      </div>
    );
  }

  const au = S("audience"), co = S("comptes"), ca = S("catalogue"), le = S("lecteurs"), op = S("oped"), im = S("images"), mo = S("moderation"), inf = S("infra"), auto = S("automatisations");
  const entete = (id: string) => {
    const src = ORDRE.find((o) => o.id === id)?.source || [];
    const sec = src.map((s) => r.sections[s]).filter(Boolean);
    if (!sec.length) return null;
    const x = sec[0];
    const hebdo = ["catalogue", "images"].includes(src[0]);
    return (
      <span className="text-[11px] font-karla text-white/40 font-normal">
        calcule {depuis(x.calculeLe)}{hebdo ? " · chaque semaine" : " · chaque jour"}{x.erreur ? <span className="text-amber-300"> · dernier calcul en erreur : {x.erreur}</span> : null}
      </span>
    );
  };

  return (
    <div className="px-4 md:px-6 py-6 flex flex-col gap-10 font-karla">
      {/* Sommaire collant : les sections dans l'ordre de la page. */}
      <nav className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-2 bg-primary/90 backdrop-blur flex items-center gap-1 overflow-x-auto scrollbar-hide">
        {ORDRE.map((o, i) => (
          <a key={o.id} href={`#stats-${o.id}`} className="shrink-0 text-xs px-2.5 py-1.5 rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors">
            <span className="text-white/35 mr-1">{i + 1}.</span>{o.titre}
          </a>
        ))}
        <button type="button" onClick={charger} className="ml-auto shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20" title="Relire l'instantane">
          <ArrowPathIcon className={`w-3.5 h-3.5 ${charge ? "animate-spin" : ""}`} /> Relire
        </button>
      </nav>

      {/* 1. Vue d'ensemble */}
      <Bloc id="ensemble" n={1} titre="Vue d'ensemble" entete={<span className="text-[11px] text-white/40 font-normal">courbes : {r.historique.length} jour(s) d'historique</span>}>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Tuile label="Visiteurs aujourd'hui" valeur={fmt(au.resume?.visiteursAujourdhui)} sous={`hier ${fmt(au.resume?.visiteursHier)}`} serie={(au.parJour || []).map((d: any) => d.visiteurs)} />
          <Tuile label="Visiteurs · 7 jours" valeur={fmt(au.resume?.visiteurs7j)} sous="somme des uniques par jour" />
          <Tuile label="Pages vues · 30 jours" valeur={compact(au.resume?.pages30j)} serie={(au.parJour || []).map((d: any) => d.pages)} />
          <Tuile label="Comptes" valeur={fmt(co.comptes?.total)} sous={`+${fmt(co.comptes?.nouveaux30j)} en 30 j`} serie={serie("comptes.comptes")} />
          <Tuile label="Actifs · 7 jours" valeur={fmt(co.comptes?.actifs7j)} sous={`${fmt(co.comptes?.actifs24h)} en 24 h`} serie={serie("comptes.actifs7j")} />
          <Tuile label="Animes en base" valeur={fmt(ca.total)} sous={`${fmt(ca.perimes)} a rafraichir`} serie={serie("catalogue.animes")} />
          <Tuile label="Episodes anime-sama jouables" valeur={fmt(le.animeSama?.vivants)} sous={`${fmt(le.animeSama?.morts)} morts`} serie={serie("lecteurs.asVivants")} />
          <Tuile label="Episodes voir-anime jouables" valeur={fmt(le.voirAnime?.vivants)} sous={`${fmt(le.voirAnime?.pages)} pages copiees`} serie={serie("lecteurs.vaVivants")} />
          <Tuile label="Correspondances verifiees" valeur={fmt(le.resume?.lignesVerifiees)} sous="player_map" serie={serie("lecteurs.lignesVerifiees")} />
          <Tuile label="Signalements ouverts" valeur={fmt(mo.signalements?.ouverts)} sous={`${fmt(mo.signalements?.nouveaux7j)} nouveaux en 7 j`} serie={serie("moderation.signalementsOuverts")} />
          <Tuile label="Quota Turso du mois" valeur={inf.turso?.pct == null ? "—" : `${inf.turso.pct} %`} sous={inf.turso?.projection != null ? `projection ${inf.turso.projection} %` : undefined} serie={serie("infra.tursoPct")} />
          <Tuile label="Automatisations en echec" valeur={fmt(auto.resume?.automatisationsEnEchec)} sous={`sur ${fmt(auto.workflows?.length)} actives`} />
        </div>
      </Bloc>

      {/* 2. Audience */}
      <Bloc id="audience" n={2} titre="Audience" entete={entete("audience")}>
        {au.indisponible ? <p className="text-sm text-white/50">{au.indisponible}</p> : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tuile label="Requetes · 30 j" valeur={compact(au.resume?.requetes30j)} />
              <Tuile label="Servies par le cache Cloudflare" valeur={au.resume?.cache30j == null ? "—" : `${au.resume.cache30j} %`} />
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
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <Carte titre="Pays (requetes, 30 j)"><Barres lignes={au.pays} libelle={pays} /></Carte>
              <Carte titre="Navigateurs (pages vues, 30 j)"><Barres lignes={au.navigateurs} /></Carte>
              <Carte titre="Codes de reponse (30 j)"><Barres lignes={au.statuts} libelle={(c) => `HTTP ${c}`} /></Carte>
              <Carte titre="Familles de pages (24 h, visiteurs)"><Barres lignes={au.familles24h} /></Carte>
              <Carte titre="Appareils (24 h)"><Barres lignes={au.appareils24h} /></Carte>
              <Carte titre="Systemes (24 h)"><Barres lignes={au.os24h} /></Carte>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <Carte titre="Pages les plus demandees (24 h, aniscroll.com)" note="Les chemins /wp-…, /index.php… sont des robots qui cherchent des failles WordPress.">
                <Tableau colonnes={[{ titre: "Chemin", rendu: (l) => <span className="break-all">{l.nom}</span> }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true }]} lignes={au.chemins24h} />
              </Carte>
              <Carte titre="Par adresse (24 h)">
                <Tableau colonnes={[{ titre: "Adresse", rendu: (l) => l.nom }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true }, { titre: "Cache", rendu: (l) => pct(l.cache, l.n), droite: true }]} lignes={au.hotes24h} />
              </Carte>
            </div>
          </>
        )}
      </Bloc>

      {/* 3. Comptes */}
      <Bloc id="comptes" n={3} titre="Comptes" entete={entete("comptes")}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <Tuile label="Comptes" valeur={fmt(co.comptes?.total)} />
          <Tuile label="E-mail verifie" valeur={fmt(co.comptes?.verifies)} sous={pct(co.comptes?.verifies, co.comptes?.total)} />
          <Tuile label="Lies a AniList" valeur={fmt(co.comptes?.anilist)} sous={pct(co.comptes?.anilist, co.comptes?.total)} />
          <Tuile label="Nouveaux · 7 j" valeur={fmt(co.comptes?.nouveaux7j)} />
          <Tuile label="Nouveaux · 30 j" valeur={fmt(co.comptes?.nouveaux30j)} />
          <Tuile label="Actifs · 24 h" valeur={fmt(co.comptes?.actifs24h)} />
          <Tuile label="Actifs · 7 j" valeur={fmt(co.comptes?.actifs7j)} />
          <Tuile label="Actifs · 30 j" valeur={fmt(co.comptes?.actifs30j)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <Carte titre="Inscriptions par mois"><Colonnes lignes={(co.inscriptions || []).map((x: any) => ({ nom: x.mois, n: x.n }))} /></Carte>
          <Carte titre="Roles et statuts"><Barres lignes={co.roles} /></Carte>
          <Carte titre="Profils" note="Avatar : le sien ou celui d'AniList.">
            <Barres lignes={[{ nom: "avec avatar", n: co.comptes?.avecAvatar || 0 }, { nom: "avec banniere", n: co.comptes?.avecBanniere || 0 }]} total={co.comptes?.total} />
          </Carte>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <Carte titre="Donnees synchronisees des comptes">
            <Tableau colonnes={[
              { titre: "Type", rendu: (l) => l.nom }, { titre: "Comptes", rendu: (l) => fmt(l.n), droite: true },
              { titre: "Taille", rendu: (l) => octets(l.octets), droite: true }, { titre: "Derniere ecriture", rendu: (l) => depuis(l.dernier), droite: true },
            ]} lignes={co.donnees} />
          </Carte>
          <Carte titre="Securite de connexion">
            <Tableau colonnes={[
              { titre: "Jetons", rendu: (l) => l.nom }, { titre: "Emis", rendu: (l) => fmt(l.n), droite: true },
              { titre: "Utilises", rendu: (l) => fmt(l.utilises), droite: true }, { titre: "Encore valides", rendu: (l) => fmt(l.valides), droite: true },
            ]} lignes={co.jetons} vide="Aucun jeton (verification d'e-mail, mot de passe oublie)." />
            <p className="mt-3 text-xs text-white/60">Limiteur de tentatives : {fmt(co.throttle?.n)} cle(s), dont {fmt(co.throttle?.actifs)} encore bloquee(s).</p>
          </Carte>
        </div>
      </Bloc>

      {/* 4. Catalogue */}
      <Bloc id="catalogue" n={4} titre="Catalogue" entete={entete("catalogue")}>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Tuile label="Animes en base" valeur={fmt(ca.total)} sous="fiches AniList deja demandees" />
          <Tuile label="A rafraichir" valeur={fmt(ca.perimes)} sous={pct(ca.perimes, ca.total)} />
          <Tuile label="Adultes" valeur={fmt(ca.adultes)} sous={pct(ca.adultes, ca.total)} />
          <Tuile label="Personnages en cache" valeur={fmt(ca.personnages?.n)} sous={`${fmt(ca.personnages?.complets)} listes completes`} />
          <Tuile label="Animes avec musiques" valeur={fmt(ca.musiques?.avecMusiques)} sous={`${fmt(ca.musiques?.titres)} titres AniPlaylist`} />
          <Tuile label="Correspondances d'ids" valeur={fmt(ca.identifiants?.n)} sous="AniList ↔ MAL / TMDB / TVDB" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <Carte titre="Formats"><Barres lignes={ca.formats} /></Carte>
          <Carte titre="Statuts de diffusion"><Barres lignes={ca.statuts} /></Carte>
          <Carte titre="Par decennie"><Barres lignes={ca.decennies} max={15} /></Carte>
          <Carte titre="Par annee de diffusion (depuis 2000)" className="md:col-span-2"><Colonnes lignes={ca.annees || []} /></Carte>
          <Carte titre="Couverture des identifiants" note="Sur la table de correspondance (fribb) : quelle part des animes a un id chez chaque service.">
            <Barres lignes={[
              { nom: "MyAnimeList", n: ca.identifiants?.mal || 0 }, { nom: "TMDB", n: ca.identifiants?.tmdb || 0 },
              { nom: "TVDB", n: ca.identifiants?.tvdb || 0 }, { nom: "Simkl", n: ca.identifiants?.simkl || 0 },
            ]} total={ca.identifiants?.n} />
          </Carte>
          <Carte titre="Catalogue Frembed (par type)"><Barres lignes={ca.frembed} /></Carte>
        </div>
      </Bloc>

      {/* 5. Lecteurs */}
      <Bloc id="lecteurs" n={5} titre="Lecteurs & sources" entete={entete("lecteurs")}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <Tuile label="Fiches anime-sama" valeur={fmt(le.animeSama?.fiches)} sous={`${fmt(le.animeSama?.panneaux)} saisons × langue`} />
          <Tuile label="Episodes anime-sama" valeur={fmt(le.animeSama?.episodes)} sous={`${pct(le.animeSama?.vivants, le.animeSama?.episodes)} jouables`} />
          <Tuile label="Pages voir-anime" valeur={fmt(le.voirAnime?.pages)} sous={`${pct(le.voirAnime?.ancrees, le.voirAnime?.pages)} ancrees sur AniList`} />
          <Tuile label="Episodes voir-anime" valeur={fmt(le.voirAnime?.episodes)} sous={`${pct(le.voirAnime?.vivants, le.voirAnime?.episodes)} jouables`} />
          <Tuile label="Correspondances verifiees" valeur={fmt(le.resume?.lignesVerifiees)} />
          <Tuile label="Frembed : titres heberges" valeur={fmt(le.frembed?.heberges)} sous={`sur ${fmt(le.frembed?.sondes)} sondes`} />
          <Tuile label="Durees d'episodes connues" valeur={fmt((le.runtimes || []).reduce((s: number, x: any) => s + x.n, 0))} />
          <Tuile label="Titres doubles connus" valeur={fmt((le.doublages || []).reduce((s: number, x: any) => s + x.n, 0))} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          <Carte titre="Registre des lecteurs (lib/lecteurs.json)">
            <Tableau colonnes={[
              { titre: "Lecteur", rendu: (l) => l.nom },
              { titre: "Etat", rendu: (l) => <Etat etat={l.etat === "actif" ? "success" : l.etat === "mort" ? "failure" : "cancelled"} texte={l.etat} /> },
              { titre: "Site", rendu: (l) => (l.site ? "oui" : "non") }, { titre: "Lot OP/ED", rendu: (l) => (l.lot ? "oui" : "non") },
              { titre: "Note", rendu: (l) => <span className="text-white/50">{l.raison || l.note || ""}</span> },
            ]} lignes={Object.entries(le.lecteurs || {}).map(([nom, v]: any) => ({ nom, ...v }))} />
          </Carte>
          <Carte titre="Correspondances (player_map) par source, langue et etat" note="verified : servie telle quelle · heuristic : devinee, en attente de controle · broken / absent : la source est sautee jusqu'a echeance.">
            <Tableau colonnes={[
              { titre: "Source · langue", rendu: (l) => l.cle },
              { titre: "verified", rendu: (l) => fmt(l.verified), droite: true }, { titre: "heuristic", rendu: (l) => fmt(l.heuristic), droite: true },
              { titre: "broken", rendu: (l) => fmt(l.broken), droite: true }, { titre: "absent", rendu: (l) => fmt(l.absent), droite: true },
            ]} lignes={Object.values((le.carte || []).reduce((m: any, x: any) => {
              const k = `${x.source} · ${x.lang}`;
              (m[k] ||= { cle: k })[x.status] = x.n;
              return m;
            }, {}))} />
          </Carte>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <Carte titre="Qui a verifie les correspondances"><Barres lignes={(le.origines || []).map((x: any) => ({ nom: `${x.source} · ${x.origine}`, n: x.n }))} /></Carte>
          <Carte titre="Pourquoi une source est sautee (broken / absent)" className="xl:col-span-2"><Barres lignes={le.notes} max={10} /></Carte>
          <Carte titre="anime-sama : episodes jouables par langue"><Barres lignes={(le.animeSama?.langues || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
          <Carte titre="anime-sama : par genre de panneau"><Barres lignes={(le.animeSama?.genres || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
          <Carte titre="voir-anime : episodes jouables par langue"><Barres lignes={(le.voirAnime?.langues || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
          <Carte titre="voir-anime : types de pages"><Barres lignes={le.voirAnime?.types} /></Carte>
          <Carte titre="voir-anime : ancrage AniList"><Barres lignes={le.voirAnime?.ancres} /></Carte>
          <Carte titre="Durees d'episodes par lecteur"><Barres lignes={le.runtimes} /></Carte>
        </div>
        <Carte titre="Performance des lecteurs (moyenne glissante)" note="Mesuree par le site a chaque resolution : plus bas = plus rapide.">
          <Tableau colonnes={[
            { titre: "Lecteur", rendu: (l) => l.nom }, { titre: "Critere", rendu: (l) => l.crit },
            { titre: "Moyenne", rendu: (l) => (l.ewma == null ? "—" : Number(l.ewma).toLocaleString("fr-FR", { maximumFractionDigits: 0 })), droite: true },
            { titre: "Mesures", rendu: (l) => fmt(l.n), droite: true }, { titre: "Derniere", rendu: (l) => depuis(l.updated_at), droite: true },
          ]} lignes={le.perf} />
        </Carte>
      </Bloc>

      {/* 6. OP/ED */}
      <Bloc id="oped" n={6} titre="Openings & endings" entete={entete("oped")}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Tuile label="Sauts OP/ED (par episode)" valeur={fmt(op.resume?.skips)} />
          <Tuile label="Sauts par lecteur" valeur={fmt(op.resume?.skipsParHote)} sous="table vide tant que l'import attend la release" />
          <Tuile label="Videos YouTube examinees" valeur={fmt((op.youtube || []).reduce((s: number, x: any) => s + x.n, 0))} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Carte titre="Sauts par type et origine"><Barres lignes={op.skips} /></Carte>
          <Carte titre="Sauts par lecteur et langue"><Barres lignes={op.parHote} /></Carte>
          <Carte titre="Verdicts YouTube (OP/ED officiels)"><Barres lignes={op.youtube} /></Carte>
        </div>
      </Bloc>

      {/* 7. Images */}
      <Bloc id="images" n={7} titre="Images" entete={entete("images")}>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Tuile label="Fanarts" valeur={fmt(im.fanarts?.total)} sous={`${fmt(im.fanarts?.animes)} animes`} />
          <Tuile label="Images Wallhaven" valeur={fmt(im.wallhaven?.n)} sous={`${fmt(im.wallhaven?.animes)} animes`} />
          <Tuile label="Wallhaven etiquetees" valeur={pct(im.wallhaven?.etiquetees, im.wallhaven?.n)} />
          <Tuile label="Titres Wallhaven cherches" valeur={fmt(im.wallhaven?.titres?.n)} sous={`${fmt(im.wallhaven?.titres?.avecImages)} avec images`} />
          <Tuile label="Cache images TMDB" valeur={fmt(im.tmdb?.images)} />
          <Tuile label="Cache captures TMDB" valeur={fmt(im.tmdb?.stills)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <Carte titre="Fanarts par type"><Barres lignes={im.fanarts?.types} /></Carte>
          <Carte titre="Fanarts : classement NSFW"><Barres lignes={im.fanarts?.labels} /></Carte>
          <Carte titre="Wallhaven : contenu">
            <Barres lignes={[
              { nom: "avec personnage", n: im.wallhaven?.personnages || 0 }, { nom: "decors", n: im.wallhaven?.decors || 0 },
              { nom: "serie confirmee", n: im.wallhaven?.serieOk || 0 }, { nom: "serie refusee", n: im.wallhaven?.serieRefusee || 0 },
            ]} total={im.wallhaven?.n} />
          </Carte>
          <Carte titre="Wallhaven : types"><Barres lignes={im.wallhaven?.types} /></Carte>
        </div>
      </Bloc>

      {/* 8. Moderation */}
      <Bloc id="moderation" n={8} titre="Moderation" entete={entete("moderation")}>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <Tuile label="Signalements ouverts" valeur={fmt(mo.signalements?.ouverts)} sous={`dont ${fmt(mo.signalements?.enAttente)} en attente`} />
          <Tuile label="Signalements au total" valeur={fmt(mo.signalements?.total)} />
          <Tuile label="Nouveaux · 7 j" valeur={fmt(mo.signalements?.nouveaux7j)} />
          <Tuile label="Nouveaux · 30 j" valeur={fmt(mo.signalements?.nouveaux30j)} />
          <Tuile label="Delai moyen de resolution" valeur={duree(mo.signalements?.resolutionMoyenneS)} />
          <Tuile label="IP bannies" valeur={fmt(mo.bans)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          <Carte titre="Signalements par mois"><Colonnes lignes={(mo.parMois || []).map((x: any) => ({ nom: x.mois, n: x.n }))} /></Carte>
          <Carte titre="Par gravite"><Barres lignes={mo.gravites} /></Carte>
          <Carte titre="Actions d'administration (journal)"><Barres lignes={mo.audit} /></Carte>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          <Carte titre="Derniers evenements du journal" className="xl:col-span-2">
            <Tableau colonnes={[
              { titre: "Quand", rendu: (l) => tsDate(l.created_at) }, { titre: "Action", rendu: (l) => l.action },
              { titre: "Par", rendu: (l) => l.actor }, { titre: "Cible", rendu: (l) => <span className="break-all text-white/60">{l.target}</span> },
            ]} lignes={mo.derniers} />
          </Carte>
          <Carte titre="Annonce du site">
            {mo.annonce?.title ? (
              <div className="text-xs text-white/75 flex flex-col gap-1">
                <p className="text-white">{mo.annonce.title}</p>
                <p>{mo.annonce.show_flag ? "affichee" : "masquee"} · du {tsDate(mo.annonce.start_at)} au {tsDate(mo.annonce.end_at)}</p>
              </div>
            ) : <p className="text-xs text-white/40">Aucune annonce.</p>}
          </Carte>
        </div>
      </Bloc>

      {/* 9. Infra */}
      <Bloc id="infra" n={9} titre="Infrastructure & quotas" entete={entete("infra")}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Carte titre="Turso : lignes lues ce mois" note={`Plafond ${compact(inf.turso?.plafond)} pour toutes les bases ; periode jusqu'au ${inf.turso?.finPeriode ? new Date(inf.turso.finPeriode).toLocaleDateString("fr-FR") : "—"}.`}>
            <Jauge label={`${compact(inf.turso?.lus)} lues`} part={inf.turso?.pct ?? null} projection={inf.turso?.projection ?? null} />
            <div className="mt-4"><Barres lignes={Object.entries(inf.turso?.hier || {}).map(([nom, n]) => ({ nom: `${nom} (hier)`, n: Number(n) || 0 }))} /></div>
          </Carte>
          <Carte titre="Upstash (Redis)" note="Plafond gratuit ~500 000 commandes par mois : au-dela le cache meurt et le CPU Vercel explose.">
            <Jauge label={`${fmt(inf.upstash?.moyenne7j)} commandes / jour (moyenne 7 j)`} part={inf.upstash?.projection ?? null} />
            <p className="mt-3 text-xs text-white/60">Hier : {fmt(inf.upstash?.hier)} commandes · {fmt(inf.upstash?.cles)} cles en base.</p>
          </Carte>
        </div>
        <Carte titre="Taille des tables (lignes, approximatif)" note="MAX(rowid) : une ligne lue par table ; surestime une table dont on a efface des lignes.">
          <Tableau colonnes={[
            { titre: "Base", rendu: (l) => <span className="text-white/50">{l.base}</span> }, { titre: "Table", rendu: (l) => l.nom },
            { titre: "Lignes", rendu: (l) => fmt(l.n), droite: true },
          ]} lignes={(inf.tables || []).slice(0, 60)} />
        </Carte>
      </Bloc>

      {/* 10. Automatisations */}
      <Bloc id="automatisations" n={10} titre="Automatisations" entete={entete("automatisations")}>
        <Carte titre="Workflows GitHub Actions (copies, verifications, sauvegardes…)">
          <Tableau colonnes={[
            { titre: "Workflow", rendu: (l) => <span title={l.fichier}>{l.nom}</span> },
            { titre: "Dernier passage", rendu: (l) => (l.dernier ? <a href={l.dernier.url} target="_blank" rel="noreferrer" className="hover:underline"><Etat etat={l.dernier.etat} /></a> : "—") },
            { titre: "Quand", rendu: (l) => (l.dernier ? depuis(Date.parse(l.dernier.quand)) : "—") },
            { titre: "Duree", rendu: (l) => duree(l.dernier?.duree), droite: true },
            { titre: "Reussis (10 derniers)", rendu: (l) => (l.finis10 ? `${l.reussis10} / ${l.finis10}` : "—"), droite: true },
          ]} lignes={auto.workflows} />
        </Carte>
      </Bloc>

      {/* 11. Coulisses */}
      <Bloc id="coulisses" n={11} titre="Coulisses des chiffres">
        <Carte note="Calcule par tools/stats/instantane.mjs (workflow stats-site). Turso facture chaque ligne lue : le cout de chaque section est mesure. Ouvrir cette page lit ~100 lignes.">
          <Tableau colonnes={[
            { titre: "Section", rendu: (l) => l.id }, { titre: "Calculee", rendu: (l) => depuis(l.calculeLe) },
            { titre: "Lignes lues", rendu: (l) => fmt(l.cout), droite: true }, { titre: "Duree", rendu: (l) => (l.dureeMs == null ? "—" : `${(l.dureeMs / 1000).toFixed(1)} s`), droite: true },
            { titre: "Etat", rendu: (l) => (l.erreur ? <Etat etat="warning" texte={l.erreur} /> : <Etat etat="success" texte="ok" />) },
          ]} lignes={Object.entries(r.sections).map(([id, s]) => ({ id, ...s }))} />
        </Carte>
      </Bloc>
    </div>
  );
}

function Bloc({ id, n, titre, entete, children }: { id: string; n: number; titre: string; entete?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={`stats-${id}`} className="flex flex-col gap-3 scroll-mt-14">
      <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-outfit text-xl font-bold text-white">
        <span><span className="text-action mr-2">{n}.</span>{titre}</span>
        {entete}
      </h2>
      {children}
    </section>
  );
}
