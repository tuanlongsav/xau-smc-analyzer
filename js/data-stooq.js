// ============================================================
// Stooq fallback — free, không cần API key
// ============================================================
// Stooq cung cấp CSV data cho XAUUSD:
// - Daily: https://stooq.com/q/d/l/?s=xauusd&i=d&f=YYYYMMDD&t=YYYYMMDD&n=1
// - Intraday: i=5,15,30,60,d (5min, 15min, 30min, 1hour, daily)
//
// Format CSV: Date,Time,Open,High,Low,Close,Volume
// CORS: Stooq cho phép cross-origin (verified)

const STOOQ_BASE = "https://stooq.com/q/d/l/";

// Map TF của ta → Stooq interval code
const STOOQ_INTERVAL = {
  "5m":  "5",
  "15m": "15",
  "30m": "30",
  "1h":  "60",
  "1d":  "d",
  // Stooq không có 4h native
};

function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Fetch OHLCV từ Stooq.
 * @param {string} tf - '5m' | '15m' | '1h' | '1d'
 * @param {number} days - lookback days
 */
export async function fetchStooq(tf, days = 30) {
  const interval = STOOQ_INTERVAL[tf];
  if (!interval) {
    throw new Error(`Stooq không hỗ trợ khung ${tf} (chỉ 5m/15m/30m/1h/1d)`);
  }

  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const params = new URLSearchParams({
    s: "xauusd",
    i: interval,
    f: fmtDate(from),
    t: fmtDate(now),
    n: "1",
  });

  const url = `${STOOQ_BASE}?${params}`;
  // Stooq trả CSV trực tiếp
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Stooq HTTP ${r.status}`);
  const text = await r.text();

  // Parse CSV
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error("Stooq trả không có data");
  }
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const dateIdx = headers.indexOf("date");
  const timeIdx = headers.indexOf("time");
  const openIdx = headers.indexOf("open");
  const highIdx = headers.indexOf("high");
  const lowIdx = headers.indexOf("low");
  const closeIdx = headers.indexOf("close");
  const volIdx = headers.indexOf("volume");

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",");
    if (row.length < 5) continue;
    const date = row[dateIdx];
    const time = timeIdx !== -1 ? row[timeIdx] : "00:00:00";
    const dt = new Date(`${date}T${time}Z`);
    if (isNaN(dt.getTime())) continue;
    out.push({
      time: Math.floor(dt.getTime() / 1000),
      open: parseFloat(row[openIdx]),
      high: parseFloat(row[highIdx]),
      low: parseFloat(row[lowIdx]),
      close: parseFloat(row[closeIdx]),
      volume: volIdx !== -1 ? parseFloat(row[volIdx] || 0) : 0,
    });
  }

  // Sort cũ → mới
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Resample 1h candles → 4h (Stooq không có 4h native).
 */
export function resample4h(candles1h) {
  const groups = {};
  for (const c of candles1h) {
    const d = new Date(c.time * 1000);
    const hourBucket = Math.floor(d.getUTCHours() / 4) * 4;
    const key = `${d.toISOString().slice(0, 10)}_${hourBucket}`;
    if (!groups[key]) {
      groups[key] = {
        time: Math.floor(Date.UTC(
          d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
          hourBucket, 0, 0
        ) / 1000),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
      };
    } else {
      const g = groups[key];
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
    }
  }
  return Object.values(groups).sort((a, b) => a.time - b.time);
}
