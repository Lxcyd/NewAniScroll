import { getServersByLang } from "@/lib/servers";
import { SignalIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";

const LANG_CONFIG = {
  multi: { labelKey: "player.langMulti", flag: "🌐", descKey: "player.langMultiDesc" },
  vo: { labelKey: "player.langVO", flag: "🇯🇵", descKey: "player.langVODesc" },
  vf: { labelKey: "player.langVF", flag: "🇫🇷", descKey: "player.langVFDesc" },
};

// Decide whether a server should be visible in the selector.
function shouldShow(server, activeServer, confirmedServers, failedServers) {
  if (server.id === activeServer) return true;
  if (failedServers?.has?.(server.id) || failedServers?.get?.(server.id)) {
    return false;
  }
  if (server.type === "iframe") return true;
  return confirmedServers?.has(server.id);
}

function LangGroup({
  langKey,
  servers,
  activeServer,
  onChange,
  failedServers,
  confirmedServers,
  degradedServers,
}) {
  const { t } = useTranslation();
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
          {t(config.labelKey)}
        </span>
        <span className="text-[10px] text-white/25 font-karla">
          {t(config.descKey)}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((server) => {
          const isActive = activeServer === server.id;
          const isFailed = failedServers?.get?.(server.id);
          const isDegraded = degradedServers?.has?.(server.id);
          // Dot color: active = accent orange; failed = red; degraded = red
          // (won't run inside the custom player); confirmed = green.
          const dotColor = isActive
            ? "#FF7F57"
            : isFailed || isDegraded
            ? "#EF4444"
            : "#10B981";
          // Degraded chips: red ring + tinted background so they read as
          // "exists but might not behave" before the user clicks.
          const baseClasses = isActive
            ? isFailed
              ? "bg-as-dropped/25 text-white ring-1 ring-as-dropped/70 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
              : isDegraded
              ? "bg-red-500/15 text-white ring-1 ring-red-500/60 shadow-[0_0_12px_rgba(239,68,68,0.35)]"
              : "bg-action/25 text-white ring-1 ring-action shadow-[0_0_12px_rgba(255,127,87,0.35)]"
            : isDegraded
            ? "bg-red-500/10 text-white/85 ring-1 ring-red-500/40 hover:bg-red-500/20 hover:ring-red-500/60"
            : "bg-as-surface/70 text-white/80 ring-1 ring-white/5 hover:bg-as-surface hover:text-white hover:ring-white/20";
          const title = isFailed
            ? t("player.serverBroken", { reason: isFailed })
            : isDegraded
            ? t("player.serverDegraded")
            : "";
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              title={title}
              className={`inline-flex items-center gap-2 rounded-pill px-3 py-1.5 text-sm font-karla font-medium transition-all duration-200 ${baseClasses}`}
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

export default function ServerSelector({
  activeServer,
  onChange,
  failedServers,
  confirmedServers,
  degradedServers,
}) {
  const { t } = useTranslation();
  const groups = getServersByLang();

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex items-center gap-2 text-sm font-karla font-semibold text-white/70">
        <SignalIcon className="w-4 h-4 text-as-accent" />
        <span>{t("player.servers")}</span>
        <span className="ml-2 text-[10px] text-white/40 font-karla">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-as-watching mr-1 align-middle" />
          {t("player.available")}
        </span>
        <span className="ml-2 text-[10px] text-white/40 font-karla">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 mr-1 align-middle" />
          {t("player.degraded")}
        </span>
      </div>

      <LangGroup
        langKey="multi"
        servers={groups.multi}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
        degradedServers={degradedServers}
      />
      <LangGroup
        langKey="vo"
        servers={groups.vo}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
        degradedServers={degradedServers}
      />
      <LangGroup
        langKey="vf"
        servers={groups.vf}
        activeServer={activeServer}
        onChange={onChange}
        failedServers={failedServers}
        confirmedServers={confirmedServers}
        degradedServers={degradedServers}
      />
    </div>
  );
}
