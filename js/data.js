// ============================================================
// Data fetcher — TwelveData via Cloudflare Worker proxy
// ============================================================
// Worker giấu TWELVEDATA_API_KEY. Frontend chỉ biết Worker URL.
// Endpoints:
//   GET ${WORKER}/twelvedata/time_series?symbol=XAU/USD&interval=15min&outputsize=1000
//   GET ${WORKER}/twelvedata/price?symbol=XAU/USD
import { CONFIG } from "./config.js";

export const TF_TO_TD = {
  "5m":  "5min",
  "15m": "15min",
  "1h":  "1h",
  "4h":  "4h",
  "1d":  "1day",
};

function workerBase() {
  const base = (CONFIG.GEMINI_PROXY_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error("Chưa cấu hình GEMINI_PROXY_URL trong config.js");
  }
  return base;
}

/**
 * Spot price — TwelveData /price qua Worker.
 * Fail thì return null (không throw, để UI fallback dùng close của nến mới nhất).
 */
export async function fetchSpot() {
  try {
    const url = `${workerBase()}/twelvedata/price?symbol=${encodeURIComponent(CONFIG.SYMBOL)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Spot proxy HTTP ${r.status}`);
    const data = await r.json();
    if (data.status === "error") throw new Error(`TwelveData: ${data.message}`);
    return parseFloat(data.price);
  } catch (e) {
    console.warn(`fetchSpot fail: ${e.message}`);
    return null;
  }
}

/**
 * Fetch OHLCV — TwelveData /time_series qua Worker.
 * @param {string} tf - '5m' | '15m' | '1h' | '4h' | '1d'
 * @returns {Promise<{candles, source}>}
 */
export async function fetchOHLCV(tf) {
  const tdInterval = TF_TO_TD[tf];
  if (!tdInterval) throw new Error(`Khung ${tf} không được hỗ trợ`);

  const params = new URLSearchParams({
    symbol: CONFIG.SYMBOL,
    interval: tdInterval,
    outputsize: String(CONFIG.OUTPUT_SIZE),
    format: "JSON",
    timezone: "UTC",
  });
  const url = `${workerBase()}/twelvedata/time_series?${params}`;

  const r = await fetch(url);
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`TD proxy HTTP ${r.status}: ${errText.slice(0, 120)}`);
  }
  const data = await r.json();

  if (data.status === "error") {
    if (data.code === 429 || /credits|limit|exceeded/i.test(data.message || "")) {
      throw new Error(`TwelveData hết quota (free 800/ngày, 8/phút): ${data.message}`);
    }
    throw new Error(`TwelveData: ${data.message}`);
  }
  if (!Array.isArray(data.values)) {
    throw new Error("TwelveData trả values rỗng");
  }

  const candles = data.values
    .map(v => ({
      time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume ? parseFloat(v.volume) : 0,
    }))
    .reverse();

  return { candles, source: "twelvedata" };
}
