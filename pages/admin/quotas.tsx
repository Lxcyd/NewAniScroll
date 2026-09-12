import { useCallback, useEffect, useMemo, useState } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "../api/auth/[...nextauth]";
import { isAdminSession } from "@/lib/auth/isAdmin";
import Head from "next/head";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import {
  SORTS,
  formatValue,
  sortRows,
  type QuotaRow,
  type SortKey,
} from "@/lib/quotas/rows";

/**
 * /admin/quotas — toutes les ressources du projet qui ont un plafond, sur une
 * seule page, triees par defaut du plus pres de la limite au plus loin.
 *
 * Le 11/09/2026 le compte Vercel est passe en pause et le site a repondu 402.
 * Aucun compteur n'etait faux ce jour-la : ils etaient repartis sur quatre
 * tableaux de bord, dans quatre unites, et personne ne les regardait ensemble.
 * La question utile — « de quoi suis-je le plus pres ? » — n'avait aucun
 * endroit ou etre posee. C'est cet endroit.
 *
 * Le tri n'est donc pas un confort : c'est la fonction principale. Tout le
 * reste (filtres, saisie manuelle) sert a ce que ce tri soit honnete.
 */

export async function getServerSideProps(ctx: any) {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  if (!isAdminSession(session)) {
    return { redirect: { destination: "/", permanent: false } };
  }
  return { props: {} };
}

type Payload = {
  rows: QuotaRow[];
  errors: Record<string, string>;
  collectedAt: string;
};

const STATE_STYLE: Record<string, { bar: string; text: string; label: string }> = {
  over:    { bar: "bg-red-500",    text: "text-red-400",    label: "depasse" },
  warn:    { bar: "bg-orange-500", text: "text-orange-400", label: "critique" },
  watch:   { bar: "bg-yellow-500", text: "text-yellow-400", label: "a surveiller" },
  ok:      { bar: "bg-emerald-500",text: "text-emerald-400",label: "ok" },
  unknown: { bar: "bg-white/20",   text: "text-white/40",   label: "non mesure" },
};

const KIND_LABEL: Record<string, string> = {
  usage: "consommation",
  capacity: "occupation",
  rate: "debit",
  structural: "borne",
};

/** Un releve manuel vieux de plus d'une semaine ne vaut plus rien : le dire. */
const STALE_HOURS = 24 * 7;

