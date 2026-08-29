import { useEffect, useMemo, useRef, useState } from "react";
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

// Le gris des lecteurs au repos, exactement celui des numeros d'episode du
// panneau de droite : ces deux listes se lisent cote a cote, deux gris voisins
// mais differents se seraient vus. Le rose de l'accent reste reserve au lecteur
// ACTIF — la meme couleur que son liseré et que le "en cours" du reste du site.
const TEXT = "#a2a8b8";
const TEXT_HOVER = "#f4f5f8";
const TEXT_ACTIVE = "var(--brand-primary, #E94560)";

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

/* Le LOOK d'une chip, extrait pour etre porte a l'identique par la rangee qui
   s'en va : sans ca, la copie sortante aurait fallu recopier a la main une
   dizaine de classes et deux teintes en color-mix, et la moindre retouche du
   vivant aurait laisse la sortie derriere.
   Les teintes de l'accent passent par color-mix en style inline : `action` vaut
   `var(--brand-primary, …)`, et Tailwind v3 ne sait pas injecter d'alpha dans
   une var() — `bg-action/20` ne genere AUCUNE regle. Meme piege que
   LangPreferenceModal documente.
   Le survol de la chip ACTIVE doit l'assombrir comme les autres, et un `hover:`
   Tailwind ne peut pas : le fond est pose ici, en inline, donc il gagne
   toujours. D'ou l'etat de survol tenu en React — un voile noir se superpose a
   la teinte d'accent. */
function chipStyle(isActive, isHovered) {
  if (!isActive) {
    // Le fond s'assombrit au survol : le nom monte d'un cran en meme temps,
    // sinon la chip visee perdrait en lisibilite.
    return { color: isHovered ? TEXT_HOVER : TEXT };
  }
  return {
    background: `${
      isHovered ? "linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), " : ""
    }color-mix(in srgb, var(--brand-primary, #E94560) 20%, transparent)`,
    boxShadow:
      "inset 0 0 0 1px color-mix(in srgb, var(--brand-primary, #E94560) 70%, transparent)",
    color: TEXT_ACTIVE,
  };
}

