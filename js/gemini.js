// ============================================================
// Gemini API client — REST trực tiếp (không cần SDK build)
// ============================================================
//
// Hai chế độ:
// 1. Proxy mode (default): gọi Cloudflare Worker (CONFIG.GEMINI_PROXY_URL),
//    Worker chèn key. Frontend không bao giờ chạm key.
// 2. Direct mode (override): nếu user nhập key trong Settings, gọi thẳng Google
//    với key đó (bỏ qua proxy).
//
// Body: { contents, systemInstruction, generationConfig }
import { CONFIG, hasGemini } from "./config.js";
import { buildSmcPrompt, buildQuickPrompt } from "./prompts.js";

const GOOGLE_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Trích JSON object từ text. Gemini hay wrap trong ```json...```
 */
function extractJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // Tìm khối ```json ... ```
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  // Tìm { ... } đầu/cuối
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

/**
 * Core call với retry + fallback model khi 503.
 * @param {string} model
 * @param {object} body
 * @param {object} opts - { maxRetries, fallbackModel }
 */
function buildGeminiUrl(model) {
  // Direct mode: user nhập key trong Settings → ưu tiên (override)
  const userKey = CONFIG.GEMINI_API_KEY;
  if (userKey) {
    return `${GOOGLE_BASE}/${model}:generateContent?key=${userKey}`;
  }
  // Proxy mode: gọi Worker, Worker chèn key
  if (CONFIG.GEMINI_PROXY_URL) {
    return `${CONFIG.GEMINI_PROXY_URL.replace(/\/$/, "")}/v1beta/models/${model}:generateContent`;
  }
  return null;
}

async function callGemini(model, body, { maxRetries = 3, fallbackModel = null } = {}) {
  const url = buildGeminiUrl(model);
  if (!url) throw new Error("no_gemini_key");
  let lastErr;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const errText = await r.text();
        const transient = r.status === 503 || r.status === 429 || errText.includes("UNAVAILABLE");
        if (transient && attempt < maxRetries - 1) {
          const delay = (2 ** attempt) * 1000 + Math.random() * 500;
          await new Promise(res => setTimeout(res, delay));
          continue;
        }
        // Lần cuối + có fallback model + transient → thử fallback
        if (transient && fallbackModel && model !== fallbackModel) {
          return callGemini(fallbackModel, body, { maxRetries: 1, fallbackModel: null });
        }
        throw new Error(`Gemini ${r.status}: ${errText.slice(0, 200)}`);
      }
      const data = await r.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return text;
    } catch (e) {
      lastErr = e;
      if (attempt === maxRetries - 1) break;
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Build generationConfig với thinking budget cho Gemini 2.5.
 */
function buildConfig({ jsonMode = true, maxTokens = 4096, temperature = 0.5, thinkingBudget = 512 }) {
  const cfg = {
    temperature,
    maxOutputTokens: maxTokens,
  };
  if (jsonMode) cfg.responseMimeType = "application/json";
  // thinkingBudget=0 disable thinking; >0 cap thinking tokens
  cfg.thinkingConfig = { thinkingBudget };
  return cfg;
}

/**
 * Phân tích SMC đầy đủ. Trả dict JSON đã parse hoặc {error}.
 * @param {string} newsBlock - tin tức đã format (từ news.formatNewsForPrompt)
 */
export async function analyzeSmc(latest, zones, candles, timeframe, crossCheck = null, newsBlock = "") {
  const { system, user } = buildSmcPrompt(latest, zones, candles, timeframe, crossCheck, newsBlock);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: buildConfig({ jsonMode: true, maxTokens: 4096, thinkingBudget: 2048 }),
  };
  try {
    const text = await callGemini(
      CONFIG.GEMINI_MODEL, body,
      { maxRetries: 3, fallbackModel: CONFIG.GEMINI_FALLBACK_MODEL }
    );
    if (!text || !text.trim()) {
      return { error: "Gemini trả response rỗng. Thử lại sau." };
    }
    const obj = extractJSON(text);
    if (!obj) {
      return { error: `Không trích được JSON từ response. Tail: …${text.slice(-200)}` };
    }
    return obj;
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
      return { error: "Hết quota Gemini free (10 req/phút hoặc 250K tokens/ngày). Đợi vài phút." };
    }
    if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      return { error: "Gemini server quá tải kéo dài. Thử lại sau." };
    }
    if (msg === "no_gemini_key") {
      return { error: "Chưa có Gemini API key. Bấm ⚙️ Settings ở góc trên để nhập." };
    }
    if (msg.includes("leaked") || msg.includes("reported as leaked")) {
      return { error: "Key này đã bị Google flag là 'leaked' (tìm thấy trên public repo). Tạo key mới: https://aistudio.google.com/app/apikey" };
    }
    if (msg.includes("API_KEY") || msg.includes("PERMISSION_DENIED") || msg.includes("403")) {
      return { error: "Gemini API key sai/bị restrict. Mở Settings nhập lại key, hoặc tạo key mới: https://aistudio.google.com/app/apikey" };
    }
    return { error: `Gemini error: ${msg}` };
  }
}

/**
 * Quick scan — text 3-5 dòng, tắt thinking cho nhanh.
 */
export async function quickScan(latest, zones) {
  const { system, user } = buildQuickPrompt(latest, zones);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: buildConfig({ jsonMode: false, maxTokens: 800, thinkingBudget: 0 }),
  };
  try {
    const text = await callGemini(
      CONFIG.GEMINI_MODEL, body,
      { maxRetries: 2, fallbackModel: CONFIG.GEMINI_FALLBACK_MODEL }
    );
    return text || "(rỗng)";
  } catch (e) {
    return `⚠️ Lỗi: ${e.message || e}`;
  }
}
