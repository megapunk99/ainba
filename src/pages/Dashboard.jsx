import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

// ─── IndexedDB Cache ──────────────────────────────────────
const DB = 'sharpedge';
const STORE = 'cache';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await openDB();
    return new Promise(r => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => r(req.result || null);
      req.onerror = () => r(null);
    });
  } catch { return null; }
}
async function cacheSet(key, val) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
  } catch {}
}
async function cachedFetch(url, cacheKey, ttl = 30000) {
  const cached = await cacheGet(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;
  const res = await fetch(url);
  const data = await res.json();
  await cacheSet(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Format Helpers ──────────────────────────────────────
function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ─── Game Card Component ─────────────────────────────────
function GameCard({ game, onClick }) {
  const homeML = game.consensus?.homeML || game.odds?.consensus?.homeML;
  const awayML = game.consensus?.awayML || game.odds?.consensus?.awayML;
  const spread = game.consensus?.spread || game.odds?.consensus?.spread;
  const total = game.consensus?.total || game.odds?.consensus?.total;
  const isSharp = game.sharp;

  return (
    <div className="game-card" onClick={onClick}>
      <div className="game-card-header">
        <span style={{ fontWeight: 600 }}>{formatDate(game.date)}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isSharp && <span className="badge badge-danger" style={{ fontSize: 9 }}>⚡ SHARP</span>}
          <span className="game-status">{game.bookCount || game.bookmakers?.length || 0} books</span>
        </div>
      </div>
      <div className="game-card-body">
        {/* Away Team */}
        <div className="game-team-row">
          <img
            src={game.away?.logo || `/api/logo/${game.away?.abbreviation?.toLowerCase()}`}
            alt=""
            className="game-team-logo"
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div className="game-team-info">
            <div className="game-team-name">{game.away?.name || game.away?.abbreviation}</div>
            <div className="game-team-record">
              {game.away?.wins != null ? `${game.away.wins}-${game.away.losses}` : ''}
            </div>
          </div>            <div className="game-team-score" style={{ color: awayML > 0 ? 'var(--green)' : awayML < 0 ? 'var(--red)' : 'var(--text-tertiary)' }}>
            {awayML ? (awayML > 0 ? '+' : '') + awayML : '—'}
          </div>
        </div>

        {/* Home Team */}
        <div className="game-team-row">
          <img
            src={game.home?.logo || `/api/logo/${game.home?.abbreviation?.toLowerCase()}`}
            alt=""
            className="game-team-logo"
            onError={e => { e.target.style.display = 'none'; }}
          />
          <div className="game-team-info">
            <div className="game-team-name">{game.home?.name || game.home?.abbreviation}</div>
            <div className="game-team-record">
              {game.home?.wins != null ? `${game.home.wins}-${game.home.losses}` : ''}
            </div>
          </div>
          <div className="game-team-score" style={{ color: homeML > 0 ? 'var(--green)' : 'var(--red)' }}>
            {homeML ? (homeML > 0 ? '+' : '') + homeML : '—'}
          </div>
        </div>

        {/* Odds Row */}
        <div className="game-odds-row">
          <div className="game-odds-item">
            <span className="game-odds-label">Spread</span>
            <span className="game-odds-value">{spread || '—'}</span>
          </div>
          <div className="game-odds-item">
            <span className="game-odds-label">Total</span>
            <span className="game-odds-value">{total || '—'}</span>
          </div>
          <div className="game-odds-item">
            <span className="game-odds-label">Time</span>
            <span className="game-odds-value">{formatTime(game.time || game.date)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ──────────────────────────────────────
export default function Dashboard() {
  const [games, setGames] = useState([]);
  const [movements, setMovements] = useState([]);
  const [injuries, setInjuries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [view, setView] = useState('cards'); // 'cards' or 'list'
  const [countdown, setCountdown] = useState(30);
  const wsRef = useRef(null);

  // ─── Fetch data ──────────────────────────────────────────
  const fetchAll = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [g, m, inj] = await Promise.allSettled([
        cachedFetch('/api/games', 'games', 30000),
        cachedFetch('/api/odds/sharp', 'sharp', 60000),
        cachedFetch('/api/injuries', 'injuries', 60000),
      ]);
      if (g.status === 'fulfilled') setGames(g.value.games || []);
      if (m.status === 'fulfilled') setMovements(m.value.movements || []);
      if (inj.status === 'fulfilled') setInjuries(inj.value.injuries || []);
      setLastUpdate(new Date());
      setCountdown(30);
    } catch (e) { console.error(e); }
    setLoading(false);
    if (manual) setRefreshing(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Auto-refresh
  useEffect(() => {
    const t = setInterval(() => fetchAll(), 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // Countdown timer
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 0) return 30;
        if (c === 1) { fetchAll(); return 30; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [fetchAll]);

  // WebSocket
  useEffect(() => {
    try {
      const ws = new WebSocket(`ws://${location.hostname}:3001`);
      wsRef.current = ws;
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'odds_update') fetchAll();
        } catch {}
      };
      return () => ws.close();
    } catch {}
  }, [fetchAll]);

  // ─── Derived data ──────────────────────────────────────
  const stats = useMemo(() => ({
    totalGames: games.length,
    sharpSignals: movements.length,
    criticalInjuries: injuries.filter(i => 
      i.status?.toLowerCase().includes('out') || i.status?.toLowerCase().includes('doubtful')
    ).length,
    totalBooks: games.reduce((s, g) => s + (g.bookCount || 0), 0),
  }), [games, movements, injuries]);

  const groupedGames = useMemo(() => {
    const groups = {};
    games.forEach(g => {
      const dateKey = formatDate(g.time || g.date) || 'Other';
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(g);
    });
    return groups;
  }, [games]);

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner" />
      <span>Loading games...</span>
    </div>
  );

  return (
    <>
      {/* Stats Overview */}
      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-value text-blue">{stats.totalGames}</span>
          <span className="stat-label">Games</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-red">{stats.sharpSignals}</span>
          <span className="stat-label">Sharp Signals</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-orange">{stats.criticalInjuries}</span>
          <span className="stat-label">Out / Doubtful</span>
        </div>
        <div className="stat-box">
          <span className="stat-value">30</span>
          <span className="stat-label">Teams</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-purple">{stats.totalBooks}</span>
          <span className="stat-label">Book Lines</span>
        </div>
      </div>

      {/* Sharp Money Alert */}
      {movements.length > 0 && (
        <div className="sharp-alert">
          ⚡ {movements.length} line movement{movements.length !== 1 ? 's' : ''} detected across sportsbooks
        </div>
      )}

      {/* Injury Alert */}
      {stats.criticalInjuries > 0 && (
        <div className="injury-alert">
          🏥 {stats.criticalInjuries} player{stats.criticalInjuries !== 1 ? 's' : ''} OUT/DOUBTFUL
        </div>
      )}

      {/* View Toggle + Actions */}
      <div className="flex flex-between mb-4" style={{ alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className={`btn btn-sm ${view === 'cards' ? 'btn-primary' : ''}`} onClick={() => setView('cards')}>
            ⊞ Cards
          </button>
          <button className={`btn btn-sm ${view === 'list' ? 'btn-primary' : ''}`} onClick={() => setView('list')}>
            ☰ List
          </button>
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => fetchAll(true)} disabled={refreshing}>
            {refreshing ? '⏳' : '↻ Refresh'}
          </button>
          <span className="text-xs text-muted">
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ''}
            {countdown > 0 && ` · ${countdown}s`}
          </span>
        </div>
      </div>

      {/* Games */}
      {Object.keys(groupedGames).length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🏀</div>
          <div className="empty-title">No upcoming games</div>
          <div className="empty-desc">Check back closer to game time for live odds</div>
        </div>
      ) : view === 'cards' ? (
        Object.entries(groupedGames).map(([date, dayGames]) => (
          <div key={date} className="mb-4">
            <div className="section-title">
              <span>{date}</span>
              <span className="badge badge-muted">{dayGames.length} games</span>
            </div>
            <div className="games-grid">
              {dayGames.map((game, i) => (
                <GameCard
                  key={game.id || i}
                  game={game}
                  onClick={() => window.__openMatch?.({ home: game.home, away: game.away, date: game.time || game.date, id: game.id })}
                />
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className="card">
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Matchup</th>
                  <th className="text-right">Spread</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Home ML</th>
                  <th className="text-right">Away ML</th>
                  <th className="text-center">Books</th>
                  <th>Signal</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g, i) => {
                  const isSharp = movements.some(mv =>
                    mv.matchup?.includes(g.home?.abbreviation) && mv.matchup?.includes(g.away?.abbreviation)
                  );
                  const homeML = g.consensus?.homeML || g.odds?.consensus?.homeML;

                  return (
                    <tr
                      key={i}
                      className={isSharp ? 'hl' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => window.__openMatch?.({ home: g.home, away: g.away, date: g.time || g.date, id: g.id })}
                    >
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {g.away?.abbreviation} @ {g.home?.abbreviation}
                        </div>
                        <div className="text-xs text-muted">
                          {g.away?.name} vs {g.home?.name}
                        </div>
                      </td>
                      <td className="text-right mono">{g.consensus?.spread || g.odds?.consensus?.spread || '—'}</td>
                      <td className="text-right mono">{g.consensus?.total || g.odds?.consensus?.total || '—'}</td>
                      <td className="text-right mono" style={{ color: (g.consensus?.homeML || g.odds?.consensus?.homeML) > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                        {(g.consensus?.homeML || g.odds?.consensus?.homeML) ? ((g.consensus?.homeML || g.odds?.consensus?.homeML) > 0 ? '+' : '') + (g.consensus?.homeML || g.odds?.consensus?.homeML) : '—'}
                      </td>
                      <td className="text-right mono">
                        {(g.consensus?.awayML || g.odds?.consensus?.awayML) ? ((g.consensus?.awayML || g.odds?.consensus?.awayML) > 0 ? '+' : '') + (g.consensus?.awayML || g.odds?.consensus?.awayML) : '—'}
                      </td>
                      <td className="text-center">{g.bookCount || 0}</td>
                      <td>
                        {isSharp && <span className="badge badge-danger">SHARP</span>}
                      </td>
                      <td className="text-xs text-muted">
                        {formatTime(g.time || g.date)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ padding: '12px 0', fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
        Odds from FanDuel, DraftKings, BetMGM, Bovada, Caesars · Sharp signals = cross-book line discrepancies
      </div>
    </>
  );
}
