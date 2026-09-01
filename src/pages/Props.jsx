import { useState, useEffect, useCallback, useMemo } from 'react';

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

// ─── Stat Colors ──────────────────────────────────────────
const STAT_COLORS = {
  PTS: '#e74c3c', REB: '#3498db', AST: '#2ecc71', STL: '#f39c12',
  BLK: '#9b59b6', TO: '#e67e22', '3PM': '#1abc9c', 'FG%': '#34495e',
};

// ─── Component ────────────────────────────────────────────
export default function Props() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statFilter, setStatFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('score');
  const [expandedPick, setExpandedPick] = useState(null);
  const [generating, setGenerating] = useState(false);

  const fetchPicks = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const data = await cachedFetch('/api/predictions/top-picks?limit=100', 'props-picks', 30000);
      setPicks(data.picks || []);
    } catch (e) { console.error(e); }
    setLoading(false);
    if (manual) setRefreshing(false);
  }, []);

  useEffect(() => { fetchPicks(); }, [fetchPicks]);

  const generatePicks = useCallback(async () => {
    setGenerating(true);
    try {
      await fetch('/api/predictions/generate', { method: 'POST' });
      await cacheSet('props-picks', null);
      await fetchPicks(true);
    } catch (e) { console.error(e); }
    setGenerating(false);
  }, [fetchPicks]);

  const stats = useMemo(() => {
    const s = { total: picks.length, over: 0, under: 0, high: 0, medium: 0, low: 0 };
    picks.forEach(p => {
      if (p.recommendation === 'OVER') s.over++;
      else if (p.recommendation === 'UNDER') s.under++;
      if (p.confidence === 'HIGH') s.high++;
      else if (p.confidence === 'MEDIUM') s.medium++;
      else s.low++;
    });
    return s;
  }, [picks]);

  const statTypes = useMemo(() => {
    const types = new Set();
    picks.forEach(p => { if (p.stat) types.add(p.stat); });
    return ['ALL', ...Array.from(types).sort()];
  }, [picks]);

  const filtered = useMemo(() => {
    let list = picks;
    if (statFilter !== 'ALL') list = list.filter(p => p.stat === statFilter);
    list = [...list].sort((a, b) => {
      if (sortBy === 'score') return (b.prop_score || b.score || 0) - (a.prop_score || a.score || 0);
      if (sortBy === 'edge') return Math.abs(b.edge || 0) - Math.abs(a.edge || 0);
      if (sortBy === 'confidence') {
        const order = { HIGH: 3, MEDIUM: 2, LOW: 1 };
        return (order[b.confidence] || 0) - (order[a.confidence] || 0);
      }
      return 0;
    });
    return list;
  }, [picks, statFilter, sortBy]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading props...</span></div>;

  return (
    <>
      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-value text-blue">{stats.total}</span>
          <span className="stat-label">Total Props</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-green">{stats.over}</span>
          <span className="stat-label">Overs</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-red">{stats.under}</span>
          <span className="stat-label">Unders</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-purple">{stats.high}</span>
          <span className="stat-label">High Confidence</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-orange">{stats.medium}</span>
          <span className="stat-label">Medium</span>
        </div>
      </div>

      {/* Data Transparency */}
      <div className="injury-alert mb-4" style={{ background: picks.some(p => p.line_source === 'sportsbook') ? 'var(--green-light)' : 'var(--purple-light)', borderColor: picks.some(p => p.line_source === 'sportsbook') ? '#bbf7d0' : '#c4b5fd', color: picks.some(p => p.line_source === 'sportsbook') ? '#166534' : 'var(--purple)' }}>
        {picks.some(p => p.line_source === 'sportsbook') ? '✅' : '⚠️'} <span><b>Data Source:</b> {picks.some(p => p.line_source === 'sportsbook') ? 'Real sportsbook lines from The Odds API. Hit rates from real gamelogs. Edge = Projection vs Real Line.' : 'Lines estimated from season averages. Hit rates real. Fetch real props via POST /api/props/real/fetch.'}</span>
      </div>

      {/* Filters */}
      <div className="flex flex-between mb-4" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="filter-pills">
          {statTypes.map(s => (
            <button
              key={s}
              className={`filter-pill ${statFilter === s ? 'active' : ''}`}
              onClick={() => setStatFilter(s)}
              style={statFilter === s && s !== 'ALL' ? { background: STAT_COLORS[s] || 'var(--brand)', borderColor: STAT_COLORS[s] || 'var(--brand)' } : {}}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <select className="inp inp-sm" value={sortBy} onChange={e => setSortBy(e.target.value)}>
            <option value="score">Sort by Score</option>
            <option value="edge">Sort by Edge</option>
            <option value="confidence">Sort by Confidence</option>
          </select>
          <button className="btn btn-sm btn-primary" onClick={generatePicks} disabled={generating}>
            {generating ? '⏳ Generating...' : '🧠 Generate'}
          </button>
          <button className="btn btn-sm" onClick={() => fetchPicks(true)} disabled={refreshing}>
            {refreshing ? '...' : '↻'}
          </button>
        </div>
      </div>

      {/* Props List */}
      <div className="card">
        <div className="card-header">
          <span>{filtered.length} Prop Picks</span>
          <span className="text-xs text-muted">Edge = (Projected - Line)</span>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
          {filtered.map((pick, i) => {
            const isOver = pick.recommendation === 'OVER';
            const confColor = pick.confidence === 'HIGH' ? '#7c3aed' : pick.confidence === 'MEDIUM' ? 'var(--orange)' : 'var(--text-tertiary)';
            const edgeVal = pick.edge || 0;
            const edgeColor = Math.abs(edgeVal) >= 5 ? 'var(--green)' : Math.abs(edgeVal) >= 2 ? 'var(--orange)' : 'var(--text-tertiary)';
            const score = pick.prop_score || pick.score || 0;
            const isExpanded = expandedPick === i;
            const statColor = STAT_COLORS[pick.stat] || 'var(--brand)';

            return (
              <div
                key={i}
                style={{ borderBottom: '1px solid var(--border-light)', cursor: 'pointer', transition: 'background 0.1s' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                onClick={() => setExpandedPick(isExpanded ? null : i)}
              >
                {/* Main Row */}
                <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
                  {/* Score Badge */}
                  <div style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: score >= 80 ? '#7c3aed' : score >= 60 ? 'var(--brand)' : score >= 40 ? 'var(--orange)' : 'var(--bg-tertiary)',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: 13, fontFamily: 'var(--font-mono)', flexShrink: 0,
                  }}>
                    {Math.round(score)}
                  </div>

                  {/* Player Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="flex gap-2" style={{ alignItems: 'center', marginBottom: 2 }}>
                      <span className="fw-700" style={{ fontSize: 14 }}>{pick.player_name || pick.player}</span>
                      <span className="text-xs text-muted">{pick.team_abbr || pick.team}</span>
                      {pick.opponentAbbr && <span className="text-xs text-muted">vs {pick.opponentAbbr}</span>}
                    </div>
                    <div className="flex gap-2" style={{ alignItems: 'center', fontSize: 12 }}>
                      <span className="badge" style={{
                        fontWeight: 700, color: isOver ? 'var(--green)' : 'var(--red)',
                        background: isOver ? 'var(--green-light)' : 'var(--red-light)',
                        fontSize: 10,
                      }}>
                        {pick.recommendation}
                      </span>
                      <span style={{ fontWeight: 600, color: statColor }}>{pick.stat}</span>
                      <span className="text-muted">Line: <b className="mono">{pick.sportsbook_line || pick.line}</b> {pick.line_source === 'sportsbook' && <span style={{ background: 'var(--green)', color: '#fff', fontSize: 8, padding: '1px 4px', borderRadius: 3, fontWeight: 700, marginLeft: 2 }}>REAL</span>}</span>
                      <span className="text-muted">Proj: <b className="mono">{pick.projected_value || pick.projected}</b></span>
                    </div>
                  </div>

                  {/* Edge */}
                  <div style={{ textAlign: 'right', minWidth: 70 }}>
                    <div className="mono fw-700" style={{ fontSize: 14, color: edgeColor }}>
                      {edgeVal > 0 ? '+' : ''}{edgeVal?.toFixed(1)}
                    </div>
                    <div className="text-xs text-muted">edge</div>
                  </div>

                  {/* Confidence */}
                  <div style={{
                    padding: '4px 10px', borderRadius: 6, fontSize: 10, fontWeight: 700,
                    background: `${confColor}15`, color: confColor, minWidth: 60, textAlign: 'center',
                  }}>
                    {pick.confidence || 'N/A'}
                  </div>

                  {/* Hit Rate */}
                  <div style={{ textAlign: 'right', minWidth: 50 }}>
                    <div className="mono fw-600" style={{ fontSize: 13 }}>
                      {pick.hit_rate ? `${pick.hit_rate.toFixed(0)}%` : pick.hitRate != null ? `${pick.hitRate.toFixed(0)}%` : '—'}
                    </div>
                    <div className="text-xs text-muted">hit rate</div>
                  </div>
                </div>

                {/* Expanded Detail */}
                {isExpanded && (
                  <div style={{
                    padding: '14px 16px', borderTop: '1px solid var(--border-light)',
                    background: 'var(--bg-secondary)', display: 'flex', gap: 24, flexWrap: 'wrap',
                  }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div className="text-xs fw-700 text-muted mb-2" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>Prop Details</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: 12 }}>
                        <div>Player: <b>{pick.player_name || pick.player}</b></div>
                        <div>Team: <b>{pick.team_abbr || pick.team}</b></div>
                        <div>Opponent: <b>{pick.opponentAbbr || '—'}</b></div>
                        <div>Position: <b>{pick.position || '—'}</b></div>
                        <div>Sportsbook Line: <b>{pick.sportsbook_line || pick.line || '—'}</b> {pick.line_source === 'sportsbook' ? <span style={{ color: 'var(--green)', fontSize: 10, fontWeight: 700 }}>REAL</span> : <span style={{ color: 'var(--text-tertiary)', fontSize: 10 }}>est.</span>}</div>
                        <div>Projected: <b>{pick.projected_value || pick.projected || '—'}</b></div>
                        <div>Fair Line: <b>{pick.fair_line || '—'}</b></div>
                        {pick.best_book && <div>Best Book: <b>{pick.best_book}</b> {pick.sportsbook_over_price && <span className="text-muted">(Over {pick.sportsbook_over_price > 0 ? '+' : ''}{pick.sportsbook_over_price})</span>}</div>}
                        {pick.kelly_pct && <div>Kelly Size: <b>{pick.kelly_pct}%</b> of bankroll</div>}
                        <div>Games Analyzed: <b>{pick.games_played || pick.gamesPlayed || '—'}</b></div>
                      </div>
                    </div>
                    {pick.reasoning && (
                      <div style={{ flexBasis: '100%', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, borderTop: '1px solid var(--border-light)', paddingTop: 8 }}>
                        <b>Analysis:</b> {pick.reasoning}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">🎯</div>
              <div className="empty-title">No prop picks available</div>
              <div className="empty-desc">Click "Generate" to analyze player props</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
