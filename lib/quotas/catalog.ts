/**
 * CATALOGUE DES PLAFONDS — toutes les ressources d'AniScroll qui ont une limite.
 *
 * Pourquoi ce fichier existe : le 11/09/2026 le compte Vercel est passe en pause
 * et aniscroll.com a repondu 402 a ses visiteurs. Personne ne regardait le bon
 * compteur, parce qu'il n'existait aucun endroit ou TOUS les compteurs sont
 * visibles ensemble. Chaque fournisseur a son propre tableau de bord, avec sa
 * propre unite et sa propre periode ; la seule question qui compte — « de quoi
 * suis-je le plus pres ? » — n'etait posee nulle part.
 *
 * REGLE D'ADMISSION : une entree n'a sa place ici QUE si elle a un plafond
 * chiffre. Un compteur sans limite (le nombre d'animes en base, le nombre de
 * visiteurs) n'est pas un quota : il vit sur le Dashboard, pas ici.
 *
 * REGLE DE PROVENANCE : chaque chiffre porte son `doc`. Un plafond ecrit de
 * memoire est un plafond faux ; quand la valeur vient d'une observation et non
 * d'une documentation, `source: "observed"` le dit, avec la date.
 *
 * `measurable` distingue trois mondes, et c'est la distinction la plus utile de
 * la page :
 *   - "live"   : on sait lire la consommation par API (lib/quotas/measure.ts)
 *   - "manual" : le chiffre n'existe que dans un tableau de bord, a saisir a la
 *                main (aucune API publique — c'est le cas de tout Vercel Hobby)
 *   - "static" : il n'y a rien a mesurer, c'est un debit ou une borne
 *                structurelle. On l'affiche pour savoir qu'elle existe.
 */

export type QuotaUnit =
  | "count"
  | "bytes"
  | "cpu-hours"
  | "gb-hours"
  | "seconds"
  | "minutes";

/**
 * - usage      : se consomme et se remet a zero (commandes/mois, invocations)
 * - capacity   : un stock occupe a un instant T (octets stockes, bases creees)
 * - rate       : un debit instantane (req/min) — on ne le « consomme » pas
 * - structural : une borne de forme (taille max d'un fichier, duree max)
 */
export type QuotaKind = "usage" | "capacity" | "rate" | "structural";

