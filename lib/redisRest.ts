import { Redis as UpstashRedis } from "@upstash/redis";

/**
 * ioredis-compatible shim over the Upstash REST client.
 *
 * Why: the native Redis protocol (port 6379) is blocked outbound from our
 * network / the Vercel runtime — every `ioredis` command hit `connect
 * ETIMEDOUT`, so all caching, single-flight locking and rate-limiting silently
 * failed (this is what made the season bug non-deterministic and spammed 429s).
 * The Upstash REST API speaks HTTPS on port 443, which is NOT blocked. This
 * shim exposes the SAME method surface the codebase already calls on the
 * ioredis client (`get`, `set` with EX/NX, `del`, `keys`, `mget`, `expire`,
 * set/hash/zset/list ops, `publish`, `scan`, `on`) so call-sites don't change —
 * only the export in lib/redis.ts is swapped.
 *
 * Uses UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN when present; otherwise
 * derives them from a `rediss://default:<token>@<host>:<port>` REDIS_URL so a
 * single env var keeps working. Returns null when nothing is configured, so
 * lib/redis.ts can leave `redis` undefined and every caller's existing
 * null-guard disables caching cleanly.
 *
 * NOT covered: pub/sub SUBSCRIBE (REST is request/response). watch2gether's
 * realtime subscribe path must keep a native client or move to another channel;
 * `publish` alone works over REST.
 */

export type IoRedisish = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: any[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  keys(pattern: string): Promise<string[]>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  hset(key: string, ...args: any[]): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  zadd(key: string, ...args: any[]): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zrange(key: string, start: number, stop: number, ...args: any[]): Promise<string[]>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<string>;
  publish(channel: string, message: string): Promise<number>;
  scan(cursor: string | number, ...args: any[]): Promise<[string, string[]]>;
  on(event: string, cb: (...a: any[]) => void): void;
};

/** Parse a rediss://default:<token>@<host>:<port> URL into REST url + token. */
function deriveRest(redisUrl: string): { url: string; token: string } | null {
  try {
    const u = new URL(redisUrl);
    const token = decodeURIComponent(u.password || "");
    if (!u.hostname || !token) return null;
    return { url: `https://${u.hostname}`, token };
  } catch {
    return null;
  }
}

function resolveConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return { url, token };
  if (process.env.REDIS_URL) return deriveRest(process.env.REDIS_URL);
  return null;
}

/* ── LE DISJONCTEUR ───────────────────────────────────────────────────────────
 *
 * LE 16/09/2026, UN CACHE PLEIN A MIS LE SITE HORS SERVICE. Le palier gratuit
 * d'Upstash (500 000 commandes par mois) a été atteint, chaque commande s'est
 * mise à répondre `ERR max requests limit exceeded`, et cette erreur est
 * remontée telle quelle jusqu'à la réponse HTTP : `/api/v2/episode/:id` en 500,
 * `/api/v2/source` en 503, tous les lecteurs cassés sur toutes les pages.
 *
 * C'est une faute de conception, indépendante du quota. UN CACHE EST UNE
 * OPTIMISATION, PAS UNE DÉPENDANCE : quand il ne répond plus, le site doit
 * devenir lent, pas mort. Un `try/catch` par appelant ne suffit pas — il faut
 * qu'un seul oubli quelque part ne puisse plus faire tomber une route entière,
 * donc la garantie est posée ICI, au seul endroit par lequel tout passe.
 *
 * Et un disjoncteur, pas seulement un filet : une fois qu'Upstash a refusé une
 * commande, il refusera les suivantes. Continuer à l'appeler coûterait un
 * aller-retour HTTPS par commande, sur une fonction facturée à la seconde de
 * CPU — c'est-à-dire payer le quota Vercel pour attendre un refus connu
 * d'avance. Après une erreur, on cesse d'appeler pendant `OUTAGE_MS` et on rend
 * immédiatement la valeur de repli.
 *
 * LE PRIX, ET IL EST RÉEL : une erreur avalée est une erreur qu'on ne voit
 * plus. Le bug du `zadd` mal traduit plus bas (« NX » lu comme score) s'était
 * signalé par un 500 bien visible ; il serait désormais silencieux. D'où le
 * journal ci-dessous — une ligne par ouverture du disjoncteur, pas une par
 * commande, sinon une panne de cache remplit les logs de Vercel.
 */
