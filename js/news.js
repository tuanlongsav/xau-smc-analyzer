// ============================================================
// RSS news fetcher cho web app — qua rss2json proxy (CORS-friendly)
// ============================================================
// rss2json.com free: 10K req/ngày, không cần key
// Cache headlines vào localStorage 30 phút để giảm req

const FEEDS = [
  { source: "fxstreet",  url: "https://www.fxstreet.com/rss/news/gold" },
  { source: "investing", url: "https://www.investing.com/rss/news_25.rss" },
];

const PROXY = "https://api.rss2json.com/v1/api.json";
const CACHE_KEY = "xau_news_cache";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút

const GOLD_KEYWORDS = [
  "gold", "xau", "vàng", "bullion", "precious metal", "fed", "rates",
  "inflation", "cpi", "dxy", "dollar", "treasury", "yields",
];

function isGoldRelevant(title, summary) {
  const text = (title + " " + (summary || "")).toLowerCase();
  return GOLD_KEYWORDS.some(kw => text.includes(kw));
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchOne(source, url, count = 15) {
  const params = new URLSearchParams({ rss_url: url, count: String(count) });
  const r = await fetch(`${PROXY}?${params}`);
  if (!r.ok) throw new Error(`rss2json ${source} HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== "ok" || !Array.isArray(data.items)) return [];

  return data.items
    .map(it => ({
      ts: new Date(it.pubDate).toISOString(),
      source,
      title: (it.title || "").trim().slice(0, 300),
      summary: stripHtml(it.description || "").slice(0, 400),
      url: it.link || it.guid || "",
    }))
    .filter(it => {
      if (source === "investing" || source === "kitco") {
        return isGoldRelevant(it.title, it.summary);
      }
      return true;
    });
}

/**
 * Fetch all RSS feeds với cache. Trả mảng news items (mới → cũ).
 * @param {boolean} forceRefresh - bỏ qua cache
 */
export async function fetchNews(forceRefresh = false) {
  // Check cache
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS)) {
        return cached.items;
      }
    } catch {}
  }

  // Fetch song song
  const results = await Promise.allSettled(
    FEEDS.map(f => fetchOne(f.source, f.url))
  );
  const items = results.flatMap(r => r.status === "fulfilled" ? r.value : []);

  // Sort mới → cũ, dedupe theo URL
  const seen = new Set();
  const dedup = items
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .filter(it => {
      if (seen.has(it.url)) return false;
      seen.add(it.url);
      return true;
    });

  // Cache
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      fetchedAt: Date.now(),
      items: dedup,
    }));
  } catch {}

  return dedup;
}

/**
 * Format news cho prompt — string block.
 */
export function formatNewsForPrompt(news, max = 8) {
  if (!news || news.length === 0) return "";
  const lines = ["\n## TIN TỨC THỊ TRƯỜNG (24h gần nhất)"];
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = news.filter(it => new Date(it.ts).getTime() >= cutoff).slice(0, max);
  if (recent.length === 0) return "";
  for (const it of recent) {
    const ago = (Date.now() - new Date(it.ts).getTime()) / 3600000;
    const agoStr = ago >= 1 ? `${ago.toFixed(0)}h ago` : `${Math.round(ago * 60)}m ago`;
    let line = `- [${it.source}, ${agoStr}] ${it.title}`;
    if (it.summary && it.summary.length > 30) {
      line += ` — ${it.summary.slice(0, 200)}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
