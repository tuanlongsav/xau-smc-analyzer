// ============================================================
// CẤU HÌNH
// ============================================================
//
// Mọi API key (Gemini + TwelveData) được giấu trong Cloudflare Worker secret.
// Frontend chỉ biết Worker URL — không tiếp xúc key.
//
// User vẫn có thể override Gemini bằng key cá nhân (Settings panel) — frontend
// sẽ gọi Google trực tiếp với key đó thay vì qua Worker.
//
// Local dev override: tạo js/config.local.js (đã .gitignore).

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

const _baseConfig = {
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",

  // URL Cloudflare Worker proxy (giấu Gemini + TwelveData keys).
  // Worker code: ./worker/src/index.js
  // Set keys: cd worker && wrangler secret put GEMINI_API_KEY_1 (và _2/_3/_4/_5, TWELVEDATA_API_KEY)
  GEMINI_PROXY_URL: "https://xau-gemini-proxy.tuanlong-sav.workers.dev",

  SYMBOL: "XAU/USD",
  OUTPUT_SIZE: 1000,

  // Default TF khi mở app
  DEFAULT_TF: "15m",
};

// Proxy để đọc Gemini override key từ localStorage
export const CONFIG = new Proxy(_baseConfig, {
  get(target, prop) {
    if (prop === "GEMINI_API_KEY") return loadKeys().gemini || "";
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

// Có Gemini access (Worker proxy hoặc user override)
export function hasGemini() {
  return !!loadKeys().gemini || !!_baseConfig.GEMINI_PROXY_URL;
}
