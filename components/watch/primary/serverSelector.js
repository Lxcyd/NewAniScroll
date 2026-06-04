import { getServersByLang } from "@/lib/servers";
import { SignalIcon } from "@heroicons/react/24/solid";
import { useTranslation } from "react-i18next";

const LANG_CONFIG = {
  multi: { labelKey: "player.langMulti", flag: "🌐", descKey: "player.langMultiDesc" },
  vo: { labelKey: "player.langVO", flag: "🇯🇵", descKey: "player.langVODesc" },
  vf: { labelKey: "player.langVF", flag: "🇫🇷", descKey: "player.langVFDesc" },
};

// Speed "poinçon": a colored dot per server, keyed on its `speed` rank from
// lib/servers.js (1 = fastest). Green = fast, amber = medium, red = slow — so
// a viewer can pick a quick server at a glance and switch off a slow one.
function speedInfo(speed) {
  const s = speed ?? 99;
  if (s <= 2) return { color: "#2dd47a", labelKey: "player.speedFast" };
  if (s <= 4) return { color: "#f6c544", labelKey: "player.speedMedium" };
  return { color: "#ff6b6b", labelKey: "player.speedSlow" };
}

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
          // Active server = orange ring. Every chip also carries a speed
          // "poinçon" (colored dot, see speedInfo) so the fastest servers are
          // obvious at a glance. Degraded (iframe-fallback) servers look
          // identical otherwise.
          const baseClasses = isActive
            ? "bg-action/25 text-white ring-1 ring-action shadow-[0_0_12px_rgba(255,127,87,0.35)]"
            : "bg-as-surface/70 text-white/80 ring-1 ring-white/5 hover:bg-as-surface hover:text-white hover:ring-white/20";
          const sp = speedInfo(server.speed);
          return (
            <button
              key={server.id}
              type="button"
              onClick={() => onChange(server.id)}
              title={t(sp.labelKey)}
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-karla font-medium transition-all duration-200 ${baseClasses}`}
            >
              <span
                aria-hidden="true"
                className="inline-block w-[7px] h-[7px] rounded-full shrink-0"
                style={{ background: sp.color, boxShadow: `0 0 6px ${sp.color}80` }}
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
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm font-karla font-semibold text-white/70">
          <SignalIcon className="w-4 h-4 text-as-accent" />
          <span>{t("player.servers")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-[11px] font-karla text-white/35">
          <span>{t("player.slowHint")}</span>
          <span className="flex items-center gap-2.5 text-white/30">
            <span className="flex items-center gap-1">
              <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: "#2dd47a" }} />
              {t("player.speedFast")}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: "#f6c544" }} />
              {t("player.speedMedium")}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-[6px] h-[6px] rounded-full" style={{ background: "#ff6b6b" }} />
              {t("player.speedSlow")}
            </span>
          </span>
        </div>
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
