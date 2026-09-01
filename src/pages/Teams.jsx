import { useState, useEffect, useMemo } from 'react';

export default function Teams() {
  const [teams, setTeams] = useState([]);
  const [standings, setStandings] = useState({});
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [conference, setConference] = useState('all');

  useEffect(() => {
    Promise.all([
      fetch('/api/teams/all').then(r => r.json()),
      fetch('/api/standings').then(r => r.json()),
    ]).then(([teamsData, standingsData]) => {
      // Build standings map
      const stMap = {};
      (standingsData?.children || []).forEach(conf => {
        conf.standings?.entries?.forEach(entry => {
          const s = {};
          entry.stats?.forEach(x => { s[x.name] = x.value; });
          stMap[entry.team.id] = {
            wins: s.wins || 0,
            losses: s.losses || 0,
            winPct: s.winPercent || 0,
            ppg: s.avgPointsFor || 0,
            oppg: s.avgPointsAgainst || 0,
            diff: s.differential || 0,
          };
        });
      });

      const enriched = (teamsData.teams || []).map(t => ({
        ...t,
        standings: stMap[String(t.id)] || null,
      }));

      setTeams(enriched);
      setStandings(stMap);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = teams;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name?.toLowerCase().includes(q) ||
        t.abbreviation?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [teams, search]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading teams...</span></div>;

  return (
    <>
      <div className="flex flex-between mb-4" style={{ alignItems: 'center' }}>
        <div className="section-title" style={{ marginBottom: 0 }}>👥 NBA Teams</div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <input
            className="inp inp-sm"
            placeholder="🔍 Search teams..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
        </div>
      </div>

      <div className="team-grid">
        {filtered
          .sort((a, b) => (b.standings?.winPct || 0) - (a.standings?.winPct || 0))
          .map(team => (
            <div
              key={team.id}
              className="team-card"
              onClick={() => window.__openTeam?.(team.id)}
            >
              <img
                src={team.logo || `/api/logo/${team.abbreviation?.toLowerCase()}`}
                alt={team.name}
                className="team-card-logo"
                onError={e => { e.target.src = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><circle cx="28" cy="28" r="28" fill="%23f1f5f9"/><text x="28" y="33" text-anchor="middle" fill="%2394a3b8" font-size="14" font-weight="700">${team.abbreviation || '?'}</text></svg>`; }}
              />
              <div className="team-card-name">{team.name}</div>
              <div className="team-card-record">
                {team.standings
                  ? `${team.standings.wins}-${team.standings.losses}`
                  : '—'}
              </div>
              {team.standings && (
                <div className="text-xs text-muted" style={{ marginTop: 4 }}>
                  {team.standings.ppg?.toFixed(1)} PPG · {team.standings.diff > 0 ? '+' : ''}{team.standings.diff?.toFixed(1)} DIFF
                </div>
              )}
            </div>
          ))}
      </div>

      {filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <div className="empty-title">No teams found</div>
          <div className="empty-desc">Try a different search term</div>
        </div>
      )}
    </>
  );
}
