const App = () => {
  return (
    <div data-screen-label="Anime Info Page">
      <Hero/>
      <main style={appStyles.main}>
        <Tabs/>
        <div style={appStyles.recsRow}>
          <Recommendations/>
        </div>
      </main>
      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 0; transform: scale(1.6); } }
        button:hover { filter: brightness(1.08); }
        button:disabled { cursor: not-allowed; opacity: 0.5; }
      `}</style>
    </div>
  );
};

const appStyles = {
  main: { maxWidth: 1320, margin: '0 auto', padding: '24px 28px 60px' },
  recsRow: { marginTop: 36 },
  footer: { marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--line)', textAlign:'center', fontSize: 11, color: 'var(--txt-3)', letterSpacing: '0.05em' },
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