export default function QuotasPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("closest");
  const [provider, setProvider] = useState("all");
  const [kind, setKind] = useState("all");
  const [onlyMeasured, setOnlyMeasured] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v2/admin/quotas${fresh ? "?fresh=1" : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e?.message || "echec du chargement");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (id: string, value: string) => {
      await fetch("/api/v2/admin/quotas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, used: value === "" ? null : value }),
      });
      setEditing(null);
      // `fresh` parce que le POST vient d'invalider le cache : recharger sans
      // lui reafficherait la valeur d'avant.
      load(true);
    },
    [load],
  );

  const providers = useMemo(
    () => Array.from(new Set((data?.rows || []).map((r) => r.provider))),
    [data],
  );

  const rows = useMemo(() => {
    let r = data?.rows || [];
    if (provider !== "all") r = r.filter((x) => x.provider === provider);
    if (kind !== "all") r = r.filter((x) => x.kind === kind);
    if (onlyMeasured) r = r.filter((x) => x.used != null);
    return sortRows(r, sort);
  }, [data, provider, kind, onlyMeasured, sort]);

  // Le resume ne compte que ce qui est mesure : annoncer « 0 depassement »
  // alors que 30 lignes sont inconnues serait un mensonge par omission.
  const summary = useMemo(() => {
    const all = data?.rows || [];
    const measured = all.filter((r) => r.used != null);
    return {
      total: all.length,
      measured: measured.length,
      over: measured.filter((r) => r.state === "over").length,
      warn: measured.filter((r) => r.state === "warn").length,
    };
  }, [data]);

  return (
    <>
      <Head>
        <title>Quotas — AniScroll admin</title>
      </Head>
      <div className="min-h-screen bg-primary text-white px-6 py-6">
        <header className="mb-6 space-y-3">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-xs text-white/60 hover:text-action w-fit transition-colors"
          >
            <ArrowLeftIcon className="w-4 h-4" />
            Retour a l&apos;admin
          </Link>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Quotas</h1>
              <p className="text-sm text-white/50 max-w-2xl">
                Toutes les ressources du projet qui ont un plafond chiffre.
                Triees par defaut du plus pres de la limite au plus loin.
              </p>
            </div>
            <button
              type="button"
              onClick={() => load(true)}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-secondary hover:bg-image rounded transition-colors disabled:opacity-40"
            >
              <ArrowPathIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              Releve frais
            </button>
          </div>

          <div className="flex flex-wrap gap-3 text-sm">
            <Pill label="plafonds suivis" value={summary.total} />
            <Pill label="mesures automatiques" value={summary.measured} />
            <Pill
              label="depasses"
              value={summary.over}
              tone={summary.over ? "text-red-400" : undefined}
            />
            <Pill
              label="au-dela de 80 %"
              value={summary.warn}
              tone={summary.warn ? "text-orange-400" : undefined}
            />
            {data?.collectedAt && (
              <span className="px-3 py-1 rounded bg-secondary text-white/40">
                releve {new Date(data.collectedAt).toLocaleString("fr-FR")}
              </span>
            )}
          </div>

          {/* Une API qui refuse de repondre est une information, pas un detail
              technique a avaler en silence : sans ca, une ligne « non mesuree »
              ressemble a une ligne « non mesurable ». */}
          {data && Object.keys(data.errors || {}).length > 0 && (
            <div className="text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded p-3 space-y-1">
              {Object.entries(data.errors).map(([k, v]) => (
                <p key={k}>
                  <strong>{k}</strong> n&apos;a pas repondu : {v}
                </p>
              ))}
            </div>
          )}
          {error && (
            <p className="text-sm text-red-400">Chargement impossible : {error}</p>
          )}
        </header>

        <div className="flex flex-wrap gap-3 mb-4 text-sm">
          <Select
            label="Trier par"
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            options={Object.entries(SORTS)}
          />
          <Select
            label="Fournisseur"
            value={provider}
            onChange={setProvider}
            options={[["all", "Tous"], ...providers.map((p) => [p, p] as [string, string])]}
          />
          <Select
            label="Nature"
            value={kind}
            onChange={setKind}
            options={[["all", "Toutes"], ...Object.entries(KIND_LABEL)]}
          />
          <label className="flex items-center gap-2 px-3 py-2 bg-secondary rounded cursor-pointer">
            <input
              type="checkbox"
              checked={onlyMeasured}
              onChange={(e) => setOnlyMeasured(e.target.checked)}
            />
            Seulement ce qui est mesure
          </label>
        </div>

        <div className="space-y-2">
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              editing={editing === r.id}
              draft={draft}
              setDraft={setDraft}
              onEdit={() => {
                setEditing(r.id);
                setDraft(r.used != null && r.manual ? String(r.used) : "");
              }}
              onCancel={() => setEditing(null)}
              onSave={() => save(r.id, draft)}
            />
          ))}
          {!loading && !rows.length && (
            <p className="text-white/40 py-8 text-center">
              Aucun plafond ne correspond a ces filtres.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <span className="px-3 py-1 rounded bg-secondary">
      <strong className={tone || "text-white"}>{value}</strong>{" "}
      <span className="text-white/40">{label}</span>
    </span>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-2 px-3 py-2 bg-secondary rounded">
      <span className="text-white/40">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent outline-none cursor-pointer"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v} className="bg-secondary">
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row({
  row,
  editing,
  draft,
  setDraft,
  onEdit,
  onCancel,
  onSave,
}: {
  row: QuotaRow;
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const style = STATE_STYLE[row.state];
  const stale = row.manual && row.ageHours != null && row.ageHours > STALE_HOURS;
  // Une jauge vide et une jauge pleine doivent se distinguer au coup d'oeil,
  // mais un depassement ne doit pas deborder du conteneur : on borne a 100 %
  // en largeur et on garde le vrai pourcentage dans le texte.
  const width = row.pct == null ? 0 : Math.min(100, row.pct);

  return (
    <div className="bg-secondary/60 rounded p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs px-2 py-0.5 rounded bg-image/60 text-white/60">
          {row.provider} · {row.plan}
        </span>
        <h2 className="font-medium">{row.metric}</h2>
        <span className="text-xs text-white/30">
          {KIND_LABEL[row.kind]}
          {row.period !== "—" && ` · par ${row.period}`}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className={`text-sm font-mono ${style.text}`}>
            {row.used != null
              ? `${formatValue(row.used, row.unit)} / ${formatValue(row.limit, row.unit)}`
              : row.limit > 0
                ? `— / ${formatValue(row.limit, row.unit)}`
                : "aucun plafond publie"}
          </span>
          <span className={`text-sm font-mono w-16 text-right ${style.text}`}>
            {row.pct != null ? `${row.pct} %` : style.label}
          </span>
        </div>
      </div>

      <div className="mt-2 h-1.5 bg-black/40 rounded overflow-hidden">
        <div
          className={`h-full ${style.bar} transition-all`}
          style={{ width: `${width}%` }}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
        {row.measuredBy && (
          <span className={stale ? "text-orange-400" : undefined}>
            {row.measuredBy}
            {row.ageHours != null &&
              ` · il y a ${row.ageHours < 1 ? "moins d'une heure" : `${Math.round(row.ageHours)} h`}`}
            {stale && " · releve perime"}
          </span>
        )}
        {row.detail && <span>{row.detail}</span>}
        {row.missing.length > 0 && (
          <span className="text-orange-400">
            mesure impossible — il manque {row.missing.join(", ")}
          </span>
        )}
        {row.measurable === "manual" && !row.measuredBy && (
          <span>aucune API d&apos;usage — a relever a la main</span>
        )}
        {row.source === "observed" && (
          <span className="text-white/30">plafond releve, non documente</span>
        )}
        {row.doc && (
          <a
            href={row.doc}
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-action"
          >
            doc
          </a>
        )}
        {row.measurable === "manual" && !editing && (
          <button
            type="button"
            onClick={onEdit}
            className="flex items-center gap-1 hover:text-action ml-auto"
          >
            <PencilSquareIcon className="w-3.5 h-3.5" />
            {row.manual ? "corriger le releve" : "noter un releve"}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave();
              if (e.key === "Escape") onCancel();
            }}
            placeholder={`valeur en ${row.unit === "bytes" ? "octets" : row.unit}`}
            className="px-2 py-1 bg-black/40 rounded outline-none w-56 font-mono"
          />
          <button type="button" onClick={onSave} className="px-2 py-1 bg-action/80 rounded">
            enregistrer
          </button>
          <button type="button" onClick={onCancel} className="px-2 py-1 bg-image rounded">
            annuler
          </button>
          <span className="text-white/30">
            vide = effacer le releve · plafond {formatValue(row.limit, row.unit)}
          </span>
        </div>
      )}

      {row.note && (
        <p className="mt-2 text-xs text-white/35 leading-relaxed">{row.note}</p>
      )}
    </div>
  );
}