function chipClass(isActive) {
  return `inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-karla font-medium transition-colors duration-200 ${
    isActive
      ? ""
      : // Le survol ASSOMBRIT la chip visee (il ne l'eclaircit pas) : sur une
        // barre posee sous des ambient lights, un creux se lit mieux qu'une
        // bosse.
        "bg-[#232735]/55 ring-1 ring-white/10 hover:bg-[#0e1016]/40 hover:ring-white/20"
  }`;
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

  /* Le fond de l'onglet choisi est un calque unique qui GLISSE d'un onglet a
     l'autre, au lieu de s'eteindre ici pour se rallumer la. Sa position est
     mesuree sur le bouton actif plutot que calculee : les trois libelles n'ont
     pas la meme longueur ("MULTI" / "VOSTFR" / "VF"), et des colonnes de
     largeur egale auraient etire "VF" pour rien.
     Rien a prevoir pour le premier rendu : le calque n'existe pas tant qu'il
     n'est pas mesure, et une transition ne se declenche jamais sur le style
     initial d'un element — il nait donc a sa place, sans traverser la barre.
     `available.join("|")` en dependance et non `available` : le tableau est
     reconstruit a chaque rendu, la chaine ne change qu'avec les onglets. */
  /* La rangee qui s'en va, gardee le temps de son fondu.
     `key={lang}` demonte les anciennes chips a l'instant meme du changement :
     il n'y a donc plus rien a animer quand on voudrait les faire partir. On en
     conserve une COPIE inerte, posee en surimpression, effacee au bout de la
     duree du fondu. Le compare se fait sur la langue seule — `servers` et
     `labels` sont reconstruits a chaque rendu et relanceraient l'effet sans
     qu'aucun onglet n'ait bouge. */
  const dernierRendu = useRef(null);
  const [sortants, setSortants] = useState(null);
  useEffect(() => {
    const avant = dernierRendu.current;
    dernierRendu.current = { lang, servers, labels };
    if (!avant || avant.lang === lang || !avant.servers.length) return;
    setSortants(avant);
    const id = setTimeout(() => setSortants(null), 200);
    return () => clearTimeout(id);
    // Seule la langue declenche la sortie ; le reste est lu au moment ou elle
    // change, jamais observe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const tabsRef = useRef(null);
  const [pill, setPill] = useState(null);
  useEffect(() => {
    const el = tabsRef.current?.querySelector("[data-lang-active]");
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [lang, available.join("|")]);

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

      {/* La rangee, et par-dessus la copie de celle qui s'en va.
          `relative` sur le conteneur : la copie sortante est posee en
          `absolute` dessus, donc elle ne pousse rien et les deux gestes se
          croisent au meme endroit.
          `key={lang}` : changer d'onglet REMONTE la rangee, ce qui rejoue
          l'animation d'entree meme sur une chip dont l'identifiant survivrait
          d'une langue a l'autre. Sans lui, React reconcilierait en place et le
          changement se ferait sans que rien ne bouge — or c'est justement le
          moment ou l'on veut voir que la liste n'est plus la meme. */}
      <div className="relative flex min-w-0 grow items-center">
        {sortants && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 flex flex-wrap items-center gap-1.5"
          >
            {sortants.servers.map((server) => (
              <span
                key={server.id}
                className={`as-chip-out ${chipClass(activeServer === server.id)}`}
                style={chipStyle(activeServer === server.id, false)}
              >
                {sortants.labels[server.id]}
              </span>
            ))}
          </div>
        )}

        <div key={lang} className="flex flex-wrap items-center gap-1.5 min-w-0 grow">
          {/* La vitesse ne s'affiche plus nulle part sur la chip — ni le mot, ni
              le poincon de couleur, ni l'infobulle. Elle continue en revanche
              d'ORDONNER la liste (useServerPerfRank) : le plus rapide reste en
              tete, c'est ce rang qui parle maintenant. */}
          {servers.map((server, i) => {
            const isActive = activeServer === server.id;
            const solo = servers.length === 1;
            return (
              <button
                key={server.id}
                type="button"
                onClick={() => onChange(server.id)}
                onMouseEnter={() => setHovered(server.id)}
                onMouseLeave={() => setHovered(null)}
                /* Les chips entrent l'une apres l'autre, de gauche a droite : un
                   decalage court suffit a montrer que la rangee s'est refaite,
                   la ou une apparition simultanee ressemble a un simple
                   clignotement. Plafonne a 5 crans — au-dela, la derniere chip
                   arriverait apres qu'on ait deja lu la premiere.
                   Une chip seule n'a personne a attendre : pas de retard, et une
                   entree plus ample (cf. `as-chip-in-solo`). */
                style={{
                  animationDelay: solo ? undefined : `${Math.min(i, 5) * 45}ms`,
                  ...chipStyle(isActive, hovered === server.id),
                }}
                /* Voir `as-chip-in` dans styles/globals.css pour le geste et
                   pour ce qui change quand la chip est seule. */
                className={`${solo ? "as-chip-in-solo" : "as-chip-in"} ${chipClass(
                  isActive,
                )}`}
              >
                {labels[server.id]}
              </button>
            );
          })}
        </div>
      </div>

      {available.length > 1 && (
        <div
          ref={tabsRef}
          className="relative shrink-0 flex items-center gap-0.5 rounded-lg bg-black/30 p-0.5"
        >
          {/* Le calque qui glisse. Il est pose SOUS les onglets (z-0 contre
              z-10) et porte le fond opaque + le liseré que chaque onglet actif
              dessinait lui-meme : un seul objet qui se deplace se lit comme un
              curseur, la ou trois fonds qui s'allument tour a tour ne disent
              rien du chemin parcouru. */}
          {pill && (
            <span
              aria-hidden
              className="absolute bottom-0.5 top-0.5 z-0 rounded-[6px]"
              style={{
                left: 0,
                width: pill.width,
                transform: `translateX(${pill.left}px)`,
                background: "#2b3040",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.16)",
                transition:
                  "transform 260ms cubic-bezier(0.32,0.72,0,1), width 260ms cubic-bezier(0.32,0.72,0,1)",
              }}
            />
          )}
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
              data-lang-active={l === lang ? "" : undefined}
              className={`relative z-10 rounded-[6px] px-2.5 py-1 text-[11px] font-karla font-semibold uppercase tracking-wide transition-colors ${
                l === lang ? "text-white" : "text-white/60 hover:text-white"
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
