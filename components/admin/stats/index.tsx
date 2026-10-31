/**
 * Onglet « Statistiques » du panneau admin, en onglets. Le premier, « Sante »,
 * repond a UNE question : quelque chose est-il casse ? Chaque controle
 * (diagnostiquer) dit ok / a surveiller / panne, avec le pourquoi et un lien.
 * Puis GitHub Actions (echecs recents, job et etape), la fraicheur de chaque
 * chaine de donnees, et le detail par domaine.
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
        <div key={String(l.nom)} className={`group grid ${large ? "grid-cols-[minmax(0,20rem)_1fr_auto]" : "grid-cols-[minmax(0,9rem)_1fr_auto]"} items-center gap-2 text-xs font-karla`} title={`${libelle(l.nom)} : ${format(l.n)} (${pct(l.n, somme)})`}>
          <span className="text-white/70 truncate">{libelle(l.nom)}</span>
          <span className="h-2.5 rounded-sm bg-white/5 overflow-hidden">
            <span className="block h-full rounded-sm bg-action opacity-75 group-hover:opacity-100 transition-opacity" style={{ width: `${Math.max(1.5, ((Number(l.n) || 0) / haut) * 100)}%` }} />
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
          <div key={String(l.nom)} className="group relative flex-1 h-full flex items-end" title={`${l.nom} : ${format(l.n)}`}>
            <div className="w-full rounded-t-[3px] bg-action opacity-75 group-hover:opacity-100 transition-opacity" style={{ height: `${Math.max(1, ((Number(l.n) || 0) / max) * 100)}%` }} />
          </div>
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
// L'ordre des groupes « sans souci » : ce qui touche les visiteurs d'abord.
const ORDRE_DOMAINES = ["Site", "Donnees", "GitHub Actions", "Quotas", "Moderation", "Statistiques"];

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

/* ── Les onglets ─────────────────────────────────────────────────────────── */
const ONGLETS: { id: string; titre: string }[] = [
  { id: "sante", titre: "Sante" },
  { id: "github", titre: "GitHub Actions" },
  { id: "donnees", titre: "Donnees" },
  { id: "audience", titre: "Audience" },
  { id: "comptes", titre: "Comptes" },
  { id: "catalogue", titre: "Catalogue" },
  { id: "lecteurs", titre: "Lecteurs" },
  { id: "images", titre: "Images" },
  { id: "oped", titre: "OP/ED" },
  { id: "moderation", titre: "Moderation" },
  { id: "infra", titre: "Quotas & bases" },
];
const CLE_ONGLET = "admin-stats-onglet";

