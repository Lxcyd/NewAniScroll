// Vercel collector — best-effort. Vercel does NOT expose a stable public API for
// per-route invocations / Active-CPU on Hobby (that data lives only in the
// dashboard's Observability, or via Log Drains you host yourself). So this
// collector pulls what IS reliably available: the recent DEPLOYMENTS, so a usage
// spike in the report can be correlated with the release that caused it — which
// is exactly how the July CPU incident was (mis)diagnosed. If/when you enable a
// Log Drain, aggregate it separately and feed it into the report.

async function vGet(cfg, path) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (cfg.teamId) url.searchParams.set("teamId", cfg.teamId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    throw new Error(`Vercel ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Recent deployments (prod + preview), newest first, trimmed to the essentials. */
export async function fetchVercelDeployments(cfg, limit = 12) {
  const data = await vGet(
    cfg,
    `/v6/deployments?app=${encodeURIComponent(cfg.projectId)}&limit=${limit}`,
  );
  const deployments = (data?.deployments || []).map((d) => ({
    uid: d.uid,
    state: d.state || d.readyState,
    target: d.target || (d.meta?.githubCommitRef === "main" ? "production" : "preview"),
    branch: d.meta?.githubCommitRef || null,
    sha: d.meta?.githubCommitSha ? String(d.meta.githubCommitSha).slice(0, 7) : null,
    message: d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 80) || null,
    createdAt: d.created ? new Date(d.created).toISOString() : null,
  }));
  return { deployments };
}

export async function collectVercel(cfg) {
  try {
    return { ok: true, ...(await fetchVercelDeployments(cfg)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
