// ============================================================
// Data fetcher — Stooq primary (free, no key), TwelveData optional add-on
// ============================================================
import { CONFIG, hasTwelveData } from "./config.js";
import { fetchStooq, resample4h } from "./data-stooq.js";

const BASE = "https://api.twelvedata.com";

export const TF_TO_TD = {
  "5m":  "5min",
  "15m": "15min",
  "1h":  "1h",
  "4h":  "4h",
  "1d":  "1day",
};

/**
 * Spot price — chỉ TwelveData có endpoint spot.
 * Không có key → return null (không throw, để UI fallback dùng close của nến mới nhất).
 */
export async function fetchSpot() {
  if (!hasTwelveData()) return null;
  const url = `${BASE}/price?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&apikey=${CONFIG.TWELVEDATA_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TwelveData spot HTTP ${r.status}`);
  const data = await r.json();
  if (data.status === "error") throw new Error(`TwelveData: ${data.message}`);
  return parseFloat(data.price);
}

async function fetchTwelveData(tdInterval, outputsize = CONFIG.OUTPUT_SIZE) {
  if (!hasTwelveData()) throw new Error("no_twelvedata_key");
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
  if (data.status === "error") {
    // Special case: hết quota → throw quota_exceeded để fallback
    if (data.code === 429 || /credits|limit|exceeded/i.test(data.message || "")) {
      const e = new Error("quota_exceeded");
      e.detail = data.message;
      throw e;
    }
    throw new Error(`TwelveData ${tdInterval}: ${data.message}`);
  }
  if (!Array.isArray(data.values)) return [];
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
 * Fetch OHLCV — Stooq primary (free, no key).
 * 1. Thử Stooq trước (free, không cần key)
 * 2. Nếu fail (network / CORS / empty) VÀ có TwelveData key → fallback TwelveData
 *
 * @param {string} tf - '5m' | '15m' | '1h' | '4h' | '1d'
 * @returns {Promise<{candles, source}>}
 */
export async function fetchOHLCV(tf) {
  // Bước 1: thử Stooq (primary)
  try {
    let candles;
    if (tf === "4h") {
      // Stooq không có 4h native → resample từ 1h
      const candles1h = await fetchStooq("1h", 60);
      candles = resample4h(candles1h);
    } else {
      const days = tf === "1d" ? 365 : (tf === "1h" ? 60 : 7);
      candles = await fetchStooq(tf, days);
    }
    if (candles.length > 0) return { candles, source: "stooq" };
    throw new Error("Stooq trả empty");
  } catch (e) {
    console.warn(`Stooq fail for ${tf} (${e.message})${hasTwelveData() ? ", fallback TwelveData..." : ""}`);
    if (!hasTwelveData()) throw e;
  }

  // Bước 2: TwelveData fallback (chỉ chạy nếu user có key)
  const tdInterval = TF_TO_TD[tf];
  const candles = await fetchTwelveData(tdInterval);
  return { candles, source: "twelvedata" };
}
