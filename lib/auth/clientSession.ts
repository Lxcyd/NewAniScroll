/**
 * La session telle que le <SessionProvider> de _app l'a DEJA recue, lisible hors
 * de React.
 *
 * Pourquoi. `getSession()` de next-auth refait TOUJOURS l'aller-retour
 * `/api/auth/session` — une invocation de fonction Vercel. Or la synchro AniList
 * de fond (lib/list/syncEngine.ts), lancee au repos par _app a CHAQUE chargement
 * de page et pour TOUT visiteur (anonymes compris, tant que la direction de
 * synchro n'est pas choisie), l'appelait juste apres que le provider eut fait le
 * meme appel. Mesure le 23/10/2026 sur une ouverture de page anime : deux
 * `/api/auth/session`, dont un pour relire ce qu'on savait deja.
 *
 * Le provider tourne sans rafraichissement (refetchInterval 0, cf. _app) : ce
 * que tout le reste de l'interface affiche, c'est deja cette valeur-ci. On ne
 * perd donc aucune fraicheur ; une deconnexion (signOut) passe par le provider
 * et arrive ici comme le reste.
 */
import { getSession } from "next-auth/react";

type Status = "loading" | "authenticated" | "unauthenticated";

let status: Status = "loading";
let data: any = null;
let waiters: Array<() => void> = [];

/** Appele par <SessionBridge/> (pages/_app.tsx) a chaque changement d'etat. */
export function publishSession(next: Status, session: any): void {
  status = next;
  data = session ?? null;
  if (next === "loading") return;
  const w = waiters;
  waiters = [];
  w.forEach((f) => f());
}

/** Au-dela, on cesse d'attendre le provider et on demande au serveur. */
const WAIT_MS = 5000;

/**
 * La session courante, sans requete quand le provider l'a deja. Pendant son
 * premier chargement, attend sa reponse plutot que d'en lancer une seconde ;
 * `getSession()` ne sert plus que de filet (provider absent ou muet).
 */
export async function currentSession(): Promise<any | null> {
  if (status === "loading") {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, WAIT_MS);
      waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (status !== "loading") return data;
  return getSession();
}
