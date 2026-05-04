// ============================================================
// TwelveData API client — XAU/USD spot + OHLCV
// ============================================================
import { CONFIG } from "./config.js";

const BASE = "https://api.twelvedata.com";

/**
 * Fetch real-time spot price.
 * @returns {Promise<number>}
 */
export async function fetchSpot() {
  const url = `${BASE}/price?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&apikey=${CONFIG.TWELVEDATA_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TwelveData spot HTTP ${r.status}`);
  const data = await r.json();
  if (data.status === "error") throw new Error(`TwelveData: ${data.message}`);
  return parseFloat(data.price);
}

/**
 * Fetch OHLCV time series.
 * @param {string} tdInterval - '5min' | '15min' | '1h' | '4h' | '1day'
 * @param {number} outputsize - số nến (max 5000 free tier)
 * @returns {Promise<Array<{time, open, high, low, close, volume}>>}
 */
export async function fetchOHLCV(tdInterval, outputsize = CONFIG.OUTPUT_SIZE) {
  const params = new URLSearchParams({
    symbol: CONFIG.SYMBOL,
    interval: tdInterval,
    outputsize: String(outputsize),
    apikey: CONFIG.TWELVEDATA_API_KEY,
    format: "JSON",
    timezone: "UTC",
  });
  const r = await fetch(`${BASE}/time_series?${params}`);
  if (!r.ok) throw new Error(`TwelveData ${tdInterval} HTTP ${r.status}`);
  const data = await r.json();
  if (data.status === "error") throw new Error(`TwelveData ${tdInterval}: ${data.message}`);
  if (!Array.isArray(data.values)) return [];

  // TwelveData trả từ mới → cũ. Lightweight Charts cần cũ → mới.
  // Cũng convert datetime → Unix seconds.
  return data.values
    .map(v => ({
      time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0,
    }))
    .reverse();
}

/**
 * Bản đồ key UI → TwelveData interval.
 */
export const TF_TO_TD = {
  "5m":  "5min",
  "15m": "15min",
  "1h":  "1h",
  "4h":  "4h",
  "1d":  "1day",
};
