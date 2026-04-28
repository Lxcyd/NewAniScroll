import { getServersByLang } from "@/lib/servers";
import { SignalIcon } from "@heroicons/react/24/solid";

const LANG_CONFIG = {
  multi: { label: "Multi", flag: "🌐", description: "Sub / Dub" },
  vo: { label: "VO", flag: "🇯🇵", description: "Japanese" },
  vf: { label: "VF", flag: "🇫🇷", description: "French" },
};

// Decide whether a server should be visible in the selector.
// Rules:
//  1. Active server is always visible (so user sees what's playing).
//  2. Failed servers are hidden (even iframe ones, once explicitly flagged).
//  3. Iframe servers are visible by default (confirmed = true unless flagged).
//  4. API/HLS servers are visible only after a successful probe.
function shouldShow(server, activeServer, confirmedServers, failedServers) {
  if (server.id === activeServer) return true;
  // A client-side iframe validator or onError can flag the server as failed;
  // hide it in that case even if it's iframe-type.
  if (failedServers?.has?.(server.id) || failedServers?.get?.(server.id)) {
    return false;
  }
  if (server.type === "iframe") return true;
  return confirmedServers?.has(server.id);
}

function LangGroup({ langKey, servers, activeServer, onChange, failedServers, confirmedServers }) {
  const config = LANG_CONFIG[langKey];
  const visible = (servers || []).filter((s) =>
    shouldShow(s, activeServer, confirmedServers, failedServers)
  );
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-base leading-none">{config.flag}</span>
        <span className="text-xs text-white/40 font-karla uppercase tracking-wider">
          {config.label}
        </span>
        <span className="text-[10px] text-white/25 font-karla">
          {config.description}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((server) => {
          const isActive = activeServer === server.id;
          const isFailed = failedServers?.get?.(server.id);
          // Dot color: active = accent orange, confirmed = green, failed = red
          const dotColor = isActive
            ? "#FF7F57"
            : isFailed
            ? "#EF4444"
            : "#10B981";
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              title={isFailed ? `Broken: ${isFailed}` : ""}
              className={`inline-flex items-center gap-2 rounded-pill px-3 py-1.5 text-sm font-karla font-medium transition-all duration-200 ${
                isActive
                  ? isFailed
                    ? "bg-as-dropped/25 text-white ring-1 ring-as-dropped/70 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
                    : "bg-action/25 text-white ring-1 ring-action shadow-[0_0_12px_rgba(255,127,87,0.35)]"
                  : "bg-as-surface/70 text-white/80 ring-1 ring-white/5 hover:bg-as-surface hover:text-white hover:ring-white/20"
              }`}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: dotColor, boxShadow: `0 0 6px ${dotColor}` }}
              />
              {server.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ServerSelector({ activeServer, onChange, failedServers, confirmedServers }) {
  const groups = getServersByLang();

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex items-center gap-2 text-sm font-karla font-semibold text-white/70">
        <SignalIcon className="w-4 h-4 text-as-accent" />
        <span>Servers</span>
        <span className="ml-2 text-[10px] text-white/40 font-karla">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-as-watching mr-1 align-middle" />
          available
        </span>
      </div>

      <LangGroup
        langKey="multi"
        servers={groups.multi}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
      />
      <LangGroup
        langKey="vo"
        servers={groups.vo}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
      />
      <LangGroup
        langKey="vf"
        servers={groups.vf}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
      />
    </div>
  );
}
