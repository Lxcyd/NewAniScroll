import Link from "next/link";

/**
 * Generic "this section is under construction" placeholder. Used on
 * pages whose feature isn't shipped yet (manga reader, etc.) so the
 * route doesn't 404 and the user gets a clear status message.
 */
export default function UnderConstruction({
  feature = "This section",
  description,
  backHref = "/en",
  backLabel = "Back home",
}: {
  feature?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <main className="min-h-screen w-full flex items-center justify-center px-4 py-20">
      <div className="max-w-md w-full bg-secondary rounded-card ring-1 ring-white/10 p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-action/15 flex-center mb-4 text-3xl">
          🚧
        </div>
        <h1 className="font-outfit text-2xl font-bold text-white mb-2">
          {feature} is under construction
        </h1>
        <p className="font-karla text-white/70 leading-relaxed">
          {description ||
            "We're building this part of the site — it isn't ready yet. Come back soon."}
        </p>
        <Link
          href={backHref}
          className="inline-block mt-6 px-5 py-2 rounded-md bg-action text-white font-semibold hover:bg-action/90 transition-colors font-karla"
        >
          {backLabel}
        </Link>
      </div>
    </main>
  );
}