export type Quota = {
  id: string;
  provider: string;
  plan: string;
  metric: string;
  limit: number;
  unit: QuotaUnit;
  /** "mois" | "jour" | "heure" | "minute" | "seconde" | "30 jours" | "—" */
  period: string;
  kind: QuotaKind;
  measurable: "live" | "manual" | "static";
  /** Variables d'env necessaires a la mesure (affichees quand elles manquent). */
  needs?: string[];
  doc?: string;
  /** "docs" quand la valeur vient d'une documentation, "observed" d'un releve. */
  source?: "docs" | "observed" | "code";
  note?: string;
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/* ------------------------------------------------------------------ *
 * VERCEL — plan Hobby
 *
 * Le fournisseur qui a casse, et le seul dont AUCUNE consommation n'est
 * lisible par API : Vercel n'expose pas d'endpoint d'usage sur Hobby (ni Active
 * CPU, ni invocations, ni stockage). Ces chiffres vivent dans l'Observability
 * du dashboard, ou dans un Log Drain qu'on heberge — indisponible sur Hobby.
 * D'ou `measurable: "manual"` sur tout ce qui se consomme : la page offre une
 * saisie, parce qu'un compteur qu'on note a la main vaut mieux qu'un compteur
 * qu'on ne regarde pas. Seuls les deploiements sont comptables par API.
 * ------------------------------------------------------------------ */
const DOC_LIMITS = "https://vercel.com/docs/limits";
const DOC_HOBBY = "https://vercel.com/docs/plans/hobby";

const VERCEL: Quota[] = [
  {
    id: "vercel.active-cpu",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Fluid Active CPU",
    limit: 4,
    unit: "cpu-hours",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
    note:
      "Le compteur qui a mis le compte en pause (12 h 05 pour 4 h le 11/09/2026). " +
      "Il est par PROJET et la prod comme dev.aniscroll.com y puisent — une preview " +
      "est un MISS d'edge par construction, donc l'environnement le plus cher.",
  },
  {
    id: "vercel.provisioned-memory",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Provisioned Memory",
    limit: 360,
    unit: "gb-hours",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.invocations",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Function Invocations",
    limit: 1_000_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.edge-requests",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Edge Requests",
    limit: 1_000_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
    note:
      "Chaque reponse d'erreur non cachable au bord en consomme une. C'est le " +
      "levier derriere les en-tetes CDN-Cache-Control des chemins d'echec.",
  },
  {
    id: "vercel.fast-data-transfer",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Fast Data Transfer",
    limit: 100 * GB,
    unit: "bytes",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.fast-origin-transfer",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Fast Origin Transfer",
    limit: 10 * GB,
    unit: "bytes",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.functions-storage",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Functions Storage",
    limit: 10 * GB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "manual",
    source: "observed",
    doc: DOC_LIMITS,
    note:
      "Releve sur le dashboard le 11/09/2026 : 35,85 Go pour 10 Go. Ce plafond " +
      "n'apparait dans AUCUNE page de doc — il ne se voit que dans Usage. " +
      "Il se remplit par accumulation de deploiements, d'ou la politique de retention.",
  },
  {
    id: "vercel.deployment-storage",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Deployment Storage",
    limit: 10 * GB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "manual",
    source: "observed",
    doc: DOC_LIMITS,
    note: "Releve le 11/09/2026 : 15,23 Go pour 10 Go. Meme remarque que ci-dessus.",
  },
  {
    id: "vercel.image-transformations",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Image Transformations",
    limit: 5_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
    note:
      "Normalement a zero : next.config a `images.unoptimized = true`, donc " +
      "aucune image ne passe par l'optimiseur. Une remise a false relancerait ce compteur.",
  },
  {
    id: "vercel.image-cache-reads",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Image Cache Reads",
    limit: 300_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.image-cache-writes",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Image Cache Writes",
    limit: 100_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.global-config-reads",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Global Config Reads",
    limit: 100_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.global-config-writes",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Global Config Writes",
    limit: 100,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.web-analytics-events",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Web Analytics Events",
    limit: 50_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
    note: "Depassement : la collecte se met en pause 7 jours (pas 30).",
  },
  {
    id: "vercel.speed-insights-events",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Speed Insights Events",
    limit: 10_000,
    unit: "count",
    period: "30 jours",
    kind: "usage",
    measurable: "manual",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.deployments-per-day",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Deploiements par jour",
    limit: 100,
    unit: "count",
    period: "jour",
    kind: "usage",
    measurable: "live",
    needs: ["VERCEL_TOKEN"],
    doc: DOC_LIMITS,
    source: "docs",
    note:
      "Le seul compteur Vercel lisible par API, et accessoirement le plus parlant : " +
      "10 pushs en une journee sur dev est ce qui a rempli les deux stockages. " +
      "Le budget local de tools/quota-guard (3/jour) est bien plus strict que ce plafond.",
  },
  {
    id: "vercel.builds-per-hour",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Builds par heure",
    limit: 100,
    unit: "count",
    period: "heure",
    kind: "usage",
    measurable: "live",
    needs: ["VERCEL_TOKEN"],
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.projects",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Projets",
    limit: 200,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["VERCEL_TOKEN"],
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.domains-per-project",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Domaines par projet",
    limit: 50,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["VERCEL_TOKEN"],
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.concurrent-deployments",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Deploiements simultanes",
    limit: 1,
    unit: "count",
    period: "—",
    kind: "rate",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.build-time",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Duree de build",
    limit: 45,
    unit: "minutes",
    period: "par deploiement",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.function-duration",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Duree max d'une fonction",
    limit: 300,
    unit: "seconds",
    period: "par invocation",
    kind: "structural",
    measurable: "static",
    doc: DOC_HOBBY,
    source: "docs",
    note:
      "La page Hobby annonce 300 s ; la page Limits donne encore « 10 s par defaut, " +
      "60 s maximum » dans son tableau de configuration. Les deux coexistent dans la " +
      "doc — ne pas s'appuyer sur la valeur haute sans l'avoir verifiee.",
  },
  {
    id: "vercel.proxied-request-timeout",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Timeout d'une requete proxifiee",
    limit: 120,
    unit: "seconds",
    period: "par requete",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.build-disk",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Disque de build",
    limit: 32 * GB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.build-cache",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Cache de build",
    limit: 1 * GB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
    note: "Conserve un mois, par cle de cache.",
  },
  {
    id: "vercel.static-upload",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Taille des sources televersees (CLI)",
    limit: 100 * MB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.files-per-deployment",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Fichiers source par deploiement",
    limit: 15_000,
    unit: "count",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.routes-per-deployment",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Routes par deploiement",
    limit: 2_048,
    unit: "count",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.env-vars",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Variables d'env par environnement",
    limit: 1_000,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.env-size",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Taille totale des variables d'env",
    limit: 64 * 1024,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.cron-jobs",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Cron jobs par projet",
    limit: 100,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
    note: "Le projet n'en utilise aucun : les crons vivent dans GitHub Actions.",
  },
  {
    id: "vercel.deploy-hooks",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Deploy hooks par projet",
    limit: 5,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.projects-per-repo",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Projets par depot Git",
    limit: 25,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
  },
  {
    id: "vercel.waf-ip-blocking",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Regles WAF de blocage d'IP",
    limit: 3,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_HOBBY,
    source: "docs",
    note:
      "A garder en tete : le bannissement d'IP du projet passe par la table " +
      "admin `banned_ips`, pas par le WAF — qui plafonnerait a 3.",
  },
  {
    id: "vercel.waf-custom-rules",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Regles WAF personnalisees",
    limit: 3,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_HOBBY,
    source: "docs",
  },
  {
    id: "vercel.runtime-log-retention",
    provider: "Vercel",
    plan: "Hobby",
    metric: "Retention des logs d'execution",
    limit: 1,
    unit: "minutes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_LIMITS,
    source: "docs",
    note:
      "1 HEURE (la valeur est en heures, pas en minutes — affichee ici faute " +
      "d'unite dediee). C'est pourquoi `vercel logs --json` doit etre lance dans " +
      "l'heure qui suit l'evenement qu'on cherche.",
  },
];

/* ------------------------------------------------------------------ *
 * UPSTASH REDIS — plan Free
 *
 * Le fournisseur le mieux instrumente : l'API de management donne la serie
 * quotidienne des commandes ET les plafonds reels de la base. C'est donc le
 * seul endroit ou la page affiche une consommation vraie sans rien saisir.
 * ------------------------------------------------------------------ */
const DOC_UPSTASH = "https://upstash.com/docs/redis/overall/pricing";

const UPSTASH: Quota[] = [
  {
    id: "upstash.commands-monthly",
    provider: "Upstash",
    plan: "Free",
    metric: "Commandes",
    limit: 500_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["UPSTASH_EMAIL", "UPSTASH_API_KEY"],
    doc: DOC_UPSTASH,
    source: "docs",
    note:
      "Quand ce plafond tombe, le cache meurt — et un cache mort multiplie le " +
      "travail a l'origine, donc les invocations Vercel. C'est la boucle du 09/09. " +
      "La valeur affichee est le cumul du mois en cours ; la projection compte davantage.",
  },
  {
    id: "upstash.commands-projected",
    provider: "Upstash",
    plan: "Free",
    metric: "Commandes — projection 30 j",
    limit: 500_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["UPSTASH_EMAIL", "UPSTASH_API_KEY"],
    doc: DOC_UPSTASH,
    source: "docs",
    note:
      "Moyenne des 7 derniers jours x 30. C'est la metrique qui a predit la mort " +
      "du cache en milieu de mois en juillet — un cumul rassurant le 5 du mois " +
      "ne dit rien, la pente si.",
  },
  {
    id: "upstash.data-size",
    provider: "Upstash",
    plan: "Free",
    metric: "Taille des donnees",
    limit: 256 * MB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["UPSTASH_EMAIL", "UPSTASH_API_KEY"],
    doc: DOC_UPSTASH,
    source: "docs",
  },
  {
    id: "upstash.bandwidth",
    provider: "Upstash",
    plan: "Free",
    metric: "Bande passante",
    limit: 10 * GB,
    unit: "bytes",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["UPSTASH_EMAIL", "UPSTASH_API_KEY"],
    doc: DOC_UPSTASH,
    source: "docs",
  },
  {
    id: "upstash.databases",
    provider: "Upstash",
    plan: "Free",
    metric: "Bases de donnees",
    limit: 1,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["UPSTASH_EMAIL", "UPSTASH_API_KEY"],
    doc: DOC_UPSTASH,
    source: "docs",
    note:
      "Une seule base gratuite : c'est la raison mecanique pour laquelle dev et " +
      "prod partagent le meme cache, et pour laquelle chaque test sur dev " +
      "consomme le quota de la prod.",
  },
  {
    id: "upstash.max-request-size",
    provider: "Upstash",
    plan: "Free",
    metric: "Taille max d'une requete",
    limit: 10 * MB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_UPSTASH,
    source: "docs",
  },
  {
    id: "upstash.max-record-size",
    provider: "Upstash",
    plan: "Free",
    metric: "Taille max d'un enregistrement",
    limit: 100 * MB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_UPSTASH,
    source: "docs",
  },
];

/* ------------------------------------------------------------------ *
 * TURSO — plan Free
 *
 * L'API de plateforme donne l'usage de l'organisation entiere. A noter, parce
 * que le commentaire de lib/db/turso-fanarts.ts affirme le contraire : sur le
 * plan gratuit le budget de lignes lues est ORGANISATIONNEL, pas par base.
 * Separer les fanarts de l'anime isole la contention, pas le quota.
 * ------------------------------------------------------------------ */
const DOC_TURSO = "https://turso.tech/pricing";

const TURSO: Quota[] = [
  {
    id: "turso.rows-read",
    provider: "Turso",
    plan: "Free",
    metric: "Lignes lues",
    limit: 500_000_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["TURSO_API_TOKEN", "TURSO_ORG"],
    doc: DOC_TURSO,
    source: "docs",
    note:
      "60 M/jour pendant la panne AniList, pour un balayage complet de la table " +
      "`anime` a chaque rendu d'accueil. Le compteur monte par requete non indexee, " +
      "pas par visiteur.",
  },
  {
    id: "turso.rows-written",
    provider: "Turso",
    plan: "Free",
    metric: "Lignes ecrites",
    limit: 10_000_000,
    unit: "count",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["TURSO_API_TOKEN", "TURSO_ORG"],
    doc: DOC_TURSO,
    source: "docs",
  },
  {
    id: "turso.storage",
    provider: "Turso",
    plan: "Free",
    metric: "Stockage",
    limit: 5 * GB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["TURSO_API_TOKEN", "TURSO_ORG"],
    doc: DOC_TURSO,
    source: "docs",
  },
  {
    id: "turso.databases",
    provider: "Turso",
    plan: "Free",
    metric: "Bases de donnees",
    limit: 100,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "live",
    needs: ["TURSO_API_TOKEN", "TURSO_ORG"],
    doc: DOC_TURSO,
    source: "docs",
    note: "Le projet en utilise trois : anime, fanarts, admin.",
  },
  {
    id: "turso.bytes-synced",
    provider: "Turso",
    plan: "Free",
    metric: "Octets synchronises",
    limit: 5 * GB,
    unit: "bytes",
    period: "mois",
    kind: "usage",
    measurable: "live",
    needs: ["TURSO_API_TOKEN", "TURSO_ORG"],
    doc: DOC_TURSO,
    source: "observed",
    note:
      "Le plafond de sync n'est pas publie sur la page de tarifs ; la valeur " +
      "retenue est prudente. A corriger des qu'un chiffre officiel est disponible.",
  },
];

/* ------------------------------------------------------------------ *
 * CLOUDFLARE WORKERS — plan Free
 * Le proxy video (proxy.aniscroll.com). Sa consommation n'est pas lisible sans
 * un token d'API Cloudflare ; le plafond de 100 k requetes/jour est en revanche
 * le plus facile a crever de tout le projet — un audit de masse de player_map
 * suffit, d'ou l'interdiction d'en lancer un sans demander.
 * ------------------------------------------------------------------ */
const DOC_CF = "https://developers.cloudflare.com/workers/platform/limits/";

const CLOUDFLARE: Quota[] = [
  {
    id: "cf.requests-per-day",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Requetes",
    limit: 100_000,
    unit: "count",
    period: "jour",
    kind: "usage",
    measurable: "manual",
    doc: DOC_CF,
    source: "docs",
    note:
      "Remis a zero a minuit UTC. Ne jamais lancer d'audit de masse de player_map " +
      "sans accord : c'est exactement ce qui vide ce compteur.",
  },
  {
    id: "cf.cpu-per-request",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Temps CPU par requete",
    limit: 10,
    unit: "seconds",
    period: "par invocation",
    kind: "structural",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
    note: "10 MILLISECONDES (affiche en secondes faute d'unite dediee).",
  },
  {
    id: "cf.subrequests",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Sous-requetes par invocation",
    limit: 50,
    unit: "count",
    period: "par invocation",
    kind: "structural",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
  },
  {
    id: "cf.memory",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Memoire par isolat",
    limit: 128 * MB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
  },
  {
    id: "cf.script-size",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Taille du Worker",
    limit: 64 * MB,
    unit: "bytes",
    period: "—",
    kind: "structural",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
  },
  {
    id: "cf.cron-triggers",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Cron triggers par compte",
    limit: 5,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
  },
  {
    id: "cf.workers",
    provider: "Cloudflare",
    plan: "Workers Free",
    metric: "Workers par compte",
    limit: 100,
    unit: "count",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: DOC_CF,
    source: "docs",
  },
];

/* ------------------------------------------------------------------ *
 * GITHUB — depot public
 * Les minutes d'Actions sont gratuites et illimitees sur un depot public : ce
 * n'est donc PAS un quota, et ca n'a pas sa place ici. Ce qui a un plafond,
 * c'est la concurrence, la duree d'un job, le stockage de cache et l'API.
 * ------------------------------------------------------------------ */
const DOC_GH_LIMITS =
  "https://docs.github.com/actions/reference/usage-limits-billing-and-administration";

const GITHUB: Quota[] = [
  {
    id: "gh.concurrent-jobs",
    provider: "GitHub",
    plan: "Depot public",
    metric: "Jobs simultanes",
    limit: 20,
    unit: "count",
    period: "—",
    kind: "rate",
    measurable: "static",
    doc: DOC_GH_LIMITS,
    source: "docs",
  },
  {
    id: "gh.job-duration",
    provider: "GitHub",
    plan: "Depot public",
    metric: "Duree max d'un job",
    limit: 360,
    unit: "minutes",
    period: "par job",
    kind: "structural",
    measurable: "static",
    doc: DOC_GH_LIMITS,
    source: "docs",
  },
  {
    id: "gh.workflow-duration",
    provider: "GitHub",
    plan: "Depot public",
    metric: "Duree max d'un workflow",
    limit: 35 * 24 * 60,
    unit: "minutes",
    period: "par execution",
    kind: "structural",
    measurable: "static",
    doc: DOC_GH_LIMITS,
    source: "docs",
  },
  {
    id: "gh.actions-cache",
    provider: "GitHub",
    plan: "Depot public",
    metric: "Cache Actions par depot",
    limit: 10 * GB,
    unit: "bytes",
    period: "—",
    kind: "capacity",
    measurable: "static",
    doc: "https://docs.github.com/actions/using-workflows/caching-dependencies-to-speed-up-workflows",
    source: "docs",
  },
  {
    id: "gh.api-rate",
    provider: "GitHub",
    plan: "Token authentifie",
    metric: "Appels API REST",
    limit: 5_000,
    unit: "count",
    period: "heure",
    kind: "rate",
    measurable: "static",
    doc: "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    source: "docs",
  },
];

/* ------------------------------------------------------------------ *
 * SOURCES DE DONNEES EXTERNES — des DEBITS, pas des quotas mensuels.
 *
 * On ne peut pas les « consommer » au sens d'un compteur qui se remplit : ils
 * se depassent instantanement ou pas du tout. Ils figurent ici parce que c'est
 * la reponse a « quelle limite vais-je toucher si je lance ce script ? », et
 * parce que plusieurs de ces chiffres ne sont ecrits nulle part ailleurs que
 * dans un commentaire de code — ce qui les rend invisibles.
 * ------------------------------------------------------------------ */
const EXTERNES: Quota[] = [
  {
    id: "anilist.rate",
    provider: "AniList",
    plan: "Public",
    metric: "Requetes GraphQL",
    limit: 30,
    unit: "count",
    period: "minute",
    kind: "rate",
    measurable: "static",
    doc: "https://docs.anilist.co/guide/rate-limiting",
    source: "code",
    note:
      "lib/anilist/anilistFetch.ts s'autolimite a 28/min pour garder 2/min de marge " +
      "aux appelants qui contournent le limiteur. API en panne (403) depuis le 02/09/2026.",
  },
  {
    id: "jikan.rate-minute",
    provider: "Jikan (MAL)",
    plan: "Public",
    metric: "Requetes",
    limit: 60,
    unit: "count",
    period: "minute",
    kind: "rate",
    measurable: "static",
    doc: "https://docs.api.jikan.moe/#section/Information/Rate-Limiting",
    source: "code",
  },
  {
    id: "jikan.rate-second",
    provider: "Jikan (MAL)",
    plan: "Public",
    metric: "Requetes",
    limit: 3,
    unit: "count",
    period: "seconde",
    kind: "rate",
    measurable: "static",
    doc: "https://docs.api.jikan.moe/#section/Information/Rate-Limiting",
    source: "code",
  },
  {
    id: "wallhaven.rate",
    provider: "Wallhaven",
    plan: "Sans cle (SFW)",
    metric: "Requetes",
    limit: 45,
    unit: "count",
    period: "minute",
    kind: "rate",
    measurable: "static",
    doc: "https://wallhaven.cc/help/api",
    source: "docs",
    note:
      "Par IP. C'est la contrainte qui a impose la pagination paresseuse : " +
      "1 445 images = 61 requetes, soit plus d'une minute de debit pour un seul titre.",
  },
  {
    id: "animeskip.rate",
    provider: "Anime-Skip",
    plan: "Free",
    metric: "Requetes",
    limit: 60,
    unit: "count",
    period: "minute",
    kind: "rate",
    measurable: "static",
    doc: "https://api.anime-skip.com",
    source: "code",
    note: "Chiffre releve dans lib/db/turso-admin.ts, pas dans une doc publique.",
  },
  {
    id: "tmdb.rate",
    provider: "TMDB",
    plan: "Cle API",
    metric: "Requetes",
    limit: 50,
    unit: "count",
    period: "seconde",
    kind: "rate",
    measurable: "static",
    doc: "https://developer.themoviedb.org/docs/rate-limiting",
    source: "docs",
    note: "Plus de plafond journalier depuis 2019 — seulement ce debit.",
  },
  {
    id: "fanart.rate",
    provider: "fanart.tv",
    plan: "Cle personnelle",
    metric: "Requetes",
    limit: 0,
    unit: "count",
    period: "—",
    kind: "rate",
    measurable: "static",
    doc: "https://fanarttv.docs.apiary.io/",
    source: "observed",
    note:
      "Aucun plafond publie. Entree conservee pour que l'absence de limite soit " +
      "un fait constate et non une supposition — un 429 ici voudrait dire que " +
      "la politique a change.",
  },
];

export const CATALOG: Quota[] = [
  ...VERCEL,
  ...UPSTASH,
  ...TURSO,
  ...CLOUDFLARE,
  ...GITHUB,
  ...EXTERNES,
];

export const PROVIDERS = Array.from(new Set(CATALOG.map((q) => q.provider)));

export function quotaById(id: string): Quota | undefined {
  return CATALOG.find((q) => q.id === id);
}
