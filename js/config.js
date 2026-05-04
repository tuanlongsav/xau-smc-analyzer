// ============================================================
// CẤU HÌNH — Dynamic từ localStorage, fallback empty
// ============================================================
//
// ⚠️ KHÔNG hardcode API key trong file này khi push lên GitHub!
// Google quét public repo và tự động disable key dù có HTTP referrer.
//
// User-input pattern:
// - User nhập key trong Settings panel (UI) → lưu localStorage
// - Mỗi user dùng key riêng, an toàn
// - Repo public không chứa key
//
// Để override default cho local dev: tạo file js/config.local.js (đã .gitignore)
// và import nó từ index.html (thêm <script type="module" src="js/config.local.js">)

const LS_KEY = "xau_api_keys";

function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveKeys(keys) {
  localStorage.setItem(LS_KEY, JSON.stringify(keys));
}

// CONFIG là một Proxy: đọc lấy giá trị live từ localStorage
const _baseConfig = {
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",

  // URL của Cloudflare Worker proxy (giấu Gemini key).
  // Worker code: ./worker/src/index.js. Set key: cd worker && wrangler secret put GEMINI_API_KEY
  GEMINI_PROXY_URL: "https://xau-gemini-proxy.tuanlong-sav.workers.dev",

  SYMBOL: "XAU/USD",
  OUTPUT_SIZE: 1000,

  // Map TwelveData interval → key chuẩn nội bộ
  INTERVALS: {
    "5min":  "5m",
    "15min": "15m",
    "1h":    "1h",
    "4h":    "4h",
    "1day":  "1d",
  },

  // Default TF khi mở app
  DEFAULT_TF: "15m",

  // Data source priority: 'stooq' (chính, free no-key), 'twelvedata' (optional, fallback khi Stooq lỗi)
  DATA_SOURCES: ["stooq", "twelvedata"],
};

export const CONFIG = new Proxy(_baseConfig, {
  get(target, prop) {
    if (prop === "GEMINI_API_KEY") return loadKeys().gemini || "";
    if (prop === "TWELVEDATA_API_KEY") return loadKeys().twelvedata || "";
    return target[prop];
  },
});

export function setApiKey(name, value) {
  const keys = loadKeys();
  if (value && value.trim()) {
    keys[name] = value.trim();
  } else {
    delete keys[name];
  }
  saveKeys(keys);
}

export function getApiKey(name) {
  return loadKeys()[name] || "";
}

export function hasGemini() {
  return !!loadKeys().gemini || !!_baseConfig.GEMINI_PROXY_URL;
}

export function hasGeminiProxy() {
  return !!_baseConfig.GEMINI_PROXY_URL;
}

export function hasTwelveData() {
  return !!loadKeys().twelvedata;
}
