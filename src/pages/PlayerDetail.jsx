import { useState, useEffect, useMemo } from 'react';

// ─── Mini Sparkline ──────────────────────────────────────
function Sparkline({ values, color = 'var(--brand)', width = 80, height = 24 }) {
  if (!values?.length) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1 || 1);
  const points = values.map((v, i) => `${i * step},${height - ((v - min) / range) * height}`).join(' ');
  
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Player Detail ───────────────────────────────────────
export default function PlayerDetail({ playerId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!playerId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/players/${playerId}`).then(r => r.json()),
      fetch(`/api/players/${playerId}/stats`).then(r => r.json()),
    ]).then(([profile, stats]) => {
      setData({ ...profile, gameStats: stats });
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [playerId]);

  const lastTenPts = useMemo(() => {
    if (!data?.gameStats?.games) return [];
    return data.gameStats.games.slice(-10).map(g => parseFloat(g.PTS) || 0);
  }, [data]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading player...</span></div>;
  if (!data?.profile) return <div className="empty-state"><div className="empty-title">Player not found</div></div>;

  const profile = data.profile;
  const info = profile.athletes?.[0] || profile;
  const name = info.displayName || `${info.firstName} ${info.lastName}`;
  const headshot = info.headshot?.href || '';
  const pos = info.position?.abbreviation || '';
  const jersey = info.jersey || '';
  const height = info.displayHeight || '';
  const weight = info.displayWeight || '';
  const age = info.age || '';
  const stats = data.gameStats?.averages || {};
  const games = data.gameStats?.games || [];

  return (
    <>
      <div className="back-btn" onClick={onBack}>← Back</div>

      {/* Profile Header */}
      <div className="profile-header">
        <img
          src={headshot}
          alt={name}
          className="profile-avatar"
          onError={e => { e.target.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="40" fill="%23f1f5f9"/><text x="40" y="47" text-anchor="middle" fill="%2394a3b8" font-size="24" font-weight="700">${jersey || '?'}</text></svg>`; }}
        />
        <div>
          <div className="profile-name">{name}</div>
          <div className="profile-meta">
            <span className="badge badge-info">#{jersey}</span>
            <span>{pos}</span>
            {height && <span>{height}</span>}
            {weight && <span>{weight}</span>}
            {age && <span>Age {age}</span>}
          </div>
          <div className="profile-stats">
            {stats.PTS && <div className="profile-stat"><div className="profile-stat-value">{stats.PTS}</div><div className="profile-stat-label">PPG</div></div>}
            {stats.REB && <div className="profile-stat"><div className="profile-stat-value">{stats.REB}</div><div className="profile-stat-label">RPG</div></div>}
            {stats.AST && <div className="profile-stat"><div className="profile-stat-value">{stats.AST}</div><div className="profile-stat-label">APG</div></div>}
            {stats.STL && <div className="profile-stat"><div className="profile-stat-value">{stats.STL}</div><div className="profile-stat-label">SPG</div></div>}
            {stats.BLK && <div className="profile-stat"><div className="profile-stat-value">{stats.BLK}</div><div className="profile-stat-label">BPG</div></div>}
            {stats['FG%'] && <div className="profile-stat"><div className="profile-stat-value">{stats['FG%']}</div><div className="profile-stat-label">FG%</div></div>}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* Recent Form */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">📈 Scoring Trend (Last 10)</span>
          </div>
          <div className="card-body" style={{ textAlign: 'center', padding: '20px 16px' }}>
            <Sparkline values={lastTenPts} color="#2563eb" width={280} height={60} />
            <div className="flex flex-between mt-3" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              <span>Last 10 games</span>
              <span className="mono fw-600" style={{ color: 'var(--text-primary)' }}>
                {lastTenPts.length ? (lastTenPts.reduce((s, v) => s + v, 0) / lastTenPts.length).toFixed(1) : '—'} avg
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Game Log */}
      <div className="card mt-4">
        <div className="card-header">
          <span className="card-title">📋 Game Log</span>
          <span className="text-xs text-muted">{data.gameStats?.totalGames || 0} games</span>
        </div>
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                {(data.gameStats?.labels || []).slice(0, 12).map(label => (
                  <th key={label} className="text-center">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {games.slice(-20).reverse().map((game, i) => (
                <tr key={i}>
                  {(data.gameStats?.labels || []).slice(0, 12).map(label => (
                    <td key={label} className="text-center mono" style={{ fontSize: 12 }}>
                      {game[label] || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {stats.PTS && (
              <tfoot>
                <tr style={{ fontWeight: 700, background: 'var(--bg-secondary)' }}>
                  {(data.gameStats?.labels || []).slice(0, 12).map(label => (
                    <td key={label} className="text-center mono" style={{ fontSize: 12, color: 'var(--brand)' }}>
                      {stats[label] || '—'}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  );
}
