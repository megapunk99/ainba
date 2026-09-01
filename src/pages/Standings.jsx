import { useState, useEffect, useMemo } from 'react';

export default function Standings() {
  const [standings, setStandings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [conference, setConference] = useState('all');

  useEffect(() => {
    fetch('/api/standings')
      .then(r => r.json())
      .then(data => {
        setStandings(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const allTeams = useMemo(() => {
    if (!standings?.children) return [];
    const teams = [];
    standings.children.forEach(conference => {
      conference.standings?.entries?.forEach(entry => {
        const stats = {};
        entry.stats?.forEach(s => { stats[s.name] = s.value; });
        teams.push({
          id: entry.team.id,
          name: entry.team.displayName,
          abbreviation: entry.team.abbreviation,
          logo: entry.team.logos?.[0]?.href || '',
          conference: conference.name || '',
          confAbbrev: conference.abbreviation || '',
          wins: stats.wins || 0,
          losses: stats.losses || 0,
          winPct: stats.winPercent || 0,
          ppg: stats.avgPointsFor || 0,
          oppg: stats.avgPointsAgainst || 0,
          diff: stats.differential || 0,
          streak: stats.streak || 0,
          last10: stats.record || '',
          confRank: stats.confRank || 0,
          divRank: stats.divRank || 0,
          homeRecord: stats.home?.split('-').map(Number) || [0, 0],
          roadRecord: stats.road?.split('-').map(Number) || [0, 0],
          pointsAgainst: stats.pointsAgainst || 0,
          pointsFor: stats.pointsFor || 0,
        });
      });
    });
    return teams;
  }, [standings]);

  const filteredTeams = useMemo(() => {
    if (conference === 'all') return allTeams;
    return allTeams.filter(t => t.confAbbrev === conference || t.conference?.includes(conference === 'east' ? 'Eastern' : 'Western'));
  }, [allTeams, conference]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading standings...</span></div>;

  return (
    <>
      <div className="section-title">📊 NBA Standings</div>

      <div className="tabs mb-4">
        {['all', 'east', 'west'].map(c => (
          <div
            key={c}
            className={`tab ${conference === c ? 'active' : ''}`}
            onClick={() => setConference(c)}
          >
            {c === 'all' ? 'All Teams' : c === 'east' ? 'Eastern Conference' : 'Western Conference'}
          </div>
        ))}
      </div>

      <div className="card">
        <div className="table-wrapper">
          <table className="data-table standings-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}>#</th>
                <th>Team</th>
                <th className="text-center">W</th>
                <th className="text-center">L</th>
                <th className="text-center">PCT</th>
                <th className="text-center">GB</th>
                <th className="text-center">PPG</th>
                <th className="text-center">OPPG</th>
                <th className="text-center">DIFF</th>
                <th className="text-center">L10</th>
                <th className="text-center">STRK</th>
              </tr>
            </thead>
            <tbody>
              {filteredTeams
                .sort((a, b) => b.winPct - a.winPct || b.diff - a.diff)
                .map((team, i) => {
                  const gb = i === 0 ? '—' : ((filteredTeams[0].wins - team.wins + (team.losses - filteredTeams[0].losses)) / 2).toFixed(1);
                  return (
                    <tr
                      key={team.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => window.__openTeam?.(team.id)}
                    >
                      <td className="rank">{i + 1}</td>
                      <td>
                        <div className="team-cell">
                          <img
                            src={team.logo || `/api/logo/${team.abbreviation?.toLowerCase()}`}
                            alt=""
                            className="team-logo-sm"
                            onError={e => { e.target.style.display = 'none'; }}
                          />
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{team.name}</div>
                            <div className="text-xs text-muted">{team.confAbbrev}</div>
                          </div>
                        </div>
                      </td>
                      <td className="text-center mono" style={{ fontWeight: 700 }}>{team.wins}</td>
                      <td className="text-center mono">{team.losses}</td>
                      <td className="text-center mono" style={{ fontWeight: 700 }}>
                        {team.winPct?.toFixed(3)}
                      </td>
                      <td className="text-center mono">{gb}</td>
                      <td className="text-center mono">{team.ppg?.toFixed(1)}</td>
                      <td className="text-center mono">{team.oppg?.toFixed(1)}</td>
                      <td className="text-center mono" style={{ color: team.diff > 0 ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                        {team.diff > 0 ? '+' : ''}{team.diff?.toFixed(1)}
                      </td>
                      <td className="text-center">{team.last10 || '—'}</td>
                      <td className="text-center">
                        {team.streak > 0 ? (
                          <span className="badge badge-success">W{team.streak}</span>
                        ) : team.streak < 0 ? (
                          <span className="badge badge-danger">L{Math.abs(team.streak)}</span>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
