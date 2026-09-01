import { useState, useEffect, useCallback, useMemo } from 'react';

// ─── Helpers ──────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Severity Colors ──────────────────────────────────────
const SEVERITY_COLORS = {
  HIGH: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
  MEDIUM: { bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
  LOW: { bg: '#f0f9ff', color: '#2563eb', border: '#bae6fd' },
};

const SIGNAL_ICONS = {
  INJURY: '🏥',
  TRADE: '🔄',
  SUSPENSION: '⛔',
  REST: '😴',
  RUMOR: '🗣️',
  SHARP: '⚡',
  LINE_MOVE: '📊',
  BREAKING: '🚨',
};

// ─── Main Component ────────────────────────────────────
export default function Alerts() {
  const [sharpSignals, setSharpSignals] = useState([]);
  const [injuries, setInjuries] = useState([]);
  const [newsSignals, setNewsSignals] = useState([]);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [lastUpdate, setLastUpdate] = useState(null);

  const fetchAll = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [sharpRes, injuryRes, newsRes, gamesRes] = await Promise.allSettled([
        fetch('/api/odds/sharp').then(r => r.json()),
        fetch('/api/injuries').then(r => r.json()),
        fetch('/api/news/signals').then(r => r.json()),
        fetch('/api/games').then(r => r.json()),
      ]);
      if (sharpRes.status === 'fulfilled') setSharpSignals(sharpRes.value.movements || []);
      if (injuryRes.status === 'fulfilled') setInjuries(injuryRes.value.injuries || []);
      if (newsRes.status === 'fulfilled') setNewsSignals(newsRes.value.signals || []);
      if (gamesRes.status === 'fulfilled') setGames(gamesRes.value.games || []);
      setLastUpdate(new Date());
    } catch (e) { console.error(e); }
    setLoading(false);
    if (manual) setRefreshing(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const t = setInterval(() => fetchAll(), 2 * 60 * 1000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const allAlerts = useMemo(() => {
    const alerts = [];

    // Sharp signals
    sharpSignals.forEach(s => {
      alerts.push({
        type: 'SHARP',
        severity: s.sharpScore >= 50 ? 'HIGH' : s.sharpScore >= 30 ? 'MEDIUM' : 'LOW',
        title: `Sharp Money — ${s.matchup || 'Unknown'}`,
        description: `${s.signal || 'SHARP'} signal detected. ML Gap: ${s.mlGap || 0}, Spread Gap: ${s.spreadGap || 0}, Total Gap: ${s.totalGap || 0}`,
        source: 'Line Scanner',
        icon: '⚡',
        timestamp: s.detected_at || new Date().toISOString(),
        details: s,
      });
    });

    // Critical injuries
    injuries.filter(i => i.status?.toLowerCase().includes('out') || i.status?.toLowerCase().includes('doubtful')).forEach(inj => {
      alerts.push({
        type: 'INJURY',
        severity: inj.status?.toLowerCase().includes('out') ? 'HIGH' : 'MEDIUM',
        title: `${inj.player} (${inj.team}) — ${inj.status}`,
        description: inj.detail || 'No details available',
        source: 'Injury Report',
        icon: '🏥',
        timestamp: new Date().toISOString(),
        details: inj,
      });
    });

    // News signals
    newsSignals.forEach(sig => {
      alerts.push({
        type: sig.type,
        severity: sig.severity,
        title: `${SIGNAL_ICONS[sig.type] || '📰'} ${sig.type}: ${sig.teams?.join(', ') || 'NBA'}`,
        description: sig.description || sig.headline || '',
        source: sig.source || 'News',
        icon: SIGNAL_ICONS[sig.type] || '📰',
        timestamp: sig.published || new Date().toISOString(),
        link: sig.link,
        details: sig,
      });
    });

    // Sort by severity then time
    const sevOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    alerts.sort((a, b) => (sevOrder[a.severity] || 2) - (sevOrder[b.severity] || 2));

    return alerts;
  }, [sharpSignals, injuries, newsSignals]);

  const filtered = useMemo(() => {
    if (activeTab === 'all') return allAlerts;
    if (activeTab === 'sharp') return allAlerts.filter(a => a.type === 'SHARP');
    if (activeTab === 'injury') return allAlerts.filter(a => a.type === 'INJURY');
    if (activeTab === 'news') return allAlerts.filter(a => ['TRADE', 'RUMOR', 'REST', 'SUSPENSION', 'BREAKING'].includes(a.type));
    return allAlerts;
  }, [allAlerts, activeTab]);

  const counts = useMemo(() => ({
    all: allAlerts.length,
    sharp: allAlerts.filter(a => a.type === 'SHARP').length,
    injury: allAlerts.filter(a => a.type === 'INJURY').length,
    news: allAlerts.filter(a => ['TRADE', 'RUMOR', 'REST', 'SUSPENSION', 'BREAKING'].includes(a.type)).length,
    high: allAlerts.filter(a => a.severity === 'HIGH').length,
  }), [allAlerts]);

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading alerts...</span></div>;

  return (
    <>
      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-value text-blue">{counts.all}</span>
          <span className="stat-label">Total Alerts</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-red">{counts.high}</span>
          <span className="stat-label">High Severity</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-purple">{counts.sharp}</span>
          <span className="stat-label">Sharp Signals</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-orange">{counts.injury}</span>
          <span className="stat-label">Injury Alerts</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-green">{counts.news}</span>
          <span className="stat-label">News Signals</span>
        </div>
      </div>

      {/* Tabs + Refresh */}
      <div className="flex flex-between mb-4" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="filter-pills">
          {[
            { key: 'all', label: 'All' },
            { key: 'sharp', label: '⚡ Sharp' },
            { key: 'injury', label: '🏥 Injury' },
            { key: 'news', label: '📰 News' },
          ].map(t => (
            <button key={t.key} className={`filter-pill ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label} ({counts[t.key] || 0})
            </button>
          ))}
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <button className="btn btn-sm" onClick={() => fetchAll(true)} disabled={refreshing}>{refreshing ? '⏳' : '↻ Refresh'}</button>
          {lastUpdate && <span className="text-xs text-muted">{lastUpdate.toLocaleTimeString()}</span>}
        </div>
      </div>

      {/* Alerts List */}
      <div className="card">
        <div className="card-header">
          <span>{filtered.length} Alert{filtered.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 350px)', overflowY: 'auto' }}>
          {filtered.map((alert, i) => {
            const sev = SEVERITY_COLORS[alert.severity] || SEVERITY_COLORS.LOW;
            return (
              <div key={i} style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--border-light)',
                borderLeft: `3px solid ${sev.color}`,
                background: i === 0 ? `${sev.bg}` : 'transparent',
                cursor: alert.link ? 'pointer' : 'default',
              }} onClick={() => alert.link && window.open(alert.link, '_blank')}>
                <div className="flex flex-between" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div className="flex gap-2" style={{ alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 16 }}>{alert.icon}</span>
                      <span className="fw-700" style={{ fontSize: 14 }}>{alert.title}</span>
                      <span className="badge" style={{
                        background: `${sev.color}15`, color: sev.color, fontSize: 9, fontWeight: 700,
                      }}>
                        {alert.severity}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, marginLeft: 28 }}>
                      {alert.description}
                    </div>
                    <div className="flex gap-3 mt-2" style={{ marginLeft: 28, fontSize: 11, color: 'var(--text-tertiary)' }}>
                      <span>Source: {alert.source}</span>
                      <span>{timeAgo(alert.timestamp)}</span>
                      {alert.link && <span style={{ color: 'var(--brand)' }}>↗ View</span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">🔔</div>
              <div className="empty-title">No alerts right now</div>
              <div className="empty-desc">Alerts appear when sharp money, injuries, or breaking news are detected</div>
            </div>
          )}
        </div>
      </div>

      {/* Games with Sharp Signals */}
      {sharpSignals.length > 0 && (
        <div className="card mt-4">
          <div className="card-header">
            <span className="card-title">⚡ Games with Sharp Signals</span>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Matchup</th>
                  <th className="text-center">Signal</th>
                  <th className="text-right">ML Gap</th>
                  <th className="text-right">Spread Gap</th>
                  <th className="text-right">Total Gap</th>
                  <th className="text-right">Score</th>
                </tr>
              </thead>
              <tbody>
                {sharpSignals.map((s, i) => (
                  <tr key={i} className="hl">
                    <td className="fw-600">{s.matchup || '—'}</td>
                    <td className="text-center">
                      <span className="badge badge-danger" style={{ fontSize: 10 }}>{s.signal || 'SHARP'}</span>
                    </td>
                    <td className="mono text-right">{s.mlGap || 0}</td>
                    <td className="mono text-right">{s.spreadGap || 0}</td>
                    <td className="mono text-right">{s.totalGap || 0}</td>
                    <td className="mono text-right fw-700" style={{ color: s.sharpScore >= 50 ? 'var(--red)' : 'var(--orange)' }}>
                      {s.sharpScore || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
