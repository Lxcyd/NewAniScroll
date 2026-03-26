import SERVERS from "@/lib/servers";
import { SignalIcon } from "@heroicons/react/24/solid";

export default function ServerSelector({ activeServer, onChange }) {
  const iframeServers = SERVERS.filter((s) => s.type === "iframe");
  const hlsServers = SERVERS.filter((s) => s.type === "hls");

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex items-center gap-2 text-sm font-karla font-semibold text-white/70">
        <SignalIcon className="w-4 h-4" />
        <span>Servers</span>
      </div>

      {/* Iframe servers */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-white/40 font-karla uppercase tracking-wider">
          Embed
        </span>
        <div className="flex flex-wrap gap-2">
          {iframeServers.map((server) => (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              className={`px-3 py-1.5 text-sm rounded font-karla transition-all duration-200 ${
                activeServer === server.id
                  ? "bg-action text-white ring-1 ring-action"
                  : "bg-secondary text-white/70 hover:bg-secondary/80 hover:text-white hover:ring-1 hover:ring-white/20"
              }`}
            >
              {server.name}
            </button>
          ))}
        </div>
      </div>

      {/* HLS servers */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-white/40 font-karla uppercase tracking-wider">
          HLS
        </span>
        <div className="flex flex-wrap gap-2">
          {hlsServers.map((server) => (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              className={`px-3 py-1.5 text-sm rounded font-karla transition-all duration-200 ${
                activeServer === server.id
                  ? "bg-action text-white ring-1 ring-action"
                  : "bg-secondary text-white/70 hover:bg-secondary/80 hover:text-white hover:ring-1 hover:ring-white/20"
              }`}
            >
              {server.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
