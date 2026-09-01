import { useState, useEffect } from 'react';

/**
 * Enhanced Player Stats Component
 * Shows season averages, last 5/10 games, consistency, hit rates, and projections
 */
export default function PlayerStats({ playerId }) {
  const [profile, setProfile] = useState(null);
  const [projection, setProjection] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!playerId) return;
    setLoading(true);
    
    Promise.all([
      fetch(`/api/players/${playerId}/profile`).then(r => r.json()),
      fetch(`/api/players/${playerId}/projection/PTS`).then(r => r.json()),
    ]).then(([profileData, projData]) => {
      setProfile(profileData);
      setProjection(projData);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [playerId]);

  if (loading) return <div className="p-4 text-center text-gray-500">Loading player stats...</div>;
  if (!profile?.profile) return <div className="p-4 text-center text-gray-500">No stats available</div>;

  const { profile: p } = profile;

  return (
    <div className="space-y-4">
      {/* Season Averages */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="font-bold text-gray-900 mb-3">Season Averages</h3>
        <div className="grid grid-cols-6 gap-2 text-center">
          <StatBox label="PTS" value={p.seasonAvg.PTS} />
          <StatBox label="REB" value={p.seasonAvg.REB} />
          <StatBox label="AST" value={p.seasonAvg.AST} />
          <StatBox label="STL" value={p.seasonAvg.STL} />
          <StatBox label="BLK" value={p.seasonAvg.BLK} />
          <StatBox label="MIN" value={p.seasonAvg.MIN} />
        </div>
        <div className="text-xs text-gray-500 mt-2 text-center">
          {p.gamesPlayed} games played
        </div>
      </div>

      {/* Last 5/10/20 Games */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="font-bold text-gray-900 mb-3">Recent Form</h3>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">Last 5</div>
            <div className="grid grid-cols-3 gap-1">
              <MiniStat label="PTS" value={p.last5Avg.PTS} />
              <MiniStat label="REB" value={p.last5Avg.REB} />
              <MiniStat label="AST" value={p.last5Avg.AST} />
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">Last 10</div>
            <div className="grid grid-cols-3 gap-1">
              <MiniStat label="PTS" value={p.last10Avg.PTS} />
              <MiniStat label="REB" value={p.last10Avg.REB} />
              <MiniStat label="AST" value={p.last10Avg.AST} />
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500 mb-1">Last 20</div>
            <div className="grid grid-cols-3 gap-1">
              <MiniStat label="PTS" value={p.last20Avg.PTS} />
              <MiniStat label="REB" value={p.last20Avg.REB} />
              <MiniStat label="AST" value={p.last20Avg.AST} />
            </div>
          </div>
        </div>
      </div>

      {/* Consistency */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="font-bold text-gray-900 mb-3">Consistency (CV%)</h3>
        <div className="grid grid-cols-3 gap-4">
          <ConsistencyBar label="PTS" value={p.consistency.PTS} />
          <ConsistencyBar label="REB" value={p.consistency.REB} />
          <ConsistencyBar label="AST" value={p.consistency.AST} />
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Lower = more consistent (under 25% is very consistent)
        </div>
      </div>

      {/* Hit Rates */}
      <div className="bg-white rounded-lg border p-4">
        <h3 className="font-bold text-gray-900 mb-3">Hit Rates</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs font-medium text-gray-700 mb-2">Points</div>
            <div className="space-y-1">
              <HitRateLine label="Over 15 PTS" value={p.hitRates.over15pts} />
              <HitRateLine label="Over 20 PTS" value={p.hitRates.over20pts} />
              <HitRateLine label="Over 25 PTS" value={p.hitRates.over25pts} />
              <HitRateLine label="Over 30 PTS" value={p.hitRates.over30pts} />
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-gray-700 mb-2">Rebounds</div>
            <div className="space-y-1">
              <HitRateLine label="Over 5 REB" value={p.hitRates.over5reb} />
              <HitRateLine label="Over 8 REB" value={p.hitRates.over8reb} />
              <HitRateLine label="Over 10 REB" value={p.hitRates.over10reb} />
              <HitRateLine label="Over 12 REB" value={p.hitRates.over12reb} />
            </div>
          </div>
        </div>
      </div>

      {/* Projection */}
      {projection && (
        <div className="bg-blue-50 rounded-lg border border-blue-200 p-4">
          <h3 className="font-bold text-blue-900 mb-2">PTS Projection</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold text-blue-600">{projection.projection}</div>
              <div className="text-xs text-blue-700">Projected</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-gray-600">{projection.expectedLine}</div>
              <div className="text-xs text-gray-600">Expected Line</div>
            </div>
            <div>
              <div className={`text-lg font-bold ${projection.confidence === 'HIGH' ? 'text-green-600' : projection.confidence === 'MEDIUM' ? 'text-yellow-600' : 'text-red-600'}`}>
                {projection.confidence}
              </div>
              <div className="text-xs text-gray-600">Confidence</div>
            </div>
          </div>
          <div className="mt-3 text-xs text-blue-700">
            Season: {projection.breakdown.seasonAvg} | Last 5: {projection.breakdown.last5Avg} | Last 10: {projection.breakdown.last10Avg}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }) {
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-lg font-bold text-gray-900">{value || '-'}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="bg-gray-50 rounded p-1">
      <div className="text-sm font-semibold text-gray-900">{value || '-'}</div>
      <div className="text-[10px] text-gray-500">{label}</div>
    </div>
  );
}

function ConsistencyBar({ label, value }) {
  const percentage = Math.min(100, value || 0);
  const color = percentage < 25 ? 'bg-green-500' : percentage < 35 ? 'bg-yellow-500' : 'bg-red-500';
  
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="font-medium">{label}</span>
        <span className="text-gray-500">{value?.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function HitRateLine({ label, value }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-gray-600">{label}</span>
      <span className={`font-medium ${value >= 50 ? 'text-green-600' : value >= 30 ? 'text-yellow-600' : 'text-red-600'}`}>
        {value?.toFixed(1) || '0.0'}%
      </span>
    </div>
  );
}
