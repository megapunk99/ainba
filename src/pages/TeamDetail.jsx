import { useState, useEffect, useMemo } from 'react';

// ─── Team Detail ─────────────────────────────────────────
export default function TeamDetail({ teamId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('roster');

  useEffect(() => {
    if (!teamId) return;
    setLoading(true);
    fetch(`/api/teams/${teamId}/detail`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [teamId]);

  const teamRadar = useMemo(() => {
    if (!data?.roster?.length) return null;
    const topPlayers = data.roster.slice(0, 5);
    const avg = (key) => {
      const vals = topPlayers.map(p => p.averages?.[key] || 0);
      return vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
    };
    return {
      PTS: avg('ppg'),
      REB: avg('rpg'),
      AST: avg('apg'),
      STL: avg('spg'),
      BLK: avg('bpg'),
      FG: avg('fgPct'),
    };
  }, [data]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading team...</span></div>;
  if (!data?.team) return <div className="empty-state"><div className="empty-title">Team not found</div></div>;

  const team = data.team;
  const standing = data.standing;
  const roster = data.roster || [];

  return (
    <>
      <div className="back-btn" onClick={onBack}>← Back to Teams</div>

      {/* Team Header */}
      <div className="team-header">
        <img
          src={team.logos?.[0]?.href || `/api/logo/${team.abbreviation?.toLowerCase()}`}
          alt={team.displayName}
          className="team-header-logo"
          onError={e => { e.target.style.display = 'none'; }}
        />
        <div>
          <div className="team-header-name">{team.displayName}</div>
          <div className="team-header-record">
            {standing ? `${standing.wins}-${standing.losses}` : '—'}
            {standing?.winPercent ? ` · ${standing.winPercent.toFixed(3)} PCT` : ''}
          </div>
          <div className="flex gap-3 mt-2" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {standing?.avgPointsFor && <span>PPG: <b>{standing.avgPointsFor.toFixed(1)}</b></span>}
            {standing?.avgPointsAgainst && <span>OPPG: <span className="text-red">{standing.avgPointsAgainst.toFixed(1)}</span></span>}
            {standing?.differential != null && (
              <span>DIFF: <b style={{ color: standing.differential > 0 ? 'var(--green)' : 'var(--red)' }}>
                {standing.differential > 0 ? '+' : ''}{standing.differential.toFixed(1)}
              </b></span>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs mb-4">
        {['roster', 'stats', 'schedule'].map(t => (
          <div key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'roster' ? '👥 Roster' : t === 'stats' ? '📊 Stats' : '📅 Schedule'}
          </div>
        ))}
      </div>

      {/* Roster Tab */}
      {tab === 'roster' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">👥 Roster ({roster.length} players)</span>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {roster.map(player => (
                <div
                  key={player.id}
                  className="player-card"
                  onClick={() => window.__openPlayer?.(player.id)}
                >
                  <img
                    src={player.headshot?.href || ''}
                    alt=""
                    className="player-avatar"
                    onError={e => { e.target.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><circle cx="22" cy="22" r="22" fill="%23f1f5f9"/><text x="22" y="27" text-anchor="middle" fill="%2394a3b8" font-size="14" font-weight="700">${player.jersey || '?'}</text></svg>`; }}
                  />
                  <div className="player-info">
                    <div className="player-name">{player.displayName}</div>
                    <div className="player-meta">
                      <span>{player.position?.abbreviation || ''}</span>
                      <span>#{player.jersey}</span>
                      <span>{player.displayHeight}</span>
                    </div>
                  </div>
                  {player.averages?.games > 0 && (
                    <div className="player-stats-mini">
                      <span>{player.averages.ppg} <span className="text-xs text-muted">PTS</span></span>
                      <span>{player.averages.rpg} <span className="text-xs text-muted">REB</span></span>
                      <span>{player.averages.apg} <span className="text-xs text-muted">AST</span></span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Stats Tab */}
      {tab === 'stats' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-header">
              <span className="card-title">📊 Team Averages</span>
            </div>
            <div className="card-body">
              <div>
                {teamRadar && Object.entries(teamRadar).map(([key, val]) => (
                  <div key={key} className="flex flex-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border-light)', fontSize: 13 }}>
                    <span className="fw-600">{key}</span>
                    <span className="mono">{val?.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">🏀 Top Scorers</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {roster
                .filter(p => p.averages?.ppg > 0)
                .sort((a, b) => (b.averages?.ppg || 0) - (a.averages?.ppg || 0))
                .slice(0, 10)
                .map((p, i) => (
                  <div
                    key={p.id}
                    className="flex flex-between"
                    style={{
                      padding: '8px 14px',
                      borderBottom: '1px solid var(--border-light)',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                    onClick={() => window.__openPlayer?.(p.id)}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div className="flex gap-2" style={{ alignItems: 'center' }}>
                      <span className="text-muted" style={{ width: 20, textAlign: 'right' }}>{i + 1}</span>
                      <img
                        src={p.headshot?.href || ''}
                        alt=""
                        style={{ width: 28, height: 28, borderRadius: '50%' }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <div>
                        <div className="fw-600">{p.displayName}</div>
                        <div className="text-xs text-muted">#{p.jersey} · {p.position?.abbreviation}</div>
                      </div>
                    </div>
                    <div className="mono" style={{ fontWeight: 700, color: 'var(--brand)' }}>
                      {p.averages?.ppg}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Schedule Tab */}
      {tab === 'schedule' && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">📅 Schedule</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {(!data.schedule || data.schedule.length === 0) ? (
              <div className="empty-state">
                <div className="empty-icon">📅</div>
                <div className="empty-title">No schedule data</div>
              </div>
            ) : (
              data.schedule.slice(0, 30).map((game, i) => {
                const homeTeam = game.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home');
                const awayTeam = game.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away');
                const isHome = homeTeam?.team?.id === String(teamId);
                const opponent = isHome ? awayTeam?.team : homeTeam?.team;
                const score = game.competitions?.[0]?.competitors;
                const teamScore = score?.find(c => c.team?.id === String(teamId))?.score;
                const oppScore = score?.find(c => c.team?.id !== String(teamId))?.score;
                const won = parseInt(teamScore) > parseInt(oppScore);

                return (
                  <div
                    key={i}
                    className="flex flex-between"
                    style={{
                      padding: '10px 14px',
                      borderBottom: '1px solid var(--border-light)',
                      fontSize: 13,
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ minWidth: 80, color: 'var(--text-tertiary)', fontSize: 12 }}>
                      {new Date(game.date).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </div>
                    <div className="flex gap-2" style={{ alignItems: 'center', flex: 1 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, width: 24, textAlign: 'center',
                        color: isHome ? 'var(--brand)' : 'var(--text-tertiary)',
                      }}>
                        {isHome ? 'vs' : '@'}
                      </span>
                      <img
                        src={opponent?.logos?.[0]?.href || ''}
                        alt=""
                        style={{ width: 24, height: 24, borderRadius: '50%' }}
                        onError={e => { e.target.style.display = 'none'; }}
                      />
                      <span className="fw-600">{opponent?.displayName || 'TBD'}</span>
                    </div>
                    {teamScore && oppScore ? (
                      <div className="flex gap-2" style={{ alignItems: 'center' }}>
                        <span className="mono" style={{ fontWeight: 700, color: won ? 'var(--green)' : 'var(--red)' }}>
                          {teamScore} - {oppScore}
                        </span>
                        <span className={`badge ${won ? 'badge-success' : 'badge-danger'}`}>
                          {won ? 'W' : 'L'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted text-xs">
                        {new Date(game.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </>
  );
}
