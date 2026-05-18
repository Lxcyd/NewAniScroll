const TopBar = () => {
  const items = ['Home', 'Browse', 'Seasonal', 'My List', 'Schedule'];
  const [active, setActive] = React.useState('Browse');
  return (
    <header style={tbStyles.bar}>
      <div style={tbStyles.left}>
        <div style={tbStyles.logo}>
          <div style={tbStyles.logoMark}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M11 2 L20 7 L20 15 L11 20 L2 15 L2 7 Z" stroke="#ff3b5c" strokeWidth="1.6" fill="rgba(255,59,92,0.12)"/>
              <circle cx="11" cy="11" r="2.5" fill="#ff3b5c"/>
            </svg>
          </div>
          <span className="display" style={tbStyles.logoText}>OTAKU<span style={{color:'var(--accent)'}}>.</span>HUB</span>
        </div>
        <nav style={tbStyles.nav}>
          {items.map(i => (
            <button key={i} onClick={()=>setActive(i)} style={{
              ...tbStyles.navItem,
              color: active === i ? 'var(--txt-0)' : 'var(--txt-2)',
            }}>
              {i}
              {active === i && <div style={tbStyles.navDot}/>}
            </button>
          ))}
        </nav>
      </div>
      <div style={tbStyles.right}>
        <div style={tbStyles.search}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
          <input placeholder="Search anime, manga, characters..." style={tbStyles.searchInput}/>
          <span className="mono" style={tbStyles.kbd}>⌘K</span>
        </div>
        <button style={tbStyles.iconBtn} title="Notifications">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
          <span style={tbStyles.notifDot}/>
        </button>
        <div style={tbStyles.avatar}>HK</div>
      </div>
    </header>
  );
};

const tbStyles = {
  bar: {
    position: 'sticky', top: 0, zIndex: 50,
    height: 60,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0 28px',
    background: 'rgba(10,11,16,0.85)',
    backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
    borderBottom: '1px solid var(--line)',
  },
  left: { display: 'flex', alignItems: 'center', gap: 36 },
  logo: { display: 'flex', alignItems: 'center', gap: 10 },
  logoMark: { display:'grid', placeItems:'center' },
  logoText: { fontSize: 16, fontWeight: 700, letterSpacing: '0.02em' },
  nav: { display: 'flex', gap: 4 },
  navItem: {
    position: 'relative', padding: '8px 12px', fontSize: 13.5, fontWeight: 500,
    transition: 'color 0.15s',
  },
  navDot: {
    position: 'absolute', bottom: -2, left: '50%', transform: 'translateX(-50%)',
    width: 4, height: 4, borderRadius: 2, background: 'var(--accent)',
  },
  right: { display: 'flex', alignItems: 'center', gap: 12 },
  search: {
    display: 'flex', alignItems: 'center', gap: 8,
    width: 320, padding: '8px 12px',
    background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8,
    color: 'var(--txt-2)',
  },
  searchInput: {
    flex: 1, background: 'transparent', border: 'none', outline: 'none',
    color: 'var(--txt-0)', fontSize: 13, fontFamily: 'inherit',
  },
  kbd: {
    fontSize: 11, padding: '2px 6px', background: 'var(--bg-3)',
    borderRadius: 4, color: 'var(--txt-2)',
  },
  iconBtn: {
    position: 'relative', width: 36, height: 36, borderRadius: 8,
    display: 'grid', placeItems: 'center', color: 'var(--txt-1)',
    background: 'var(--bg-2)', border: '1px solid var(--line)',
  },
  notifDot: {
    position: 'absolute', top: 8, right: 9, width: 7, height: 7, borderRadius: 4,
    background: 'var(--accent)', border: '2px solid var(--bg-2)',
  },
  avatar: {
    width: 36, height: 36, borderRadius: 8,
    background: 'linear-gradient(135deg, #ff3b5c, #b07cff)',
    display: 'grid', placeItems: 'center',
    fontSize: 12, fontWeight: 700,
  },
};

window.TopBar = TopBar;
