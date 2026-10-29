// Runs once when a server/function starts. The Node-only code lives in its
// own file: the edge build compiles this one too and has no `http` module.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
