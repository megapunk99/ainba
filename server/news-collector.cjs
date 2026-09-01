/**
 * SHARPEDGE News Collector v2.0
 * Multi-source NBA news: ESPN, Yahoo Sports, Google News (includes X/Twitter insider reports)
 * Sources: RSS feeds, APIs, Google News aggregation
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const DATA = path.join(__dirname, '..', 'data');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 12000,
    }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ─── RSS Parser ──────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      // Handle CDATA
      const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
      if (cdata) return cdata[1].trim();
      const m = block.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      description: get('description') || get('content:encoded'),
      author: get('dc:creator') || get('author'),
      link: get('link'),
      pubDate: get('pubDate'),
      guid: get('guid'),
      source: get('source'),
    });
  }
  return items;
}

// ─── Category Detection ──────────────────────────────────────────
function categorize(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (/\b(trade|traded|trading|deal|swap|acquire|acquired|land)\b/.test(text)) return 'trade';
  if (/\b(sign|signed|signing|free agent|contract|extension|join|joining|re-sign|commit)\b/.test(text)) return 'transaction';
  if (/\b(injur|out|doubtful|questionable|day-to-day|return|recover|surgery|ACL|knee|ankle|hamstring|calf|groin)\b/.test(text)) return 'injury';
  if (/\b(waive|waived|cut|release|released|assign|recall|buyout)\b/.test(text)) return 'transaction';
  if (/\b(draft|pick|lottery|combine|workout|prospect)\b/.test(text)) return 'draft';
  if (/\b(rumor|report|rumble|buzz|could|might|may|expected|target|pursuit|pursuing|monitoring)\b/.test(text)) return 'rumor';
  if (/\b(predict|forecast|rank|power|tier|best|worst|over|under|odds|bet|prop)\b/.test(text)) return 'analysis';
  if (/\b(playoff|finals|series|game|win|loss|score|highlight|recap|beat|defeat)\b/.test(text)) return 'game';
  if (/\b(coach|firing|hired|hire|staff|assistant|coach)\b/.test(text)) return 'coaching';
  if (/\b(breaking|announce|official|confirm|confirm)\b/.test(text)) return 'breaking';
  return 'news';
}

// ─── Team Mention Detection ──────────────────────────────────────
const TEAM_KEYWORDS = {
  ATL: ['hawks', 'atlanta'], BOS: ['celtics', 'boston'], BKN: ['nets', 'brooklyn'],
  CHA: ['hornets', 'charlotte'], CHI: ['bulls', 'chicago'], CLE: ['cavaliers', 'cleveland', 'cavs'],
  DAL: ['mavericks', 'dallas', 'mavs'], DEN: ['nuggets', 'denver'], DET: ['pistons', 'detroit'],
  GSW: ['warriors', 'golden state', 'steph curry'], HOU: ['rockets', 'houston'],
  IND: ['pacers', 'indiana'], LAC: ['clippers', 'la clippers'], LAL: ['lakers', 'la lakers', 'los angeles lakers'],
  MEM: ['grizzlies', 'memphis'], MIA: ['heat', 'miami'], MIL: ['bucks', 'milwaukee'],
  MIN: ['timberwolves', 'wolves', 'minnesota'], NOP: ['pelicans', 'new orleans', 'pels'],
  NYK: ['knicks', 'new york knicks'], OKC: ['thunder', 'oklahoma city'], ORL: ['magic', 'orlando'],
  PHI: ['76ers', 'sixers', 'philadelphia'], PHX: ['suns', 'phoenix'], POR: ['blazers', 'trail blazers', 'portland'],
  SAC: ['kings', 'sacramento'], SAS: ['spurs', 'san antonio'], TOR: ['raptors', 'toronto'],
  UTA: ['jazz', 'utah'], WAS: ['wizards', 'washington'],
};

function detectTeams(text) {
  const lower = text.toLowerCase();
  const teams = [];
  for (const [abbr, keywords] of Object.entries(TEAM_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) teams.push(abbr);
  }
  return teams;
}

// ─── Player Name Extraction ─────────────────────────────────────
function extractPlayers(text) {
  const patterns = [
    /(?:sources?:?\s+|report(?:s|edly)?:?\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    /(?:trade|traded|sign|signed|waive|waived|release|released|acquire|acquired)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
  ];
  const players = new Set();
  patterns.forEach(re => {
    let m;
    while ((m = re.exec(text)) !== null) players.add(m[1]);
  });
  return [...players];
}

// ─── Source: ESPN RSS ────────────────────────────────────────────
async function collectESPN() {
  const articles = [];
  try {
    const xml = await fetchUrl('https://www.espn.com/espn/rss/nba/news');
    const items = parseRSS(xml);
    for (const item of items) {
      if (!item.title || item.title.includes('www.espn.com') || item.title.length < 10) continue;
      const text = `${item.title} ${item.description}`;
      articles.push({
        id: `espn-${Buffer.from(item.title).toString('base64').slice(0, 20)}`,
        source: 'ESPN',
        title: item.title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        description: (item.description || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 500),
        author: item.author || 'ESPN',
        link: item.link,
        published: item.pubDate || new Date().toISOString(),
        category: categorize(item.title, item.description || ''),
        teams: detectTeams(text),
        players: extractPlayers(text),
      });
    }
  } catch (err) {
    console.log(`[news] ESPN RSS failed: ${err.message}`);
  }
  return articles;
}

// ─── Source: ESPN API ────────────────────────────────────────────
async function collectESPNAPI() {
  const articles = [];
  try {
    const data = await fetchUrl('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/news?limit=25');
    const json = JSON.parse(data);
    for (const item of (json.articles || [])) {
      const text = `${item.headline || ''} ${item.description || ''}`;
      articles.push({
        id: `espn-api-${item.id || Date.now()}`,
        source: 'ESPN',
        title: (item.headline || item.title || '').replace(/&amp;/g, '&'),
        description: (item.description || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 500),
        author: item.author?.name || 'ESPN',
        link: item.links?.[0]?.href || '',
        published: item.published || item.lastModified || new Date().toISOString(),
        category: categorize(item.headline || '', item.description || ''),
        teams: detectTeams(text),
        players: extractPlayers(text),
        image: item.images?.[0]?.url || '',
      });
    }
  } catch (err) {
    console.log(`[news] ESPN API failed: ${err.message}`);
  }
  return articles;
}

// ─── Source: Yahoo Sports RSS ────────────────────────────────────
async function collectYahoo() {
  const articles = [];
  try {
    const xml = await fetchUrl('https://sports.yahoo.com/nba/rss/');
    const items = parseRSS(xml);
    for (const item of items) {
      if (!item.title || item.title.length < 10) continue;
      const cleanTitle = item.title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&');
      const text = `${cleanTitle} ${item.description}`;
      articles.push({
        id: `yahoo-${Buffer.from(cleanTitle).toString('base64').slice(0, 20)}`,
        source: 'Yahoo Sports',
        title: cleanTitle,
        description: (item.description || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 500),
        author: item.author || item.source || 'Yahoo Sports',
        link: item.link,
        published: item.pubDate || new Date().toISOString(),
        category: categorize(cleanTitle, item.description || ''),
        teams: detectTeams(text),
        players: extractPlayers(text),
      });
    }
  } catch (err) {
    console.log(`[news] Yahoo RSS failed: ${err.message}`);
  }
  return articles;
}

// ─── Source: Google News (includes X/Twitter, Bleacher Report, etc.) ──
async function collectGoogleNews() {
  const articles = [];
  const queries = [
    'NBA trade OR breaking OR injury',
    'NBA betting OR odds OR prop',
    'NBA free agency OR signing OR contract',
    'NBA Woj OR Shams Charania OR Adrian Wojnarowski',
    'NBA injury report OR lineup OR rest',
    'NBA rumors OR buzz OR reports site:x.com OR site:twitter.com',
    'NBA Bleacher Report OR The Athletic OR CBS Sports',
  ];

  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:1d&hl=en-US&gl=US&ceid=US:en`;
      const xml = await fetchUrl(url);
      const items = parseRSS(xml);
      for (const item of items) {
        if (!item.title || item.title.length < 10) continue;
        const cleanTitle = item.title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const source = item.source || 'Google News';
        const text = `${cleanTitle} ${item.description || ''}`;

        // Detect if source is an X/Twitter account
        const isTwitter = /twitter|x\.com|@wojespn|@shamscharania|@adrianwojnarowski|@chrisbhaynes|@jonyej young/i.test(text + source);

        articles.push({
          id: `gnews-${Buffer.from(cleanTitle).toString('base64').slice(0, 20)}`,
          source: isTwitter ? `X/${source}` : source,
          title: cleanTitle,
          description: (item.description || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').slice(0, 500),
          author: isTwitter ? `@${source.replace(/\s+/g, '').toLowerCase()}` : source,
          link: item.link,
          published: item.pubDate || new Date().toISOString(),
          category: categorize(cleanTitle, item.description || ''),
          teams: detectTeams(text),
          players: extractPlayers(text),
          isTwitter,
        });
      }
    } catch (err) {
      console.log(`[news] Google News failed for "${q}": ${err.message}`);
    }
    // Small delay between queries
    await new Promise(r => setTimeout(r, 500));
  }
  return articles;
}

// ─── Main ────────────────────────────────────────────────────────
async function collectNews() {
  console.log('[news] Collecting NBA news from multiple sources...');
  const start = Date.now();

  const [espnArticles, espnAPIArticles, yahooArticles, googleArticles] = await Promise.all([
    collectESPN(),
    collectESPNAPI(),
    collectYahoo(),
    collectGoogleNews(),
  ]);

  console.log(`[news] ESPN RSS: ${espnArticles.length}, ESPN API: ${espnAPIArticles.length}, Yahoo: ${yahooArticles.length}, Google: ${googleArticles.length}`);

  // Merge and deduplicate by title similarity
  const seen = new Set();
  const all = [];
  [...googleArticles, ...yahooArticles, ...espnAPIArticles, ...espnArticles].forEach(a => {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 50);
    if (!seen.has(key) && key.length > 10) {
      seen.add(key);
      all.push(a);
    }
  });

  // Sort by date (newest first)
  all.sort((a, b) => new Date(b.published) - new Date(a.published));

  // Save
  const output = {
    collected: new Date().toISOString(),
    total: all.length,
    sources: [...new Set(all.map(a => a.source))],
    categories: all.reduce((acc, a) => { acc[a.category] = (acc[a.category] || 0) + 1; return acc; }, {}),
    articles: all,
  };

  fs.writeFileSync(path.join(DATA, 'news.json'), JSON.stringify(output, null, 2));

  const elapsed = Date.now() - start;
  console.log(`[news] Collected ${all.length} articles in ${elapsed}ms`);
  console.log(`[news] Sources: ${output.sources.join(', ')}`);
  console.log(`[news] Categories: ${JSON.stringify(output.categories)}`);

  return output;
}

module.exports = { collectNews };

if (require.main === module) {
  collectNews().catch(console.error);
}
