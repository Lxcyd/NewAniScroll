// Tabbed content area: Overview / Episodes / Characters / Artworks
const Tabs = () => {
  const [tab, setTab] = React.useState('overview');
  const tabs = [
    { id: 'overview', label: 'Overview', count: null },
    { id: 'episodes', label: 'Episodes', count: 25 },
    { id: 'characters', label: 'Characters', count: 18 },
    { id: 'artworks', label: 'Artworks', count: 12 },
  ];

  return (
    <div style={tStyles.wrap}>
      <div style={tStyles.tabBar}>
        {tabs.map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{
            ...tStyles.tab,
            color: tab===t.id ? 'var(--txt-0)' : 'var(--txt-2)',
            borderColor: tab===t.id ? 'var(--accent)' : 'transparent',
          }}>
            {t.label}
            {t.count !== null && (
              <span style={{
                ...tStyles.tabCount,
                background: tab===t.id ? 'var(--accent-soft)' : 'var(--bg-3)',
                color: tab===t.id ? '#ff7a91' : 'var(--txt-3)',
              }}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div style={tStyles.content}>
        {tab === 'overview' && <Overview/>}
        {tab === 'episodes' && <Episodes/>}
        {tab === 'characters' && <Characters/>}
        {tab === 'artworks' && <Artworks/>}
      </div>
    </div>
  );
};

// ------------- OVERVIEW: V12 layout — Sidebar (Details + Tags scroll + External Sites scroll) | Main (Relations + Trailer + Popularity) -------------
const DETAILS_DATA = [
  ['Format','TV Series'],
  ['Status','Airing'],
  ['Source','Web Novel'],
  ['Aired','Jan 7 – Mar 31, 2024'],
  ['Premiered','Winter 2024'],
  ['Studios','A-1 Pictures'],
  ['Producers','Aniplex'],
  ['Rating','PG-13'],
  ['Country','Japan / Korea'],
];

const TAGS_LONG = [
  {t:'Dungeons', v:98}, {t:'Male Protagonist', v:92}, {t:'Urban Fantasy', v:90},
  {t:'Super Power', v:88}, {t:'Magic', v:85}, {t:'Cultivation', v:82},
  {t:'Survival', v:80}, {t:'Action', v:78}, {t:'Adventure', v:76},
  {t:'Gore', v:68}, {t:'Swordplay', v:62}, {t:'Anti-Hero', v:60},
  {t:'Alternate Universe', v:58}, {t:'Travel', v:48},
  {t:'Post-Apocalyptic', v:42}, {t:'Time Skip', v:38},
];
const SPOILER_TAGS = [
  {t:'Shadow Monarch', v:96, spoiler:true},
  {t:'Power-up Arc', v:88, spoiler:true},
  {t:'Time Manipulation', v:62, spoiler:true},
  {t:'Hidden Identity', v:54, spoiler:true},
];
const STATS_BOXES = [
  ['Popularity', '#73', '#ff7a91'],
  ['Rating',     '#253','#f6c544'],
  ['Seasonal',   '#1',  '#2dd47a'],
  ['Members',    '482K','#7ec8ff'],
];
const SITES = [
  { name: 'MyAnimeList', color: '#2e51a2', initial: 'M' },
  { name: 'AniList',     color: '#3577ff', initial: 'A' },
  { name: 'Official',    color: '#ff3b5c', initial: '◆' },
  { name: 'X / Twitter', color: '#1da1f2', initial: '𝕏' },
  { name: 'Reddit',      color: '#ff4500', initial: 'r' },
  { name: 'Wikipedia',   color: '#a0a0a0', initial: 'W' },
];

const Overview = () => {
  const [spoilers, setSpoilers] = React.useState(false);
  const tagList = spoilers ? [...SPOILER_TAGS, ...TAGS_LONG] : TAGS_LONG;
  return (
    <div style={tStyles.overviewWrap}>
      {/* Synopsis */}
      <section>
        <div style={tStyles.secKicker}>SYNOPSIS</div>
        <p style={tStyles.synopsisText}>
          They say whatever doesn't kill you makes you stronger, but that's not the case for the world's weakest hunter <strong style={{color:'var(--txt-0)'}}>Seong Jin-U</strong>. After being brutally slaughtered by monsters in a high-ranking dungeon, Jin-U came back with the System — a program only he could see, that's leveling him up in every way. Now, he's inspired to discover the secrets behind his powers and the dungeon that spawned them.
        </p>
        <div style={tStyles.synopsisSrc}><em>Source: Crunchyroll</em></div>
      </section>

      {/* V12 grid: 320px sidebar + main */}
      <div style={{display:'grid', gridTemplateColumns:'320px minmax(0,1fr)', gridTemplateRows:'auto auto', columnGap:28, rowGap:18, alignItems:'stretch'}}>

        {/* Row 1 — Details (sidebar) | Relations (main) */}
        <div style={{gridColumn:1, gridRow:1, display:'flex', flexDirection:'column', minWidth:0}}>
          <section style={{flex:1, minHeight:0, display:'flex', flexDirection:'column', paddingBottom:6}}>
            <div style={tStyles.secKicker}>DETAILS</div>
            <div style={{...tStyles.detailsCard, flex:1, display:'flex', flexDirection:'column'}}>
              <div style={{display:'grid', gridTemplateColumns:'auto 1fr', gap:'8px 16px', fontSize:12.5, flex:1, alignContent:'space-between'}}>
                {DETAILS_DATA.map(([k,v]) => (
                  <React.Fragment key={k}>
                    <div style={tStyles.detailKey}>{k}</div>
                    <div style={tStyles.detailVal}>{v}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </section>
        </div>
        <div style={{gridColumn:2, gridRow:1, minWidth:0}}>
          <section>
            <div style={tStyles.secKicker}>RELATIONS</div>
            <Related/>
          </section>
        </div>

        {/* Row 2 — Tags + External Sites stacked (sidebar) | Trailer + Popularity (main) */}
        <div style={{gridColumn:1, gridRow:2, minWidth:0, position:'relative'}}>
          <div style={{position:'absolute', inset:0, display:'flex', flexDirection:'column', gap:18}}>
            {/* Tags scrollable */}
            <section style={{flex:1, minHeight:0, display:'flex', flexDirection:'column'}}>
              <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12}}>
                <div style={{...tStyles.secKicker, marginBottom:0}}>TAGS</div>
                <button onClick={()=>setSpoilers(s=>!s)} style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'4px 9px', borderRadius:6,
                  background: spoilers ? 'rgba(255,59,92,0.12)' : 'var(--bg-2)',
                  border: spoilers ? '1px solid rgba(255,59,92,0.4)' : '1px solid var(--line)',
                  color: spoilers ? 'var(--accent)' : 'var(--txt-2)',
                  fontSize:10, fontWeight:600, letterSpacing:'0.06em', cursor:'pointer',
                }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {spoilers
                      ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                      : <><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></>}
                  </svg>
                  {spoilers ? 'Hide Spoilers' : 'Show Spoilers'}
                </button>
              </div>
              <div className="custom-scroll" style={{...tStyles.detailsCard, flex:1, minHeight:0, overflowY:'auto'}}>
                <div style={{display:'flex', flexDirection:'column', gap:10}}>
                  {tagList.map(t => (
                    <div key={t.t} style={{display:'flex', alignItems:'center', gap:10}}>
                      <span style={{fontSize:12, color: t.spoiler ? 'var(--accent)' : 'var(--txt-1)', flex:'0 0 145px'}}>{t.t}</span>
                      <div style={tStyles.tagBar}><div style={{...tStyles.tagFill, width: t.v+'%'}}/></div>
                      <span className="mono" style={tStyles.tagPct}>{t.v}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            {/* External Sites scrollable */}
            <section style={{flex:1, minHeight:0, display:'flex', flexDirection:'column'}}>
              <div style={tStyles.secKicker}>EXTERNAL SITES</div>
              <div className="custom-scroll" style={{...tStyles.detailsCard, flex:1, minHeight:0, overflowY:'auto'}}>
                <div style={{display:'grid', gap:8, gridTemplateColumns:'1fr'}}>
                  {SITES.map(s => (
                    <button key={s.name} style={{...tStyles.siteBtn, borderLeft:`3px solid ${s.color}`}}>
                      <div style={{...tStyles.siteLogo, background:s.color+'22', color:s.color}}>{s.initial}</div>
                      <span style={tStyles.siteName}>{s.name}</span>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{color:'var(--txt-3)', marginLeft:'auto'}}><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
        <div style={{gridColumn:2, gridRow:2, display:'flex', flexDirection:'column', gap:28, minWidth:0}}>
          <section>
            <div style={tStyles.secKicker}>TRAILER</div>
            <div style={tStyles.mainPlayer}>
              <div style={tStyles.playerBg}/>
              <div style={tStyles.playerOverlay}>
                <button style={tStyles.bigPlay}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white" style={{marginLeft:3}}><polygon points="5 3 19 12 5 21"/></svg>
                </button>
              </div>
              <div style={tStyles.playerInfo}>
                <span className="mono" style={tStyles.playerKind}>OFFICIAL TRAILER</span>
                <div style={tStyles.playerTitle}>Solo Leveling Season 2 — Arise from the Shadow</div>
                <div style={tStyles.playerMeta}>1:42 · Aniplex · 4.2M views</div>
              </div>
            </div>
          </section>
          <section>
            <div style={tStyles.secKicker}>POPULARITY</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10}}>
              {STATS_BOXES.map(([k,v,c]) => (
                <div key={k} style={tStyles.statBox}>
                  <div style={tStyles.statBoxK}>{k}</div>
                  <div className="display" style={{...tStyles.statBoxV, color: c}}>{v}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

// ------------- EPISODES -------------
const Episodes = () => {
  const [season, setSeason] = React.useState('S2');
  const seasons = {
    S1: { label: 'Season 1', sub: 'Winter 2024 · Completed', count: 12 },
    S2: { label: 'Season 2 — Arise from the Shadow', sub: 'Winter 2025 · Airing', count: 13 },
  };

  const epsS2 = [
    { n: 1, title: 'To Be Strong', dur: '24:30', date: 'Jan 5', watched: true, rating: 8.8 },
    { n: 2, title: 'A Pretty Strong Person', dur: '24:30', date: 'Jan 12', watched: true, rating: 8.6 },
    { n: 3, title: 'Should I Have Trusted Them?', dur: '24:30', date: 'Jan 19', watched: true, rating: 9.0 },
    { n: 4, title: 'Re-awakening', dur: '24:30', date: 'Jan 26', watched: false, current: true, rating: 9.2, progress: 34 },
    { n: 5, title: 'You\'ve Been Hiding Your Skills', dur: '24:30', date: 'Feb 2', watched: false, rating: null },
    { n: 6, title: 'The Real Hunt Begins', dur: '24:30', date: 'Feb 9', watched: false, rating: null },
    { n: 7, title: 'Episode 7', dur: '24:30', date: 'Feb 16', watched: false, locked: true, rating: null },
    { n: 8, title: 'Episode 8', dur: '24:30', date: 'Feb 23', watched: false, locked: true, rating: null },
  ];

  return (
    <div>
      {/* Season switcher */}
      <div style={tStyles.seasonRow}>
        <div style={tStyles.seasonTabs}>
          {Object.entries(seasons).map(([k,v]) => (
            <button key={k} onClick={()=>setSeason(k)} style={{
              ...tStyles.seasonTab,
              background: season===k ? 'var(--bg-3)' : 'transparent',
              borderColor: season===k ? 'var(--line-2)' : 'transparent',
            }}>
              <div style={{display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1}}>
                <span style={{fontSize: 13, fontWeight: 600, color: season===k ? 'var(--txt-0)' : 'var(--txt-1)'}}>{v.label}</span>
                <span style={{fontSize: 10.5, color: 'var(--txt-3)'}}>{v.sub}</span>
              </div>
              <span className="mono" style={tStyles.seasonCount}>{v.count} EP</span>
            </button>
          ))}
        </div>
        <div style={tStyles.epActions}>
          <button style={tStyles.smallBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            Mark all watched
          </button>
          <button style={tStyles.smallBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
            Sort
          </button>
        </div>
      </div>

      {/* Episode list */}
      <div style={tStyles.epList}>
        {epsS2.map(ep => (
          <div key={ep.n} style={{
            ...tStyles.epRow,
            opacity: ep.locked ? 0.55 : 1,
            borderColor: ep.current ? 'rgba(255,59,92,0.4)' : 'var(--line)',
            background: ep.current ? 'linear-gradient(90deg, rgba(255,59,92,0.06), var(--bg-2))' : 'var(--bg-2)',
          }}>
            <div style={tStyles.epThumb}>
              <div style={{...tStyles.epThumbBg, background: `linear-gradient(135deg, hsl(${ep.n*30}, 30%, 18%), hsl(${ep.n*30+40}, 40%, 28%))`}}/>
              <span className="mono" style={tStyles.epThumbN}>{String(ep.n).padStart(2,'0')}</span>
              {ep.current && (
                <div style={tStyles.epPlayOverlay}>
                  <div style={tStyles.epPlayBtn}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg>
                  </div>
                </div>
              )}
              {ep.locked && (
                <div style={tStyles.epLockOverlay}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
              )}
              {ep.progress && (
                <div style={tStyles.epProgress}><div style={{...tStyles.epProgressFill, width: ep.progress+'%'}}/></div>
              )}
            </div>
            <div style={tStyles.epInfo}>
              <div style={tStyles.epHead}>
                <span className="mono" style={tStyles.epNum}>EP {String(ep.n).padStart(2,'0')}</span>
                {ep.watched && <span style={tStyles.watchedTag}>✓ Watched</span>}
                {ep.current && <span style={tStyles.currentTag}>● In progress</span>}
                {ep.rating && (
                  <span style={tStyles.epRating}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="#f6c544"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9"/></svg>
                    {ep.rating}
                  </span>
                )}
              </div>
              <div style={tStyles.epTitle}>{ep.title}</div>
              <div style={tStyles.epMeta}>
                <span>{ep.dur}</span>
                <span style={tStyles.dotSep}/>
                <span>Aired {ep.date}, 2025</span>
                <span style={tStyles.dotSep}/>
                <span>Sub · Dub</span>
              </div>
            </div>
            <button style={tStyles.epPlay} disabled={ep.locked}>
              {ep.locked ? 'Locked' : (ep.current ? 'Resume' : (ep.watched ? 'Replay' : 'Play'))}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

// ------------- CHARACTERS -------------
const Characters = () => {
  const chars = [
    { name: 'Seong Jin-Woo', role: 'Main', va: 'Taito Ban', color: '#1a1a3a' },
    { name: 'Cha Hae-In', role: 'Main', va: 'Reina Ueda', color: '#3a1a3a' },
    { name: 'Go Gun-Hee', role: 'Supporting', va: 'Banjo Ginga', color: '#1a3a3a' },
    { name: 'Yoo Jin-Ho', role: 'Supporting', va: 'Genta Nakamura', color: '#2a3a1a' },
    { name: 'Baek Yoon-Ho', role: 'Supporting', va: 'Hiroki Tochi', color: '#3a2a1a' },
    { name: 'Choi Jong-In', role: 'Supporting', va: 'Daisuke Hirakawa', color: '#1a2a3a' },
    { name: 'Woo Jin-Chul', role: 'Supporting', va: 'Makoto Furukawa', color: '#3a1a2a' },
    { name: 'Hwang Dong-Su', role: 'Antagonist', va: 'Subaru Kimura', color: '#3a1010' },
  ];
  return (
    <div style={tStyles.charGrid}>
      {chars.map(c => (
        <div key={c.name} style={tStyles.charCard}>
          <div style={{...tStyles.charImg, background: `linear-gradient(160deg, ${c.color}, var(--bg-3))`}}>
            <span className="display" style={tStyles.charInitial}>{c.name.split(' ').map(w=>w[0]).join('').slice(0,2)}</span>
          </div>
          <div style={tStyles.charBody}>
            <div style={{
              ...tStyles.charRole,
              color: c.role === 'Main' ? '#ff7a91' : c.role === 'Antagonist' ? '#f6c544' : 'var(--txt-3)',
            }}>{c.role.toUpperCase()}</div>
            <div style={tStyles.charName}>{c.name}</div>
            <div style={tStyles.charVa}>VA · {c.va}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ------------- RECOMMENDATIONS (carousel) -------------
const Recommendations = () => {
  const recs = [
    { title: 'Jujutsu Kaisen', year: '2020', score: 8.7, match: 94, hue: 280 },
    { title: 'Tokyo Ghoul', year: '2014', score: 7.8, match: 89, hue: 0 },
    { title: 'Chainsaw Man', year: '2022', score: 8.5, match: 87, hue: 20 },
    { title: 'Demon Slayer', year: '2019', score: 8.6, match: 85, hue: 200 },
    { title: 'Re:Zero', year: '2016', score: 8.3, match: 82, hue: 220 },
    { title: 'That Time I Got Reincarnated', year: '2018', score: 8.0, match: 80, hue: 180 },
    { title: 'Mushoku Tensei', year: '2021', score: 8.4, match: 78, hue: 140 },
    { title: 'Overlord', year: '2015', score: 7.9, match: 76, hue: 260 },
    { title: 'Attack on Titan', year: '2013', score: 9.0, match: 74, hue: 30 },
    { title: 'Vinland Saga', year: '2019', score: 8.7, match: 72, hue: 160 },
  ];
  const ref = React.useRef(null);
  const scroll = (dir) => {
    if (ref.current) ref.current.scrollBy({ left: dir * 520, behavior: 'smooth' });
  };
  return (
    <div style={tStyles.recCarouselWrap}>
      <div style={tStyles.recHeader}>
        <div>
          <div style={tStyles.secKicker}>RECOMMENDATIONS</div>
          <div style={tStyles.recHeadTitle}>Because you're watching Solo Leveling</div>
        </div>
        <div style={tStyles.recNav}>
          <button onClick={()=>scroll(-1)} style={tStyles.recNavBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button onClick={()=>scroll(1)} style={tStyles.recNavBtn}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
      <div ref={ref} style={tStyles.recCarousel}>
        {recs.map(r => (
          <div key={r.title} style={tStyles.recCardC}>
            <div style={{...tStyles.recCover, background: `linear-gradient(135deg, hsl(${r.hue}, 40%, 15%), hsl(${r.hue+30}, 50%, 25%))`}}>
              <span style={tStyles.matchBadge}>{r.match}% match</span>
              <button style={tStyles.recPlay}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg>
              </button>
            </div>
            <div style={tStyles.recBody}>
              <div style={tStyles.recTitle}>{r.title}</div>
              <div style={tStyles.recMeta}>
                <span>{r.year}</span>
                <span style={tStyles.dotSep}/>
                <span style={{display:'inline-flex', alignItems:'center', gap:3}}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="#f6c544"><polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9"/></svg>
                  {r.score}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

window.Recommendations = Recommendations;

// ------------- ARTWORKS -------------
const Artworks = () => {
  const arts = [
    { type: 'Key Visual', no: '01', span: 2, hue: 0 },
    { type: 'Poster', no: '02', span: 1, hue: 220 },
    { type: 'Promo', no: '03', span: 1, hue: 280 },
    { type: 'Episode Card', no: '04', span: 1, hue: 340 },
    { type: 'Key Visual', no: '05', span: 2, hue: 200 },
    { type: 'Poster', no: '06', span: 1, hue: 30 },
  ];
  return (
    <div style={tStyles.artGrid}>
      {arts.map(a => (
        <div key={a.no} style={{
          ...tStyles.artCard,
          gridColumn: `span ${a.span}`,
          background: `linear-gradient(135deg, hsl(${a.hue}, 35%, 12%), hsl(${a.hue+30}, 45%, 22%))`,
        }}>
          <div style={tStyles.artStripes}/>
          <div style={tStyles.artLabel}>
            <span className="mono" style={{fontSize: 10, color: 'rgba(255,255,255,0.5)'}}>ART · {a.no}</span>
            <span style={{fontSize: 13, fontWeight: 600}}>{a.type}</span>
          </div>
          <button style={tStyles.artExpand}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
        </div>
      ))}
    </div>
  );
};

// ------------- TRAILERS / OST -------------
const Trailers_REMOVED = () => null;


// ------------- TAGS / STATS -------------
const TagsStats = () => {
  const tags = [
    {t:'Dungeons', v:98}, {t:'Male Protagonist', v:92}, {t:'Urban Fantasy', v:90},
    {t:'Super Power', v:88}, {t:'Magic', v:85}, {t:'Cultivation', v:82},
    {t:'Survival', v:80}, {t:'Gore', v:68}, {t:'Alternate Universe', v:60},
    {t:'Swordplay', v:58}, {t:'Post-Apocalyptic', v:50}, {t:'Travel', v:42},
  ];
  return (
    <div style={tStyles.tagsWrap}>
      <div style={tStyles.statsBar}>
        {[
          ['Popularity', '#73', '#ff7a91'],
          ['Rating Rank', '#253', '#f6c544'],
          ['Seasonal #', '#1', '#2dd47a'],
          ['Members', '482K', '#7ec8ff'],
        ].map(([k,v,c]) => (
          <div key={k} style={tStyles.statBox}>
            <div style={tStyles.statBoxK}>{k}</div>
            <div className="display" style={{...tStyles.statBoxV, color: c}}>{v}</div>
          </div>
        ))}
      </div>
      <div style={tStyles.tagsTitle}>Themes & Topics</div>
      <div style={tStyles.tagsGrid}>
        {tags.map(t => (
          <div key={t.t} style={tStyles.tagRow}>
            <span style={tStyles.tagName}>{t.t}</span>
            <div style={tStyles.tagBar}><div style={{...tStyles.tagFill, width: t.v+'%'}}/></div>
            <span className="mono" style={tStyles.tagPct}>{t.v}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const tStyles = {
  wrap: { display:'flex', flexDirection:'column', gap: 0 },
  tabBar: {
    display:'flex', gap: 4,
    borderBottom: '1px solid var(--line)',
    marginBottom: 18,
    overflowX: 'auto',
  },
  tab: {
    display:'flex', alignItems:'center', gap: 7,
    padding: '12px 14px',
    fontSize: 13.5, fontWeight: 600,
    borderBottom: '2px solid',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  },
  tabCount: {
    fontSize: 10.5, fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 4,
    fontFamily: 'JetBrains Mono',
  },
  content: {},

  // Episodes
  seasonRow: { display:'flex', alignItems:'center', justifyContent:'space-between', gap: 12, marginBottom: 14, flexWrap:'wrap' },
  seasonTabs: { display:'flex', gap: 6, padding: 4, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10 },
  seasonTab: {
    display:'flex', alignItems:'center', gap: 12,
    padding: '8px 12px',
    border: '1px solid',
    borderRadius: 7,
    transition: 'all 0.15s',
  },
  seasonCount: { fontSize: 10, color: 'var(--txt-3)', letterSpacing: '0.05em', padding: '2px 6px', background: 'var(--bg-0)', borderRadius: 4 },
  epActions: { display:'flex', gap: 6 },
  smallBtn: { display:'flex', alignItems:'center', gap: 6, padding: '8px 12px', fontSize: 12, color: 'var(--txt-1)', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 8 },
  epList: { display:'flex', flexDirection:'column', gap: 8 },
  epRow: {
    display:'flex', alignItems:'center', gap: 14,
    padding: 10,
    border: '1px solid',
    borderRadius: 10,
    transition: 'all 0.15s',
  },
  epThumb: { position:'relative', width: 124, height: 70, borderRadius: 7, overflow: 'hidden', flexShrink: 0 },
  epThumbBg: { position:'absolute', inset: 0 },
  epThumbN: { position:'absolute', bottom: 6, left: 8, fontSize: 16, fontWeight: 700, color: 'rgba(255,255,255,0.85)' },
  epPlayOverlay: { position:'absolute', inset: 0, display:'grid', placeItems:'center', background: 'rgba(0,0,0,0.4)' },
  epPlayBtn: { width: 32, height: 32, borderRadius: 16, background: 'rgba(255,59,92,0.9)', display:'grid', placeItems:'center', paddingLeft: 2 },
  epLockOverlay: { position:'absolute', inset: 0, display:'grid', placeItems:'center', background: 'rgba(0,0,0,0.5)', color: 'var(--txt-3)' },
  epProgress: { position:'absolute', bottom: 0, left: 0, right: 0, height: 3, background: 'rgba(0,0,0,0.5)' },
  epProgressFill: { height: '100%', background: 'var(--accent)' },
  epInfo: { flex: 1, display:'flex', flexDirection:'column', gap: 4, minWidth: 0 },
  epHead: { display:'flex', alignItems:'center', gap: 8 },
  epNum: { fontSize: 10.5, color: 'var(--txt-3)', letterSpacing: '0.08em' },
  watchedTag: { fontSize: 9.5, fontWeight: 600, color: '#2dd47a', padding: '2px 6px', background: 'rgba(45,212,122,0.1)', borderRadius: 3, letterSpacing: '0.04em' },
  currentTag: { fontSize: 9.5, fontWeight: 600, color: 'var(--accent)', padding: '2px 6px', background: 'var(--accent-soft)', borderRadius: 3, letterSpacing: '0.04em' },
  epRating: { display:'inline-flex', alignItems:'center', gap: 3, fontSize: 11, color: '#f6c544', fontWeight: 600 },
  epTitle: { fontSize: 14, fontWeight: 600, color: 'var(--txt-0)' },
  epMeta: { display:'flex', alignItems:'center', gap: 8, fontSize: 11.5, color: 'var(--txt-3)' },
  dotSep: { width: 3, height: 3, borderRadius: 2, background: 'var(--txt-3)' },
  epPlay: {
    padding: '8px 16px',
    background: 'var(--bg-3)',
    border: '1px solid var(--line-2)',
    borderRadius: 8,
    fontSize: 12, fontWeight: 600,
    color: 'var(--txt-0)',
  },

  // Characters
  charGrid: { display:'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  charCard: { background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden' },
  charImg: { aspectRatio: '3/4', display:'grid', placeItems:'center' },
  charInitial: { fontSize: 36, fontWeight: 700, color: 'rgba(255,255,255,0.65)', letterSpacing: '0.02em' },
  charBody: { padding: 10 },
  charRole: { fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em' },
  charName: { fontSize: 13, fontWeight: 600, marginTop: 3 },
  charVa: { fontSize: 11, color: 'var(--txt-3)', marginTop: 2 },

  // Artworks
  artGrid: { display:'grid', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: 160, gap: 10 },
  artCard: { position:'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' },
  artStripes: {
    position:'absolute', inset: 0,
    backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.03) 0 8px, transparent 8px 16px)',
  },
  artLabel: { position:'absolute', left: 12, bottom: 10, display:'flex', flexDirection:'column', gap: 2 },
  artExpand: {
    position:'absolute', top: 10, right: 10,
    width: 26, height: 26, borderRadius: 6,
    display:'grid', placeItems:'center',
    background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(6px)',
    color: 'rgba(255,255,255,0.8)',
    border: '1px solid rgba(255,255,255,0.1)',
  },

  // Recs carousel
  recCarouselWrap: { display:'flex', flexDirection:'column', gap: 14 },
  recHeader: { display:'flex', alignItems:'flex-end', justifyContent:'space-between' },
  recHeadTitle: { fontSize: 20, fontWeight: 700, marginTop: 4, letterSpacing: '-0.01em' },
  recNav: { display:'flex', gap: 6 },
  recNavBtn: { width: 36, height: 36, borderRadius: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', display:'grid', placeItems:'center', color: 'var(--txt-1)' },
  recCarousel: { display:'flex', gap: 14, overflowX: 'auto', overflowY:'hidden', paddingBottom: 8, scrollSnapType: 'x mandatory' },
  recCardC: { display:'flex', flexDirection:'column', gap: 8, flex: '0 0 180px', scrollSnapAlign: 'start' },

  // Recs (legacy grid kept for compat)
  recGrid: { display:'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 },
  recCard: { display:'flex', flexDirection:'column', gap: 8 },
  recCover: { position:'relative', aspectRatio: '3/4', borderRadius: 10, overflow:'hidden', border: '1px solid var(--line)' },
  matchBadge: {
    position:'absolute', top: 8, left: 8,
    padding: '3px 7px', borderRadius: 4,
    background: 'rgba(45,212,122,0.2)', color: '#2dd47a',
    fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
    backdropFilter: 'blur(8px)',
    border: '1px solid rgba(45,212,122,0.3)',
  },
  recPlay: {
    position:'absolute', bottom: 8, right: 8,
    width: 30, height: 30, borderRadius: 8,
    background: 'var(--accent)', display:'grid', placeItems:'center',
    paddingLeft: 2,
  },
  recBody: { display:'flex', flexDirection:'column', gap: 2 },
  recTitle: { fontSize: 13, fontWeight: 600 },
  recMeta: { display:'flex', alignItems:'center', gap: 8, fontSize: 11, color: 'var(--txt-3)' },

  // Trailers
  trailerWrap: { display:'grid', gridTemplateColumns: '2fr 1fr', gap: 12 },
  mainPlayer: { position:'relative', aspectRatio: '16/9', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)' },
  playerBg: { position:'absolute', inset: 0, background: 'linear-gradient(135deg, #0a0a2a, #1a0a3a, #2a1a3a)' },
  playerOverlay: { position:'absolute', inset: 0, display:'grid', placeItems:'center', background: 'radial-gradient(circle at center, rgba(0,0,0,0.2), rgba(0,0,0,0.6))' },
  bigPlay: { width: 64, height: 64, borderRadius: 32, background: 'rgba(255,59,92,0.95)', display:'grid', placeItems:'center', boxShadow: '0 12px 30px rgba(255,59,92,0.4)' },
  playerInfo: { position:'absolute', left: 16, bottom: 16, display:'flex', flexDirection:'column', gap: 4 },
  playerKind: { fontSize: 10, color: 'rgba(255,255,255,0.7)', letterSpacing: '0.12em', fontWeight: 700 },
  playerTitle: { fontSize: 16, fontWeight: 600 },
  playerMeta: { fontSize: 11.5, color: 'rgba(255,255,255,0.6)' },
  trailerList: { display:'flex', flexDirection:'column', gap: 6 },
  trailerRow: { display:'flex', alignItems:'center', gap: 10, padding: 8, background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 9 },
  trailerThumb: { width: 56, height: 38, borderRadius: 6, display:'grid', placeItems:'center', flexShrink: 0 },
  trailerKind: { fontSize: 10, color: 'var(--txt-3)', letterSpacing: '0.08em', fontWeight: 600 },
  trailerTitle: { fontSize: 12.5, fontWeight: 500, marginTop: 1 },
  trailerDur: { fontSize: 10.5, color: 'var(--txt-3)' },

  // Tags / Stats
  // Tags / Stats — used inside Overview
  overviewWrap: { display:'flex', flexDirection:'column', gap: 28 },
  metaBar: { display:'flex', alignItems:'center', gap: 14, padding: '12px 16px', background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius: 12, flexWrap:'wrap' },
  metaGroup: { display:'flex', alignItems:'center', gap: 8, flexWrap:'wrap' },
  metaLabel: { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--txt-3)', marginRight: 4 },
  metaSep: { width: 1, height: 22, background: 'var(--line)' },
  genreChip: { padding: '5px 11px', background: 'var(--accent-soft)', border: '1px solid rgba(255,59,92,0.35)', borderRadius: 999, color: '#ff7a91', fontSize: 12, fontWeight: 600 },
  studioChip: { display:'flex', alignItems:'center', gap: 6, padding: '5px 11px', background: 'rgba(74,143,255,0.1)', border: '1px solid rgba(74,143,255,0.3)', borderRadius: 999, color: '#7ec8ff', fontSize: 12, fontWeight: 600 },
  ovRow1: { display:'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems:'flex-start' },
  ovRow2: { display:'grid', gridTemplateColumns: '1fr 320px', gap: 24, alignItems:'flex-start' },
  detailsCard: { padding: 16, background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius: 12 },
  detailGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', fontSize: 12.5 },
  detailKey: { color: 'var(--txt-3)', fontSize: 11.5, letterSpacing: '0.04em' },
  detailVal: { color: 'var(--txt-1)', fontWeight: 500, textAlign:'right' },
  sitesList: { display:'flex', flexDirection:'column', gap: 8 },
  siteBtn: { display:'flex', alignItems:'center', gap: 12, padding: '10px 12px', background:'var(--bg-2)', border:'1px solid var(--line)', borderRadius: 9 },
  siteLogo: { width: 32, height: 32, borderRadius: 7, display:'grid', placeItems:'center', fontSize: 14, fontWeight: 700, flexShrink: 0 },
  siteName: { fontSize: 13.5, fontWeight: 600, color: 'var(--txt-0)' },
  secKicker: { fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--txt-3)', marginBottom: 12 },
  synopsisText: { fontSize: 14, color: 'var(--txt-1)', lineHeight: 1.65, margin: 0, textWrap: 'pretty' },
  synopsisSrc: { fontSize: 11, color: 'var(--txt-3)', marginTop: 10 },

  tagsWrap: { display:'flex', flexDirection:'column', gap: 18 },
  statsBar: { display:'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 },
  statBox: { padding: '14px 16px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 10 },
  statBoxK: { fontSize: 10.5, color: 'var(--txt-3)', letterSpacing: '0.1em', fontWeight: 600 },
  statBoxV: { fontSize: 26, fontWeight: 700, marginTop: 4, letterSpacing: '-0.02em' },
  tagsTitle: { fontSize: 13, fontWeight: 600, color: 'var(--txt-1)' },
  tagsGrid: { display:'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' },
  tagRow: { display:'flex', alignItems:'center', gap: 10 },
  tagName: { fontSize: 12, color: 'var(--txt-1)', minWidth: 130 },
  tagBar: { flex: 1, height: 6, background: 'var(--bg-3)', borderRadius: 3, overflow: 'hidden' },
  tagFill: { height: '100%', background: 'linear-gradient(90deg, var(--accent), #ff7a91)', borderRadius: 3 },
  tagPct: { fontSize: 10.5, color: 'var(--txt-2)', minWidth: 32, textAlign: 'right' },
};

window.Tabs = Tabs;
