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
async function cachedFetch(url, cacheKey, ttl = 60000) {
  const cached = await cacheGet(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) return cached.data;
  const res = await fetch(url);
  const data = await res.json();
  await cacheSet(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Time Ago ──────────────────────────────────────────────
function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ─── Category Config ──────────────────────────────────────
const CATEGORIES = [
  { key: 'all', label: 'All', icon: '📰', color: 'var(--text-secondary)' },
  { key: 'trade', label: 'Trades', icon: '🔄', color: 'var(--red)' },
  { key: 'rumor', label: 'Rumors', icon: '🗣️', color: 'var(--orange)' },
  { key: 'injury', label: 'Injuries', icon: '🏥', color: 'var(--orange)' },
  { key: 'transaction', label: 'Moves', icon: '📋', color: 'var(--brand)' },
  { key: 'breaking', label: 'Breaking', icon: '🚨', color: 'var(--red)' },
  { key: 'analysis', label: 'Analysis', icon: '📊', color: 'var(--green)' },
  { key: 'game', label: 'Game', icon: '🏀', color: 'var(--brand)' },
  { key: 'news', label: 'General', icon: '📄', color: 'var(--text-tertiary)' },
];

const TRUSTED_SOURCES = [
  'ESPN', 'Yahoo Sports', 'Bleacher Report', 'The Athletic',
  'Sports Illustrated', 'NBA.com', 'USA Today', 'FOX Sports',
  'ClutchPoints', 'RotoWire', 'Hoops Rumors',
];

function isTrustedSource(source) {
  return TRUSTED_SOURCES.some(ts => source.toLowerCase().includes(ts.toLowerCase()));
}

// ─── Component ────────────────────────────────────────────
export default function News() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');

  const fetchNews = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const data = await cachedFetch('/api/news', 'news-feed', 60000);
      setArticles(data.articles || []);
      setLastUpdate(new Date());
    } catch (e) { console.error(e); }
    setLoading(false);
    if (manual) setRefreshing(false);
  }, []);

  useEffect(() => { fetchNews(); }, [fetchNews]);

  const refreshFromSources = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/news/refresh');
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const data = await cachedFetch('/api/news', 'news-feed', 0);
          if (data.total > 0 || attempts >= 15) {
            clearInterval(poll);
            setArticles(data.articles || []);
            setLastUpdate(new Date());
            setRefreshing(false);
          }
        } catch {}
      }, 2000);
      setTimeout(() => { clearInterval(poll); setRefreshing(false); }, 30000);
    } catch {
      setRefreshing(false);
    }
  }, []);

  const categoryCounts = useMemo(() => {
    const counts = { all: articles.length };
    articles.forEach(a => { counts[a.category] = (counts[a.category] || 0) + 1; });
    return counts;
  }, [articles]);

  const filtered = useMemo(() => {
    let list = articles;
    if (category !== 'all') list = list.filter(a => a.category === category);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        a.title?.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.source?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [articles, category, search]);

  const breakingNews = useMemo(() =>
    articles.filter(a => (a.category === 'breaking' || a.category === 'trade' || a.category === 'injury') && isTrustedSource(a.source)).slice(0, 5),
    [articles]
  );

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading news...</span></div>;

  return (
    <>
      {/* Stats */}
      <div className="stat-grid">
        <div className="stat-box">
          <span className="stat-value text-blue">{articles.length}</span>
          <span className="stat-label">Articles</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-red">{categoryCounts.trade || 0}</span>
          <span className="stat-label">Trades</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-orange">{categoryCounts.injury || 0}</span>
          <span className="stat-label">Injuries</span>
        </div>
        <div className="stat-box">
          <span className="stat-value text-purple">{categoryCounts.breaking || 0}</span>
          <span className="stat-label">Breaking</span>
        </div>
      </div>

      {/* Breaking News */}
      {breakingNews.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">
            <span className="card-title">🚨 Breaking & Important</span>
          </div>
          <div style={{ padding: 0 }}>
            {breakingNews.map((a, i) => (
              <div
                key={i}
                className="news-card"
                onClick={() => window.open(a.link, '_blank')}
                style={{ background: a.category === 'breaking' ? 'var(--red-light)' : 'transparent' }}
              >
                <div className="news-card-meta">
                  <span className={`badge ${a.category === 'trade' ? 'badge-danger' : a.category === 'injury' ? 'badge-warning' : 'badge-info'}`}>
                    {a.category?.toUpperCase()}
                  </span>
                  <span>{a.source}</span>
                  <span>{timeAgo(a.published)}</span>
                </div>
                <div className="news-card-title">{a.title?.replace(/ - [^-]+$/, '')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-between mb-4" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div className="filter-pills">
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              className={`filter-pill ${category === c.key ? 'active' : ''}`}
              onClick={() => setCategory(c.key)}
            >
              {c.icon} {c.label}
              {categoryCounts[c.key] > 0 && <span style={{ marginLeft: 4, opacity: 0.7 }}>{categoryCounts[c.key]}</span>}
            </button>
          ))}
        </div>
        <div className="flex gap-2" style={{ alignItems: 'center' }}>
          <input
            className="inp inp-sm"
            placeholder="🔍 Search..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 180 }}
          />
          <button className="btn btn-sm" onClick={refreshFromSources} disabled={refreshing}>
            {refreshing ? '⏳' : '🔄 Refresh'}
          </button>
        </div>
      </div>

      {/* News Feed */}
      <div className="card">
        <div className="card-header">
          <span>{filtered.length} Article{filtered.length !== 1 ? 's' : ''}</span>
          <span className="text-xs text-muted">
            {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString()}` : ''}
          </span>
        </div>
        <div style={{ maxHeight: 'calc(100vh - 300px)', overflowY: 'auto' }}>
          {filtered.map((article, i) => {
            const cat = CATEGORIES.find(c => c.key === article.category);
            const trusted = isTrustedSource(article.source);

            return (
              <div
                key={i}
                className="news-card"
                onClick={() => window.open(article.link, '_blank')}
              >
                <div className="news-card-meta">
                  {cat && (
                    <span className="badge" style={{ background: `${cat.color}10`, color: cat.color }}>
                      {cat.icon} {cat.label}
                    </span>
                  )}
                  {trusted && <span className="badge badge-success" style={{ fontSize: 10 }}>✓ Trusted</span>}
                  <span style={{ marginLeft: 'auto' }}>{article.source}</span>
                  <span>{timeAgo(article.published)}</span>
                </div>
                <div className="news-card-title">{article.title?.replace(/ - [^-]+$/, '')}</div>
                {article.description && (
                  <div className="news-card-excerpt">
                    {article.description.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 200)}
                  </div>
                )}
                {article.teams?.length > 0 && (
                  <div className="flex gap-2 mt-2" style={{ flexWrap: 'wrap' }}>
                    {article.teams.slice(0, 4).map(t => (
                      <span key={t} className="badge badge-info" style={{ fontSize: 10 }}>{t}</span>
                    ))}
                    {article.players?.slice(0, 3).map(p => (
                      <span key={p} className="badge badge-muted" style={{ fontSize: 10 }}>{p}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon">📰</div>
              <div className="empty-title">No articles found</div>
              <div className="empty-desc">Try changing the filters or search term</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
