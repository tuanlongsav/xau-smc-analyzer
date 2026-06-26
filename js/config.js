// ============================================================
// CẤU HÌNH FRONTEND
// ============================================================
//
// Mọi API key (Gemini + TwelveData) giấu trong Cloudflare Worker secret.
// Frontend CHỈ biết Worker URL — không bao giờ tiếp xúc key trực tiếp.
//
// Worker proxy:
//   - /v1beta/models/{model}:generateContent → Gemini với rotation 5 keys
//   - /twelvedata/time_series, /twelvedata/price → TwelveData với rotation 3 keys
//   - Worker code: ./worker/src/index.js
//   - Set secrets: cd worker && wrangler secret put GEMINI_API_KEY_1
//     (rồi _2/_3/_4/_5, TWELVEDATA_API_KEY_1/_2/_3, TELEGRAM_*, FINNHUB_API_KEY)

export const CONFIG = {
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",

  // URL Cloudflare Worker proxy (giấu Gemini + TwelveData keys).
  GEMINI_PROXY_URL: "https://xau-gemini-proxy.tuanlong-sav.workers.dev",

  SYMBOL: "XAU/USD",
  OUTPUT_SIZE: 350,

  // Default TF khi mở app
  DEFAULT_TF: "15m",
};

// Có Gemini access — luôn true khi GEMINI_PROXY_URL được cấu hình.
// (Settings panel + user-key override đã bỏ; flow LUÔN qua Worker proxy.)
export function hasGemini() {
  return !!CONFIG.GEMINI_PROXY_URL;
}
