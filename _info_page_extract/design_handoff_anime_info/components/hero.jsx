/* Hero — V18 layout, actionsY=120
   3-col grid: cover+watch (left) | title-art+stats+chips (center) | status+like+share (right, dropped low)
*/

const Hero = () => {
  const [fav, setFav] = React.useState(true);
  const [list, setList] = React.useState('Watching');
  const [listOpen, setListOpen] = React.useState(false);
  const lists = ['Watching', 'Rewatching', 'Completed', 'Planning', 'Paused', 'Dropped'];
  const listColors = {
    'Watching':   '#22c55e',
    'Rewatching': '#06b6d4',
    'Completed':  '#3b82f6',
    'Planning':   '#a855f7',
    'Paused':     '#f97316',
    'Dropped':    '#ef4444',
  };

  return (
    <section style={hStyles.hero}>
      {/* Banner */}
      <div style={hStyles.banner}>
        <img src="assets/banner.png" alt="" style={hStyles.bannerImg}/>
        <div style={hStyles.bannerFade}/>
        <div style={hStyles.seasonPill}>
          <span style={{width:6, height:6, borderRadius:3, background:'#7ec8ff'}}/>
          WINTER 2024 · S2 AIRING
        </div>
      </div>

      {/* Content */}
      <div style={hStyles.contentWrap}>
        <div style={hStyles.grid}>
          {/* COL 1 — cover + watch */}
          <div style={hStyles.leftCol}>
            <img src="assets/cover.png" alt="Solo Leveling cover" style={hStyles.cover}/>
            <button style={hStyles.watchBtn}>
              <div style={hStyles.watchPlay}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg>
              </div>
              <div style={{display:'flex', flexDirection:'column', textAlign:'left'}}>
                <div style={hStyles.watchLabel}>WATCH NOW</div>
                <div style={hStyles.watchEp}>S2 · EP 04</div>
              </div>
            </button>
          </div>

          {/* COL 2 — title art + stats + chips */}
          <div style={hStyles.centerCol}>
            <img src="assets/title-art.png" alt="Solo Leveling" style={hStyles.titleArt}/>

            {/* Stats inline */}
            <div style={hStyles.statsRow}>
              <div style={hStyles.statBlock}>
                <div style={hStyles.statTop}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#f6c544"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9"/></svg>
                  <span style={{...hStyles.statBig, color:'#f6c544'}}>8.61</span>
                  <span style={hStyles.statTiny}>/10</span>
                </div>
                <div style={hStyles.statLabel}>RATED #253</div>
              </div>
              <div style={hStyles.statSep}/>
              <div style={hStyles.statBlock}>
                <div style={hStyles.statTop}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="#ff3b5c"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <span style={hStyles.statBig}>18,193</span>
                </div>
                <div style={hStyles.statLabel}>FAVORITES · #73</div>
              </div>
              <div style={hStyles.statSep}/>
              <div style={hStyles.statBlock}>
                <div style={{...hStyles.statTop, color:'var(--txt-1)'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>
                  <span style={hStyles.statBig}>12 + 13</span>
                  <span style={hStyles.statTiny}>EP · 24min</span>
                </div>
                <div style={hStyles.statLabel}>S1 COMPLETE · S2 AIRING</div>
              </div>
            </div>

            {/* Chips */}
            <div style={hStyles.chipsRow}>
              {['Action','Adventure','Fantasy','Supernatural'].map(g => (
                <span key={g} style={hStyles.genreChip}>{g}</span>
              ))}
              <span style={{width:1, height:16, background:'var(--line-2)'}}/>
              <span style={hStyles.studioChip}>A-1 Pictures</span>
              <span style={hStyles.studioChip}>Aniplex</span>
            </div>
          </div>

          {/* COL 3 — status + like + share (dropped low, Y=120) */}
          <div style={hStyles.rightCol}>
            <div style={hStyles.actionsPanel}>
              <div style={{position:'relative'}}>
                <button onClick={()=>setListOpen(o=>!o)} style={{
                  display:'flex', alignItems:'center', gap:12, padding:'17px 20px',
                  background:`${listColors[list]}1a`, border:`1px solid ${listColors[list]}66`, borderRadius:13,
                  color:listColors[list], fontSize:16, fontWeight:600, width:'100%',
                }}>
                  <span style={{
                    width:9, height:9, borderRadius:5, background:listColors[list],
                    boxShadow:`0 0 6px ${listColors[list]}b3, 0 0 2px ${listColors[list]}`,
                    flexShrink:0,
                  }}/>
                  <span style={{flex:1, textAlign:'left'}}>{list}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {listOpen && (
                  <div style={hStyles.listMenu}>
                    {lists.map(l => (
                      <button key={l} onClick={()=>{setList(l); setListOpen(false);}} style={{
                        ...hStyles.listItem,
                        background: l === list ? `${listColors[l]}1a` : 'transparent',
                        color: l === list ? listColors[l] : 'var(--txt-1)',
                      }}>
                        <span style={{
                          width:8, height:8, borderRadius:4, background:listColors[l],
                          boxShadow:`0 0 6px ${listColors[l]}b3, 0 0 2px ${listColors[l]}`,
                          flexShrink:0,
                        }}/>
                        {l}
                        {l === list && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{marginLeft:'auto'}}><polyline points="20 6 9 17 4 12"/></svg>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div style={{display:'flex', gap:10}}>
                <button onClick={()=>setFav(f=>!f)} style={{
                  flex:'0 0 auto', width:56, height:56, display:'grid', placeItems:'center', borderRadius:11,
                  background: fav ? 'rgba(255,59,92,0.08)' : 'rgba(255,255,255,0.04)',
                  border: fav ? '1px solid rgba(255,59,92,0.3)' : '1px solid var(--line-2)',
                  color: fav ? 'var(--accent)' : 'var(--txt-1)',
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill={fav?'currentColor':'none'} stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                </button>
                <button style={{
                  flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:12,
                  padding:'14px 20px', borderRadius:11,
                  background:'rgba(255,255,255,0.04)', border:'1px solid var(--line-2)',
                  color:'var(--txt-0)', fontSize:15, fontWeight:600,
                }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                  Share
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const hStyles = {
  hero: { position:'relative', borderBottom:'1px solid var(--line)' },
  banner: { position:'relative', height:280, overflow:'hidden' },
  bannerImg: { position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', objectPosition:'center 35%' },
  bannerFade: { position:'absolute', inset:0, background:'linear-gradient(180deg, rgba(10,11,16,0.15) 0%, rgba(10,11,16,0.5) 60%, var(--bg-0) 100%)' },
  seasonPill: {
    position:'absolute', top:20, right:28,
    display:'flex', alignItems:'center', gap:8,
    padding:'6px 12px',
    background:'rgba(10,11,16,0.65)', backdropFilter:'blur(10px)',
    border:'1px solid rgba(126,200,255,0.3)',
    borderRadius:999,
    color:'#7ec8ff',
    fontSize:11, fontWeight:600, letterSpacing:'0.08em',
  },

  contentWrap: {
    maxWidth:1380, margin:'0 auto',
    padding:'0 28px 36px',
    marginTop:-160,
    position:'relative', zIndex:2,
  },
  grid: {
    display:'grid',
    gridTemplateColumns:'240px minmax(0,1fr) auto',
    columnGap:32,
    alignItems:'stretch',
  },

  // COL 1 — cover stack
  leftCol: { display:'flex', flexDirection:'column', gap:14, alignSelf:'flex-start' },
  cover: {
    width:240, height:'auto', display:'block',
    borderRadius:12,
    border:'1px solid rgba(255,255,255,0.1)',
    boxShadow:'0 24px 60px rgba(0,0,0,0.7)',
    position:'relative', zIndex:3,
  },
  watchBtn: {
    width:'100%',
    display:'flex', alignItems:'center', gap:12,
    padding:'16px 18px',
    background:'linear-gradient(135deg, #ff3b5c 0%, #e8294b 100%)',
    borderRadius:12, color:'white',
    boxShadow:'0 12px 30px -10px rgba(255,59,92,0.7), inset 0 1px 0 rgba(255,255,255,0.2)',
  },
  watchPlay: {
    width:42, height:42, borderRadius:11,
    background:'rgba(255,255,255,0.18)',
    display:'grid', placeItems:'center', paddingLeft:3, flexShrink:0,
  },
  watchLabel: { fontSize:11, fontWeight:700, letterSpacing:'0.14em', opacity:0.9 },
  watchEp: { fontSize:15, fontWeight:600 },

  // COL 2 — center
  centerCol: {
    display:'flex', flexDirection:'column', gap:18,
    alignItems:'center', justifyContent:'center', textAlign:'center',
    paddingTop:75, minWidth:0,
  },
  titleArt: { maxHeight:300, width:'auto', objectFit:'contain', filter:'drop-shadow(0 14px 36px rgba(0,0,0,0.7))', marginTop:-40 },
  statsRow: { display:'flex', alignItems:'center', gap:24, flexWrap:'wrap', justifyContent:'center' },
  statBlock: { display:'flex', flexDirection:'column', gap:3, alignItems:'flex-start' },
  statTop: { display:'flex', alignItems:'baseline', gap:6 },
  statBig: { fontSize:20, fontWeight:700, color:'var(--txt-0)', fontFamily:'Space Grotesk' },
  statTiny: { fontSize:11.5, color:'var(--txt-2)', fontWeight:500 },
  statLabel: { fontSize:10, color:'var(--txt-3)', letterSpacing:'0.1em', fontWeight:600 },
  statSep: { width:1, height:32, background:'var(--line)' },
  chipsRow: { display:'flex', alignItems:'center', gap:8, flexWrap:'wrap', justifyContent:'center' },
  genreChip: {
    padding:'5px 11px',
    background:'rgba(255,59,92,0.12)',
    border:'1px solid rgba(255,59,92,0.35)',
    borderRadius:999,
    color:'#ff7a91', fontSize:12, fontWeight:600,
  },
  studioChip: {
    display:'flex', alignItems:'center', gap:6,
    padding:'5px 11px',
    background:'rgba(74,143,255,0.1)',
    border:'1px solid rgba(74,143,255,0.3)',
    borderRadius:999,
    color:'#7ec8ff', fontSize:12, fontWeight:600,
  },

  // COL 3 — actions, dropped low (Y=120)
  rightCol: {
    display:'flex', flexDirection:'column', justifyContent:'center', alignSelf:'stretch',
    paddingTop:120,
  },
  actionsPanel: {
    display:'flex', flexDirection:'column', gap:14, minWidth:320, alignItems:'stretch', paddingTop:24,
  },
  listMenu: {
    position:'absolute', top:'calc(100% + 6px)', left:0, right:0,
    background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius:12,
    padding:6, display:'flex', flexDirection:'column', gap:2,
    boxShadow:'0 20px 40px rgba(0,0,0,0.5)', zIndex:10,
  },
  listItem: {
    display:'flex', alignItems:'center', gap:10,
    padding:'9px 10px', borderRadius:8,
    fontSize:13, color:'var(--txt-1)', textAlign:'left',
    transition:'background 0.1s',
  },
};

window.Hero = Hero;
