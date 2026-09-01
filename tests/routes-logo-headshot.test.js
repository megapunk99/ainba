/**
 * Tests for logo proxy route and headshot proxy route
 * 
 * Uses Express app.handle() to simulate HTTP requests without a real server.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';

// ── Helpers ─────────────────────────────────────────────────────
function createMockRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    _ended: false,
    _redirectUrl: null,
    status(code) { res._status = code; return res; },
    setHeader(k, v) { res._headers[k] = v; return res; },
    redirect(code, url) { res._redirectUrl = url; res._status = code; res._ended = true; return res; },
    send(body) { res._body = body; res._ended = true; return res; },
    json(body) { res._body = body; res._ended = true; return res; },
    end() { res._ended = true; return res; },
  };
  return res;
}

function handleRoute(app, path) {
  return new Promise((resolve) => {
    const res = createMockRes();
    const req = { params: {}, headers: {}, ...arguments[2] };
    const origEnd = res.end.bind(res);
    const origSend = res.send.bind(res);
    const origJson = res.json.bind(res);
    const origRedirect = res.redirect.bind(res);

    // Also wrap to capture on call
    const wrappedRes = Object.assign(res, {
      end() { res._ended = true; resolve(res); return res; },
      send(body) { res._body = body; res._ended = true; resolve(res); return res; },
      json(body) { res._body = body; res._ended = true; resolve(res); return res; },
      redirect(code, url) { res._redirectUrl = url; res._status = code; res._ended = true; resolve(res); return res; },
      status(code) { res._status = code; return wrappedRes; },
    });

    app.handle(
      { url: path, method: 'GET', params: {}, headers: {}, ...req },
      wrappedRes
    );

    // Safety timeout
    setTimeout(() => resolve(res), 100);
  });
}

// ── Logo Proxy Route ────────────────────────────────────────────
describe('Logo Proxy Route', () => {
  function buildLogoApp(logoCacheMap = {}) {
    const app = express();
    app.get('/api/logo/:slug', (req, res) => {
      const slug = req.params.slug.toLowerCase();
      const cached = logoCacheMap[slug];
      if (cached && cached.filePath) {
        res.setHeader('Content-Type', cached.contentType || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        res.setHeader('ETag', `"${slug}"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.send({ served: 'file', slug, filePath: cached.filePath });
      }
      const logoUrl = `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${slug}.png&h=120&w=120`;
      res.redirect(302, logoUrl);
    });
    return app;
  }

  it('serves cached logo with correct cache headers', async () => {
    const app = buildLogoApp({
      bos: { filePath: '/data/logos/bos.png', contentType: 'image/png' },
    });
    const res = await handleRoute(app, '/api/logo/bos');

    expect(res._headers['Content-Type']).toBe('image/png');
    expect(res._headers['Cache-Control']).toBe('public, max-age=604800, immutable');
    expect(res._headers['ETag']).toBe('"bos"');
    expect(res._ended).toBe(true);
  });

  it('sets ETag from slug for cache revalidation', async () => {
    const app = buildLogoApp({
      lal: { filePath: '/data/logos/lal.png', contentType: 'image/png' },
    });
    const res = await handleRoute(app, '/api/logo/lal');

    expect(res._headers['ETag']).toBe('"lal"');
  });

  it('normalizes slug to lowercase', async () => {
    const app = buildLogoApp({
      bos: { filePath: '/data/logos/bos.png', contentType: 'image/png' },
    });
    const res = await handleRoute(app, '/api/logo/BOS');

    // Should find 'bos' in cache via lowercase normalization
    expect(res._headers['Content-Type']).toBe('image/png');
  });

  it('redirects to ESPN CDN when logo is not cached', async () => {
    const app = buildLogoApp({});
    const res = await handleRoute(app, '/api/logo/atl');

    expect(res._redirectUrl).toContain('espncdn.com');
    expect(res._redirectUrl).toContain('atl.png');
    expect(res._status).toBe(302);
  });

  it('constructs correct ESPN CDN URL for fallback', async () => {
    const app = buildLogoApp({});
    const res = await handleRoute(app, '/api/logo/nyk');

    expect(res._redirectUrl).toBe(
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/nyk.png&h=120&w=120'
    );
  });

  it('serves with immutable cache header for cached logos', async () => {
    const app = buildLogoApp({
      okc: { filePath: '/data/logos/okc.png', contentType: 'image/png' },
    });
    const res = await handleRoute(app, '/api/logo/okc');

    expect(res._headers['Cache-Control']).toContain('immutable');
    expect(res._headers['Cache-Control']).toContain('max-age=604800');
  });

  it('sets X-Content-Type-Options for cached logos', async () => {
    const app = buildLogoApp({
      mia: { filePath: '/data/logos/mia.png', contentType: 'image/png' },
    });
    const res = await handleRoute(app, '/api/logo/mia');

    expect(res._headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves correct content type for non-png cached logos', async () => {
    const app = buildLogoApp({
      dal: { filePath: '/data/logos/dal.webp', contentType: 'image/webp' },
    });
    const res = await handleRoute(app, '/api/logo/dal');

    expect(res._headers['Content-Type']).toBe('image/webp');
  });
});

// ── Headshot Proxy Route ────────────────────────────────────────
describe('Headshot Proxy Route', () => {
  function buildHeadshotApp() {
    const app = express();
    app.get('/api/headshot/:id', (req, res) => {
      const playerId = req.params.id;
      if (!playerId || !/^\d+$/.test(playerId)) {
        return res.status(400).json({ error: 'Invalid player ID' });
      }
      const headshotUrl = `https://a.espncdn.com/i/headshots/nba/players/full/${playerId}.png`;
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.redirect(302, headshotUrl);
    });
    return app;
  }

  it('redirects to ESPN CDN for valid player ID', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/4066259');

    expect(res._status).toBe(302);
    expect(res._redirectUrl).toBe(
      'https://a.espncdn.com/i/headshots/nba/players/full/4066259.png'
    );
  });

  it('sets immutable cache headers', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/3032977');

    expect(res._headers['Cache-Control']).toBe('public, max-age=604800, immutable');
  });

  it('returns 400 for non-numeric player ID', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/abc123');

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid player ID' });
  });

  it('returns 400 for non-numeric player ID with letters', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/xyz789');

    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: 'Invalid player ID' });
  });

  it('handles very large numeric IDs', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/999999999999');

    expect(res._status).toBe(302);
    expect(res._redirectUrl).toContain('999999999999.png');
  });

  it('handles single digit player IDs', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/1');

    expect(res._status).toBe(302);
    expect(res._redirectUrl).toBe(
      'https://a.espncdn.com/i/headshots/nba/players/full/1.png'
    );
  });

  it('rejects IDs with special characters', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/123abc');

    expect(res._status).toBe(400);
  });

  it('rejects IDs with dots', async () => {
    const app = buildHeadshotApp();
    const res = await handleRoute(app, '/api/headshot/12.34');

    expect(res._status).toBe(400);
  });
});
