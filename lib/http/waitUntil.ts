/**
 * Laisser un travail finir APRES la reponse, sur Vercel.
 *
 * C'est ce que fait `waitUntil` de `@vercel/functions`, sans le paquet : il
 * tire une quinzaine de dependances (oidc, execa, zod…) pour lire une seule
 * valeur, le contexte de requete que le runtime Vercel pose sur `globalThis`.
 *
 * Hors Vercel (local, build) le contexte n'existe pas : la promesse tourne
 * quand meme, simplement sans garantie d'aller au bout si le processus
 * s'arrete. Jamais d'exception : c'est un confort, pas un chemin critique.
 */
const CONTEXT = Symbol.for("@vercel/request-context");

export function waitUntil(promise: Promise<unknown>): void {
  const safe = promise.catch(() => {});
  try {
    const ctx = (globalThis as any)[CONTEXT]?.get?.();
    ctx?.waitUntil?.(safe);
  } catch {
    /* pas de contexte : la promesse suit son cours seule */
  }
}
