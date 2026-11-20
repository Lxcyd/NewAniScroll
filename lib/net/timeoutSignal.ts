/**
 * Un signal qui abandonne la requete au bout de `ms` — ou rien du tout.
 *
 * `AbortSignal.timeout` n'existe qu'a partir de Safari 16 / Chrome 103 : sur un
 * vieil iPhone, l'appeler directement jetterait un TypeError AVANT la requete,
 * et casserait ce qui marchait. Sans support, on rend `undefined` : le fetch
 * part comme avant, simplement sans borne (20/11/2026).
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== "undefined" && typeof (AbortSignal as any).timeout === "function"
      ? (AbortSignal as any).timeout(ms)
      : undefined;
  } catch {
    return undefined;
  }
}