export default function AdminStats() {
  const [r, setR] = useState<Reponse | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [charge, setCharge] = useState(true);
  const [onglet, setOngletBrut] = useState("sante");
  useEffect(() => { try { const o = localStorage.getItem(CLE_ONGLET); if (o && ONGLETS.some((x) => x.id === o)) setOngletBrut(o); } catch {} }, []);
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
  const controles = useMemo(() => (r && !r.vide ? diagnostiquer(r) : []), [r]);
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

  const S = (id: string) => r.sections?.[id]?.data || {};
  const au = S("audience"), co = S("comptes"), ca = S("catalogue"), le = S("lecteurs"), op = S("oped"), im = S("images"), mo = S("moderation"), inf = S("infra"), auto = S("automatisations"), tb = S("tables"), fr = S("fraicheur");
  const parOnglet = (o: string) => controles.filter((x) => x.onglet === o && (x.niveau === "panne" || x.niveau === "attention"));
  const calcule = (...ids: string[]) => {
    const x = ids.map((i) => r.sections[i]).filter(Boolean);
    if (!x.length) return null;
    const hebdo = ids.some((i) => ["catalogue", "images"].includes(i));
    return (
      <p className="text-[11px] text-white/40">
        Chiffres calcules {depuis(Math.min(...x.map((s) => s.calculeLe || 0)))} · {ids.includes("automatisations") ? "chaque heure" : hebdo ? "chaque semaine" : "chaque matin"}
        {x.some((s) => s.erreur) && <span className="text-amber-300"> · dernier calcul en erreur : {x.find((s) => s.erreur)!.erreur}</span>}
      </p>
    );
  };

  return (
    <div className="px-4 md:px-6 py-6 flex flex-col gap-6 font-karla">
      {/* Les onglets, avec le nombre de points a regarder dans chacun. */}
      <nav className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-2 bg-primary/95 backdrop-blur flex items-center gap-1 overflow-x-auto scrollbar-hide border-b border-white/5" role="tablist">
        {ONGLETS.map((o) => {
          const n = o.id === "sante" ? controles.filter((x) => x.niveau === "panne" || x.niveau === "attention").length : parOnglet(o.id).length;
          const panne = o.id === "sante" ? controles.some((x) => x.niveau === "panne") : parOnglet(o.id).some((x) => x.niveau === "panne");
          return (
            <button key={o.id} type="button" role="tab" aria-selected={onglet === o.id} onClick={() => setOnglet(o.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded transition-colors ${onglet === o.id ? "bg-white/15 text-white" : "text-white/60 hover:text-white hover:bg-white/5"}`}>
              {o.titre}
              {n > 0 && <span className={`text-[10px] font-bold px-1.5 rounded-full ${panne ? "bg-rose-500/80 text-white" : "bg-amber-400/80 text-black"}`}>{n}</span>}
            </button>
          );
        })}
        <button type="button" onClick={charger} className="ml-auto shrink-0 inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-white/10 hover:bg-white/20" title="Relire l'instantane">
          <ArrowPathIcon className={`w-3.5 h-3.5 ${charge ? "animate-spin" : ""}`} /> Relire
        </button>
      </nav>

      {onglet === "sante" && <OngletSante controles={controles} aller={setOnglet} r={r} />}

      {onglet === "github" && (
        <Panneau titre="GitHub Actions" sous={calcule("automatisations")}>
          <OngletGithub auto={auto} />
        </Panneau>
      )}

      {onglet === "donnees" && (
        <Panneau titre="Fraicheur des donnees" sous={calcule("fraicheur")} alertes={parOnglet("donnees")} aller={setOnglet}>
          <OngletDonnees fr={fr} serie={serie} />
        </Panneau>
      )}

      {onglet === "audience" && (
        <Panneau titre="Audience" sous={calcule("audience")} alertes={parOnglet("audience")} aller={setOnglet}>
          {au.indisponible ? <p className="text-sm text-white/50">{au.indisponible}</p> : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <Tuile label="Visiteurs aujourd'hui" valeur={fmt(au.resume?.visiteursAujourdhui)} sous={`hier ${fmt(au.resume?.visiteursHier)}`} />
                <Tuile label="Visiteurs · 7 jours" valeur={fmt(au.resume?.visiteurs7j)} sous="somme des uniques par jour" />
                <Tuile label="Pages vues · 30 j" valeur={compact(au.resume?.pages30j)} />
                <Tuile label="Requetes · 30 j" valeur={compact(au.resume?.requetes30j)} />
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
              <Carte titre="Erreurs serveur (5xx) des dernieres 24 h" note="proxy.aniscroll.com relaie le code du lecteur source : un 504 la-bas veut dire qu'un hebergeur video a ete trop lent, pas que le site est casse.">
                <Tableau colonnes={[
                  { titre: "Adresse", rendu: (l) => l.hote }, { titre: "Chemin", rendu: (l) => <span className="break-all text-white/60">{l.chemin}</span> },
                  { titre: "Code", rendu: (l) => l.code, droite: true }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true },
                ]} lignes={au.erreurs24h || []} vide="Aucune erreur 5xx en 24 h." max={10} />
              </Carte>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                <Carte titre="Pays (requetes, 30 j)"><Barres lignes={au.pays} libelle={pays} /></Carte>
                <Carte titre="Navigateurs (pages vues, 30 j)"><Barres lignes={au.navigateurs} /></Carte>
                <Carte titre="Codes de reponse (30 j)"><Barres lignes={au.statuts} libelle={(c) => `HTTP ${c}`} /></Carte>
                <Carte titre="Familles de pages (24 h)"><Barres lignes={au.familles24h} /></Carte>
                <Carte titre="Appareils (24 h)"><Barres lignes={au.appareils24h} /></Carte>
                <Carte titre="Systemes (24 h)"><Barres lignes={au.os24h} /></Carte>
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                <Carte titre="Pages les plus demandees (24 h, aniscroll.com)" note="Les chemins /wp-…, /index.php… sont des robots qui cherchent des failles WordPress.">
                  <Tableau colonnes={[{ titre: "Chemin", rendu: (l) => <span className="break-all">{l.nom}</span> }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true }]} lignes={au.chemins24h} max={12} />
                </Carte>
                <Carte titre="Par adresse (24 h)">
                  <Tableau colonnes={[{ titre: "Adresse", rendu: (l) => l.nom }, { titre: "Requetes", rendu: (l) => fmt(l.n), droite: true }, { titre: "Cache Cloudflare", rendu: (l) => pct(l.cache, l.n), droite: true }]} lignes={au.hotes24h} />
                </Carte>
              </div>
            </>
          )}
        </Panneau>
      )}

      {onglet === "comptes" && (
        <Panneau titre="Comptes" sous={calcule("comptes")}>
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
            <Tuile label="Comptes" valeur={fmt(co.comptes?.total)} serie={serie("comptes.comptes")} />
            <Tuile label="E-mail verifie" valeur={fmt(co.comptes?.verifies)} sous={pct(co.comptes?.verifies, co.comptes?.total)} />
            <Tuile label="Lies a AniList" valeur={fmt(co.comptes?.anilist)} sous={pct(co.comptes?.anilist, co.comptes?.total)} />
            <Tuile label="Nouveaux · 7 j" valeur={fmt(co.comptes?.nouveaux7j)} />
            <Tuile label="Nouveaux · 30 j" valeur={fmt(co.comptes?.nouveaux30j)} />
            <Tuile label="Actifs · 24 h" valeur={fmt(co.comptes?.actifs24h)} />
            <Tuile label="Actifs · 7 j" valeur={fmt(co.comptes?.actifs7j)} serie={serie("comptes.actifs7j")} />
            <Tuile label="Actifs · 30 j" valeur={fmt(co.comptes?.actifs30j)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <Carte titre="Inscriptions par mois"><Colonnes lignes={parMois(co.inscriptions)} /></Carte>
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
        </Panneau>
      )}

      {onglet === "catalogue" && (
        <Panneau titre="Catalogue" sous={calcule("catalogue")}>
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
        </Panneau>
      )}

      {onglet === "lecteurs" && (
        <Panneau titre="Lecteurs & sources" sous={calcule("lecteurs")}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tuile label="Episodes anime-sama jouables" valeur={fmt(le.animeSama?.vivants)} sous={`${fmt(le.animeSama?.morts)} morts · ${pct(le.animeSama?.vivants, le.animeSama?.episodes)} du total`} serie={serie("lecteurs.asVivants")} />
            <Tuile label="Episodes voir-anime jouables" valeur={fmt(le.voirAnime?.vivants)} sous={`${fmt(le.voirAnime?.pages)} pages · ${pct(le.voirAnime?.ancrees, le.voirAnime?.pages)} ancrees`} serie={serie("lecteurs.vaVivants")} />
            <Tuile label="Correspondances verifiees" valeur={fmt(le.resume?.lignesVerifiees)} sous="player_map" serie={serie("lecteurs.lignesVerifiees")} />
            <Tuile label="Frembed : titres heberges" valeur={fmt(le.frembed?.heberges)} sous={`sur ${fmt(le.frembed?.sondes)} sondes`} />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            <Carte titre="Registre des lecteurs (lib/lecteurs.json)">
              <Tableau colonnes={[
                { titre: "Lecteur", rendu: (l) => l.nom },
                { titre: "Etat", rendu: (l) => <Etat etat={l.etat === "actif" ? "success" : l.etat === "mort" ? "failure" : "cancelled"} texte={l.etat} /> },
                { titre: "Site", rendu: (l) => (l.site ? "oui" : "non") }, { titre: "Lot OP/ED", rendu: (l) => (l.lot ? "oui" : "non") },
                { titre: "Note", rendu: (l) => <span className="text-white/50">{l.raison || l.note || ""}</span> },
              ]} lignes={Object.entries(le.lecteurs || {}).map(([nom, v]: any) => ({ nom, ...v })).sort((a: any, b: any) => (a.etat === "actif" ? 0 : 1) - (b.etat === "actif" ? 0 : 1))} max={12} />
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
          <Carte titre="Performance des lecteurs (moyenne glissante, tous visiteurs)" note="Mesuree dans le navigateur des visiteurs (lib/watch/serverPerf.ts). Demarrage, coupures, avance et seek : plus bas = mieux ; qualite : plus haut = mieux. Entre parentheses : nombre de mesures.">
            <Tableau colonnes={[
              { titre: "Lecteur", rendu: (l) => l.nom },
              ...([["t", "Demarrage", (v: number) => `${(v / 1000).toFixed(1)} s`], ["s", "Coupures / min", (v: number) => `${v.toFixed(1)} s`],
                ["b", "20 s d'avance en", (v: number) => `${(v / 1000).toFixed(1)} s`], ["k", "Seek", (v: number) => `${(v / 1000).toFixed(1)} s`],
                ["q", "Qualite", (v: number) => `${Math.round(v)}p`]] as const).map(([c, titre, f]) => ({
                titre, droite: true,
                rendu: (l: any) => (l[c] ? <span>{f(l[c].ewma)} <span className="text-white/35">({fmt(l[c].n)})</span></span> : "—"),
              })),
              { titre: "Derniere mesure", rendu: (l) => depuis(l.maj), droite: true },
            ]} lignes={Object.values((le.perf || []).reduce((m: any, x: any) => {
              const q = (m[x.nom] ||= { nom: x.nom, maj: 0, total: 0 });
              q[x.crit] = { ewma: Number(x.ewma), n: x.n };
              q.maj = Math.max(q.maj, Number(x.updated_at) || 0);
              q.total += x.n;
              return m;
            }, {})).sort((a: any, b: any) => b.total - a.total)} />
          </Carte>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <Carte titre="Pourquoi une source est sautee (broken / absent)" className="xl:col-span-2"><Barres lignes={le.notes} max={10} large /></Carte>
            <Carte titre="Qui a verifie les correspondances"><Barres lignes={(le.origines || []).map((x: any) => ({ nom: `${x.source} · ${x.origine}`, n: x.n }))} /></Carte>
            <Carte titre="anime-sama : episodes jouables par langue"><Barres lignes={(le.animeSama?.langues || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
            <Carte titre="anime-sama : par genre de panneau"><Barres lignes={(le.animeSama?.genres || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
            <Carte titre="voir-anime : episodes jouables par langue"><Barres lignes={(le.voirAnime?.langues || []).map((x: any) => ({ nom: x.nom, n: x.vivants }))} /></Carte>
            <Carte titre="voir-anime : types de pages"><Barres lignes={le.voirAnime?.types} /></Carte>
            <Carte titre="voir-anime : ancrage AniList"><Barres lignes={le.voirAnime?.ancres} /></Carte>
            <Carte titre="Durees d'episodes par lecteur"><Barres lignes={le.runtimes} /></Carte>
          </div>
        </Panneau>
      )}

      {onglet === "images" && (
        <Panneau titre="Images" sous={calcule("images")}>
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
        </Panneau>
      )}

      {onglet === "oped" && (
        <Panneau titre="Openings & endings" sous={calcule("oped")}>
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
        </Panneau>
      )}

      {onglet === "moderation" && (
        <Panneau titre="Moderation" sous={calcule("moderation")} alertes={parOnglet("moderation")} aller={setOnglet}>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <Tuile label="Signalements ouverts" valeur={fmt(mo.signalements?.ouverts)} sous={`dont ${fmt(mo.signalements?.enAttente)} en attente`} />
            <Tuile label="Signalements au total" valeur={fmt(mo.signalements?.total)} />
            <Tuile label="Nouveaux · 7 j" valeur={fmt(mo.signalements?.nouveaux7j)} />
            <Tuile label="Nouveaux · 30 j" valeur={fmt(mo.signalements?.nouveaux30j)} />
            <Tuile label="Delai moyen de resolution" valeur={duree(mo.signalements?.resolutionMoyenneS)} />
            <Tuile label="IP bannies" valeur={fmt(mo.bans)} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            <Carte titre="Signalements par mois"><Colonnes lignes={parMois(mo.parMois)} /></Carte>
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
        </Panneau>
      )}

      {onglet === "infra" && (
        <Panneau titre="Quotas & bases" sous={calcule("infra", "tables")} alertes={parOnglet("infra")} aller={setOnglet}>
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
          <Carte titre="Taille des tables (lignes)" note={`Comptage exact, chaque jour. ${fmt(tb.resume?.lignesEnBase)} lignes au total.`}>
            <Tableau colonnes={[
              { titre: "Base", rendu: (l) => <span className="text-white/50">{l.base}</span> }, { titre: "Table", rendu: (l) => l.nom },
              { titre: "Lignes", rendu: (l) => fmt(l.n), droite: true },
            ]} lignes={tb.tables || []} max={15} />
          </Carte>
          <Carte titre="Comment ces chiffres sont calcules" note="tools/stats/instantane.mjs (workflow stats-site) : tout chaque matin, l'etat GitHub chaque heure, catalogue et images chaque semaine. Turso facture chaque ligne lue : le cout de chaque section est mesure. Ouvrir cette page lit ~20 lignes.">
            <Tableau colonnes={[
              { titre: "Section", rendu: (l) => l.id }, { titre: "Calculee", rendu: (l) => depuis(l.calculeLe) },
              { titre: "Lignes lues", rendu: (l) => fmt(l.cout), droite: true }, { titre: "Duree", rendu: (l) => (l.dureeMs == null ? "—" : `${(l.dureeMs / 1000).toFixed(1)} s`), droite: true },
              { titre: "Etat", rendu: (l) => (l.erreur ? <Etat etat="warning" texte={l.erreur} /> : <Etat etat="success" texte="ok" />) },
            ]} lignes={Object.entries(r.sections).map(([id, s]) => ({ id, ...s }))} />
          </Carte>
        </Panneau>
      )}
    </div>
  );
}

/** Un onglet : son titre, quand ses chiffres ont ete calcules, et ses alertes en tete. */
function Panneau({ titre, sous, alertes, aller, children }: { titre: string; sous?: React.ReactNode; alertes?: Controle[]; aller?: (o: string) => void; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-outfit text-xl font-bold text-white">{titre}</h2>
        {sous}
      </div>
      {!!alertes?.length && aller && (
        <div className="bg-secondary rounded-md px-4 py-1 border-l-2 border-amber-400/70">
          {alertes.map((x, i) => <LigneControle key={i} x={x} aller={aller} />)}
        </div>
      )}
      {children}
    </section>
  );
}

/* ── Sante ───────────────────────────────────────────────────────────────── */
function OngletSante({ controles, aller, r }: { controles: Controle[]; aller: (o: string) => void; r: Reponse }) {
  const pannes = controles.filter((x) => x.niveau === "panne");
  const attention = controles.filter((x) => x.niveau === "attention");
  const reste = controles.filter((x) => x.niveau === "ok" || x.niveau === "info");
  const domaines = [...new Set(reste.map((x) => x.domaine))].sort((a, b) => ORDRE_DOMAINES.indexOf(a) - ORDRE_DOMAINES.indexOf(b));
  const [Icone, couleur] = pannes.length ? NIVEAU.panne : attention.length ? NIVEAU.attention : NIVEAU.ok;
  const plusVieux = Math.min(...Object.values(r.sections).map((s) => s.calculeLe || Date.now()));
  return (
    <section className="flex flex-col gap-4">
      <div className="bg-secondary rounded-md p-5 flex items-center gap-4">
        <Icone className={`w-10 h-10 shrink-0 ${couleur}`} />
        <div>
          <p className="font-outfit text-2xl font-bold text-white">
            {pannes.length ? `${pannes.length} probleme${pannes.length > 1 ? "s" : ""} a corriger` : attention.length ? "Rien de casse" : "Tout fonctionne"}
          </p>
          <p className="text-sm text-white/60">
            {attention.length ? `${attention.length} point${attention.length > 1 ? "s" : ""} a surveiller · ` : ""}{controles.length} controles · etat GitHub mis a jour chaque heure, le reste chaque matin (plus ancien chiffre : {depuis(plusVieux)})
          </p>
        </div>
      </div>

      {!!(pannes.length + attention.length) && (
        <div className="bg-secondary rounded-md px-4 py-1">
          {[...pannes, ...attention].map((x, i) => (
            <div key={i} className="flex flex-col">
              <span className="sr-only">{x.domaine}</span>
              <LigneControle x={{ ...x, nom: `${x.domaine} · ${x.nom}` }} aller={aller} />
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {domaines.map((d) => (
          <Carte key={d} titre={`${d} · ${reste.filter((x) => x.domaine === d).length} controle(s) sans souci`}>
            <ListeRepliable lignes={reste.filter((x) => x.domaine === d)} aller={aller} />
          </Carte>
        ))}
      </div>
    </section>
  );
}

function ListeRepliable({ lignes, aller, max = 6 }: { lignes: Controle[]; aller: (o: string) => void; max?: number }) {
  const [tout, setTout] = useState(false);
  return (
    <div>
      {(tout ? lignes : lignes.slice(0, max)).map((x, i) => <LigneControle key={i} x={x} aller={aller} />)}
      {lignes.length > max && (
        <button type="button" onClick={() => setTout(!tout)} className="mt-1 text-[11px] text-action hover:underline">
          {tout ? "Reduire" : `Voir les ${lignes.length}`}
        </button>
      )}
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
