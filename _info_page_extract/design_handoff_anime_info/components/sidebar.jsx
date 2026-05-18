const Sidebar = () => {
  const sites = [
    { name: 'MyAnimeList', tag: 'MAL', color: '#2e51a2', initial: 'M' },
    { name: 'AniList', tag: 'AL', color: '#3577ff', initial: 'A' },
    { name: 'Official Site', tag: 'WEB', color: '#ff3b5c', initial: '◆' },
    { name: 'X / Twitter', tag: 'TW', color: '#1da1f2', initial: '𝕏' },
    { name: 'Reddit', tag: 'RDT', color: '#ff4500', initial: 'r' },
    { name: 'Wikipedia', tag: 'WIKI', color: '#a0a0a0', initial: 'W' },
  ];

  return (
    <aside style={sStyles.aside}>
      {/* Details */}
      <div style={sStyles.card}>
        <div style={sStyles.kicker}>DETAILS</div>
        <div style={sStyles.detailGrid}>
          {[
            ['Format','TV Series'],
            ['Status','Airing'],
            ['Source','Web Novel'],
            ['Aired','Jan 7 – Mar 31, 2024'],
            ['Premiered','Winter 2024'],
            ['Studios','A-1 Pictures'],
            ['Producers','Aniplex, Crunchyroll'],
            ['Licensors','Crunchyroll'],
            ['Rating','PG-13'],
            ['Country','Japan / Korea'],
          ].map(([k,v]) => (
            <React.Fragment key={k}>
              <div style={sStyles.detailKey}>{k}</div>
              <div style={sStyles.detailVal}>{v}</div>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* External sites — same design as Where to Watch (left border accent) */}
      <div style={sStyles.card}>
        <div style={sStyles.kickerRow}>
          <div style={sStyles.kicker}>EXTERNAL SITES</div>
          <span className="mono" style={sStyles.tinyTag}>6 LINKS</span>
        </div>
        <div style={sStyles.platforms}>
          {sites.map(s => (
            <button key={s.name} style={{...sStyles.platform, borderLeft: `3px solid ${s.color}`}}>
              <div style={{...sStyles.platLogo, background: s.color+'22', color: s.color}}>{s.initial}</div>
              <div style={{flex:1, textAlign:'left'}}>
                <div style={sStyles.platName}>{s.name}</div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{color:'var(--txt-3)'}}><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
};

const sStyles = {
  aside: { display:'flex', flexDirection:'column', gap: 14 },
  card: {
    background: 'var(--bg-1)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    padding: 18,
  },
  kicker: { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--txt-3)', marginBottom: 10 },
  kickerRow: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10 },
  tinyTag: { fontSize: 9, color: 'var(--txt-3)', letterSpacing: '0.1em' },
  platforms: { display:'flex', flexDirection:'column', gap: 8 },
  platform: {
    display:'flex', alignItems:'center', gap: 12,
    padding: '10px 12px',
    background: 'var(--bg-2)',
    border: '1px solid var(--line)',
    borderRadius: 9,
    transition: 'all 0.15s',
  },
  platLogo: {
    width: 32, height: 32, borderRadius: 7,
    display:'grid', placeItems:'center',
    fontSize: 14, fontWeight: 700,
    flexShrink: 0,
  },
  platName: { fontSize: 13.5, fontWeight: 600, color: 'var(--txt-0)' },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '10px 16px',
    fontSize: 12.5,
  },
  detailKey: { color: 'var(--txt-3)', fontSize: 11.5, letterSpacing: '0.04em' },
  detailVal: { color: 'var(--txt-1)', fontWeight: 500, textAlign:'right' },
};

window.Sidebar = Sidebar;
