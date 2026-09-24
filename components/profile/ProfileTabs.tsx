/**
 * Les onglets d'un profil. Un simple sélecteur en pilules — l'état vit chez la
 * page, qui décide aussi lesquels ont un sens (un profil sans liste n'a pas
 * d'onglet statistiques à proposer).
 */

export type ProfileTab = {
  key: string;
  label: string;
  /** Compteur discret à droite du libellé. */
  count?: number | null;
};

export default function ProfileTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: ProfileTab[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    /* `as-stat-card` comme toutes les surfaces du profil : elle porte le fond
       sombre ET le flou que règle le studio de bannière. Sans elle, la barre
       était la seule à laisser l'illustration nette derrière son texte. */
    <div className="as-stat-card flex w-max items-center gap-1 rounded-full p-[5px] ring-1 ring-white/[0.07]">
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            onClick={() => onChange(tab.key)}
            aria-current={on ? "page" : undefined}
            className={`rounded-full px-4 py-2 font-karla text-[13px] font-bold transition-colors sm:px-[18px] ${
              on ? "bg-action text-white shadow-glow" : "text-white/55 hover:text-white"
            }`}
          >
            {tab.label}
            {tab.count != null ? (
              <span className="ml-1.5 opacity-55">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
