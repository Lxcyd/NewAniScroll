// Remplacement AniScroll : l'original envoie les erreurs a Sentry. Ici, les
// projecteurs n'en ont besoin que pour signaler, la console suffit.
export class AmbientlightError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

const SentryReporter = {
  captureException: (ex) => console.warn("[ambilight]", ex),
};

export default SentryReporter;
