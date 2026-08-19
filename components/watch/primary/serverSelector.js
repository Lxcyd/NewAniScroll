import { useMemo, useState } from "react";
import { getServersByLang } from "@/lib/servers";
import { useTranslation } from "react-i18next";
// @ts-ignore — plain JS context, no types
import { useWatchProvider } from "@/lib/context/watchPageProvider";
import {
  useServerPerfRank,
  useServerPerfScores,
  tierOf,
} from "@/lib/watch/serverPerf";
import { shouldShowServer } from "@/lib/watch/serverVisibility";

const LANGS = ["multi", "vo", "vf"];
const LANG_LABELS = {
  multi: "player.langMulti",
  vo: "player.langVO",
  vf: "player.langVF",
};

// Speed "poinçon" tiers. Green = fast, amber = medium, red = slow.
const SPEED_TIERS = {
  fast: { color: "#2dd47a", labelKey: "player.speedFast" },
  medium: { color: "#f6c544", labelKey: "player.speedMedium" },
  slow: { color: "#ff6b6b", labelKey: "player.speedSlow" },
};

// A server's tier reflects, in order of authority:
//   1. the LIVE reading for the stream playing right now (UniversalPlayer
//      writes the real throughput/rebuffering to the watch context),
//   2. the PERSISTED score learned across sessions on this device
//      (lib/watch/serverPerf) — the only tier that can speak for a server the
//      user hasn't opened yet, which is exactly what a chip needs,
//   3. the static `speed` rank from lib/servers.js (1 = fastest), the at-rest
//      estimate written by hand.
// megaplay & co. vary per title, so a static rank lies; each step down is a
// weaker claim, and the opacity of the tier word says which one is talking.
function staticTier(speed) {
  const s = speed ?? 99;
  if (s <= 2) return "fast";
  if (s <= 4) return "medium";
  return "slow";
}

// Chips are read at a glance, and inside a language group the site prefix is
// noise: under VF every host is anime-sama or voir-anime already. So we show
// the host word ("Sibnet", "Ansembed") — but only while it stays UNIQUE among
// the chips on screen. Two "Vidmoly" chips from different sites would be an
// unresolvable choice, so in that case everyone keeps their full name.
function shortNames(servers) {
  const short = {};
  const seen = {};
  for (const s of servers) {
    const w = s.name.split(" ").pop();
    seen[w] = (seen[w] || 0) + 1;
    short[s.id] = w;
  }
  const out = {};
  for (const s of servers) out[s.id] = seen[short[s.id]] > 1 ? s.name : short[s.id];
  return out;
}

