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
async function cachedFetch(url, cacheKey, ttl = 120000) {
  const cached = await cacheGet(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;
  const res = await fetch(url);
  const data = await res.json();
  await cacheSet(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Color Helpers ──────────────────────────────────────
const COLORS = [
  { left: '#6366f1', right: '#f59e0b' },
  { left: '#8b5cf6', right: '#ec4899' },
  { left: '#3b82f6', right: '#f97316' },
];

function getColor(abbr) {
  const code = (abbr || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return COLORS[code % COLORS.length];
}

// ─── Compare Bar ──────────────────────────────────────
function CompareBar({ leftVal, rightVal, leftColor, rightColor, label, invert }) {
  const total = (parseFloat(leftVal) || 0) + (parseFloat(rightVal) || 0);
  const leftPct = total > 0 ? ((parseFloat(leftVal) || 0) / total) * 100 : 50;
  const rightPct = total > 0 ? ((parseFloat(rightVal) || 0) / total) * 100 : 50;
  const leftWins = invert ? leftPct < rightPct : leftPct > rightPct;

  return (
    <div className="compare-bar">
      <div className="compare-bar-header">
        <span className="mono" style={{ color: leftWins ? leftColor : 'var(--text-tertiary)', fontWeight: leftWins ? 700 : 400 }}>{leftVal}</span>
        <span className="compare-bar-label">{label}</span>
        <span className="mono" style={{ color: !leftWins ? rightColor : 'var(--text-tertiary)', fontWeight: !leftWins ? 700 : 400 }}>{rightVal}</span>
      </div>
      <div className="compare-bar-track">
        <div className="compare-bar-fill" style={{ width: `${leftPct}%`, background: leftColor }} />
        <div className="compare-bar-fill" style={{ width: `${rightPct}%`, background: rightColor }} />
      </div>
    </div>
  );
}

// ─── Player Row ──────────────────────────────────────
function PlayerRow({ awayPlayer, homePlayer, leftColor, rightColor }) {
  if (!awayPlayer && !homePlayer) return null;
  const stats = ['ppg', 'rpg', 'apg', 'spg', 'bpg'];
  const labels = { ppg: 'PTS', rpg: 'REB', apg: 'AST', spg: 'STL', bpg: 'BLK' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light)', alignItems: 'center' }}>
      {/* Away Player */}
      <div className="flex gap-2" style={{ alignItems: 'center' }}>
        {awayPlayer?.headshot ? (
          <img src={awayPlayer.headshot} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }} />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontWeight: 700, fontSize: 12, border: '1px solid var(--border)' }}>
            {awayPlayer?.name?.charAt(0) || '?'}
          </div>
        )}
        <div>
          <div className="fw-600" style={{ fontSize: 12 }}>{awayPlayer?.name || '—'}</div>
          <div className="text-xs text-muted">{awayPlayer?.position || ''} #{awayPlayer?.jersey || ''} · <span style={{ color: leftColor, fontWeight: 600 }}>{awayPlayer?.ppg || 0} PPG</span></div>
        </div>
      </div>

      {/* VS Badge */}
      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: 'var(--text-tertiary)' }}>VS</div>

      {/* Home Player */}
      <div className="flex gap-2" style={{ alignItems: 'center', flexDirection: 'row-reverse' }}>
        {homePlayer?.headshot ? (
          <img src={homePlayer.headshot} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border)' }} />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontWeight: 700, fontSize: 12, border: '1px solid var(--border)' }}>
            {homePlayer?.name?.charAt(0) || '?'}
          </div>
        )}
        <div style={{ textAlign: 'right' }}>
          <div className="fw-600" style={{ fontSize: 12 }}>{homePlayer?.name || '—'}</div>
          <div className="text-xs text-muted"><span style={{ color: rightColor, fontWeight: 600 }}>{homePlayer?.ppg || 0} PPG</span> · {homePlayer?.position || ''} #{homePlayer?.jersey || ''}</div>
        </div>
      </div>

      {/* Mini stat comparison */}
      <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
        <div className="flex gap-2" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
          {stats.map(s => {
            const av = parseFloat(awayPlayer?.[s]) || 0;
            const hv = parseFloat(homePlayer?.[s]) || 0;
            const aWins = av > hv;
            const hWins = hv > av;
            return (
              <div key={s} className="flex gap-2" style={{ alignItems: 'center', fontSize: 10, padding: '3px 6px', borderRadius: 4, background: 'var(--bg-tertiary)' }}>
                <span style={{ fontWeight: aWins ? 700 : 400, color: aWins ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{av.toFixed(1)}</span>
                <span className="text-muted">{labels[s]}</span>
                <span style={{ fontWeight: hWins ? 700 : 400, color: hWins ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{hv.toFixed(1)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────
export default function MatchDetail({ match, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [props, setProps] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [h2h, setH2h] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [injuryImpact, setInjuryImpact] = useState(null);

  const awayId = match?.away?.id;
  const homeId = match?.home?.id;
  const awayAbbr = match?.away?.abbreviation || match?.away?.abbr || '';
  const homeAbbr = match?.home?.abbreviation || match?.home?.abbr || '';
  const colors = getColor(awayAbbr);
  const leftColor = colors.left;
  const rightColor = colors.right;

  useEffect(() => {
    if (!awayId || !homeId) return;
    setLoading(true);
    Promise.allSettled([
      cachedFetch(`/api/matchup/${awayId}/${homeId}`, `matchup-${awayId}-${homeId}`),
      cachedFetch(`/api/predictions/top-picks?limit=50`, 'props-picks', 30000),
      fetch(`/api/injuries/impact/${awayId}/${homeId}`).then(r => r.json()),
    ]).then(([matchResult, propsResult, injuryResult]) => {
      if (matchResult.status === 'fulfilled') {
        setData(matchResult.value);
        setH2h(matchResult.value.h2h || null);
      }
      if (propsResult.status === 'fulfilled') {
        const gameProps = (propsResult.value.picks || []).filter(p =>
          p.team_abbr === awayAbbr || p.team_abbr === homeAbbr ||
          p.opponentAbbr === awayAbbr || p.opponentAbbr === homeAbbr
        );
        setProps(gameProps);
      }
      if (injuryResult.status === 'fulfilled' && !injuryResult.value?.error) {
        setInjuryImpact(injuryResult.value);
      }
      setLoading(false);
    });
  }, [awayId, homeId, awayAbbr, homeAbbr]);

  const comparisonStats = useMemo(() => {
    if (!data?.away?.standing || !data?.home?.standing) return [];
    const a = data.away.standing;
    const h = data.home.standing;
    return [
      { label: 'PPG', a: a.avgPointsFor, h: h.avgPointsFor },
      { label: 'OPP PPG', a: a.avgPointsAgainst, h: h.avgPointsAgainst, invert: true },
      { label: 'Rebounds', a: a.avgRebounds, h: h.avgRebounds },
      { label: 'Assists', a: a.avgAssists, h: h.avgAssists },
      { label: 'Steals', a: a.avgSteals, h: h.avgSteals },
      { label: 'Blocks', a: a.avgBlocks, h: h.avgBlocks },
      { label: 'Turnovers', a: a.avgTurnovers, h: h.avgTurnovers, invert: true },
      { label: 'FG%', a: a.fieldGoalPct, h: h.fieldGoalPct },
      { label: '3P%', a: a.threePointFieldGoalPct, h: h.threePointFieldGoalPct },
      { label: 'FT%', a: a.freeThrowPct, h: h.freeThrowPct },
    ];
  }, [data]);

  const playerMatchups = useMemo(() => {
    if (!data) return [];
    const awayPlayers = data.away?.players || [];
    const homePlayers = data.home?.players || [];
    const maxLen = Math.max(awayPlayers.length, homePlayers.length);
    return Array.from({ length: Math.min(maxLen, 10) }, (_, i) => ({
      away: awayPlayers[i] || null,
      home: homePlayers[i] || null,
    }));
  }, [data]);

  if (loading) return (
    <div>
      <div className="back-btn" onClick={onBack}>← Back to Games</div>
      <div className="loading-screen"><div className="spinner" /><span>Loading matchup...</span></div>
    </div>
  );

  if (!data) return (
    <div>
      <div className="back-btn" onClick={onBack}>← Back to Games</div>
      <div className="empty-state"><div className="empty-title">Could not load matchup data</div></div>
    </div>
  );

  const away = data.away;
  const home = data.home;
  const awayStanding = away?.standing || {};
  const homeStanding = home?.standing || {};

  return (
    <>
      <div className="back-btn" onClick={onBack}>← Back to Games</div>

      {/* Matchup Header */}
      <div style={{
        background: `linear-gradient(135deg, ${leftColor}10, ${rightColor}10)`,
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', padding: '20px 24px', marginBottom: 20,
      }}>
        <div className="flex flex-between" style={{ alignItems: 'center' }}>
          {/* Away Team */}
          <div className="flex gap-3" style={{ alignItems: 'center' }}>
            <img
              src={away?.team?.logos?.[0]?.href || `/api/logo/${awayAbbr.toLowerCase()}`}
              alt={awayAbbr}
              style={{ width: 56, height: 56, opacity: 0.85 }}
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div>
              <div className="fw-800" style={{ fontSize: 22 }}>{awayAbbr}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{away?.team?.displayName}</div>
              <div className="text-xs text-muted fw-600">
                {awayStanding.wins ?? '?'}-{awayStanding.losses ?? '?'}
                {awayStanding.winPercent ? ` (${(awayStanding.winPercent * 100).toFixed(1)}%)` : ''}
              </div>
            </div>
          </div>

          {/* VS */}
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: 'var(--bg)', border: '2px solid var(--border)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 800, color: 'var(--text-tertiary)',
            }}>VS</div>
            {match?.date && (
              <div className="text-xs text-muted mt-2">
                {new Date(match.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              </div>
            )}
          </div>

          {/* Home Team */}
          <div className="flex gap-3" style={{ alignItems: 'center', flexDirection: 'row-reverse' }}>
            <img
              src={home?.team?.logos?.[0]?.href || `/api/logo/${homeAbbr.toLowerCase()}`}
              alt={homeAbbr}
              style={{ width: 56, height: 56, opacity: 0.85 }}
              onError={e => { e.target.style.display = 'none'; }}
            />
            <div style={{ textAlign: 'right' }}>
              <div className="fw-800" style={{ fontSize: 22 }}>{homeAbbr}</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{home?.team?.displayName}</div>
              <div className="text-xs text-muted fw-600">
                {homeStanding.wins ?? '?'}-{homeStanding.losses ?? '?'}
                {homeStanding.winPercent ? ` (${(homeStanding.winPercent * 100).toFixed(1)}%)` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Prediction + Injury Impact */}
      {(injuryImpact || data?.away?.standing) && (
        <div className="card mb-4">
          <div className="card-header">
            <span className="card-title">🧠 Model Prediction</span>
          </div>
          <div className="card-body">
            {/* Win Probability Bar */}
            {(() => {
              const awayStanding = data?.away?.standing || {};
              const homeStanding = data?.home?.standing || {};
              if (!awayStanding.winPercent || !homeStanding.winPercent) return null;
              const awayRating = (awayStanding.avgPointsFor || 110) * (awayStanding.winPercent || 0.5);
              const homeRating = (homeStanding.avgPointsFor || 110) * (homeStanding.winPercent || 0.5);
              const diff = (homeRating + 3.5) - awayRating;
              let homeProb = 1 / (1 + Math.exp(-diff * 0.1));
              // Apply injury adjustment if available
              if (injuryImpact?.probAdjustment) homeProb = Math.max(0.05, Math.min(0.95, homeProb + injuryImpact.probAdjustment));
              const awayPct = Math.round((1 - homeProb) * 100);
              const homePct = Math.round(homeProb * 100);
              const predictedMargin = diff * 0.4 + (injuryImpact?.netImpact || 0) * 0.4;
              return (
                <>
                  <div className="flex flex-between mb-2" style={{ fontSize: 14, fontWeight: 700 }}>
                    <span>{awayAbbr} {awayPct}%</span>
                    <span className="text-xs text-muted fw-400">WIN PROBABILITY</span>
                    <span>{homePct}% {homeAbbr}</span>
                  </div>
                  <div className="compare-bar-track" style={{ height: 10, borderRadius: 5 }}>
                    <div style={{ width: `${awayPct}%`, background: leftColor, borderRadius: 5 }} />
                    <div style={{ width: `${homePct}%`, background: rightColor, borderRadius: 5 }} />
                  </div>
                  <div className="flex flex-between mt-2" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <span>Predicted Margin: <b className="mono">{predictedMargin > 0 ? homeAbbr : awayAbbr} {Math.abs(predictedMargin).toFixed(1)}</b></span>
                    <span>Confidence: <b>{Math.abs(predictedMargin) > 5 ? 'HIGH' : Math.abs(predictedMargin) > 2 ? 'MEDIUM' : 'LOW'}</b></span>
                  </div>
                </>
              );
            })()}

            {/* Injury Impact */}
            {injuryImpact && injuryImpact.netImpact !== 0 && (
              <div style={{ marginTop: 16, padding: '12px 16px', borderRadius: 8, background: Math.abs(injuryImpact.netImpact) > 5 ? 'var(--red-light)' : 'var(--bg-secondary)', border: `1px solid ${Math.abs(injuryImpact.netImpact) > 5 ? '#fecaca' : 'var(--border-light)'}` }}>
                <div className="fw-700 mb-2" style={{ fontSize: 13 }}>🏥 Injury Impact</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
                  <div>
                    <span className="text-muted">{awayAbbr}:</span>{' '}
                    <span className="fw-600" style={{ color: injuryImpact.homeInjuries?.totalImpact < 0 ? 'var(--red)' : 'var(--green)' }}>
                      {injuryImpact.homeInjuries?.totalImpact ? `${injuryImpact.homeInjuries.totalImpact > 0 ? '+' : ''}${injuryImpact.homeInjuries.totalImpact} pts` : '0 pts'}
                    </span>
                    {injuryImpact.homeInjuries?.keyPlayersOut?.length > 0 && (
                      <div className="text-xs text-muted mt-1">Key OUT: {injuryImpact.homeInjuries.keyPlayersOut.map(p => p.player).join(', ')}</div>
                    )}
                  </div>
                  <div>
                    <span className="text-muted">{homeAbbr}:</span>{' '}
                    <span className="fw-600" style={{ color: injuryImpact.awayInjuries?.totalImpact < 0 ? 'var(--red)' : 'var(--green)' }}>
                      {injuryImpact.awayInjuries?.totalImpact ? `${injuryImpact.awayInjuries.totalImpact > 0 ? '+' : ''}${injuryImpact.awayInjuries.totalImpact} pts` : '0 pts'}
                    </span>
                    {injuryImpact.awayInjuries?.keyPlayersOut?.length > 0 && (
                      <div className="text-xs text-muted mt-1">Key OUT: {injuryImpact.awayInjuries.keyPlayersOut.map(p => p.player).join(', ')}</div>
                    )}
                  </div>
                </div>
                <div className="mt-2 text-xs" style={{ color: injuryImpact.netImpact > 0 ? 'var(--green)' : 'var(--red)' }}>
                  Net swing: <b>{injuryImpact.netImpact > 0 ? '+' : ''}{injuryImpact.netImpact} pts</b> favoring {injuryImpact.netImpact > 0 ? awayAbbr : homeAbbr}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs mb-4">
        {[
          { key: 'overview', label: '📊 Team Comparison' },
          { key: 'players', label: '👤 Player Matchups' },
          { key: 'props', label: '🎯 Props' },
        ].map(tab => (
          <div key={tab.key} className={`tab ${activeTab === tab.key ? 'active' : ''}`} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </div>
        ))}
      </div>

      {/* ═══ OVERVIEW TAB ═══════════════════════════════════════ */}
      {activeTab === 'overview' && (
        <>
          {/* Win Probability */}
          {awayStanding.winPercent && homeStanding.winPercent && (() => {
            const awayRating = (awayStanding.avgPointsFor || 110) * (awayStanding.winPercent || 0.5);
            const homeRating = (homeStanding.avgPointsFor || 110) * (homeStanding.winPercent || 0.5);
            const diff = (homeRating + 3.5) - awayRating;
            const homeProb = 1 / (1 + Math.exp(-diff * 0.1));
            const awayPct = Math.round((1 - homeProb) * 100);
            const homePct = Math.round(homeProb * 100);
            return (
              <div className="card mb-4">
                <div className="card-body">
                  <div className="flex flex-between mb-2" style={{ fontSize: 14, fontWeight: 700 }}>
                    <span>{awayAbbr} {awayPct}%</span>
                    <span className="text-xs text-muted fw-400" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>Win Probability</span>
                    <span>{homePct}% {homeAbbr}</span>
                  </div>
                  <div className="compare-bar-track" style={{ height: 10, borderRadius: 5 }}>
                    <div style={{ width: `${awayPct}%`, background: leftColor, borderRadius: 5 }} />
                    <div style={{ width: `${homePct}%`, background: rightColor, borderRadius: 5 }} />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Quick Stats */}
          <div className="stat-grid mb-4">
            {[
              { label: 'PPG', away: awayStanding.avgPointsFor, home: homeStanding.avgPointsFor },
              { label: 'OPP PPG', away: awayStanding.avgPointsAgainst, home: homeStanding.avgPointsAgainst },
              { label: 'REB', away: awayStanding.avgRebounds, home: homeStanding.avgRebounds },
              { label: 'AST', away: awayStanding.avgAssists, home: homeStanding.avgAssists },
            ].map(s => {
              const aVal = parseFloat(s.away) || 0;
              const hVal = parseFloat(s.home) || 0;
              const aWins = s.label === 'OPP PPG' ? aVal < hVal : aVal > hVal;
              return (
                <div key={s.label} className="stat-box" style={{ padding: 12 }}>
                  <div className="flex flex-between" style={{ alignItems: 'center' }}>
                    <span className="mono fw-700" style={{ fontSize: 16, color: aWins ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{aVal.toFixed(1)}</span>
                    <div className="stat-label">{s.label}</div>
                    <span className="mono fw-700" style={{ fontSize: 16, color: !aWins ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{hVal.toFixed(1)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Comparison Bars */}
          <div className="card mb-4">
            <div className="card-header">
              <span className="fw-700" style={{ color: leftColor }}>{awayAbbr}</span>
              <span className="card-title">Head-to-Head Comparison</span>
              <span className="fw-700" style={{ color: rightColor }}>{homeAbbr}</span>
            </div>
            <div className="card-body">
              {comparisonStats.map(s => (
                <CompareBar key={s.label} leftVal={s.a} rightVal={s.h} leftColor={leftColor} rightColor={rightColor} label={s.label} invert={s.invert} />
              ))}
            </div>
          </div>

          {/* H2H History */}
          {h2h && h2h.recentGames?.length > 0 && (
            <div className="card mb-4">
              <div className="card-header">
                <span className="card-title">📋 Head-to-Head ({h2h.record.games} games)</span>
                <span className="fw-700 text-sm">{awayAbbr} {h2h.record.awayWins} - {h2h.record.homeWins} {homeAbbr}</span>
              </div>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Away</th>
                      <th className="text-right">Score</th>
                      <th>Home</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {h2h.recentGames.map((g, i) => {
                      const homeWon = g.homeScore > g.awayScore;
                      return (
                        <tr key={i}>
                          <td className="text-xs text-muted">{g.date?.slice(5, 10)}</td>
                          <td className="text-xs">{g.away?.split(' ').pop()}</td>
                          <td className="mono text-right fw-700">{g.awayScore} - {g.homeScore}</td>
                          <td className="text-xs">{g.home?.split(' ').pop()}</td>
                          <td>
                            <span className={`badge ${homeWon ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: 10 }}>
                              {homeWon ? 'HOME' : 'AWAY'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Advanced Stats Table */}
          <div className="card">
            <div className="card-header"><span className="card-title">📊 Advanced Stats</span></div>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ color: leftColor }}>{awayAbbr}</th>
                    <th className="text-center">Stat</th>
                    <th className="text-right" style={{ color: rightColor }}>{homeAbbr}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: 'Win %', a: awayStanding.winPercent ? (awayStanding.winPercent * 100).toFixed(1) + '%' : '—', h: homeStanding.winPercent ? (homeStanding.winPercent * 100).toFixed(1) + '%' : '—' },
                    { label: 'Point Diff', a: awayStanding.differential ?? '—', h: homeStanding.differential ?? '—' },
                    { label: 'PPG', a: awayStanding.avgPointsFor?.toFixed(1) ?? '—', h: homeStanding.avgPointsFor?.toFixed(1) ?? '—' },
                    { label: 'Opp PPG', a: awayStanding.avgPointsAgainst?.toFixed(1) ?? '—', h: homeStanding.avgPointsAgainst?.toFixed(1) ?? '—' },
                    { label: 'Rebounds', a: awayStanding.avgRebounds?.toFixed(1) ?? '—', h: homeStanding.avgRebounds?.toFixed(1) ?? '—' },
                    { label: 'Assists', a: awayStanding.avgAssists?.toFixed(1) ?? '—', h: homeStanding.avgAssists?.toFixed(1) ?? '—' },
                    { label: 'Steals', a: awayStanding.avgSteals?.toFixed(1) ?? '—', h: homeStanding.avgSteals?.toFixed(1) ?? '—' },
                    { label: 'Blocks', a: awayStanding.avgBlocks?.toFixed(1) ?? '—', h: homeStanding.avgBlocks?.toFixed(1) ?? '—' },
                    { label: 'Turnovers', a: awayStanding.avgTurnovers?.toFixed(1) ?? '—', h: homeStanding.avgTurnovers?.toFixed(1) ?? '—' },
                    { label: 'FG%', a: awayStanding.fieldGoalPct?.toFixed(1) ?? '—', h: homeStanding.fieldGoalPct?.toFixed(1) ?? '—' },
                    { label: '3P%', a: awayStanding.threePointFieldGoalPct?.toFixed(1) ?? '—', h: homeStanding.threePointFieldGoalPct?.toFixed(1) ?? '—' },
                    { label: 'FT%', a: awayStanding.freeThrowPct?.toFixed(1) ?? '—', h: homeStanding.freeThrowPct?.toFixed(1) ?? '—' },
                  ].map((s, i) => {
                    const aNum = parseFloat(s.a);
                    const hNum = parseFloat(s.h);
                    const lowerBetter = s.label === 'Turnovers' || s.label === 'Opp PPG';
                    const aWins = !isNaN(aNum) && !isNaN(hNum) ? (lowerBetter ? aNum < hNum : aNum > hNum) : false;
                    const hWins = !isNaN(aNum) && !isNaN(hNum) && !aWins && aNum !== hNum;
                    return (
                      <tr key={i}>
                        <td className={`mono text-center ${aWins ? 'fw-700' : ''}`} style={{ color: aWins ? 'var(--brand)' : 'var(--text-tertiary)' }}>{s.a}</td>
                        <td className="text-center fw-600 text-xs text-muted">{s.label}</td>
                        <td className={`mono text-center ${hWins ? 'fw-700' : ''}`} style={{ color: hWins ? 'var(--brand)' : 'var(--text-tertiary)' }}>{s.h}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ═══ PLAYERS TAB ═══════════════════════════════════════ */}
      {activeTab === 'players' && (
        <>
          <div className="card mb-4">
            <div className="card-header">
              <span className="fw-700" style={{ color: leftColor }}>{awayAbbr}</span>
              <span className="card-title">Player-by-Player Matchup</span>
              <span className="fw-700" style={{ color: rightColor }}>{homeAbbr}</span>
            </div>
            <div className="card-body" style={{ padding: '8px 18px' }}>
              {playerMatchups.map((m, i) => (
                <PlayerRow key={i} awayPlayer={m.away} homePlayer={m.home} leftColor={leftColor} rightColor={rightColor} />
              ))}
            </div>
          </div>

          {/* Full Roster Tables */}
          <div className="grid-2">
            {[{ label: awayAbbr, players: away?.players, color: leftColor }, { label: homeAbbr, players: home?.players, color: rightColor }].map(team => (
              <div key={team.label} className="card">
                <div className="card-header">
                  <span className="card-title fw-700" style={{ color: team.color }}>{team.label} Roster</span>
                </div>
                <div className="table-wrapper" style={{ maxHeight: 400, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th className="text-right">GP</th>
                        <th className="text-right">PPG</th>
                        <th className="text-right">RPG</th>
                        <th className="text-right">APG</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(team.players || []).map((p, i) => (
                        <tr key={i} onClick={() => window.__openPlayer?.(p.id)} style={{ cursor: 'pointer' }}>
                          <td>
                            <div className="flex gap-2" style={{ alignItems: 'center' }}>
                              {p.headshot && <img src={p.headshot} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} />}
                              <div>
                                <div className="fw-600 text-xs">{p.name}</div>
                                <div className="text-xs text-muted">{p.position} #{p.jersey}</div>
                              </div>
                            </div>
                          </td>
                          <td className="mono text-right">{p.games}</td>
                          <td className="mono text-right fw-700">{p.ppg}</td>
                          <td className="mono text-right">{p.rpg}</td>
                          <td className="mono text-right">{p.apg}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ═══ PROPS TAB ═══════════════════════════════════════ */}
      {activeTab === 'props' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">🎯 Player Props — {awayAbbr} @ {homeAbbr}</span>
            <span className="text-xs text-muted">Projected vs Lines</span>
          </div>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Stat</th>
                  <th className="text-right">Line</th>
                  <th className="text-right">Projected</th>
                  <th className="text-right">Edge</th>
                  <th>Pick</th>
                  <th className="text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {props.map((p, i) => {
                  const isOver = p.recommendation === 'OVER';
                  const edge = p.edge || 0;
                  return (
                    <tr key={i}>
                      <td className="fw-600">{p.player_name || p.player}</td>
                      <td className="fw-600 text-xs">{p.stat}</td>
                      <td className="mono text-right">{p.sportsbook_line || p.line}</td>
                      <td className="mono text-right fw-600">{p.projected_value || p.projected}</td>
                      <td className="mono text-right fw-600" style={{ color: Math.abs(edge) >= 3 ? 'var(--green)' : 'var(--text-secondary)' }}>
                        {edge > 0 ? '+' : ''}{edge?.toFixed(1)}
                      </td>
                      <td>
                        <span className={`badge ${isOver ? 'badge-success' : 'badge-danger'}`}>{p.recommendation}</span>
                      </td>
                      <td className="mono text-right fw-700" style={{ color: 'var(--brand)' }}>
                        {Math.round(p.prop_score || p.score || 0)}
                      </td>
                    </tr>
                  );
                })}
                {props.length === 0 && (
                  <tr><td colSpan={7} className="empty-state" style={{ padding: 24 }}>No props available for this matchup</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
