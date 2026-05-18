// Horizontal Related — universe map row
const Related = () => {
  const nodes = [
    { kind: 'NOVEL', title: 'Solo Leveling', meta: 'Web Novel · 2016', color: '#b07cff', cover: 'novel' },
    { kind: 'MANHWA', title: 'Solo Leveling', meta: 'Manhwa · 2018–21', color: '#b07cff', cover: 'manhwa' },
    { kind: 'S1', title: 'Solo Leveling', meta: 'Anime · 12 EP · ✓', color: '#2dd47a', cover: 's1' },
    { kind: 'S2', title: '−Arise from the Shadow−', meta: 'Anime · 13 EP · 4/13', color: '#ff3b5c', cover: 's2', current: true },
    { kind: 'MOVIE', title: 'ReAwakening', meta: 'Movie · 110 min', color: '#4a8fff', cover: 'movie' },
  ];

  const grads = {
    novel: 'linear-gradient(135deg, #2a1f3d, #4a2d5f)',
    manhwa: 'linear-gradient(135deg, #1a3a5f, #2d5fa0)',
    s1: 'linear-gradient(135deg, #0f1a3d, #2a4080)',
    s2: 'linear-gradient(135deg, #2a0a14, #5f1a2a)',
    movie: 'linear-gradient(135deg, #0a2a3d, #1a4f6f)',
  };

  return (
    <div style={rStyles.row}>
      {nodes.map((n, i) => (
        <React.Fragment key={n.kind}>
          <div style={{
            ...rStyles.card,
            borderColor: n.current ? n.color+'66' : 'var(--line)',
            background: n.current ? `linear-gradient(160deg, ${n.color}14, var(--bg-2))` : 'var(--bg-2)',
          }}>
            <div style={{...rStyles.cover, background: grads[n.cover]}}>
              <span className="display" style={rStyles.coverGlyph}>{n.kind}</span>
              {n.current && <span style={rStyles.nowDot}/>}
            </div>
            <div style={rStyles.body}>
              <span style={{...rStyles.tag, color: n.color, borderColor: n.color+'44', background: n.color+'14'}}>{n.kind}</span>
              <div style={rStyles.title} title={n.title}>{n.title}</div>
              <div style={rStyles.meta}>{n.meta}</div>
            </div>
          </div>
          {i < nodes.length - 1 && (
            <div style={rStyles.connector}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--txt-3)" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

const rStyles = {
  row: {
    display: 'flex', alignItems: 'stretch', gap: 4,
    overflowX: 'auto', paddingBottom: 6,
  },
  card: {
    display:'flex', flexDirection:'column', gap: 8,
    flex: '1 1 0',
    minWidth: 150,
    padding: 10,
    border: '1px solid',
    borderRadius: 10,
    transition: 'all 0.15s',
    cursor: 'pointer',
  },
  cover: {
    position: 'relative',
    aspectRatio: '3/4',
    borderRadius: 7,
    display: 'grid', placeItems: 'center',
    border: '1px solid rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  coverGlyph: { fontSize: 16, fontWeight: 700, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.85)' },
  nowDot: {
    position:'absolute', top: 8, right: 8,
    width: 8, height: 8, borderRadius: 4,
    background: '#ff3b5c',
    boxShadow: '0 0 0 3px rgba(255,59,92,0.3)',
  },
  body: { display:'flex', flexDirection:'column', gap: 3, minWidth: 0 },
  tag: {
    alignSelf: 'flex-start',
    fontSize: 9, fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '2px 6px',
    border: '1px solid',
    borderRadius: 4,
  },
  title: { fontSize: 12.5, fontWeight: 600, lineHeight: 1.3, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' },
  meta: { fontSize: 10.5, color: 'var(--txt-3)' },
  connector: { display:'grid', placeItems:'center', flexShrink: 0, width: 18 },
};

window.Related = Related;