export default function ServerSelector({
  activeServer,
  onChange,
  failedServers,
  confirmedServers,
  degradedServers,
}) {
  const { t } = useTranslation();
  const { liveSpeed } = useWatchProvider() || {};
  // Ordre par le rang MESURE sur cet appareil ; identique au rang statique tant
  // qu'aucune mesure n'existe, donc l'affichage par defaut ne bouge pas.
  const groups = getServersByLang(useServerPerfRank());
  // Un seul balayage pour les trois groupes : c'est la meme table.
  const scores = useServerPerfScores();

  // Only languages that actually have a showable server get a tab — an empty
  // "VF" tab would be a dead end on a title anime-sama doesn't carry.
  const visibleByLang = useMemo(() => {
    const out = {};
    for (const lang of LANGS) {
      const v = (groups[lang] || []).filter((s) =>
        shouldShowServer(s, activeServer, confirmedServers, failedServers)
      );
      if (v.length) out[lang] = v;
    }
    return out;
  }, [groups, activeServer, confirmedServers, failedServers]);

  const available = LANGS.filter((l) => visibleByLang[l]);
  // The language of the server actually playing wins over any earlier click:
  // a fallback that switched host across languages must move the tab with it,
  // otherwise the bar would highlight a language the player isn't serving.
  const activeLang = available.find((l) =>
    visibleByLang[l].some((s) => s.id === activeServer)
  );
  const [picked, setPicked] = useState(null);
  const lang =
    (picked && visibleByLang[picked] && picked) || activeLang || available[0];

  const servers = visibleByLang[lang] || [];
  const labels = useMemo(() => shortNames(servers), [servers]);

  if (!servers.length) return null;

  return (
    /* Le fond passe par un style inline : `bg-as-card/60` ne produisait AUCUNE
       regle — `as-card` vaut `var(--surface-card, …)` et Tailwind v3 ne sait pas
       y injecter d'alpha (meme piege que les teintes d'accent plus bas). La
       barre n'avait donc pas de fond du tout. On garde la translucidite voulue
       au depart, cette fois reellement appliquee : c'est le contraste des chips
       qui porte la lisibilite, pas un aplat sombre. */
    <div
      className="relative z-10 flex items-center gap-3 rounded-xl ring-1 ring-white/[0.06] px-3 py-2"
      style={{ background: "rgba(20,22,31,0.3)" }}
    >
      <span className="hidden sm:block shrink-0 text-[11px] font-karla font-semibold uppercase tracking-[0.12em] text-white/60">
        {t("player.servers")}
      </span>

      <div className="flex flex-wrap items-center gap-1.5 min-w-0 grow">
        {servers.map((server) => {
          const isActive = activeServer === server.id;
          const score = scores[server.id];
          const live = liveSpeed?.[server.id];
          const learned = live || !score ? null : tierOf(score);
          const measured = live || learned;
          const sp =
            SPEED_TIERS[measured || staticTier(server.speed)] || SPEED_TIERS.medium;
          // Le chiffre : 0-100, plus haut = plus rapide. C'est EXACTEMENT ce qui
          // ordonne les chips, donc il reste la reference — mais dans l'infobulle,
          // le mot ("rapide") portant seul l'information a l'oeil.
          const shown = score ? Math.round(score.final) : null;
          const isMeasured = !!score && score.measured != null;
          const tip = [
            server.name,
            t(sp.labelKey),
            measured ? t("player.speedMeasured") : null,
            shown == null
              ? null
              : isMeasured
                ? `${t("player.speedScore")} ${shown} · ${t(
                    "player.speedConfidence",
                  )} ${Math.round(score.C * 100)}%`
                : `${t("player.speedScore")} ${shown} · ${t("player.speedEstimated")}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              title={tip}
              // Les teintes de l'accent passent par color-mix en style inline :
              // `action` vaut `var(--brand-primary, …)`, et Tailwind v3 ne sait
              // pas injecter d'alpha dans une var() — `bg-action/20` ne genere
              // AUCUNE regle. Meme piege que LangPreferenceModal documente.
              style={
                isActive
                  ? {
                      background:
                        "color-mix(in srgb, var(--brand-primary, #E94560) 20%, transparent)",
                      boxShadow:
                        "inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) 70%, transparent)",
                    }
                  : undefined
              }
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-karla font-medium transition-colors duration-200 ${
                isActive
                  ? "text-white"
                  : // Le survol ASSOMBRIT la chip visee (il ne l'eclaircit pas) :
                    // sur une barre posee sous des ambient lights, un creux se lit
                    // mieux qu'une bosse. Le texte reste blanc, la lisibilite ne
                    // baisse pas au moment ou on vise.
                    "bg-[#232735] text-white ring-1 ring-white/10 hover:bg-[#12141b] hover:ring-white/20"
              }`}
            >
              {labels[server.id]}
              {/* Une mesure parle plus fort qu'une estimation : le mot est
                  franc quand il vient d'une lecture, en retrait sinon. */}
              <span
                className="text-[10px] font-normal leading-none"
                style={{ color: sp.color, opacity: measured ? 1 : 0.8 }}
              >
                {t(sp.labelKey).toLowerCase()}
              </span>
            </button>
          );
        })}
      </div>

      {available.length > 1 && (
        <div className="shrink-0 flex items-center gap-0.5 rounded-lg bg-black/30 p-0.5">
          {/* Browsing, not switching: picking a language only changes WHICH
              hosts are listed — the stream keeps playing until a chip is
              clicked. So the tab holding the host that's actually playing
              carries a dot; without it, browsing another language would
              leave no active chip anywhere and hide where the stream is. */}
          {available.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setPicked(l)}
              className={`relative rounded-[6px] px-2.5 py-1 text-[11px] font-karla font-semibold uppercase tracking-wide transition-colors ${
                l === lang
                  ? "bg-white/10 text-white ring-1 ring-white/15"
                  : "text-white/60 hover:text-white"
              }`}
            >
              {t(LANG_LABELS[l])}
              {l === activeLang && l !== lang && (
                <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-action" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