const OUTAGE_MS = 60_000;
let deadUntil = 0;

/**
 * Le cache répond-il ?
 *
 * À lire par les appelants pour qui « pas de réponse » et « la réponse est
 * vide » ne sont PAS la même chose — typiquement un verrou anti-ruée : un
 * `SET NX` sans réponse ne veut pas dire « quelqu'un d'autre tient le verrou »,
 * il veut dire qu'il n'y a plus de verrou du tout, et il faut alors avancer
 * seul plutôt qu'attendre un chef qui n'existe pas.
 */
export function redisAvailable(): boolean {
  return Date.now() >= deadUntil;
}

function trip(op: string, err: unknown): void {
  const first = redisAvailable();
  deadUntil = Date.now() + OUTAGE_MS;
  if (first) {
    console.error(
      `[redis] indisponible (${op}) — cache coupé ${OUTAGE_MS / 1000}s :`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Enrobe une commande : jamais d'exception, et aucun appel réseau tant que le
 * disjoncteur est ouvert.
 *
 * `fallback` est une FONCTION et non une valeur parce que `mget` doit rendre un
 * tableau de la longueur demandée : la valeur de repli dépend des arguments.
 */
function soft<A extends any[], R>(
  op: string,
  fn: (...a: A) => Promise<R>,
  fallback: (...a: A) => R,
): (...a: A) => Promise<R> {
  return async (...a: A) => {
    if (!redisAvailable()) return fallback(...a);
    try {
      return await fn(...a);
    } catch (err) {
      trip(op, err);
      return fallback(...a);
    }
  };
}

/** Translate an ioredis `set(k, v, "EX", n, "NX")` varargs tail into the
 *  Upstash options object. Supports EX/PX (ttl) and NX/XX (conditional). */
function setOpts(args: any[]): Record<string, any> {
  const opts: Record<string, any> = {};
  for (let i = 0; i < args.length; i++) {
    const tok = String(args[i]).toUpperCase();
    if (tok === "EX") opts.ex = Number(args[++i]);
    else if (tok === "PX") opts.px = Number(args[++i]);
    else if (tok === "NX") opts.nx = true;
    else if (tok === "XX") opts.xx = true;
  }
  return opts;
}

export function createRestRedis(): IoRedisish | null {
  const cfg = resolveConfig();
  if (!cfg) return null;

  // automaticDeserialization:false → return raw strings, matching ioredis, so
  // existing JSON.parse(...) call-sites keep working unchanged.
  const c = new UpstashRedis({
    url: cfg.url,
    token: cfg.token,
    automaticDeserialization: false,
  });

  /* Les commandes telles quelles. Elles ne sont PAS exposées directement : le
     shim rendu plus bas est leur version enrobée par `soft`, qui ne lève jamais
     et n'appelle plus le réseau quand le disjoncteur est ouvert. */
  const raw: Omit<IoRedisish, "on"> = {
    get: (k) => c.get<string | null>(k) as Promise<string | null>,
    set: (k, v, ...args) => {
      const opts = setOpts(args);
      return c.set(k, v, opts) as Promise<string | null>;
    },
    del: (...keys) => c.del(...keys),
    mget: (...keys) => c.mget<(string | null)[]>(...keys) as Promise<(string | null)[]>,
    keys: (pattern) => c.keys(pattern),
    exists: (...keys) => c.exists(...keys),
    expire: (k, s) => c.expire(k, s),
    incr: (k) => c.incr(k),
    sadd: (k, ...m) => c.sadd(k, ...(m as [string, ...string[]])),
    srem: (k, ...m) => c.srem(k, ...(m as [string, ...string[]])),
    sismember: (k, m) => c.sismember(k, m),
    smembers: (k) => c.smembers(k),
    hset: (k, ...args) => {
      // ioredis: hset(k, f1, v1, f2, v2) OR hset(k, obj). Normalize to object.
      let obj: Record<string, any>;
      if (args.length === 1 && typeof args[0] === "object") obj = args[0];
      else {
        obj = {};
        for (let i = 0; i < args.length; i += 2) obj[args[i]] = args[i + 1];
      }
      return c.hset(k, obj);
    },
    hget: (k, f) => c.hget<string | null>(k, f) as Promise<string | null>,
    hgetall: (k) => c.hgetall<Record<string, string>>(k),
    hdel: (k, ...f) => c.hdel(k, ...(f as [string, ...string[]])),
    zadd: (k, ...args) => {
      // ioredis: zadd(k, [NX|XX|GT|LT], [CH], score, member). Upstash takes the
      // flags as an options object, then {score, member}. Peel any leading
      // string flags off before reading the score/member pair — otherwise the
      // flag is parsed AS the score (Number("NX") → NaN), which Upstash rejects
      // with a 500 and takes the whole request (e.g. w2g room create) down.
      const opts: Record<string, boolean> = {};
      let i = 0;
      for (; i < args.length; i++) {
        const tok = String(args[i]).toUpperCase();
        if (tok === "NX") opts.nx = true;
        else if (tok === "XX") opts.xx = true;
        else if (tok === "GT") opts.gt = true;
        else if (tok === "LT") opts.lt = true;
        else if (tok === "CH") opts.ch = true;
        else break;
      }
      const score = Number(args[i]);
      const member = args[i + 1];
      const payload = { score, member };
      return (
        Object.keys(opts).length ? c.zadd(k, opts, payload) : c.zadd(k, payload)
      ) as Promise<number>;
    },
    zrem: (k, ...m) => c.zrem(k, ...(m as [string, ...string[]])),
    zrange: (k, start, stop, ...args) => {
      // ioredis: zrange(k, start, stop, [WITHSCORES]). Upstash flattens
      // member/score pairs into the same array when withScores is set, matching
      // ioredis's output shape, so downstream WITHSCORES parsing is unchanged.
      const withScores = args.some((a) => String(a).toUpperCase() === "WITHSCORES");
      return c.zrange(k, start, stop, withScores ? { withScores: true } : undefined) as Promise<
        string[]
      >;
    },
    rpush: (k, ...v) => c.rpush(k, ...(v as [string, ...string[]])),
    lrange: (k, start, stop) => c.lrange(k, start, stop),
    ltrim: (k, start, stop) => c.ltrim(k, start, stop),
    publish: (ch, msg) => c.publish(ch, msg),
    scan: async (cursor, ...args) => {
      // ioredis: scan(cursor, "MATCH", pat, "COUNT", n). Upstash: scan(cursor,{match,count}).
      const opts: Record<string, any> = {};
      for (let i = 0; i < args.length; i++) {
        const tok = String(args[i]).toUpperCase();
        if (tok === "MATCH") opts.match = args[++i];
        else if (tok === "COUNT") opts.count = Number(args[++i]);
      }
      const [next, keys] = await c.scan(Number(cursor), opts);
      return [String(next), keys as string[]];
    },
  };

  /* LES VALEURS DE REPLI, une par commande.
   *
   * Chacune répond à la question « que vaut cette commande quand il n'y a pas
   * de cache du tout ? ». Une lecture rend le vide, une écriture rend « rien
   * écrit ». Elles sont ce qui transforme une panne de cache en site lent
   * plutôt qu'en site mort.
   *
   * `set` rend `null` et NON `"OK"` : un `SET NX` sert de verrou, et prétendre
   * l'avoir posé alors qu'aucun verrou n'existe ferait croire à l'exclusivité à
   * tout le monde à la fois. Les appelants qui ont besoin de la nuance lisent
   * `redisAvailable()` — cf. son commentaire. */
  const FALLBACKS: Record<string, (...a: any[]) => any> = {
    get: () => null,
    set: () => null,
    del: () => 0,
    mget: (...keys: string[]) => keys.map(() => null),
    keys: () => [],
    exists: () => 0,
    expire: () => 0,
    incr: () => 0,
    sadd: () => 0,
    srem: () => 0,
    sismember: () => 0,
    smembers: () => [],
    hset: () => 0,
    hget: () => null,
    hgetall: () => null,
    hdel: () => 0,
    zadd: () => 0,
    zrem: () => 0,
    zrange: () => [],
    rpush: () => 0,
    lrange: () => [],
    ltrim: () => "OK",
    publish: () => 0,
    scan: () => ["0", []],
  };

  const guarded = Object.fromEntries(
    Object.entries(raw as unknown as Record<string, (...a: any[]) => Promise<any>>).map(
      ([name, fn]) => [name, soft(name, fn, FALLBACKS[name] ?? (() => null))],
    ),
  );

  const shim: IoRedisish = {
    ...(guarded as unknown as Omit<IoRedisish, "on">),
    // REST has no persistent connection, so there are no connection events.
    on: () => {},
  };

  return shim;
}
