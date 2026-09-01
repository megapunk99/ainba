import { useState, useCallback, useEffect, useRef } from 'react';

// ─── Pages ──────────────────────────────────────────────
import Dashboard from './pages/Dashboard';
import Standings from './pages/Standings';
import Teams from './pages/Teams';
import TeamDetail from './pages/TeamDetail';
import PlayerDetail from './pages/PlayerDetail';
import MatchDetail from './pages/MatchDetail';
import News from './pages/News';
import Props from './pages/Props';
import Alerts from './pages/Alerts';

// ─── Search Component ───────────────────────────────────
function SearchBar({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!query || query.length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search/all?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults([...(data.teams || []).map(t => ({ ...t, type: 'team' })),
                     ...(data.players || []).map(p => ({ ...p, type: 'player' }))]);
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="search-container" ref={ref}>
      <span className="search-icon">🔍</span>
      <input
        className="search-input"
        placeholder="Search teams, players..."
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="search-results">
          {results.slice(0, 10).map((r, i) => (
            <div
              key={i}
              className="search-result-item"
              onClick={() => { onSelect(r); setQuery(''); setOpen(false); }}
            >
              {r.type === 'team' && r.logo && (
                <img src={r.logo} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} />
              )}
              <span className="result-type">{r.type === 'team' ? 'TEAM' : 'PLAYER'}</span>
              <span style={{ fontWeight: 600 }}>{r.name}</span>
              {r.abbreviation && <span className="text-muted">{r.abbreviation}</span>}
              {r.team && <span className="text-muted">{r.team}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main App ───────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState('dashboard');
  const [params, setParams] = useState(null);

  // Global navigation
  useEffect(() => {
    window.__navigate = (p, pr) => { setPage(p); setParams(pr || null); window.scrollTo(0, 0); };
    window.__openMatch = (m) => { setParams(m); setPage('match'); window.scrollTo(0, 0); };
    window.__openTeam = (id) => { setParams({ teamId: id }); setPage('team'); window.scrollTo(0, 0); };
    window.__openPlayer = (id) => { setParams({ playerId: id }); setPage('player'); window.scrollTo(0, 0); };
  }, []);

  const handleSearch = useCallback((result) => {
    if (result.type === 'team') {
      window.__openTeam(result.id);
    } else if (result.type === 'player') {
      window.__openPlayer(result.id);
    }
  }, []);

  const NAV_ITEMS = [
    { key: 'dashboard', label: 'Games', icon: '🏀' },
    { key: 'standings', label: 'Standings', icon: '📊' },
    { key: 'teams', label: 'Teams', icon: '👥' },
    { key: 'props', label: 'Props', icon: '🎯' },
    { key: 'alerts', label: 'Alerts', icon: '🔔' },
    { key: 'news', label: 'News', icon: '📰' },
  ];

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard />;
      case 'standings': return <Standings />;
      case 'teams': return <Teams />;
      case 'team': return <TeamDetail teamId={params?.teamId} onBack={() => setPage('teams')} />;
      case 'player': return <PlayerDetail playerId={params?.playerId} onBack={() => setPage('teams')} />;
      case 'match': return <MatchDetail match={params} onBack={() => setPage('dashboard')} />;
      case 'props': return <Props />;
      case 'alerts': return <Alerts />;
      case 'news': return <News />;
      default: return <Dashboard />;
    }
  };

  return (
    <div className="app-layout">
      {/* Top Navigation */}
      <div className="topbar">
        <div className="topbar-brand" style={{ cursor: 'pointer' }} onClick={() => { setPage('dashboard'); setParams(null); }}>
          <div className="brand-icon">S</div>
          <span>SHARPEDGE</span>
        </div>

        <nav>
          {NAV_ITEMS.map(item => (
            <a
              key={item.key}
              href="#"
              className={page === item.key ? 'on' : ''}
              onClick={(e) => { e.preventDefault(); setPage(item.key); setParams(null); }}
            >
              <span>{item.icon}</span>
              {item.label}
            </a>
          ))}
        </nav>

        <SearchBar onSelect={handleSearch} />

        <div className="topbar-r">
          <span className="time-display" style={{ fontSize: 12 }}>
            {new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
      </div>

      {/* Page Content */}
      <div className="content">
        {renderPage()}
      </div>

      {/* Mobile Bottom Nav */}
      <style>{`
        @media (max-width: 768px) {
          .topbar nav { display: none !important; }
          .content { padding-bottom: 80px !important; }
          .bottom-nav { display: flex !important; }
        }
        .bottom-nav { display: none; }
      `}</style>
      <nav className="bottom-nav" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: 'var(--bg)', borderTop: '1px solid var(--border)',
        display: 'none', justifyContent: 'space-around', padding: '6px 0 env(safe-area-inset-bottom, 6px)',
        zIndex: 100, backdropFilter: 'blur(12px)',
      }}>
        {NAV_ITEMS.map(item => (
          <button
            key={item.key}
            onClick={() => { setPage(item.key); setParams(null); }}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              padding: '4px 12px', borderRadius: 8,
              color: page === item.key ? 'var(--brand)' : 'var(--text-tertiary)',
              fontWeight: page === item.key ? 700 : 500,
              fontSize: 10, background: page === item.key ? 'var(--brand-light)' : 'transparent',
            }}
          >
            <span style={{ fontSize: 18 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
