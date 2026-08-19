import { useMemo, useState } from "react";
import { getServersByLang } from "@/lib/servers";
import { useTranslation } from "react-i18next";
import { useServerPerfRank } from "@/lib/watch/serverPerf";
import { shouldShowServer } from "@/lib/watch/serverVisibility";

const LANGS = ["multi", "vo", "vf"];
const LANG_LABELS = {
  multi: "player.langMulti",
  vo: "player.langVO",
  vf: "player.langVF",
};

// Pas de couleur "de marque" sur ces noms : la barre est posee dans la trainee
// des ambient lights, dont la teinte change a chaque plan — un vert, un bleu ou
// un rose finit toujours par jurer avec l'image. Les deux gris de la palette du
// site (ceux de details.tsx / episodeLists.tsx) tiennent sur n'importe quel
// fond, et l'ecart entre les deux dit a lui seul quel lecteur est actif.
const TEXT = "#c4c8d4";
const TEXT_ACTIVE = "#f4f5f8";

// La vitesse ne s'AFFICHE plus (ni mot, ni poincon, ni infobulle) : elle ne fait
// plus qu'ordonner les chips, via useServerPerfRank. Les paliers rapide/moyen/
// lent et la lecture live du contexte n'ont donc plus de lecteur ici — ils
// restent dans lib/watch/serverPerf, ou le classement les consomme.

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
  // Ordre par le rang MESURE sur cet appareil ; identique au rang statique tant
  // qu'aucune mesure n'existe, donc l'affichage par defaut ne bouge pas.
  const groups = getServersByLang(useServerPerfRank());

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
  const [hovered, setHovered] = useState(null);
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
      style={{ background: "rgba(20,22,31,0.15)" }}
    >
      <span className="hidden sm:block shrink-0 text-[14px] font-karla font-bold uppercase tracking-[0.12em] text-white/75">
        {t("player.servers")}
      </span>

      <div className="flex flex-wrap items-center gap-1.5 min-w-0 grow">
        {/* La vitesse ne s'affiche plus nulle part sur la chip — ni le mot, ni le
            poincon de couleur, ni l'infobulle. Elle continue en revanche
            d'ORDONNER la liste (useServerPerfRank) : le plus rapide reste en
            tete, c'est ce rang qui parle maintenant. */}
        {servers.map((server) => {
          const isActive = activeServer === server.id;
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              onMouseEnter={() => setHovered(server.id)}
              onMouseLeave={() => setHovered(null)}
              // Les teintes de l'accent passent par color-mix en style inline :
              // `action` vaut `var(--brand-primary, …)`, et Tailwind v3 ne sait
              // pas injecter d'alpha dans une var() — `bg-action/20` ne genere
              // AUCUNE regle. Meme piege que LangPreferenceModal documente.
              //
              // Le survol de la chip ACTIVE doit l'assombrir comme les autres, et
              // un `hover:` Tailwind ne peut pas : le fond est pose ici, en
              // inline, donc il gagne toujours. D'ou l'etat de survol tenu en
              // React — un voile noir se superpose a la teinte d'accent.
              style={
                isActive
                  ? {
                      background: `${
                        hovered === server.id
                          ? "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), "
                          : ""
                      }color-mix(in srgb, var(--brand-primary, #E94560) 20%, transparent)`,
                      boxShadow:
                        "inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) 70%, transparent)",
                      color: TEXT_ACTIVE,
                    }
                  : // Le fond s'assombrit au survol : le nom monte d'un cran en
                    // meme temps, sinon la chip visee perdrait en lisibilite.
                    { color: hovered === server.id ? TEXT_ACTIVE : TEXT }
              }
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-karla font-medium transition-colors duration-200 ${
                isActive
                  ? ""
                  : // Le survol ASSOMBRIT la chip visee (il ne l'eclaircit pas) :
                    // sur une barre posee sous des ambient lights, un creux se lit
                    // mieux qu'une bosse.
                    "bg-[#232735]/55 ring-1 ring-white/10 hover:bg-[#0e1016]/40 hover:ring-white/20"
              }`}
            >
              {labels[server.id]}
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
