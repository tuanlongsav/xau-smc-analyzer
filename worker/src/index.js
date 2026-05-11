// ============================================================
// Gemini API proxy — Cloudflare Worker
// ============================================================
//
// Mục đích: giữ Gemini API keys trong Worker secret, frontend không bao giờ chạm vào key.
// Frontend gọi `${WORKER_URL}/v1beta/models/{model}:generateContent` (mirror path Google),
// Worker chèn `?key=...` rồi forward sang generativelanguage.googleapis.com.
//
// Set key: wrangler secret put GEMINI_API_KEY_1 (rồi _2, _3, _4, _5 cho rotation).

const GOOGLE_BASE = "https://generativelanguage.googleapis.com";

// Origin nào được phép gọi (CORS). Browser sẽ enforce, curl thì không.
function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Cloudflare Pages
  if (origin === "https://xau-smc-analyzer.pages.dev") return true;
  // Cloudflare Pages preview branches: <hash>.xau-smc-analyzer.pages.dev
  if (/^https:\/\/[a-z0-9-]+\.xau-smc-analyzer\.pages\.dev$/.test(origin)) return true;
  // GitHub Pages: https://tuanlongsav.github.io (path /xau-smc-analyzer/ không thuộc origin)
  if (origin === "https://tuanlongsav.github.io") return true;
  // Local dev
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin : "https://xau-smc-analyzer.pages.dev";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(status, obj, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

/**
 * Gom các Gemini key có cấu hình thành mảng theo thứ tự ưu tiên.
 * Tên chuẩn duy nhất: GEMINI_API_KEY_1..5
 */
function collectGeminiKeys(env) {
  const slots = [
    { name: "GEMINI_API_KEY_1", label: "key_1" },
    { name: "GEMINI_API_KEY_2", label: "key_2" },
    { name: "GEMINI_API_KEY_3", label: "key_3" },
    { name: "GEMINI_API_KEY_4", label: "key_4" },
    { name: "GEMINI_API_KEY_5", label: "key_5" },
  ];
  return slots
    .map(s => ({ key: env[s.name], label: s.label, source: s.name }))
    .filter(s => !!s.key);
}

// ──────────────────────────────────────────────────────────
// Smart rotation: track key state per Worker isolate
// 429 (rate limit/quota) → cooldown 60s
// 400/500/etc → cooldown 2 phút (có thể do Worker DC hiện tại không support;
//   sau 2 phút DC có thể đã đổi → retry)
// 200 success → reset state
// ──────────────────────────────────────────────────────────
const keyState = new Map();
const COOLDOWN_429_MS  = 60_000;
const COOLDOWN_OTHER_MS = 120_000;

function isKeyOnCooldown(label) {
  const s = keyState.get(label);
  return s && Date.now() < s.until;
}

function markKeyCooldown(label, status) {
  const dur = status === 429 ? COOLDOWN_429_MS : COOLDOWN_OTHER_MS;
  keyState.set(label, { until: Date.now() + dur, lastStatus: status });
}

function clearKeyCooldown(label) {
  keyState.delete(label);
}

// ──────────────────────────────────────────────────────────
// TwelveData multi-key rotation
// Tên chuẩn: TWELVEDATA_API_KEY_1..3. Legacy single TWELVEDATA_API_KEY
// vẫn được nhận (treat như slot bổ sung) để rolling deploy không downtime.
// ──────────────────────────────────────────────────────────
function collectTdKeys(env) {
  const slots = [
    { name: "TWELVEDATA_API_KEY_1", label: "td_1" },
    { name: "TWELVEDATA_API_KEY_2", label: "td_2" },
    { name: "TWELVEDATA_API_KEY_3", label: "td_3" },
  ];
  const keys = slots
    .map(s => ({ key: env[s.name], label: s.label, source: s.name }))
    .filter(s => !!s.key);
  // Legacy fallback — bỏ sau khi migrate xong
  if (env.TWELVEDATA_API_KEY) {
    const dup = keys.some(k => k.key === env.TWELVEDATA_API_KEY);
    if (!dup) keys.push({ key: env.TWELVEDATA_API_KEY, label: "td_legacy", source: "TWELVEDATA_API_KEY" });
  }
  return keys;
}

function hasAnyTdKey(env) {
  return collectTdKeys(env).length > 0;
}

// In-memory cooldown (per Worker isolate, mất khi cold-start nhưng OK).
//   daily quota → cooldown đến 00:01 UTC hôm sau (TD reset theo UTC).
//   per-minute rate limit → 60s.
//   network/HTTP error khác → 120s.
const tdKeyState = new Map();

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0, 0
  ));
  return next.getTime() - now.getTime();
}

function isTdKeyOnCooldown(label) {
  const s = tdKeyState.get(label);
  return s && Date.now() < s.until;
}

function markTdCooldown(label, kind, message) {
  let dur;
  if (kind === "daily") dur = msUntilNextUtcMidnight();
  else if (kind === "rate_limit") dur = 60_000;
  else dur = 120_000;
  tdKeyState.set(label, { until: Date.now() + dur, kind, message: (message || "").slice(0, 120) });
}

function clearTdCooldown(label) {
  tdKeyState.delete(label);
}

function classifyTdError(httpStatus, jsonBody) {
  const msg = ((jsonBody && jsonBody.message) || "").toString().toLowerCase();
  if (msg.includes("for the day") || msg.includes("daily limit") || msg.includes("daily quota")) {
    return { kind: "daily", message: jsonBody.message };
  }
  if (httpStatus === 429 || msg.includes("per minute") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return { kind: "rate_limit", message: jsonBody?.message || `HTTP ${httpStatus}` };
  }
  return { kind: "other", message: jsonBody?.message || `HTTP ${httpStatus}` };
}

/**
 * Gọi TwelveData với rotation. Trả về { ok, json, status, headers, attempts, lastError }.
 * - ok=true: ít nhất 1 key thành công, json là body parse được.
 * - ok=false: tất cả keys đều fail (cooldown hoặc lỗi). attempts list từng key đã thử.
 * Cache CF edge 30s vẫn giữ (URL chứa apikey nên cache khác nhau theo key — chấp nhận).
 */
async function tdFetch(env, path, paramsObj) {
  const keys = collectTdKeys(env);
  if (keys.length === 0) {
    return { ok: false, json: null, status: 0, attempts: [], lastError: "Không có TWELVEDATA_API_KEY nào được cấu hình" };
  }
  const attempts = [];
  let firstError = null;
  for (const k of keys) {
    if (isTdKeyOnCooldown(k.label)) {
      const s = tdKeyState.get(k.label);
      attempts.push({ label: k.label, skipped: `cooldown ${s.kind}` });
      continue;
    }
    const fwd = new URLSearchParams(paramsObj);
    fwd.set("apikey", k.key);
    const url = `https://api.twelvedata.com${path}?${fwd}`;
    let resp;
    try {
      resp = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 30 } });
    } catch (e) {
      markTdCooldown(k.label, "other", `fetch fail: ${e.message}`);
      attempts.push({ label: k.label, error: `fetch fail: ${e.message}` });
      if (!firstError) firstError = e.message;
      continue;
    }
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    // TD trả 200 với body {status:"error"} cho daily quota — phải parse body để biết.
    const isErr = !resp.ok || (json && json.status === "error");
    if (!isErr) {
      clearTdCooldown(k.label);
      return { ok: true, json, text, status: resp.status, headers: resp.headers, label: k.label, attempts };
    }
    const cls = classifyTdError(resp.status, json);
    markTdCooldown(k.label, cls.kind, cls.message);
    attempts.push({ label: k.label, kind: cls.kind, error: cls.message });
    if (!firstError) firstError = cls.message;
  }
  return { ok: false, json: null, status: 0, attempts, lastError: firstError || "Tất cả TD keys đều cooldown" };
}

// ──────────────────────────────────────────────────────────
// KV cache helpers
// ──────────────────────────────────────────────────────────
const CACHE_TTL_S = 300; // 5 phút

async function hashBody(body) {
  const data = new TextEncoder().encode(body);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

async function cacheGet(env, key) {
  if (!env.CACHE) return null;
  try { return await env.CACHE.get(key); } catch { return null; }
}

async function cachePut(env, key, value) {
  if (!env.CACHE) return;
  try { await env.CACHE.put(key, value, { expirationTtl: CACHE_TTL_S }); } catch {}
}

// ──────────────────────────────────────────────────────────
// Workers AI fallback (Llama 3.3 70B)
// Chạy khi tất cả Gemini keys fail. Convert format Gemini ↔ AI.
// ──────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────
// Indicators (port từ js/indicators.js, minimal subset cần cho alert)
// ──────────────────────────────────────────────────────────
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = (prev * (period - 1) + values[i]) / period;
    }
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const gains = [], losses = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { gains.push(0); losses.push(0); continue; }
    const d = closes[i] - closes[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  const ag = wilder(gains, period);
  const al = wilder(losses, period);
  return closes.map((_, i) => {
    if (ag[i] === null || al[i] === null) return null;
    if (al[i] === 0) return 100;
    return 100 - 100 / (1 + ag[i] / al[i]);
  });
}

function bollinger(closes, period = 20, mult = 2) {
  const u = new Array(closes.length).fill(null);
  const l = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const sl = closes.slice(i - period + 1, i + 1);
    const m = sl.reduce((a, b) => a + b, 0) / period;
    const v = sl.reduce((a, b) => a + (b - m) ** 2, 0) / period;
    const sd = Math.sqrt(v);
    u[i] = m + mult * sd;
    l[i] = m - mult * sd;
  }
  return { upper: u, lower: l };
}

function atr(highs, lows, closes, period = 14) {
  const trs = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  });
  return wilder(trs, period);
}

function rollingMax(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    return Math.max(...values.slice(i - period + 1, i + 1));
  });
}
function rollingMin(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    return Math.min(...values.slice(i - period + 1, i + 1));
  });
}

function enrichIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes, 14);
  const { upper: bu, lower: bl } = bollinger(closes, 20, 2);
  const atr14 = atr(highs, lows, closes, 14);
  const rh50 = rollingMax(highs, 50);
  const rl50 = rollingMin(lows, 50);
  return candles.map((c, i) => ({
    ...c,
    ema21: e21[i], ema50: e50[i], ema200: e200[i],
    sma50: s50[i], sma200: s200[i],
    rsi: r14[i],
    bbUpper: bu[i], bbLower: bl[i],
    atr: atr14[i],
    recentHigh: rh50[i],
    recentLow: rl50[i],
  }));
}

function computePivots(candle) {
  if (!candle) return null;
  const H = candle.high, L = candle.low, C = candle.close;
  const PP = (H + L + C) / 3;
  const range = H - L;
  return {
    pp: PP,
    r1: 2 * PP - L, r2: PP + range,
    s1: 2 * PP - H, s2: PP - range,
  };
}

/**
 * Phiên giao dịch hiện tại theo UTC.
 * Trả về {code, name, volMult} — volMult dùng để adjust threshold cảnh báo:
 *  - <1.0: nới ngưỡng (nhạy hơn) vì phiên đang ở giai đoạn vol cao thật
 *  - >1.0: siết ngưỡng (bớt noise) vì phiên đang ở giai đoạn vol thấp
 * Ý tưởng: dùng cùng "% di chuyển bình thường của phiên" làm baseline,
 * cảnh báo chỉ kêu khi vượt baseline → giảm false positive phiên Á + tăng nhạy phiên NY.
 */
function getSessionInfo(date) {
  const h = (date || new Date()).getUTCHours();
  if (h >= 0 && h < 7)   return { code: "asia",        name: "Á (biến động thấp, thường đi ngang)",        volMult: 1.25 };
  if (h >= 7 && h < 8)   return { code: "asia_eu",     name: "giao thoa Á-Âu (biến động bắt đầu tăng)",     volMult: 1.10 };
  if (h >= 8 && h < 13)  return { code: "europe",      name: "Âu (biến động tăng, có xu hướng rõ)",         volMult: 1.00 };
  if (h >= 13 && h < 16) return { code: "eu_ny",       name: "giao thoa Âu-Mỹ (biến động cao nhất)",        volMult: 0.80 };
  if (h >= 16 && h < 21) return { code: "ny",          name: "Mỹ (biến động cao, hay có đảo chiều)",        volMult: 0.85 };
  return { code: "after_hours", name: "ngoài giờ chính (thanh khoản thấp)", volMult: 1.15 };
}

// Backward-compat — các nơi dùng getTradingSession() chỉ cần chuỗi tên.
function getTradingSession() {
  return getSessionInfo().name;
}

/**
 * Phát hiện pattern nến — Pin bar / Engulfing / Doji / Marubozu.
 */
function detectCandlePattern(latest, prev) {
  const o = latest.open, c = latest.close, h = latest.high, l = latest.low;
  const body = Math.abs(c - o);
  const range = h - l;
  if (range === 0) return "Doji không biên độ";
  const bodyRatio = body / range;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const upperRatio = upperWick / range;
  const lowerRatio = lowerWick / range;

  if (bodyRatio < 0.3 && lowerRatio > 0.6)
    return "Pin bar đáy (Hammer) — râu dưới dài, báo hiệu đảo chiều TĂNG";
  if (bodyRatio < 0.3 && upperRatio > 0.6)
    return "Pin bar đỉnh (Shooting Star) — râu trên dài, báo hiệu đảo chiều GIẢM";
  if (bodyRatio < 0.1) return "Doji — phe mua bán cân bằng, do dự";

  if (prev) {
    const prevBody = Math.abs(prev.close - prev.open);
    const prevBullish = prev.close > prev.open;
    const currBullish = c > o;
    if (!prevBullish && currBullish && body > prevBody && o <= prev.close && c >= prev.open)
      return "Bullish Engulfing (nến nhấn chìm tăng) — đảo chiều TĂNG mạnh";
    if (prevBullish && !currBullish && body > prevBody && o >= prev.close && c <= prev.open)
      return "Bearish Engulfing (nến nhấn chìm giảm) — đảo chiều GIẢM mạnh";
  }
  if (bodyRatio > 0.7) {
    return c > o ? "Marubozu tăng (nến đặc) — momentum phe MUA mạnh" : "Marubozu giảm (nến đặc) — momentum phe BÁN mạnh";
  }
  return c > o ? "Nến tăng bình thường" : "Nến giảm bình thường";
}

/**
 * HTF trend (4h + 1d) — cached 1h, dùng cho LTF analysis cần context lớn.
 */
async function getHTFContext(env) {
  const cacheKey = `htf_trend:${new Date().toISOString().slice(0, 13)}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch {} }
  }
  try {
    const [c4h, c1d] = await Promise.all([
      fetchTdCandles(env, "4h", 220),
      fetchTdCandles(env, "1day", 220),
    ]);
    const trendOf = (candles) => {
      if (!candles || candles.length < 50) return "chưa rõ";
      const e = enrichIndicators(candles);
      const last = e[e.length - 1];
      if (last.close > last.ema200 && last.ema21 > last.ema50 && last.ema50 > last.ema200) return "Tăng mạnh (Strong Bullish)";
      if (last.close > last.ema50 && last.close > last.ema200) return "Tăng giá (Bullish)";
      if (last.close < last.ema200 && last.ema21 < last.ema50 && last.ema50 < last.ema200) return "Giảm mạnh (Strong Bearish)";
      if (last.close < last.ema50 && last.close < last.ema200) return "Giảm giá (Bearish)";
      return "Đi ngang (Sideways)";
    };
    const result = { trend4h: trendOf(c4h), trend1d: trendOf(c1d) };
    if (env.CACHE) {
      await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
    }
    return result;
  } catch (e) {
    console.log(`[htf-context] fail: ${e.message}`);
    return null;
  }
}

/**
 * Lấy daily pivots — cache KV theo ngày UTC, auto-rotate khi qua nửa đêm.
 * Tiết kiệm TwelveData calls (yesterday's daily candle ổn định trong ngày).
 *
 * Cron 5p × 288 runs/ngày × 0 TD daily fetch (cache hit) = chỉ 1 TD daily/ngày.
 */
async function getCachedDailyPivots(env) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // "20260105"
  const cacheKey = `daily_pivots:${today}`;

  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch {}
    }
  }

  // Cache miss → fetch và lưu
  try {
    const c1d = await fetchTdCandles(env, "1day", 5);
    if (c1d.length < 2) return null;
    const pivots = computePivots(c1d[c1d.length - 2]);
    if (pivots && env.CACHE) {
      // TTL 2 ngày — key tự rotate theo date nên không lo leak
      await env.CACHE.put(cacheKey, JSON.stringify(pivots), { expirationTtl: 172800 });
    }
    return pivots;
  } catch (e) {
    console.log(`[pivots] daily fetch fail: ${e.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────
// TwelveData fetch (cron + aux context — đi qua tdFetch để được rotation)
// ──────────────────────────────────────────────────────────
async function fetchTdCandles(env, interval, outputsize, symbol = "XAU/USD") {
  const result = await tdFetch(env, "/time_series", { symbol, interval, outputsize });
  if (!result.ok) {
    throw new Error(`TD ${symbol}: ${result.lastError}`);
  }
  const d = result.json;
  if (!Array.isArray(d.values)) return [];
  return d.values.reverse().map(v => ({
    time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

/**
 * Lấy context inter-market (DXY, WTI Oil) — cache 5 phút trong KV.
 * XAU correlation:
 * - DXY: nghịch (~-0.7) — DXY tăng → áp lực giảm XAU
 * - OIL: đồng pha — cả 2 hedge inflation, OIL tăng = bullish XAU
 */
async function getCachedAuxData(env, symbol, label, interval = "1h") {
  const bucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const cacheKey = `aux:${symbol}:${interval}:${bucket}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch {} }
  }
  try {
    const candles = await fetchTdCandles(env, interval, 220, symbol);
    if (candles.length < 20) return null;
    const enriched = enrichIndicators(candles);
    const last = enriched[enriched.length - 1];

    // % change qua khoảng thời gian phù hợp TF (gần đúng 24h)
    const ms24h = 24 * 60 * 60 * 1000;
    const targetTime = (Date.now() - ms24h) / 1000;
    const prev24h = candles.find(c => c.time >= targetTime) || candles[0];
    const pct24h = ((last.close - prev24h.close) / prev24h.close) * 100;

    // % change theo TF (so với candle thứ 5 trước — fresh trend chính khung user xem)
    const candlesAgo = Math.min(5, candles.length - 1);
    const prevTf = candles[candles.length - 1 - candlesAgo];
    const pctTf = ((last.close - prevTf.close) / prevTf.close) * 100;

    const trend = getTrendAssessment(last);
    const result = {
      symbol, label, interval,
      price: last.close,
      pct24h,
      pctTf,
      candlesAgo,
      trendLabel: trend?.label || "?",
      trendEmoji: trend?.emoji || "❓",
    };
    if (env.CACHE) {
      await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 });
    }
    return result;
  } catch (e) {
    console.log(`[aux] ${symbol}@${interval} fail: ${e.message}`);
    return null;
  }
}

/**
 * Parse args sau lệnh chính tìm "oil" / "dxy" / "all".
 * Returns { wantsOil, wantsDxy }
 */
function parseAuxArgs(args) {
  const tokens = (args || []).map(a => String(a).toLowerCase());
  const all = tokens.includes("all") || tokens.includes("inter");
  return {
    wantsOil: all || tokens.includes("oil") || tokens.includes("wti"),
    wantsDxy: all || tokens.includes("dxy") || tokens.includes("dx") || tokens.includes("usd"),
  };
}

/**
 * Format aux context block (text plain) cho prompt AI hoặc pulse display.
 */
function formatAuxBlock(auxCtx) {
  if (!auxCtx) return "";
  const fmtPct = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
  const lines = [];
  if (auxCtx.oil) {
    const o = auxCtx.oil;
    lines.push(`🛢️ Dầu (USO ETF, ${o.interval}): ${o.trendEmoji} ${o.trendLabel} | ${o.candlesAgo} nến gần: ${fmtPct(o.pctTf)} | 24h: ${fmtPct(o.pct24h)}`);
  }
  if (auxCtx.dxy) {
    const x = auxCtx.dxy;
    lines.push(`💵 USD Index (EUR/USD inverse, ${x.interval}): ${x.trendEmoji} ${x.trendLabel} | DXY ${x.candlesAgo} nến gần: ≈${fmtPct(x.pctTf)} | 24h: ≈${fmtPct(x.pct24h)}`);
  }
  return lines.join("\n");
}

/**
 * Get aux context cho query — fetch nếu user yêu cầu oil/dxy.
 */
async function getAuxContext(env, args, tf = "1h") {
  const { wantsOil, wantsDxy } = parseAuxArgs(args);
  if (!wantsOil && !wantsDxy) return null;
  const interval = TF_TO_TD[tf] || "1h"; // map khung user → TD interval
  const ctx = {};
  const tasks = [];
  // TwelveData free tier proxies:
  // - DXY: EUR/USD inverse (EUR 57% DXY weight, correlation -0.76)
  // - OIL: USO ETF (WTI tracker, direction match 99%)
  if (wantsOil) tasks.push(
    getCachedAuxData(env, "USO", "Dầu (USO ETF)", interval).then(d => { if (d) ctx.oil = d; })
  );
  if (wantsDxy) tasks.push(
    getCachedAuxData(env, "EUR/USD", "EUR/USD", interval).then(d => {
      if (d) {
        ctx.dxy = {
          ...d,
          symbol: "DXY (proxy)",
          label: "DXY (qua EUR/USD inverse)",
          eurusdPrice: d.price,
          pct24h: -d.pct24h,
          pctTf: -d.pctTf,
          trendLabel: {
            "Tăng mạnh (Strong Bullish)": "Giảm mạnh (Strong Bearish)",
            "Tăng giá (Bullish)":         "Giảm giá (Bearish)",
            "Đi ngang (Sideways)":        "Đi ngang (Sideways)",
            "Giảm giá (Bearish)":         "Tăng giá (Bullish)",
            "Giảm mạnh (Strong Bearish)": "Tăng mạnh (Strong Bullish)",
          }[d.trendLabel] || "?",
          trendEmoji: { "🚀": "🔻", "🟢": "🔴", "↔️": "↔️", "🔴": "🟢", "🔻": "🚀" }[d.trendEmoji] || "❓",
        };
      }
    })
  );
  await Promise.all(tasks);
  return Object.keys(ctx).length > 0 ? ctx : null;
}

/**
 * Diễn giải tác động inter-market lên XAU dựa trên DXY/OIL trend.
 * Dùng cho /nhanh pulse (no AI), context tự computed.
 */
function interpretAuxImpact(auxCtx) {
  if (!auxCtx) return "";
  const lines = [];
  if (auxCtx.dxy) {
    const p = auxCtx.dxy.pct24h;
    if (p > 0.3)       lines.push("Đô la mạnh lên → áp lực GIẢM GIÁ (bearish) cho XAU (tương quan nghịch ~-0.7)");
    else if (p < -0.3) lines.push("Đô la yếu đi → ủng hộ TĂNG GIÁ (bullish) cho XAU");
    else                lines.push("Đô la đi ngang (sideways) → ít tác động lên XAU");
  }
  if (auxCtx.oil) {
    const p = auxCtx.oil.pct24h;
    if (p > 0.5)       lines.push("Dầu tăng → đồng pha TĂNG GIÁ (bullish) với XAU (cùng phòng hộ lạm phát)");
    else if (p < -0.5) lines.push("Dầu giảm → áp lực GIẢM GIÁ (bearish) cho XAU");
    else                lines.push("Dầu đi ngang (sideways) → trung tính với XAU");
  }
  return lines.join(". ") + ".";
}

// ──────────────────────────────────────────────────────────
// Alert detection + dedup via KV
// ──────────────────────────────────────────────────────────
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h dedup, không spam cùng alert

async function alertCooldownOk(env, key) {
  if (!env.CACHE) return true;
  const last = await env.CACHE.get(`alert:${key}`);
  if (!last) return true;
  return Date.now() - parseInt(last) > ALERT_COOLDOWN_MS;
}

async function markAlerted(env, key) {
  if (!env.CACHE) return;
  await env.CACHE.put(`alert:${key}`, String(Date.now()), { expirationTtl: 7200 });
}

async function detectFreshAlerts(env, latest, prev, pivots, candlesEnriched) {
  const out = [];
  // Giữ `key` trong object để cron logic có thể filter redundant alerts khi MEGA-MOVE active
  const push = async (key, icon, text, suggestion = null) => {
    if (await alertCooldownOk(env, key)) {
      out.push({ key, icon, text, suggestion });
      await markAlerted(env, key);
    }
  };

  // Session-aware threshold modifier — phiên NY/overlap nhạy hơn, phiên Á siết.
  // Áp dụng cho các threshold biến động (strong move, impulse, ATR spike, BB expansion,
  // wick range, gap). KHÔNG áp dụng cho RSI/MA cross/pivot vì những thứ đó là level-based.
  const session = getSessionInfo();
  const M = session.volMult;

  // ── 1. RSI quá mua / quá bán (Overbought/Oversold) ──
  if (latest.rsi != null) {
    if (latest.rsi > 70)
      await push("rsi_overbought", "🔴", `RSI quá mua (Overbought) *${latest.rsi.toFixed(1)}* — coi chừng điều chỉnh`,
        "Theo dõi dải trên Bollinger / Điểm xoay R1 để xem có phản ứng từ chối không. Tránh đuổi mua.");
    if (latest.rsi < 30)
      await push("rsi_oversold", "🟢", `RSI quá bán (Oversold) *${latest.rsi.toFixed(1)}* — khả năng hồi phục`,
        "Theo dõi vùng hỗ trợ S1 / đáy 50 nến để xem có nảy ngược không. Đợi xác nhận trước khi mua.");
  }

  // ── 2. Phá vỡ Bollinger Bands ──
  if (latest.bbUpper != null && prev.bbUpper != null) {
    if (latest.close > latest.bbUpper && prev.close <= prev.bbUpper)
      await push("bb_up", "📈", `Vượt biên trên Bollinger (BB upper) *$${latest.bbUpper.toFixed(2)}* — đà tăng mạnh`,
        "Phá vỡ BB thường tiếp diễn 3-5 nến. Theo dõi giá retest BB upper làm hỗ trợ.");
    if (latest.close < latest.bbLower && prev.close >= prev.bbLower)
      await push("bb_dn", "📉", `Phá biên dưới Bollinger (BB lower) *$${latest.bbLower.toFixed(2)}* — đà giảm mạnh`,
        "Phá vỡ BB thường tiếp diễn. Theo dõi retest BB lower làm kháng cự.");
  }

  // ── 3. Giao cắt vàng / tử thần (Golden / Death Cross) ──
  if (prev.sma50 != null && prev.sma200 != null && latest.sma50 != null && latest.sma200 != null) {
    if (prev.sma50 <= prev.sma200 && latest.sma50 > latest.sma200)
      await push("golden", "⭐", `*Giao cắt vàng (Golden Cross)* — SMA50 cắt lên SMA200, xu hướng tăng dài hạn`,
        "Tín hiệu đảo chiều mạnh. Ưu tiên mua khi giá hồi (BTD) về EMA21/50.");
    if (prev.sma50 >= prev.sma200 && latest.sma50 < latest.sma200)
      await push("death", "💀", `*Giao cắt tử thần (Death Cross)* — SMA50 cắt xuống SMA200, xu hướng giảm dài hạn`,
        "Tín hiệu đảo chiều mạnh. Ưu tiên bán khi giá hồi (STR) về EMA21/50.");
  }

  // ── 4. Cắt EMA21/50 (đường trung bình động hàm mũ) ──
  if (prev.ema21 != null && prev.ema50 != null && latest.ema21 != null && latest.ema50 != null) {
    if (prev.ema21 <= prev.ema50 && latest.ema21 > latest.ema50)
      await push("ema_up", "📊", "EMA21 cắt lên EMA50 — đà tăng ngắn hạn",
        "Đà chuyển sang tăng. Theo dõi giá đóng cửa trên EMA50 để xác nhận.");
    if (prev.ema21 >= prev.ema50 && latest.ema21 < latest.ema50)
      await push("ema_dn", "📊", "EMA21 cắt xuống EMA50 — đà giảm ngắn hạn",
        "Đà chuyển sang giảm. Theo dõi đóng cửa dưới EMA50 để xác nhận.");
  }

  // ── 5. Phá vỡ Điểm xoay (Pivot break) ──
  if (pivots) {
    const levels = [
      { key: "r2", label: "R2", price: pivots.r2 },
      { key: "r1", label: "R1", price: pivots.r1 },
      { key: "s1", label: "S1", price: pivots.s1 },
      { key: "s2", label: "S2", price: pivots.s2 },
    ];
    for (const { key, label, price } of levels) {
      if (prev.close <= price && latest.close > price)
        await push(`piv_up_${key}`, "🎯", `Phá điểm xoay ${label} (Pivot) *$${price.toFixed(2)}* lên`,
          `Theo dõi retest ${label} làm hỗ trợ. Mục tiêu mở rộng tới mốc kháng cự kế tiếp.`);
      if (prev.close >= price && latest.close < price)
        await push(`piv_dn_${key}`, "🎯", `Phá điểm xoay ${label} (Pivot) *$${price.toFixed(2)}* xuống`,
          `Theo dõi retest ${label} làm kháng cự. Mục tiêu mở rộng tới mốc hỗ trợ kế tiếp.`);
    }
  }

  // ── 6. Biến động giá mạnh (Strong move) — DÙNG ATR-RELATIVE ──
  // Nến hiện tại di chuyển > (1.3 × ATR × volMult) là bất thường so với baseline phiên.
  if (latest.open && latest.close && latest.atr > 0) {
    const change = latest.close - latest.open;
    const changeAbs = Math.abs(change);
    const changePct = (changeAbs / latest.open) * 100;
    const atrRatio = changeAbs / latest.atr;
    if (atrRatio > 1.3 * M || changePct > 0.3 * M) {
      const direction = change > 0 ? "TĂNG" : "GIẢM";
      const icon = change > 0 ? "🚀" : "💥";
      await push(`big_move_${change > 0 ? "up" : "dn"}`, icon,
        `Biến động mạnh: ${direction} *${changePct.toFixed(2)}%* (${atrRatio.toFixed(1)}× ATR) — nến đóng $${latest.close.toFixed(2)} từ $${latest.open.toFixed(2)}`,
        change > 0
          ? "Theo dõi 1-2 nến kế tiếp xem có tiếp diễn (continuation) không. Có thể đẩy tiếp hoặc thoái lui (retrace) 50% trước khi continue."
          : "Theo dõi vùng hỗ trợ gần. Có thể nảy ngược (oversold bounce) hoặc tiếp tục giảm sâu.");
    }
  }

  // ── 6b. Biến động đa nến (3 nến gần nhất) — XU HƯỚNG MẠNH BẤT THƯỜNG ──
  // Tổng % thay đổi 3 nến > 2.0 × ATR → trend ấn mạnh, có thể impulse wave.
  if (latest.atr > 0 && Array.isArray(candlesEnriched) && candlesEnriched.length >= 4) {
    const c0 = candlesEnriched[candlesEnriched.length - 4]; // 4 nến trước
    const c1 = latest;
    if (c0?.close && c1?.close) {
      const totalMove = c1.close - c0.close;
      const totalAtrRatio = Math.abs(totalMove) / latest.atr;
      const totalPct = (Math.abs(totalMove) / c0.close) * 100;
      if (totalAtrRatio > 2.5 * M && totalPct > 0.5 * M) {
        const dir = totalMove > 0 ? "TĂNG" : "GIẢM";
        const icon = totalMove > 0 ? "🔥" : "❄️";
        await push(`multi_move_${totalMove > 0 ? "up" : "dn"}`, icon,
          `Sóng đẩy ${dir} 3 nến: *${totalPct.toFixed(2)}%* (${totalAtrRatio.toFixed(1)}× ATR) trong ${3 * 15} phút — *xu hướng đang ấn mạnh bất thường*`,
          totalMove > 0
            ? "Đà tăng (impulse) mạnh. Cẩn trọng đuổi mua giá — đợi pullback về EMA21 hoặc breakout retest."
            : "Đà giảm (impulse) mạnh. Cẩn trọng cắt đuổi — đợi bounce về EMA21 hoặc breakdown retest.");
      }
    }
  }

  // ── 7. ATR tăng vọt (Volatility spike) — ngưỡng 1.3× thay vì 1.5× ──
  if (latest.atr != null && Array.isArray(candlesEnriched) && candlesEnriched.length >= 30) {
    const recentAtrs = candlesEnriched.slice(-30, -1).map(c => c.atr).filter(a => a != null);
    if (recentAtrs.length > 10) {
      const avgAtr = recentAtrs.reduce((s, a) => s + a, 0) / recentAtrs.length;
      if (latest.atr > avgAtr * 1.3 * M) {
        await push("vol_spike", "⚡",
          `ATR tăng vọt (Volatility Spike): *${latest.atr.toFixed(2)}* (${(latest.atr / avgAtr).toFixed(1)}× trung bình 30 nến)`,
          "Biến động cao bất thường — đợi nến đóng cửa trước khi vào lệnh, mở rộng dừng lỗ (SL) tối thiểu 1.5× ATR.");
      }
    }
  }

  // ── 7b. Bollinger giãn nở đột biến (BB squeeze release) ──
  // BB width hiện tại > 1.7× width trung bình 20 nến → vừa hết tích luỹ, breakout/breakdown.
  if (latest.bbUpper != null && latest.bbLower != null
      && Array.isArray(candlesEnriched) && candlesEnriched.length >= 25) {
    const widths = candlesEnriched.slice(-25, -1)
      .map(c => (c.bbUpper != null && c.bbLower != null) ? c.bbUpper - c.bbLower : null)
      .filter(w => w != null);
    if (widths.length >= 15) {
      const avgWidth = widths.reduce((s, w) => s + w, 0) / widths.length;
      const currWidth = latest.bbUpper - latest.bbLower;
      if (currWidth > avgWidth * 1.7 * M) {
        await push("bb_expand", "🌊",
          `Dải Bollinger giãn nở đột biến: width *${currWidth.toFixed(2)}* (${(currWidth / avgWidth).toFixed(1)}× trung bình) — *vừa hết tích luỹ, breakout đang xảy ra*`,
          "Sau giai đoạn tích luỹ (consolidation), volatility expansion thường kéo dài 5-10 nến. Đi theo hướng phá vỡ.");
      }
    }
  }

  // ── 7c. Râu nến từ chối mạnh (Strong wick rejection) ──
  // Râu (wick) > 1.5× thân + range > 0.7× ATR = phản ứng từ chối mạnh tại vùng cản/hỗ trợ.
  if (latest.high != null && latest.low != null && latest.open != null && latest.close != null && latest.atr > 0) {
    const range = latest.high - latest.low;
    const body = Math.abs(latest.close - latest.open);
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    if (range > 0.7 * latest.atr * M && body > 0) {
      if (upperWick > 1.5 * body && upperWick > lowerWick * 1.5) {
        await push("wick_top", "🪶",
          `Râu nến TRÊN dài bất thường tại $${latest.high.toFixed(2)}: ${upperWick.toFixed(2)} điểm (${(upperWick/body).toFixed(1)}× thân) — *phản ứng từ chối (rejection) ở đỉnh*`,
          "Tín hiệu đảo chiều giảm — phe bán đẩy giá xuống mạnh sau khi giá thử vượt đỉnh. Theo dõi đóng cửa dưới EMA21.");
      }
      if (lowerWick > 1.5 * body && lowerWick > upperWick * 1.5) {
        await push("wick_bottom", "🪶",
          `Râu nến DƯỚI dài bất thường tại $${latest.low.toFixed(2)}: ${lowerWick.toFixed(2)} điểm (${(lowerWick/body).toFixed(1)}× thân) — *phản ứng từ chối (rejection) ở đáy*`,
          "Tín hiệu đảo chiều tăng — phe mua đẩy giá lên mạnh sau khi giá thử phá đáy. Theo dõi đóng cửa trên EMA21.");
      }
    }
  }

  // ── 7d. Khoảng trống giá (Price gap) ──
  // Open của nến hiện tại cách close nến trước > 0.3× ATR → có gap (thường do tin tức).
  if (prev.close != null && latest.open != null && latest.atr > 0) {
    const gap = latest.open - prev.close;
    const gapAbs = Math.abs(gap);
    if (gapAbs > 0.3 * latest.atr * M) {
      const dir = gap > 0 ? "LÊN" : "XUỐNG";
      const icon = gap > 0 ? "📈" : "📉";
      await push(`gap_${gap > 0 ? "up" : "dn"}`, icon,
        `Gap ${dir} *${gapAbs.toFixed(2)}* điểm (${(gapAbs/latest.atr).toFixed(1)}× ATR): nến đóng $${prev.close.toFixed(2)} → mở $${latest.open.toFixed(2)}`,
        gap > 0
          ? "Gap up thường do tin tức tích cực hoặc thiếu thanh khoản. 70% gap được lấp lại trong 1-3 nến."
          : "Gap down thường do tin xấu. Theo dõi vùng hỗ trợ; 70% gap được lấp lại nếu không có đà tiếp diễn.");
    }
  }

  // ── 8. Quét thanh khoản (Liquidity Sweep) ──
  if (prev.recentHigh != null && prev.recentLow != null) {
    if (latest.high > prev.recentHigh && latest.close < prev.recentHigh) {
      await push("liq_sweep_up", "🎣",
        `Quét thanh khoản TRÊN (Liquidity Sweep Up) — râu nến $${latest.high.toFixed(2)} vượt đỉnh $${prev.recentHigh.toFixed(2)} rồi đóng cửa lại trong`,
        "Tín hiệu đảo chiều giảm phổ biến (smart money quét lệnh dừng lỗ). Theo dõi phân kỳ (Divergence) RSI + đóng cửa dưới EMA21.");
    }
    if (latest.low < prev.recentLow && latest.close > prev.recentLow) {
      await push("liq_sweep_dn", "🎣",
        `Quét thanh khoản DƯỚI (Liquidity Sweep Down) — râu nến $${latest.low.toFixed(2)} phá đáy $${prev.recentLow.toFixed(2)} rồi đóng cửa lại trong`,
        "Tín hiệu đảo chiều tăng (smart money quét stop). Theo dõi đóng cửa trên EMA21 + RSI xác nhận.");
    }
  }

  // ── 9. Phá range tích luỹ (Range Breakout sau Consolidation) ──
  // Detect 4-8h sideways tight rồi đột ngột phá lên/xuống.
  // Try 6h trước, fallback 4h nếu 6h chưa qualify.
  for (const hours of [6, 4]) {
    const rb = detectRangeBreakout(candlesEnriched, hours);
    if (rb && rb.triggered) {
      const dir = rb.direction;
      const icon = dir === "up" ? "📤" : "📥";
      const dirText = dir === "up" ? "LÊN" : "XUỐNG";
      await push(`range_breakout_${dir}`, icon,
        `Phá range tích luỹ ${rb.consolidationHours}h ${dirText} *$${rb.breakoutPrice.toFixed(2)}* — biên độ tích luỹ ${rb.rangeSize.toFixed(2)} điểm (${rb.rangeAtrRatio.toFixed(2)}× ATR nền)`,
        `Sau giai đoạn tích luỹ (consolidation), breakout thường đẩy tiếp theo measured move. Mục tiêu kỹ thuật: $${rb.targetPrice.toFixed(2)}. Theo dõi retest mức phá vỡ làm hỗ trợ/kháng cự mới.`);
      break; // chỉ lấy 1 timeframe để tránh trùng alert
    }
  }

  return out;
}

// ──────────────────────────────────────────────────────────
// Volatility regime tracking — phân loại trạng thái biến động hiện tại
// dựa trên ATR hiện tại / ATR baseline (96 nến gần nhất, ~24h trên 15m).
// Lưu KV để detect regime shift giữa các cron run.
// ──────────────────────────────────────────────────────────
const VOL_REGIME_KEY = "vol_regime:current";

function classifyVolRegime(candlesEnriched) {
  if (!Array.isArray(candlesEnriched) || candlesEnriched.length < 50) {
    return { code: "unknown", ratio: null, currentAtr: null, baselineAtr: null };
  }
  const last = candlesEnriched[candlesEnriched.length - 1];
  const currentAtr = last.atr;
  if (currentAtr == null) return { code: "unknown", ratio: null, currentAtr: null, baselineAtr: null };

  // Baseline: 96 nến gần nhất (24h), bỏ 5 nến cuối để không bias với current spike
  const slice = candlesEnriched.slice(-101, -5).map(c => c.atr).filter(a => a != null);
  if (slice.length < 30) return { code: "unknown", ratio: null, currentAtr, baselineAtr: null };
  const baselineAtr = slice.reduce((s, a) => s + a, 0) / slice.length;
  const ratio = currentAtr / baselineAtr;

  let code;
  if (ratio < 0.65)       code = "low";
  else if (ratio < 1.25)  code = "normal";
  else if (ratio < 1.85)  code = "high";
  else                    code = "extreme";

  return { code, ratio, currentAtr, baselineAtr };
}

const REGIME_LABEL = {
  low: { icon: "🟢", text: "THẤP", desc: "biên động dưới mức bình thường — sideways/tích luỹ" },
  normal: { icon: "🟡", text: "BÌNH THƯỜNG", desc: "biên động trong baseline 24h" },
  high: { icon: "🟠", text: "CAO", desc: "biên động trên trung bình — cẩn trọng vào lệnh, nới SL" },
  extreme: { icon: "🔴", text: "RẤT CAO", desc: "biên động cực mạnh — có thể đang có tin / breakout / phân phối lớn" },
};

/**
 * Trả về regime hiện tại + alert nếu vừa shift.
 * Push regime-shift alert BYPASS cooldown (hiếm, đáng spam).
 */
async function trackVolRegime(env, currentRegime) {
  if (!env.CACHE || currentRegime.code === "unknown") return null;
  let prevState = null;
  try {
    const raw = await env.CACHE.get(VOL_REGIME_KEY);
    if (raw) prevState = JSON.parse(raw);
  } catch {}

  const now = Date.now();
  if (!prevState || prevState.code !== currentRegime.code) {
    // Regime shift (hoặc lần đầu)
    const newState = {
      code: currentRegime.code,
      since: now,
      ratio: currentRegime.ratio,
    };
    try {
      await env.CACHE.put(VOL_REGIME_KEY, JSON.stringify(newState), { expirationTtl: 7 * 86400 });
    } catch {}
    if (prevState) {
      // Chỉ alert khi từ low/normal → high/extreme HOẶC ngược lại (down-shift cũng quan trọng để biết phân phối ổn lại)
      const escalation = (
        (prevState.code === "low" || prevState.code === "normal") &&
        (currentRegime.code === "high" || currentRegime.code === "extreme")
      );
      const deescalation = (
        (prevState.code === "high" || prevState.code === "extreme") &&
        (currentRegime.code === "low" || currentRegime.code === "normal")
      );
      if (escalation || deescalation) {
        const L = REGIME_LABEL[currentRegime.code];
        const P = REGIME_LABEL[prevState.code];
        const directionIcon = escalation ? "⬆️" : "⬇️";
        return {
          icon: `${directionIcon}${L.icon}`,
          text: `*Chuyển vùng biến động:* ${P.text} → ${L.text} (ATR ${currentRegime.ratio.toFixed(2)}× nền 24 giờ) — ${L.desc}`,
          suggestion: escalation
            ? "Hệ thống sẽ nhạy hơn với cảnh báo kế tiếp. Cân nhắc thu nhỏ khối lượng, mở rộng SL tối thiểu 2× ATR, ưu tiên chốt từng phần (scale-out) sớm."
            : "Biến động đang co lại — phù hợp giao dịch lướt sóng / dao động trong vùng. SL có thể siết lại 1× ATR.",
        };
      }
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// MEGA-MOVE detection — biến động cực mạnh trong 1 nến (15p)
// hoặc cluster 3 nến (45p). Trigger sâu hơn để chạy reversal-probe + AI.
// ──────────────────────────────────────────────────────────
const MEGA_MOVE_DOLLAR = 20;
const MEGA_MOVE_SINGLE_ATR = 2.0;
const MEGA_MOVE_CLUSTER_ATR = 3.0;

function detectMegaMove(candlesEnriched) {
  if (!Array.isArray(candlesEnriched) || candlesEnriched.length < 4) {
    return { triggered: false };
  }
  const latest = candlesEnriched[candlesEnriched.length - 1];
  if (!latest.atr || !latest.open || !latest.close) return { triggered: false };

  // 1 nến: |close - open|
  const singleMove = latest.close - latest.open;
  const singleAbs = Math.abs(singleMove);
  const singleAtr = singleAbs / latest.atr;
  if (singleAbs >= MEGA_MOVE_DOLLAR || singleAtr >= MEGA_MOVE_SINGLE_ATR) {
    return {
      triggered: true,
      type: "single",
      direction: singleMove > 0 ? "up" : "down",
      dollarMove: singleAbs,
      atrRatio: singleAtr,
      pctMove: (singleAbs / latest.open) * 100,
      windowMinutes: 15,
    };
  }

  // 3 nến: close[-1] - close[-4]
  const c0 = candlesEnriched[candlesEnriched.length - 4];
  if (c0?.close) {
    const cluster = latest.close - c0.close;
    const clusterAbs = Math.abs(cluster);
    const clusterAtr = clusterAbs / latest.atr;
    if (clusterAbs >= MEGA_MOVE_DOLLAR || clusterAtr >= MEGA_MOVE_CLUSTER_ATR) {
      return {
        triggered: true,
        type: "cluster",
        direction: cluster > 0 ? "up" : "down",
        dollarMove: clusterAbs,
        atrRatio: clusterAtr,
        pctMove: (clusterAbs / c0.close) * 100,
        windowMinutes: 45,
      };
    }
  }

  return { triggered: false };
}

// ──────────────────────────────────────────────────────────
// Range expansion / Breakout sau consolidation
// Detect khi giá đi ngang tích luỹ vài giờ rồi đột ngột phá lên/xuống.
// Đây là setup high-confidence: target = breakout level + range size
// (measured move). Phổ biến sau accumulation/distribution phase.
// ──────────────────────────────────────────────────────────
function detectRangeBreakout(candlesEnriched, hours = 6) {
  const CANDLES_PER_HOUR = 4; // 15-min candles
  const windowSize = hours * CANDLES_PER_HOUR;
  if (!Array.isArray(candlesEnriched) || candlesEnriched.length < windowSize + 96) return null;

  const latest = candlesEnriched[candlesEnriched.length - 1];
  const prev = candlesEnriched[candlesEnriched.length - 2];
  if (!latest?.close || !prev?.close || !latest.atr) return null;

  // Window data: từ candle[-windowSize-1] đến candle[-2] (loại trừ nến hiện tại)
  const window = candlesEnriched.slice(-windowSize - 1, -1);
  const winHigh = Math.max(...window.map(c => c.high).filter(Number.isFinite));
  const winLow = Math.min(...window.map(c => c.low).filter(Number.isFinite));
  const winRange = winHigh - winLow;

  // Baseline ATR: trung bình 96 nến gần nhất (24h) để estimate biến động chuẩn
  const recentAtrs = candlesEnriched.slice(-96).map(c => c.atr).filter(a => a != null);
  if (recentAtrs.length < 50) return null;
  const baselineAtr = recentAtrs.reduce((s, a) => s + a, 0) / recentAtrs.length;
  const rangeAtrRatio = winRange / baselineAtr;

  // Consolidation: range trong window phải tight (< 1.5× ATR baseline)
  // 6h range < 1.5× ATR(15p) = giá đi ngang trong biên ~15-20 điểm
  if (rangeAtrRatio > 1.5) return null;

  // Breakout: nến hiện tại close ngoài winHigh/winLow + nến trước CHƯA phá
  const buffer = 0.15 * latest.atr; // confirmation buffer
  if (latest.close > winHigh + buffer && prev.close <= winHigh + buffer) {
    return {
      triggered: true,
      direction: "up",
      consolidationHours: hours,
      rangeSize: winRange,
      rangeAtrRatio,
      breakoutPrice: winHigh,
      breakoutDistance: latest.close - winHigh,
      // Measured move target: range size projected lên từ breakout level
      targetPrice: winHigh + winRange,
    };
  }
  if (latest.close < winLow - buffer && prev.close >= winLow - buffer) {
    return {
      triggered: true,
      direction: "down",
      consolidationHours: hours,
      rangeSize: winRange,
      rangeAtrRatio,
      breakoutPrice: winLow,
      breakoutDistance: winLow - latest.close,
      targetPrice: winLow - winRange,
    };
  }
  return null;
}

// Tìm local extremes (đỉnh/đáy) trong window 3-3 — dùng cho RSI divergence.
function findLocalExtremes(candles, kind) {
  const out = [];
  for (let i = 3; i < candles.length - 3; i++) {
    const v = kind === "high" ? candles[i].high : candles[i].low;
    if (v == null) continue;
    let isExtreme = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      const cmp = kind === "high" ? candles[j].high : candles[j].low;
      if (cmp == null) { isExtreme = false; break; }
      if (kind === "high" ? cmp > v : cmp < v) { isExtreme = false; break; }
    }
    if (isExtreme) out.push({ idx: i, value: v, rsi: candles[i].rsi });
  }
  return out;
}

// ──────────────────────────────────────────────────────────
// Reversal signal scanner — chấm điểm xác suất quay đầu sau mega-move.
// Trả { score (0-145), factors, verdict }.
// ──────────────────────────────────────────────────────────
function scanReversalSignals(e15m, e1h, e4h, mega) {
  const latest = e15m[e15m.length - 1];
  const prev = e15m[e15m.length - 2];
  const last1h = e1h?.[e1h.length - 1];
  const last4h = e4h?.[e4h.length - 1];
  const dir = mega.direction;
  const factors = [];
  let score = 0;

  // 1. RSI extreme 15m
  if (latest.rsi != null) {
    if (dir === "up" && latest.rsi > 75) {
      factors.push(`RSI 15p quá mua (${latest.rsi.toFixed(1)})`);
      score += 20;
    } else if (dir === "down" && latest.rsi < 25) {
      factors.push(`RSI 15p quá bán (${latest.rsi.toFixed(1)})`);
      score += 20;
    }
  }

  // 2. HTF RSI exhaustion (1h)
  if (last1h?.rsi != null) {
    if (dir === "up" && last1h.rsi > 70) {
      factors.push(`RSI 1g quá mua (${last1h.rsi.toFixed(1)})`);
      score += 15;
    } else if (dir === "down" && last1h.rsi < 30) {
      factors.push(`RSI 1g quá bán (${last1h.rsi.toFixed(1)})`);
      score += 15;
    }
  }

  // 3. HTF RSI exhaustion (4h)
  if (last4h?.rsi != null) {
    if (dir === "up" && last4h.rsi > 70) {
      factors.push(`RSI 4g quá mua (${last4h.rsi.toFixed(1)})`);
      score += 12;
    } else if (dir === "down" && last4h.rsi < 30) {
      factors.push(`RSI 4g quá bán (${last4h.rsi.toFixed(1)})`);
      score += 12;
    }
  }

  // 4. Distance from EMA50 (mean reversion)
  if (latest.ema50 && latest.atr) {
    const distAtr = Math.abs(latest.close - latest.ema50) / latest.atr;
    if (distAtr > 3) {
      factors.push(`giá xa EMA50 ${distAtr.toFixed(1)}× ATR (có khả năng hồi về trung bình)`);
      score += 15;
    }
  }

  // 5. BB extreme
  if (latest.bbUpper && latest.bbLower) {
    const bw = latest.bbUpper - latest.bbLower;
    if (bw > 0) {
      if (dir === "up" && latest.close > latest.bbUpper) {
        const beyond = ((latest.close - latest.bbUpper) / bw) * 100;
        factors.push(`đóng cửa trên biên trên Bollinger (vượt ${beyond.toFixed(0)}% chiều rộng dải)`);
        score += 15;
      } else if (dir === "down" && latest.close < latest.bbLower) {
        const beyond = ((latest.bbLower - latest.close) / bw) * 100;
        factors.push(`đóng cửa dưới biên dưới Bollinger (vượt ${beyond.toFixed(0)}% chiều rộng dải)`);
        score += 15;
      }
    }
  }

  // 6. Wick rejection trong 2 nến gần nhất
  for (const c of e15m.slice(-2)) {
    if (!c.high || !c.low || !c.open || !c.close || !c.atr) continue;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    if (body === 0 || range < 0.5 * c.atr) continue;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    if (dir === "up" && upperWick > 1.5 * body && upperWick > lowerWick * 1.5) {
      factors.push(`râu nến TRÊN dài tại $${c.high.toFixed(2)} (phản ứng từ chối)`);
      score += 20;
      break;
    }
    if (dir === "down" && lowerWick > 1.5 * body && lowerWick > upperWick * 1.5) {
      factors.push(`râu nến DƯỚI dài tại $${c.low.toFixed(2)} (phản ứng từ chối)`);
      score += 20;
      break;
    }
  }

  // 7. Liquidity sweep — nến hiện tại quét đỉnh/đáy 50 nến rồi đóng cửa lại trong
  if (prev?.recentHigh && prev?.recentLow) {
    if (dir === "up" && latest.high > prev.recentHigh && latest.close < prev.recentHigh) {
      factors.push(`quét thanh khoản TRÊN $${prev.recentHigh.toFixed(2)} rồi đóng cửa lại trong vùng`);
      score += 25;
    }
    if (dir === "down" && latest.low < prev.recentLow && latest.close > prev.recentLow) {
      factors.push(`quét thanh khoản DƯỚI $${prev.recentLow.toFixed(2)} rồi đóng cửa lại trong vùng`);
      score += 25;
    }
  }

  // 8. RSI divergence (đơn giản: 2 swing extremes gần nhất trong 30 nến)
  if (e15m.length >= 30) {
    const recent = e15m.slice(-30);
    if (dir === "up") {
      const highs = findLocalExtremes(recent, "high");
      if (highs.length >= 2) {
        const [h1, h2] = highs.slice(-2);
        if (h2.value > h1.value && h2.rsi != null && h1.rsi != null && h2.rsi < h1.rsi - 2) {
          factors.push(`phân kỳ GIẢM RSI (giá đỉnh mới cao hơn nhưng RSI đỉnh mới thấp hơn)`);
          score += 25;
        }
      }
    } else {
      const lows = findLocalExtremes(recent, "low");
      if (lows.length >= 2) {
        const [l1, l2] = lows.slice(-2);
        if (l2.value < l1.value && l2.rsi != null && l1.rsi != null && l2.rsi > l1.rsi + 2) {
          factors.push(`phân kỳ TĂNG RSI (giá đáy mới thấp hơn nhưng RSI đáy mới cao hơn)`);
          score += 25;
        }
      }
    }
  }

  let verdict;
  if (score >= 70) verdict = "reversal_strong";
  else if (score >= 45) verdict = "reversal_likely";
  else if (score >= 25) verdict = "mixed";
  else verdict = "continuation_likely";

  return { score, factors, verdict };
}

// ──────────────────────────────────────────────────────────
// News fetch cho mega-move — reuse getCachedNews() + isGoldRelevant()
// đã có sẵn trong worker (15-min cache, 3 feeds: fxstreet/investing/marketwatch).
// ──────────────────────────────────────────────────────────
async function fetchTopGoldNews(env, limit = 5) {
  try {
    const all = await getCachedNews(env);
    const filtered = (all || [])
      .filter(isGoldRelevant)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit);
    console.log(`[mega-news] total=${all?.length || 0} gold-relevant=${filtered.length}`);
    return filtered;
  } catch (e) {
    console.log(`[mega-news] fail: ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// PHASE 5: Economic calendar pre-event alerts (4h, 1h, 30p trước event)
// ══════════════════════════════════════════════════════════════════════
// Forex Factory JSON weekly feed (free, no auth). Schema:
//   [{ title, country, date (ISO), impact, forecast, previous }, ...]
const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

// Keywords nhận diện event high-impact XAU
const PRE_EVENT_KEYWORDS = [
  "non-farm", "non farm", "nfp", "payroll", "employment",
  "cpi", "ppi", "pce", "inflation", "core inflation",
  "fed funds", "fomc", "fed chair", "powell", "interest rate",
  "gdp", "unemployment", "jobless claims", "retail sales",
  "ism manufacturing", "ism services",
];

function vietnameseEventLabel(title) {
  const lc = (title || "").toLowerCase();
  if (lc.includes("non-farm") || lc.includes("nfp") || lc.includes("payroll")) return "Việc làm phi nông nghiệp Mỹ (NFP)";
  if (lc.includes("cpi") && lc.includes("core")) return "CPI lõi (Core CPI)";
  if (lc.includes("cpi")) return "Chỉ số giá tiêu dùng (CPI)";
  if (lc.includes("ppi")) return "Chỉ số giá sản xuất (PPI)";
  if (lc.includes("pce")) return "Chỉ số chi tiêu cá nhân (PCE)";
  if (lc.includes("fed funds") || lc.includes("interest rate")) return "Quyết định lãi suất Fed";
  if (lc.includes("fomc statement") || lc.includes("fomc minutes")) return "Biên bản/Tuyên bố FOMC";
  if (lc.includes("fomc")) return "Cuộc họp FOMC (Fed)";
  if (lc.includes("fed chair") || lc.includes("powell")) return "Bài phát biểu Chủ tịch Fed (Powell)";
  if (lc.includes("gdp")) return "GDP (Tăng trưởng kinh tế)";
  if (lc.includes("unemployment rate")) return "Tỷ lệ thất nghiệp";
  if (lc.includes("jobless")) return "Số người xin trợ cấp thất nghiệp";
  if (lc.includes("retail sales")) return "Doanh số bán lẻ";
  if (lc.includes("ism manufacturing")) return "Chỉ số ISM Sản xuất";
  if (lc.includes("ism services")) return "Chỉ số ISM Dịch vụ";
  return title; // fallback giữ nguyên
}

function isPreEventRelevant(event) {
  if (!event || !event.title || !event.date) return false;
  if ((event.country || "").toUpperCase() !== "USD") return false;
  const impact = (event.impact || "").toLowerCase();
  if (impact !== "high") return false;
  const t = event.title.toLowerCase();
  return PRE_EVENT_KEYWORDS.some(k => t.includes(k));
}

// Fetch finnhub.io economic calendar (free 60 req/min, allow CF egress).
// Schema: { economicCalendar: [{event, country, time, impact, actual, prev, estimate, ...}] }
async function fetchFinnhubCalendar(env) {
  if (!env.FINNHUB_API_KEY) return null;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 7 * 86400 * 1000).toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${env.FINNHUB_API_KEY}`;
  try {
    const r = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
    if (!r.ok) {
      console.log(`[econ-cal:finnhub] HTTP ${r.status}`);
      return null;
    }
    const d = await r.json();
    const arr = Array.isArray(d?.economicCalendar) ? d.economicCalendar : [];
    return arr.map(e => ({
      title: e.event,
      country: e.country,
      date: e.time, // ISO "2026-05-12 08:30:00" hoặc "2026-05-12T08:30:00"
      ts: new Date(e.time.includes("T") ? e.time : e.time.replace(" ", "T") + "Z").getTime(),
      forecast: e.estimate != null ? String(e.estimate) : null,
      previous: e.prev != null ? String(e.prev) : null,
      // Finnhub impact: "high" | "medium" | "low" (case may vary)
      impact: e.impact ? e.impact.charAt(0).toUpperCase() + e.impact.slice(1).toLowerCase() : "",
    })).filter(e => Number.isFinite(e.ts));
  } catch (e) {
    console.log(`[econ-cal:finnhub] fail: ${e.message}`);
    return null;
  }
}

// Fetch + parse + filter — cache 12h trong KV.
// Ưu tiên finnhub (CF-friendly) → fallback faireconomy (thường 429 từ CF) →
// fallback KV last_good (lần fetch thành công gần nhất).
async function fetchEconomicCalendar(env) {
  const bucket = Math.floor(Date.now() / (12 * 3600 * 1000));
  const cacheKey = `econ_cal:${bucket}`;
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  // 1) Try finnhub (preferred — không bị CF egress block)
  let arr = await fetchFinnhubCalendar(env);
  let source = "finnhub";

  // 2) Fallback: faireconomy (thường 429 nhưng thử)
  if (!arr || arr.length === 0) {
    source = "faireconomy";
    try {
      const r = await fetch(FF_CALENDAR_URL, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        cf: { cacheEverything: true, cacheTtl: 3600 },
      });
      if (r.ok) {
        const raw = await r.json();
        if (Array.isArray(raw)) {
          arr = raw.map(e => ({
            title: e.title,
            country: e.country,
            date: e.date,
            ts: new Date(e.date).getTime(),
            forecast: e.forecast || null,
            previous: e.previous || null,
            impact: e.impact,
          })).filter(e => Number.isFinite(e.ts));
        }
      } else {
        console.log(`[econ-cal:ff] HTTP ${r.status}`);
      }
    } catch (e) {
      console.log(`[econ-cal:ff] fail: ${e.message}`);
    }
  }

  // 3) Filter relevant + cache nếu có
  if (Array.isArray(arr) && arr.length > 0) {
    const relevant = arr.filter(isPreEventRelevant);
    console.log(`[econ-cal:${source}] total=${arr.length} relevant=${relevant.length}`);
    if (relevant.length > 0) {
      await cachePut(env, cacheKey, JSON.stringify(relevant));
      if (env.CACHE) {
        try { await env.CACHE.put("econ_cal:last_good", JSON.stringify(relevant), { expirationTtl: 7 * 86400 }); } catch {}
      }
    }
    return relevant;
  }

  // 4) Last resort: KV last_good (lần fetch thành công gần nhất, có thể cũ vài ngày)
  const fallback = await cacheGet(env, "econ_cal:last_good");
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback);
      const future = parsed.filter(e => e.ts > Date.now() - 60000);
      console.log(`[econ-cal] dùng KV last_good (${parsed.length} events, ${future.length} còn future)`);
      return future;
    } catch {}
  }

  console.log(`[econ-cal] không có data — cần set FINNHUB_API_KEY hoặc đợi faireconomy mở`);
  return [];
}

// Tier definitions: 4h / 1h / 30p với tolerance ±3 phút cho cron drift
const PRE_EVENT_TIERS = [
  { minutes: 240, key: "4h",  label: "4 giờ",   icon: "🟡" },
  { minutes: 60,  key: "1h",  label: "1 giờ",   icon: "🟠" },
  { minutes: 30,  key: "30m", label: "30 phút", icon: "🔴" },
];
const PRE_EVENT_TOLERANCE_MIN = 3;

function eventId(event) {
  // Hash đơn giản: ts + title (unique trong tuần)
  return `${event.ts}_${(event.title || "").slice(0, 30).replace(/[^a-z0-9]/gi, "")}`;
}

async function checkAndFirePreEventAlerts(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 0;
  const events = await fetchEconomicCalendar(env);
  if (events.length === 0) return 0;

  const now = Date.now();
  let fired = 0;

  for (const ev of events) {
    const minutesToEvent = (ev.ts - now) / 60000;
    if (minutesToEvent < 0) continue; // đã qua
    if (minutesToEvent > 250) continue; // xa quá 4h+, bỏ qua

    for (const tier of PRE_EVENT_TIERS) {
      if (Math.abs(minutesToEvent - tier.minutes) > PRE_EVENT_TOLERANCE_MIN) continue;

      const dedupKey = `pre_event:${eventId(ev)}:${tier.key}`;
      if (env.CACHE) {
        const seen = await env.CACHE.get(dedupKey);
        if (seen) continue;
      }

      const sent = await sendPreEventAlert(env, ev, tier, minutesToEvent);
      if (sent && env.CACHE) {
        // TTL = tier.minutes + 60 phút để KV không phình
        await env.CACHE.put(dedupKey, "1", { expirationTtl: (tier.minutes + 60) * 60 });
      }
      if (sent) fired++;
      break; // 1 event chỉ fire 1 tier mỗi cron tick
    }
  }
  return fired;
}

async function sendPreEventAlert(env, event, tier, minutesToEvent) {
  const h = htmlEscape;
  const vnLabel = vietnameseEventLabel(event.title);
  const eventTimeVn = new Date(event.ts).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false });
  const eventTimeUtc = new Date(event.ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const lines = [];
  lines.push(`${tier.icon} <b>SẮP CÓ TIN — Còn ${tier.label}</b>`);
  lines.push(`📅 <b>${h(vnLabel)}</b>`);
  if (vnLabel !== event.title) {
    lines.push(`<i>(${h(event.title)})</i>`);
  }
  lines.push(`🕐 ${h(eventTimeVn)} (giờ VN) — ${h(eventTimeUtc)}`);
  lines.push(`🎯 Tác động: <b>CAO</b> (USD)`);

  if (event.forecast || event.previous) {
    const parts = [];
    if (event.forecast) parts.push(`Dự báo: <b>${h(event.forecast)}</b>`);
    if (event.previous) parts.push(`Lần trước: ${h(event.previous)}`);
    lines.push(`📊 ${parts.join(" | ")}`);
  }

  // Hướng dẫn ngắn theo tier
  if (tier.key === "4h") {
    lines.push("");
    lines.push("⏳ <b>Chuẩn bị:</b> Cân nhắc đóng lệnh trước event để tránh slippage. Biến động trước/sau release có thể vượt 2-3× ATR thường.");
  } else if (tier.key === "1h") {
    lines.push("");
    lines.push("⚠️ <b>Cảnh giác:</b> Spread bắt đầu giãn. Hạn chế vào lệnh mới. Nếu giữ vị thế → cân nhắc thu hẹp size hoặc mở SL.");
  } else if (tier.key === "30m") {
    lines.push("");
    lines.push("🚨 <b>Sắp release:</b> Tạm dừng giao dịch. Đợi 5-10p sau release để xem direction rõ + spread bình thường lại.");
    lines.push("");
    lines.push("<b>Mẹo:</b>");
    lines.push("• Dữ liệu hot (vượt forecast nhiều) → USD mạnh → XAU giảm");
    lines.push("• Dữ liệu lạnh (dưới forecast) → USD yếu → XAU tăng");
    lines.push("• Fed dovish → XAU tăng | Fed hawkish → XAU giảm");
  }

  const msg = lines.join("\n");
  const sent = await sendTelegram(env, msg, false, "HTML");
  console.log(`[pre-event] ${sent ? "sent" : "send_fail"}: ${event.title} tier=${tier.key} mins_left=${minutesToEvent.toFixed(1)}`);
  return sent;
}

// ──────────────────────────────────────────────────────────
// Mega-move orchestrator — scan reversal + fetch news + gọi Gemini + gửi TG.
// Cooldown 30p qua KV để tránh spam trong giai đoạn vol kéo dài.
// ──────────────────────────────────────────────────────────
const MEGA_MOVE_COOLDOWN_MS = 30 * 60 * 1000;

async function megaMoveCooldownOk(env) {
  if (!env.CACHE) return true;
  const last = await env.CACHE.get("mega_move:last");
  if (!last) return true;
  return Date.now() - parseInt(last) > MEGA_MOVE_COOLDOWN_MS;
}

async function markMegaMoveSent(env) {
  if (!env.CACHE) return;
  await env.CACHE.put("mega_move:last", String(Date.now()), { expirationTtl: 7200 });
}

// Schema chung cho cả 2 mode (mega + alerts).
// LƯU Ý CỰC QUAN TRỌNG: AI phải hiểu "giá tuyệt đối" vs "tỉ lệ ATR"
// — XAU/USD hiện ~$4700, mọi giá trong setup phải nằm trong khoảng $4500-5000.
// Schema embed example values rõ để AI không nhầm.
function buildDeepAnalysisSchema(currentPrice, atr) {
  const px = currentPrice.toFixed(2);
  // Tính các mức tham chiếu để AI bám theo
  const slBelow = (currentPrice - atr * 1.5).toFixed(2);
  const slAbove = (currentPrice + atr * 1.5).toFixed(2);
  const tp1Above = (currentPrice + atr * 1.5).toFixed(2);
  const tp1Below = (currentPrice - atr * 1.5).toFixed(2);
  const tp3Above = (currentPrice + atr * 4).toFixed(2);
  const tp3Below = (currentPrice - atr * 4).toFixed(2);

  return `Trả JSON. **MỌI TEXT BẮT BUỘC TIẾNG VIỆT**. **MỌI GIÁ TUYỆT ĐỐI** (XAU ~$${px}, range $${(currentPrice - atr * 5).toFixed(0)}-$${(currentPrice + atr * 5).toFixed(0)}; KHÔNG dùng tỉ lệ ATR / số nhỏ).

{
  "verdict": "reversal_strong|reversal_likely|continuation|continuation_likely|mixed|wait",
  "direction": "long|short|neutral",
  "confidence_pct": 0-100,
  "summary": "2-3 câu tiếng Việt: phe nào kiểm soát, đang ở giai đoạn nào, có nên hành động gì.",
  "key_factors": [
    "Lý do BẢN CHẤT, ≤100 ký tự (vd: 'RSI 1g vẫn dưới 70, trend còn space để đẩy tiếp')",
    "DIỄN GIẢI hàm ý, KHÔNG dump số (KHÔNG: 'RSI 65.2')"
  ],
  "watch_levels": {
    "bullish_trigger": <vd ${(currentPrice + atr).toFixed(2)}>,
    "bearish_trigger": <vd ${(currentPrice - atr).toFixed(2)}>,
    "key_invalidation": <vd ${(currentPrice + atr * 2).toFixed(2)}>
  },
  "trade_setups": [{
    "bias": "long|short",
    "scenario": "tên ngắn TV (vd: Đảo chiều tại đỉnh)",
    "wait_for": "biểu hiện cụ thể TV (vd: nến 15p đóng cửa dưới EMA21 + RSI<50)",
    "entry_zone": [${(currentPrice - atr * 0.3).toFixed(2)}, ${(currentPrice - atr * 0.1).toFixed(2)}],
    "sl": ${slBelow},      // long ví dụ; short dùng ${slAbove}
    "tp1": ${tp1Above},    // long; short dùng ${tp1Below}
    "tp2": <giá>,
    "tp3": ${tp3Above},    // long; short dùng ${tp3Below}
    "rr_to_tp1": <số thập phân, vd 1.5>,
    "confidence": "cao|trung bình|thấp"
  }],
  "news_catalyst": "1 CÂU TIẾNG VIỆT ≤120 ký tự về tin nào gây biến động (KHÔNG copy EN nguyên), hoặc null"
}

QUY TẮC TUYỆT ĐỐI:
- Giá là SỐ TUYỆT ĐỐI trong $${(currentPrice - atr * 5).toFixed(0)}-$${(currentPrice + atr * 5).toFixed(0)}. KHÔNG dùng $1.95/$1.00 — đó là sai.
- Long: SL < entry < TP1 < TP2 < TP3. Short: SL > entry > TP1 > TP2 > TP3.
- SL-entry ≥ 1× ATR (~$${atr.toFixed(0)}). TP1 ≥ entry ± 1× ATR.
- **BẮT BUỘC trả ≥1 trade_setup khi direction != "neutral"** (kể cả khi verdict là *_likely). Verdict mixed → 2 setup (long+short).
- summary: 2-3 câu tự nhiên, hành động cụ thể (vd: "Phe bán có cơ hội tại $X nếu thấy Y. Đợi xác nhận, KHÔNG vào ngay.").
- key_factors: 2-3 bullet ngắn, bản chất.
- news_catalyst tiếng Việt ≤120 ký tự.
- ĐỪNG bias theo đà — cân nhắc reversal nghiêm túc.`;
}

// Map các code → tên VN — dùng chung 2 mode
const SESSION_VI = {
  asia: "Á", asia_eu: "Á-Âu", europe: "Âu",
  eu_ny: "Âu-Mỹ giao thoa", ny: "Mỹ", after_hours: "ngoài giờ chính",
};
const REGIME_VI = {
  low: "THẤP", normal: "BÌNH THƯỜNG",
  high: "CAO", extreme: "RẤT CAO", unknown: "?",
};
const AI_VERDICT_VI = {
  continuation: "TIẾP DIỄN",
  continuation_likely: "CÓ KHẢ NĂNG TIẾP DIỄN",
  reversal_strong: "ĐẢO CHIỀU MẠNH",
  reversal_likely: "CÓ KHẢ NĂNG ĐẢO CHIỀU",
  mixed: "TÍN HIỆU TRỘN",
  wait: "ĐỢI XÁC NHẬN",
};

/**
 * Deep analysis với AI — dùng cho cả MEGA-MOVE và regular alerts.
 *   mode = "mega"   → header MEGA-MOVE + rule scan reversal + extraAlerts (non-redundant)
 *   mode = "alerts" → header TÍN HIỆU + list alerts vừa kích hoạt
 * Schema AI output giống nhau giữa 2 mode → share format + render code.
 */
const DEEP_ANALYSIS_COOLDOWN_MS = 30 * 60 * 1000;

async function deepAnalysisCooldownOk(env, mode) {
  if (!env.CACHE) return true;
  const last = await env.CACHE.get(`deep:${mode}:last`);
  if (!last) return true;
  return Date.now() - parseInt(last) > DEEP_ANALYSIS_COOLDOWN_MS;
}

async function markDeepAnalysisSent(env, mode) {
  if (!env.CACHE) return;
  await env.CACHE.put(`deep:${mode}:last`, String(Date.now()), { expirationTtl: 7200 });
  // Cooldown legacy key cho mega-move (backward compat) — giữ để KV cũ vẫn hoạt động
  if (mode === "mega") {
    await env.CACHE.put("mega_move:last", String(Date.now()), { expirationTtl: 7200 });
  }
}

// Strip Markdown asterisks + escape HTML cho an toàn trong HTML parse mode
function htmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function mdBoldToHtml(s) {
  return htmlEscape(String(s || "")).replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
}

// Check tiếng Việt: phải có ít nhất 1 ký tự dấu tiếng Việt
// (để filter AI không dịch headlines/news_catalyst, vẫn trả nguyên EN).
const VN_DIACRITIC_RE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/;
function looksVietnamese(s) {
  return typeof s === "string" && VN_DIACRITIC_RE.test(s);
}

async function runDeepAnalysis(env, ctx) {
  const { mode, mega, alerts = [], e15m, e1h, e4h, regime, session, pivots: pivotsCtx = null } = ctx;

  // Validate input
  if (mode === "mega" && !mega?.triggered) {
    return { skipped: "no_trigger" };
  }
  if (mode === "alerts" && alerts.length === 0) {
    return { skipped: "no_alerts" };
  }
  // Backward compat: kiểm tra cooldown legacy key mega_move:last cho mode mega
  if (mode === "mega" && !(await megaMoveCooldownOk(env))) {
    console.log(`[deep:${mode}] cooldown (legacy mega key), skip`);
    return { skipped: "cooldown" };
  }
  if (!(await deepAnalysisCooldownOk(env, mode))) {
    console.log(`[deep:${mode}] cooldown 30p, skip`);
    return { skipped: "cooldown" };
  }

  const latest = e15m[e15m.length - 1];
  const sessionVi = SESSION_VI[session.code] || session.code;
  const regimeVi = REGIME_VI[regime.code] || regime.code;

  // Mega-specific: reversal scan từ rule-based factors
  const reversal = mode === "mega" ? scanReversalSignals(e15m, e1h, e4h, mega) : null;

  // News fetch chung
  const news = await fetchTopGoldNews(env, 5).catch(e => {
    console.log(`[deep:${mode}] news fail: ${e.message}`);
    return [];
  });

  // ── Build prompt ──
  // Phần 1: intro (khác nhau theo mode)
  let intro;
  if (mode === "mega") {
    const dirVi = mega.direction === "up" ? "TĂNG" : "GIẢM";
    intro = `XAU/USD vừa biến động ${dirVi} đột biến $${mega.dollarMove.toFixed(2)} (${mega.atrRatio.toFixed(1)}× ATR, ${mega.pctMove.toFixed(2)}%) trong ${mega.windowMinutes} phút. Giá hiện tại $${latest.close.toFixed(2)}.`;
  } else {
    intro = `XAU/USD có ${alerts.length} tín hiệu kỹ thuật vừa kích hoạt. Giá hiện tại $${latest.close.toFixed(2)}.`;
  }

  // Phần 2: BỐI CẢNH chung
  const last1hRsi = e1h?.[e1h.length - 1]?.rsi;
  const last4hRsi = e4h?.[e4h.length - 1]?.rsi;
  const context = `## BỐI CẢNH
- Phiên: ${session.name}
- Biến động: ${regimeVi}${regime.ratio != null ? ` (ATR ${regime.ratio.toFixed(2)}× nền 24g)` : ""}
- RSI 15p/1g/4g: ${latest.rsi?.toFixed(1) || "?"}/${last1hRsi?.toFixed(1) || "?"}/${last4hRsi?.toFixed(1) || "?"}
- EMA21/50/200 (15p): ${latest.ema21?.toFixed(2)}/${latest.ema50?.toFixed(2)}/${latest.ema200?.toFixed(2)}
- BB (15p): ${latest.bbLower?.toFixed(2)} ~ ${latest.bbUpper?.toFixed(2)}`;

  // Phần 3: SIGNALS (mega: reversal scan; alerts: list)
  let signalsBlock = "";
  if (mode === "mega" && reversal) {
    const lbl = {
      reversal_strong: "KHẢ NĂNG QUAY ĐẦU MẠNH",
      reversal_likely: "có khả năng quay đầu",
      mixed: "tín hiệu trộn",
      continuation_likely: "có khả năng tiếp diễn",
    }[reversal.verdict];
    signalsBlock = `\n\n## TÍN HIỆU REVERSAL (rule scan ${reversal.score}/145 → ${lbl}):
${reversal.factors.length > 0 ? reversal.factors.map(f => "- " + f).join("\n") : "- không rõ"}`;
  } else if (mode === "alerts") {
    // Strip Markdown asterisks trong alert text trước khi đưa vào prompt
    signalsBlock = `\n\n## TÍN HIỆU VỪA KÍCH HOẠT:
${alerts.slice(0, 8).map(a => "- " + String(a.text || "").replace(/\*/g, "")).join("\n")}`;
  }

  // Phần 4: NEWS
  const newsBlock = news.length > 0
    ? `\n\n## TIN MỚI (gốc EN — dịch vào headlines_vi):\n${news.slice(0, 3).map((n, i) => `${i + 1}. ${n.title}${n.summary && n.summary.length > 30 ? " — " + n.summary.slice(0, 120) : ""}`).join("\n")}`
    : "";

  // Dynamic schema có ví dụ giá tuyệt đối theo current price + ATR
  // → AI không nhầm "giá tuyệt đối" với "tỉ lệ ATR"
  const atrCur = latest.atr || 10;
  const schemaWithExamples = buildDeepAnalysisSchema(latest.close, atrCur);

  const prompt = `${intro}

${context}${signalsBlock}${newsBlock}

${schemaWithExamples}`;

  // ── Gemini call ──
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.4,
      // 1800 cho phép: summary 2-3 câu + key_factors 3 bullet + watch_levels + 1-2 setup
      // + news_catalyst — tổng ~600-1000 output tokens trong thực tế
      maxOutputTokens: 1800,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let aiResult = null;
  try {
    const resp = await callGeminiSmart(env, body);
    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      try { aiResult = JSON.parse(text); }
      catch { aiResult = extractJSON(text); }
    }
  } catch (e) {
    console.log(`[deep:${mode}] gemini fail: ${e.message}`);
  }

  // ── Format Telegram message ──
  const h = htmlEscape;
  const lines = [];

  // Header — khác nhau theo mode
  if (mode === "mega") {
    const dirIcon = mega.direction === "up" ? "🚀" : "💥";
    const dirVi = mega.direction === "up" ? "TĂNG" : "GIẢM";
    lines.push(`${dirIcon} <b>MEGA-MOVE ${h(dirVi)}</b> — $${mega.dollarMove.toFixed(2)} (${mega.atrRatio.toFixed(1)}× ATR) trong ${mega.windowMinutes} phút`);
  } else {
    lines.push(`🔔 <b>TÍN HIỆU KỸ THUẬT</b> — ${alerts.length} cảnh báo vừa kích hoạt`);
  }
  const ratioText = regime.ratio != null ? ` (ATR ${regime.ratio.toFixed(2)}× nền 24g)` : "";
  lines.push(`Giá: <b>$${latest.close.toFixed(2)}</b> | Phiên: ${h(sessionVi)} | Biến động: ${h(regimeVi)}${h(ratioText)}`);

  // Alerts block — mega hiển thị "Cảnh báo song hành" (non-redundant), alerts hiển thị full list
  if (alerts.length > 0) {
    lines.push("");
    lines.push(mode === "mega" ? "🔔 <b>Cảnh báo song hành:</b>" : "📊 <b>Cảnh báo:</b>");
    for (const a of alerts.slice(0, 6)) {
      lines.push(`${a.icon || "•"} ${mdBoldToHtml(a.text)}`);
    }
  }

  // Mega-only: rule scan — gọn 1 dòng + top 1 factor (nếu có)
  // Chi tiết AI sẽ render trong key_factors, không cần lặp.
  if (mode === "mega" && reversal) {
    const verdictLabel = {
      reversal_strong: "KHẢ NĂNG QUAY ĐẦU MẠNH",
      reversal_likely: "có khả năng quay đầu",
      mixed: "tín hiệu trộn",
      continuation_likely: "có khả năng tiếp diễn",
    }[reversal.verdict];
    const topFactor = reversal.factors[0];
    lines.push("");
    lines.push(`<b>Rà soát quy tắc: ${reversal.score}/145 → ${h(verdictLabel)}</b>${topFactor ? ` — ${h(topFactor)}` : ""}`);
  }

  // AI block — chung cho cả 2 mode
  if (aiResult) {
    lines.push("");
    const verdictKey = (aiResult.verdict || "").toString().toLowerCase();
    const verdictText = AI_VERDICT_VI[verdictKey] || verdictKey.toUpperCase() || "?";
    const conf = aiResult.confidence_pct;
    // Direction label rõ ràng — dùng "MUA (LONG)" / "BÁN (SHORT)" thay vì "mua" / "bán"
    const dirText = aiResult.direction === "long"
      ? "📈 MUA (LONG)"
      : aiResult.direction === "short"
      ? "📉 BÁN (SHORT)"
      : aiResult.direction === "neutral"
      ? "⏸️ ĐỨNG NGOÀI"
      : "";
    lines.push(`🤖 <b>AI: ${h(verdictText)}${conf != null ? ` (${h(conf)}%)` : ""}${dirText ? " — " + dirText : ""}</b>`);

    // Summary 2-3 câu — restore lại để user có context dễ đọc
    if (aiResult.summary && typeof aiResult.summary === "string") {
      const s = aiResult.summary.trim();
      const sTrim = s.length > 400 ? s.slice(0, 397) + "…" : s;
      lines.push(h(sTrim));
    }

    // key_factors: tối đa 3 bullet, mỗi cái ≤140 chars
    if (Array.isArray(aiResult.key_factors) && aiResult.key_factors.length > 0) {
      const trimmed = aiResult.key_factors.slice(0, 3)
        .map(f => String(f || "").trim())
        .filter(Boolean)
        .map(f => f.length > 140 ? f.slice(0, 137) + "…" : f);
      if (trimmed.length > 0) lines.push(trimmed.map(f => "• " + h(f)).join("\n"));
    }
    // Mốc theo dõi — ưu tiên AI, fallback rule-based (đảm bảo LUÔN có)
    const fmtVal = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : null;
    const wl = aiResult.watch_levels && typeof aiResult.watch_levels === "object" ? aiResult.watch_levels : {};
    const t1 = fmtVal(wl.bullish_trigger);
    const t2 = fmtVal(wl.bearish_trigger);
    const t3 = fmtVal(wl.key_invalidation);
    const wlLines = [];
    if (t1) wlLines.push(`• Tăng xác nhận: $${t1}`);
    if (t2) wlLines.push(`• Giảm xác nhận: $${t2}`);
    if (t3) wlLines.push(`• Mức huỷ kịch bản: $${t3}`);

    if (wlLines.length > 0) {
      lines.push("");
      lines.push("📍 <b>Mốc theo dõi (AI):</b>");
      lines.push(wlLines.join("\n"));
    } else {
      // Fallback rule-based: lấy 2 kháng cự + 2 hỗ trợ gần nhất từ pivots/EMA/swing
      const kl = getKeyLevelsAround(latest, pivotsCtx, latest.close);
      const ruleLines = [];
      for (const lv of (kl.above || []).slice(0, 2)) {
        ruleLines.push(`▲ <b>$${lv.price.toFixed(2)}</b> ${h(lv.label)} <i>(+${(lv.price - latest.close).toFixed(2)})</i>`);
      }
      for (const lv of (kl.below || []).slice(0, 2)) {
        ruleLines.push(`▼ <b>$${lv.price.toFixed(2)}</b> ${h(lv.label)} <i>(-${(latest.close - lv.price).toFixed(2)})</i>`);
      }
      if (ruleLines.length > 0) {
        lines.push("");
        lines.push("📍 <b>Mốc giá cần quan sát:</b>");
        lines.push(ruleLines.join("\n"));
      }
    }

    // Trade setups — validate giá ±10× ATR + đúng chiều bias
    const fmtNum = (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : null;
    const atrSetup = latest.atr || 10;
    const minOk = latest.close - atrSetup * 10;
    const maxOk = latest.close + atrSetup * 10;
    const inRange = (n) => {
      const num = Number(n);
      return Number.isFinite(num) && num >= minOk && num <= maxOk;
    };

    let renderedAnySetup = false;
    if (Array.isArray(aiResult.trade_setups) && aiResult.trade_setups.length > 0) {
      for (const s of aiResult.trade_setups.slice(0, 2)) {
        const biasIcon = s.bias === "long" ? "📈" : s.bias === "short" ? "📉" : "🎯";
        const biasText = s.bias === "long" ? "MUA (LONG)" : s.bias === "short" ? "BÁN (SHORT)" : "TRUNG TÍNH";
        const confText = s.confidence ? ` — độ tin cậy ${h(s.confidence)}` : "";

        const ez = Array.isArray(s.entry_zone) ? s.entry_zone.filter(inRange).map(fmtNum) : [];
        const sl = inRange(s.sl) ? fmtNum(s.sl) : null;
        const tp1 = inRange(s.tp1) ? fmtNum(s.tp1) : null;
        const tp2 = inRange(s.tp2) ? fmtNum(s.tp2) : null;
        const tp3 = inRange(s.tp3) ? fmtNum(s.tp3) : null;
        const rr = Number.isFinite(Number(s.rr_to_tp1)) ? Number(s.rr_to_tp1).toFixed(1) : null;

        if (ez.length === 0 || !sl || !tp1) {
          console.log(`[deep:${mode}] skip invalid setup: ez=${JSON.stringify(s.entry_zone)} sl=${s.sl} tp1=${s.tp1}`);
          continue;
        }

        const entryAvg = ez.length === 2 ? (parseFloat(ez[0]) + parseFloat(ez[1])) / 2 : parseFloat(ez[0]);
        const slNum = parseFloat(sl), tp1Num = parseFloat(tp1);
        if (s.bias === "long" && (slNum >= entryAvg || tp1Num <= entryAvg)) {
          console.log(`[deep:${mode}] skip long setup with bad SL/TP direction: entry=${entryAvg} sl=${slNum} tp1=${tp1Num}`);
          continue;
        }
        if (s.bias === "short" && (slNum <= entryAvg || tp1Num >= entryAvg)) {
          console.log(`[deep:${mode}] skip short setup with bad SL/TP direction: entry=${entryAvg} sl=${slNum} tp1=${tp1Num}`);
          continue;
        }

        lines.push("");
        lines.push(`${biasIcon} <b>${h(biasText)}${s.scenario ? " — " + h(s.scenario) : ""}${confText}</b>`);
        if (s.wait_for) lines.push(`   ⏳ Đợi: ${h(s.wait_for)}`);
        const entryStr = ez.length === 2 && ez[0] !== ez[1] ? `$${ez[0]} – $${ez[1]}` : `$${ez[0]}`;
        lines.push(`   🎯 Vào lệnh: ${entryStr}`);
        lines.push(`   🛑 Dừng lỗ (SL): $${sl}`);
        const tpParts = [`TP1 $${tp1}`];
        if (tp2) tpParts.push(`TP2 $${tp2}`);
        if (tp3) tpParts.push(`TP3 $${tp3}`);
        lines.push(`   💰 Chốt lời: ${tpParts.join(" | ")}`);
        if (rr) lines.push(`   ⚖️ R:R đến TP1 = 1:${rr}`);
        renderedAnySetup = true;
      }
    }

    // Fallback rule-based: AI không trả setup hợp lệ + có direction rõ
    // → đảm bảo LUÔN có giá khuyến nghị (entry/SL/TP) khi hướng đủ rõ.
    if (!renderedAnySetup && aiResult.direction && aiResult.direction !== "neutral") {
      const dirForRule = aiResult.direction === "long" ? "BUY" : "SELL";
      const klForRule = getKeyLevelsAround(latest, pivotsCtx, latest.close);
      const trendForRule = getTrendAssessment(latest);
      // Tạo alerts giả từ direction để generateTradeSuggestion chấm điểm đúng
      const fakeAlerts = [{ text: dirForRule === "BUY" ? "TĂNG đẩy lên" : "GIẢM đẩy xuống" }];
      const ruleSg = generateTradeSuggestion(latest, fakeAlerts, trendForRule, klForRule);
      if (ruleSg) {
        const biasIcon = ruleSg.dir === "BUY" ? "📈" : "📉";
        const biasText = ruleSg.dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
        lines.push("");
        lines.push(`${biasIcon} <b>${biasText} — gợi ý theo quy tắc</b> <i>(AI không trả setup rõ)</i>`);
        lines.push(`   🎯 Vào lệnh: $${ruleSg.entry.toFixed(2)}`);
        lines.push(`   🛑 Dừng lỗ (SL): $${ruleSg.sl.toFixed(2)} <i>(rủi ro ~${ruleSg.slDist.toFixed(2)} điểm)</i>`);
        lines.push(`   💰 Chốt lời: TP1 $${ruleSg.tp1.toFixed(2)} | TP2 $${ruleSg.tp2.toFixed(2)} | TP3 $${ruleSg.tp3.toFixed(2)}`);
        lines.push(`   ⚖️ R:R 1:1 / 1:2 / 1:3 (TP1/TP2/TP3)`);
        renderedAnySetup = true;
      }
    }

    // news_catalyst: 1 dòng tổng hợp tin (đã thay thế block headlines riêng)
    if (aiResult.news_catalyst && aiResult.news_catalyst !== "null" && looksVietnamese(aiResult.news_catalyst)) {
      const nc = String(aiResult.news_catalyst).trim();
      const ncTrim = nc.length > 200 ? nc.slice(0, 197) + "…" : nc;
      lines.push("");
      lines.push(`📰 <b>Tin:</b> ${h(ncTrim)}`);
    }
  } else {
    // AI offline — vẫn render rule-based key levels + trade suggestion
    lines.push("");
    lines.push("⚠️ <b>AI offline</b> — phân tích theo quy tắc:");

    const kl = getKeyLevelsAround(latest, pivotsCtx, latest.close);
    const klLines = [];
    for (const lv of (kl.above || []).slice(0, 2)) {
      klLines.push(`▲ <b>$${lv.price.toFixed(2)}</b> ${h(lv.label)} <i>(+${(lv.price - latest.close).toFixed(2)})</i>`);
    }
    for (const lv of (kl.below || []).slice(0, 2)) {
      klLines.push(`▼ <b>$${lv.price.toFixed(2)}</b> ${h(lv.label)} <i>(-${(latest.close - lv.price).toFixed(2)})</i>`);
    }
    if (klLines.length > 0) {
      lines.push("");
      lines.push("📍 <b>Mốc giá cần quan sát:</b>");
      lines.push(klLines.join("\n"));
    }

    // Rule-based suggestion từ alerts + trend
    const trendOff = getTrendAssessment(latest);
    const klOff = kl;
    const sgOff = generateTradeSuggestion(latest, alerts, trendOff, klOff);
    if (sgOff) {
      const biasIcon = sgOff.dir === "BUY" ? "📈" : "📉";
      const biasText = sgOff.dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
      lines.push("");
      lines.push(`${biasIcon} <b>${biasText} — gợi ý theo quy tắc</b>`);
      lines.push(`   🎯 Vào lệnh: $${sgOff.entry.toFixed(2)}`);
      lines.push(`   🛑 Dừng lỗ (SL): $${sgOff.sl.toFixed(2)} <i>(rủi ro ~${sgOff.slDist.toFixed(2)} điểm)</i>`);
      lines.push(`   💰 Chốt lời: TP1 $${sgOff.tp1.toFixed(2)} | TP2 $${sgOff.tp2.toFixed(2)} | TP3 $${sgOff.tp3.toFixed(2)}`);
      lines.push(`   ⚖️ R:R 1:1 / 1:2 / 1:3`);
    } else {
      lines.push("");
      lines.push("⚪ Tín hiệu mâu thuẫn — đứng ngoài, đợi xác nhận hướng.");
    }
  }

  const msg = lines.join("\n");
  const sent = await sendTelegram(env, msg, false, "HTML");
  if (sent) await markDeepAnalysisSent(env, mode);
  const logTag = mode === "mega"
    ? `dollar=$${mega.dollarMove.toFixed(2)} dir=${mega.direction} score=${reversal?.score}`
    : `alerts=${alerts.length}`;
  console.log(`[deep:${mode}] ${sent ? "sent" : "send_fail"}: ${logTag} ai=${!!aiResult}`);
  return { sent, mode, ai: !!aiResult };
}

// Backward-compat alias — endpoint /test-megamove + cũ vẫn dùng tên cũ
async function runMegaMoveAnalysis(env, ctx) {
  return runDeepAnalysis(env, { ...ctx, mode: "mega", alerts: ctx.extraAlerts || ctx.alerts || [] });
}

// ──────────────────────────────────────────────────────────
// Telegram send
// ──────────────────────────────────────────────────────────
/**
 * Gửi message tới chat đã configure (cho cron alert).
 * autoDelete mặc định true — cảnh báo giá sẽ tự xoá sau 1h.
 */
async function sendTelegram(env, text, autoDelete = true, parseMode = "Markdown") {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) {
      console.log(`[telegram] send failed ${r.status} (mode=${parseMode}): ${(await r.text()).slice(0, 300)}`);
      return false;
    }
    if (autoDelete) {
      try {
        const data = await r.json();
        const messageId = data?.result?.message_id;
        if (messageId) await scheduleAutoDelete(env, env.TELEGRAM_CHAT_ID, messageId);
      } catch {}
    }
    return true;
  } catch (e) {
    console.log(`[telegram] error: ${e.message}`);
    return false;
  }
}

// Helper: trend assessment từ EMA alignment + price position
function getTrendAssessment(latest) {
  if (!latest.ema200 || !latest.ema50 || !latest.ema21) return null;
  const c = latest.close;
  if (c > latest.ema200 && latest.ema21 > latest.ema50 && latest.ema50 > latest.ema200)
    return { label: "Tăng mạnh (Strong Bullish)", emoji: "🚀", note: "EMA21>50>200, giá trên EMA200" };
  if (c > latest.ema50 && c > latest.ema200)
    return { label: "Tăng (Bullish)", emoji: "🟢", note: "Giá trên EMA50 và EMA200" };
  if (c < latest.ema200 && latest.ema21 < latest.ema50 && latest.ema50 < latest.ema200)
    return { label: "Giảm mạnh (Strong Bearish)", emoji: "🔻", note: "EMA21<50<200, giá dưới EMA200" };
  if (c < latest.ema50 && c < latest.ema200)
    return { label: "Giảm (Bearish)", emoji: "🔴", note: "Giá dưới EMA50 và EMA200" };
  return { label: "Đi ngang (Sideways)", emoji: "↔️", note: "Giá giữa các EMA, chưa rõ xu hướng" };
}

// Helper: collect key levels around current price (label tiếng Việt)
function getKeyLevelsAround(latest, pivots, currentPrice) {
  const levels = [];
  const add = (price, label) => {
    if (price != null && !isNaN(price)) levels.push({ price, label });
  };
  add(latest.bbUpper, "Biên trên Bollinger (BB upper)");
  add(latest.bbLower, "Biên dưới Bollinger (BB lower)");
  add(latest.ema21, "Đường EMA 21");
  add(latest.ema50, "Đường EMA 50");
  add(latest.ema200, "Đường EMA 200");
  add(latest.recentHigh, "Đỉnh 50 nến");
  add(latest.recentLow, "Đáy 50 nến");
  if (pivots) {
    add(pivots.r2, "Điểm xoay R2 (Pivot)");
    add(pivots.r1, "Điểm xoay R1 (Pivot)");
    add(pivots.s1, "Điểm xoay S1 (Pivot)");
    add(pivots.s2, "Điểm xoay S2 (Pivot)");
  }
  return {
    above: levels.filter(l => l.price > currentPrice).sort((a, b) => a.price - b.price).slice(0, 3),
    below: levels.filter(l => l.price < currentPrice).sort((a, b) => b.price - a.price).slice(0, 3),
  };
}

// Helper: tạo 2-3 kịch bản dựa trên alert types + trend + levels
function generateScenarios(alerts, trend, lv, latest) {
  const scenarios = [];
  const c = latest.close;
  const isUptrend = trend?.label.includes("Tăng");
  const isDowntrend = trend?.label.includes("Giảm");

  const hasRsiExt = alerts.some(a => /RSI quá/.test(a.text));
  const hasBbBreak = alerts.some(a => /BB upper|BB lower/.test(a.text));
  const hasLiqSweep = alerts.some(a => /sweep/i.test(a.text));
  const hasPivotBreak = alerts.some(a => /pivot/i.test(a.text));
  const hasCross = alerts.some(a => /Cross|cắt/.test(a.text));

  // 1. Tiếp diễn theo xu hướng
  if (isUptrend && lv.above[0]) {
    scenarios.push(`Tiếp diễn *TĂNG GIÁ (Bullish)*: phá ${lv.above[0].label} *$${lv.above[0].price.toFixed(2)}* → mục tiêu ${lv.above[1] ? `*$${lv.above[1].price.toFixed(2)}*` : "mức kháng cự kế tiếp"}`);
  }
  if (isDowntrend && lv.below[0]) {
    scenarios.push(`Tiếp diễn *GIẢM GIÁ (Bearish)*: phá ${lv.below[0].label} *$${lv.below[0].price.toFixed(2)}* → mục tiêu ${lv.below[1] ? `*$${lv.below[1].price.toFixed(2)}*` : "mức hỗ trợ kế tiếp"}`);
  }

  // 2. Hồi giá nhẹ (RSI cực trị hoặc phá BB trong trend)
  if (hasRsiExt || hasBbBreak) {
    if (isUptrend && lv.below[0]) {
      scenarios.push(`Hồi giá (pullback) nhẹ về ${lv.below[0].label} *$${lv.below[0].price.toFixed(2)}* → nảy lên tiếp tục xu hướng tăng`);
    } else if (isDowntrend && lv.above[0]) {
      scenarios.push(`Hồi giá (bounce) nhẹ về ${lv.above[0].label} *$${lv.above[0].price.toFixed(2)}* → bị từ chối, tiếp tục xu hướng giảm`);
    }
  }

  // 3. Đảo chiều (quét thanh khoản — liquidity sweep)
  if (hasLiqSweep) {
    const isUpSweep = alerts.some(a => /sweep TRÊN/.test(a.text));
    if (isUpSweep && lv.below[1]) {
      scenarios.push(`Đảo chiều *GIẢM GIÁ (Bearish)* — dòng tiền lớn quét lệnh dừng lỗ phía trên → đẩy xuống *$${lv.below[1].price.toFixed(2)}*`);
    } else if (!isUpSweep && lv.above[1]) {
      scenarios.push(`Đảo chiều *TĂNG GIÁ (Bullish)* — dòng tiền lớn quét lệnh dừng lỗ phía dưới → đẩy lên *$${lv.above[1].price.toFixed(2)}*`);
    }
  }

  // 4. Tín hiệu giao cắt (cross) — báo đổi xu hướng
  if (hasCross && scenarios.length < 3) {
    if (lv.above[0] && lv.below[0]) {
      scenarios.push(`Giao cắt báo đổi xu hướng → theo dõi nến đóng cửa ${isUptrend ? "trên" : "dưới"} *$${(isUptrend ? lv.above[0] : lv.below[0]).price.toFixed(2)}* để xác nhận`);
    }
  }

  // Mặc định nếu không có kịch bản rõ
  if (scenarios.length === 0 && lv.above[0] && lv.below[0]) {
    scenarios.push(`Đi ngang (Sideways) trong vùng *$${lv.below[0].price.toFixed(2)}* – *$${lv.above[0].price.toFixed(2)}*`);
    scenarios.push(`Phá vỡ ra ngoài vùng → đi theo hướng phá vỡ (>1×ATR = ${latest.atr?.toFixed(1)} điểm)`);
  }

  return scenarios.slice(0, 3);
}

// Fallback rule-based khi AI hoàn toàn fail (Gemini outage + Workers AI timeout).
// User vẫn nhận được tóm tắt kỹ thuật + gợi ý lệnh rule-based, không phải error message.
function buildRuleBasedFallback(latest, pivots, tf, horizon) {
  const fmt2 = (n) => (typeof n === "number" && !isNaN(n)) ? n.toFixed(2) : "?";
  const trend = getTrendAssessment(latest);
  const lv = getKeyLevelsAround(latest, pivots, latest.close);

  let m = `<b>🥇 Phân tích XAU/USD ${tf}</b> — Horizon ${horizon}\n`;
  m += `<i>⚠️ AI tạm thời quá tải (Gemini overload + Workers AI timeout). Hiển thị phân tích rule-based:</i>\n\n`;
  m += `Giá hiện tại: <b>$${fmt2(latest.close)}</b>\n`;

  if (trend) {
    m += `\n📈 <b>Xu hướng:</b> ${trend.emoji} ${trend.label}\n   <i>${trend.note}</i>\n`;
  }

  // RSI signal
  if (latest.rsi != null) {
    const r = latest.rsi;
    const sig = r > 70 ? "Quá mua (Overbought) — coi chừng điều chỉnh giảm"
              : r < 30 ? "Quá bán (Oversold) — khả năng hồi phục"
              : "Trung tính";
    m += `\n📊 <b>RSI(14):</b> <b>${r.toFixed(1)}</b> — ${sig}\n`;
  }
  if (latest.atr != null) {
    m += `📏 <b>ATR(14):</b> ${fmt2(latest.atr)} điểm — biên độ trung bình mỗi nến\n`;
  }

  // Key levels
  if (lv.above.length || lv.below.length) {
    m += `\n📍 <b>Mức giá cần quan sát:</b>\n`;
    for (const l of lv.above) m += `▲ <b>$${fmt2(l.price)}</b> ${l.label} <i>(+${(l.price - latest.close).toFixed(2)})</i>\n`;
    for (const l of lv.below) m += `▼ <b>$${fmt2(l.price)}</b> ${l.label} <i>(-${(latest.close - l.price).toFixed(2)})</i>\n`;
  }

  // Trade suggestion: trong fallback chỉ có trend (không có alerts).
  // Tạm dùng trend strong → MUA/BÁN, ATR-based SL/TP.
  let sg = null;
  if (trend && latest.atr > 0) {
    const c = latest.close;
    const atr = latest.atr;
    const isBull = trend.label.includes("Tăng");
    const isBear = trend.label.includes("Giảm");
    if (isBull || isBear) {
      const dir = isBull ? "BUY" : "SELL";
      const slDist = Math.max(1.5 * atr, lv[isBull ? "below" : "above"][0]
        ? Math.abs(c - lv[isBull ? "below" : "above"][0].price) + 0.3 * atr
        : 1.5 * atr);
      sg = isBull
        ? { dir, entry: c, sl: c - slDist, tp1: c + slDist, tp2: c + 2 * slDist, tp3: c + 3 * slDist, slDist }
        : { dir, entry: c, sl: c + slDist, tp1: c - slDist, tp2: c - 2 * slDist, tp3: c - 3 * slDist, slDist };
    }
  }
  if (sg) {
    const dirLabel = sg.dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
    const dirIcon = sg.dir === "BUY" ? "🟢" : "🔴";
    m += `\n<b>🎯 Gợi ý vào lệnh:</b> ${dirIcon} <b>${dirLabel}</b>\n`;
    m += `📍 Điểm vào (Entry): <b>$${fmt2(sg.entry)}</b>\n`;
    m += `🛑 Cắt lỗ (SL): <b>$${fmt2(sg.sl)}</b> <i>(rủi ro ~${sg.slDist.toFixed(2)} điểm)</i>\n`;
    m += `🎯 Chốt lời 1 (TP1, R:R 1:1): <b>$${fmt2(sg.tp1)}</b>\n`;
    m += `🎯 Chốt lời 2 (TP2, R:R 1:2): <b>$${fmt2(sg.tp2)}</b>\n`;
    m += `🎯 Chốt lời 3 (TP3, mở rộng): <b>$${fmt2(sg.tp3)}</b>\n`;
  } else {
    m += `\n<b>🎯 Gợi ý:</b> Tín hiệu không rõ — đứng ngoài, đợi xác nhận hướng.\n`;
  }

  m += `\n<i>💡 Phân tích này dựa trên quy tắc kỹ thuật cố định. Khi AI hoạt động lại sẽ cho phân tích sâu hơn (bức tranh, lý do, rủi ro). Thử lại sau 1-2 phút.</i>`;
  return m;
}

// Helper: tạo gợi ý vào lệnh rule-based (Entry / SL / TP1-2-3) cho cảnh báo giá
// Logic: chấm điểm bull/bear từ alerts + xu hướng → ra hướng. Entry = giá hiện tại.
// SL = max(1.2×ATR, swing buffer + 0.3×ATR). TP1=1R, TP2=2R, TP3=mức kháng/hỗ trợ kế tiếp hoặc 3R.
function generateTradeSuggestion(latest, alerts, trend, lv) {
  if (!latest.atr || latest.atr <= 0) return null;
  const c = latest.close;
  const atr = latest.atr;

  // Chấm điểm bull/bear từ nội dung alerts (tiếng Việt)
  let bullScore = 0, bearScore = 0;
  for (const a of alerts) {
    const t = a.text;
    if (/quá bán|Oversold|sweep DƯỚI|Golden Cross|Giao cắt vàng|cắt lên|BB upper|biên trên|TĂNG|Pivot.*lên|piv_up|đẩy lên/i.test(t)) bullScore++;
    if (/quá mua|Overbought|sweep TRÊN|Death Cross|Giao cắt tử thần|cắt xuống|BB lower|biên dưới|GIẢM|Pivot.*xuống|piv_dn|đẩy xuống/i.test(t)) bearScore++;
  }
  // Xu hướng đóng góp 0.5 điểm
  const isBull = trend?.label.includes("Tăng");
  const isBear = trend?.label.includes("Giảm");
  if (isBull) bullScore += 0.5;
  if (isBear) bearScore += 0.5;

  let dir = null;
  if (bullScore >= bearScore + 1) dir = "BUY";
  else if (bearScore >= bullScore + 1) dir = "SELL";
  else return null; // tín hiệu mâu thuẫn → đứng ngoài

  const entry = c;
  let sl, tp1, tp2, tp3;

  if (dir === "BUY") {
    // SL dưới: lớn hơn giữa 1.2×ATR và (khoảng cách tới swing low gần nhất + 0.3×ATR buffer)
    const swingDist = lv.below[0] ? (c - lv.below[0].price) + 0.3 * atr : 0;
    const slDist = Math.max(1.2 * atr, swingDist);
    sl = entry - slDist;
    const r = entry - sl;
    tp1 = entry + r;          // R:R 1:1 — chốt nhanh
    tp2 = entry + 2 * r;      // R:R 1:2 — kỳ vọng
    // TP3: kháng cự kế tiếp xa hơn TP2, hoặc 3R nếu không có
    tp3 = (lv.above[1] && lv.above[1].price > entry + 2 * r) ? lv.above[1].price : entry + 3 * r;
  } else {
    // SELL — mirror
    const swingDist = lv.above[0] ? (lv.above[0].price - c) + 0.3 * atr : 0;
    const slDist = Math.max(1.2 * atr, swingDist);
    sl = entry + slDist;
    const r = sl - entry;
    tp1 = entry - r;
    tp2 = entry - 2 * r;
    tp3 = (lv.below[1] && lv.below[1].price < entry - 2 * r) ? lv.below[1].price : entry - 3 * r;
  }

  return { dir, entry, sl, tp1, tp2, tp3, slDist: Math.abs(entry - sl) };
}

// Helper: tính bias đơn cho 1 candle (dùng cho block xác nhận đa khung)
function biasOf(l) {
  if (!l || l.ema200 == null || l.ema50 == null || l.ema21 == null) return null;
  if (l.close > l.ema200 && l.ema21 > l.ema50 && l.ema50 > l.ema200) return { icon: "🚀", short: "Tăng mạnh", dir: "up" };
  if (l.close > l.ema50 && l.close > l.ema200) return { icon: "🟢", short: "Tăng giá", dir: "up" };
  if (l.close < l.ema200 && l.ema21 < l.ema50 && l.ema50 < l.ema200) return { icon: "🔻", short: "Giảm mạnh", dir: "down" };
  if (l.close < l.ema50 && l.close < l.ema200) return { icon: "🔴", short: "Giảm giá", dir: "down" };
  return { icon: "↔️", short: "Đi ngang", dir: "side" };
}

function formatAlertMessage(latest, alerts, pivots, mtfContext = null) {
  const t = new Date().toISOString().slice(0, 16).replace("T", " ");
  let m = `🥇 *Cảnh báo giá XAU/USD* (đa khung 5p+15p+1g, trigger 15p)\n`;
  m += `Giá hiện tại: *$${latest.close.toFixed(2)}* — ${t} UTC\n\n`;

  m += `*🔔 Sự kiện vừa kích hoạt (khung 15p):*\n`;
  for (const a of alerts) {
    m += `${a.icon} ${a.text}\n`;
    if (a.suggestion) m += `   💡 _${a.suggestion}_\n`;
  }

  // 🌊 Xác nhận đa khung — show bias + RSI cho mỗi khung
  if (mtfContext) {
    m += `\n*🌊 Xác nhận đa khung:*\n`;
    const dirs = [];
    for (const tfKey of ["5p", "15p", "1g"]) {
      const c = mtfContext[tfKey];
      if (!c) {
        m += `• *${tfKey}*: _không có data_\n`;
        continue;
      }
      const b = biasOf(c);
      const rsi = c.rsi != null ? c.rsi.toFixed(0) : "?";
      const rsiTag = c.rsi == null ? "" : (c.rsi > 70 ? " (Quá mua)" : c.rsi < 30 ? " (Quá bán)" : "");
      m += `${b ? b.icon : "❓"} *${tfKey}*: ${b ? b.short : "?"} | RSI ${rsi}${rsiTag}\n`;
      if (b) dirs.push(b.dir);
    }
    // Đồng thuận
    const upN = dirs.filter(d => d === "up").length;
    const dnN = dirs.filter(d => d === "down").length;
    if (upN === 3) m += `_↳ Đồng thuận TĂNG GIÁ 3/3 ✅ (tín hiệu tin cậy cao)_\n`;
    else if (dnN === 3) m += `_↳ Đồng thuận GIẢM GIÁ 3/3 ✅ (tín hiệu tin cậy cao)_\n`;
    else if (upN === 2) m += `_↳ Đa số TĂNG GIÁ 2/3 ⚠️ (1 khung mâu thuẫn — thận trọng)_\n`;
    else if (dnN === 2) m += `_↳ Đa số GIẢM GIÁ 2/3 ⚠️ (1 khung mâu thuẫn — thận trọng)_\n`;
    else m += `_↳ Khung phân vân — tín hiệu yếu, ưu tiên đứng ngoài_\n`;
  }

  // Xu hướng tổng (theo 15p)
  const trend = getTrendAssessment(latest);
  if (trend) {
    m += `\n📈 *Xu hướng tổng (15p):* ${trend.emoji} ${trend.label}\n`;
    m += `   _${trend.note}_\n`;
  }

  // Mức giá quan sát (Việt-Anh)
  const lv = getKeyLevelsAround(latest, pivots, latest.close);
  if (lv.above.length || lv.below.length) {
    m += `\n📍 *Mức giá cần quan sát:*\n`;
    for (const l of lv.above) m += `▲ *$${l.price.toFixed(2)}* ${l.label} _(+${(l.price - latest.close).toFixed(2)})_\n`;
    for (const l of lv.below) m += `▼ *$${l.price.toFixed(2)}* ${l.label} _(-${(latest.close - l.price).toFixed(2)})_\n`;
  }

  // 🎯 Gợi ý vào lệnh — Entry/SL/TP1-2-3, có boost từ MTF consensus nếu align
  const sg = generateTradeSuggestion(latest, alerts, trend, lv);
  if (sg) {
    const dirLabel = sg.dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
    const dirIcon = sg.dir === "BUY" ? "🟢" : "🔴";

    // Đánh giá độ tin cậy bằng MTF consensus
    let confidence = "trung bình";
    if (mtfContext) {
      const dirs = ["5p", "15p", "1g"]
        .map(k => biasOf(mtfContext[k]))
        .filter(Boolean)
        .map(b => b.dir);
      const wantDir = sg.dir === "BUY" ? "up" : "down";
      const aligned = dirs.filter(d => d === wantDir).length;
      if (aligned === 3) confidence = "*CAO* (3/3 khung đồng thuận)";
      else if (aligned === 2) confidence = "trung bình (2/3 khung đồng thuận)";
      else confidence = "_thấp_ (chỉ 1/3 khung đồng thuận — cẩn trọng)";
    }

    m += `\n*🎯 Gợi ý vào lệnh:* ${dirIcon} *${dirLabel}* | Tin cậy: ${confidence}\n`;
    m += `📍 Điểm vào (Entry): *$${sg.entry.toFixed(2)}*\n`;
    m += `🛑 Cắt lỗ (SL): *$${sg.sl.toFixed(2)}* _(rủi ro ~${sg.slDist.toFixed(2)} điểm)_\n`;
    m += `🎯 Chốt lời 1 (TP1, R:R 1:1 — an toàn): *$${sg.tp1.toFixed(2)}*\n`;
    m += `🎯 Chốt lời 2 (TP2, R:R 1:2 — kỳ vọng): *$${sg.tp2.toFixed(2)}*\n`;
    m += `🎯 Chốt lời 3 (TP3 — mở rộng theo xu hướng): *$${sg.tp3.toFixed(2)}*\n`;
    m += `_⚠️ Gợi ý theo quy tắc, không phải khuyến nghị đầu tư. Xác nhận thêm bằng /15p hoặc /1h trước khi vào lệnh._\n`;
  } else {
    m += `\n*🎯 Gợi ý vào lệnh:* ⚪ Tín hiệu chưa đồng nhất — đứng ngoài, đợi xác nhận.\n`;
  }

  // Kịch bản có thể (mô tả định tính)
  const scenarios = generateScenarios(alerts, trend, lv, latest);
  if (scenarios.length) {
    m += `\n🔮 *Kịch bản có thể xảy ra:*\n`;
    scenarios.forEach((s, i) => { m += `${i + 1}. ${s}\n`; });
  }

  // Chỉ báo tóm tắt (15p)
  m += `\n_Chỉ báo (15p): RSI ${latest.rsi?.toFixed(1)} | ATR ${latest.atr?.toFixed(2)} | EMA 21/50/200: ${latest.ema21?.toFixed(0)}/${latest.ema50?.toFixed(0)}/${latest.ema200?.toFixed(0)}_\n`;
  if (pivots) {
    m += `_Điểm xoay (Pivot): R2 ${pivots.r2.toFixed(1)} | R1 ${pivots.r1.toFixed(1)} | PP ${pivots.pp.toFixed(1)} | S1 ${pivots.s1.toFixed(1)} | S2 ${pivots.s2.toFixed(1)}_\n`;
  }
  m += `\n[Mở ứng dụng](https://xau-smc-analyzer.pages.dev/)`;
  return m;
}

// ──────────────────────────────────────────────────────────
// Reusable: call Gemini với KV cache + rotation + Workers AI fallback
// (Dùng từ Telegram bot handler — khác /v1beta route ở chỗ trả parsed JSON)
// ──────────────────────────────────────────────────────────
async function callGeminiSmart(env, body, model = "gemini-2.5-flash") {
  const bodyStr = JSON.stringify(body);
  const hash = await hashBody(bodyStr);
  const cacheKey = `gemini:${model}:${hash}`;
  const wantJson = body?.generationConfig?.responseMimeType === "application/json";

  // Cache hit — chỉ trả nếu valid (đã filter ở write side, nhưng safety)
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

  // Validate response: với json mode, content text PHẢI parse được JSON
  const isValidResponse = (resp) => {
    if (!resp) return false;
    if (!wantJson) return true;
    const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return false;
    return extractJSON(text) !== null;
  };

  // Try Gemini keys
  const allKeys = collectGeminiKeys(env);
  const active = allKeys.filter(k => !isKeyOnCooldown(k.label));
  const tryKeys = active.length > 0 ? active : allKeys;

  // Worker waitUntil chỉ ~30s sau response → phải fail-fast để có cơ hội thử
  // Workers AI fallback. Chỉ thử TỐI ĐA 2 key Gemini, mỗi key timeout 12s.
  // Worst case: 2×12 = 24s + Workers AI ~5s = 29s ≈ 30s limit.
  const GEMINI_TIMEOUT_MS = 12_000;
  const MAX_KEYS_TO_TRY = 2;

  let attempted = 0;
  for (const { key, label } of tryKeys) {
    if (attempted >= MAX_KEYS_TO_TRY) {
      console.log(`[gemini-smart] đã thử ${MAX_KEYS_TO_TRY} key, fall through Workers AI`);
      break;
    }
    attempted++;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const r = await fetch(`${GOOGLE_BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (r.status === 200) {
        clearKeyCooldown(label);
        const json = await r.json();
        if (isValidResponse(json)) {
          console.log(`[gemini-smart] ${label} OK in ${Date.now() - t0}ms`);
          await cachePut(env, cacheKey, JSON.stringify(json));
          return json;
        }
        // Response 200 nhưng JSON invalid (content empty/safety filter/...) → log + thử key khác
        const t = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const finish = json?.candidates?.[0]?.finishReason || "?";
        console.log(`[gemini-smart] ${label} invalid response (finish=${finish}, text len=${t.length}, tail=${t.slice(-100)})`);
        continue;
      }
      console.log(`[gemini-smart] ${label} HTTP ${r.status} in ${Date.now() - t0}ms`);
      markKeyCooldown(label, r.status);
    } catch (e) {
      clearTimeout(tid);
      const isAbort = e.name === "AbortError";
      console.log(`[gemini-smart] ${label} ${isAbort ? "TIMEOUT" : "error"} after ${Date.now() - t0}ms: ${e.message}`);
      // Abort: cooldown như 500 (2 phút) để skip key này, thử key khác / Workers AI
      if (isAbort) markKeyCooldown(label, 500);
    }
  }

  // Fallback Workers AI
  const ai = await tryWorkersAI(env, bodyStr);
  if (ai && isValidResponse(ai)) {
    await cachePut(env, cacheKey, JSON.stringify(ai));
    return ai;
  }
  if (ai) {
    const t = ai?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`[ai-fallback] invalid response (text len=${t.length}, tail=${t.slice(-100)})`);
  }
  return ai; // Return even if invalid để caller có thể debug
}

function extractText(geminiResp) {
  return geminiResp?.candidates?.[0]?.content?.parts
    ?.map(p => p.text || "").join("\n") || null;
}

// ──────────────────────────────────────────────────────────
// Telegram bot — receive group messages, parse commands, reply
// ──────────────────────────────────────────────────────────
/**
 * Gửi message Telegram. parseMode default "Markdown" cho static; pass null
 * khi text đến từ AI (tránh Bad Request entity parse error do AI output
 * có ký tự Markdown không cân: ** lẻ, _ trong tên biến, ngoặc...).
 * Auto-fallback sang plain text khi 400.
 */
/**
 * Telegram "typing..." indicator — hiện ~5s rồi tự biến mất.
 * Tốt hơn gửi message "Đang scan..." rồi để lại trong chat.
 */
async function sendChatAction(env, chatId, action = "typing") {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {}
}

// ──────────────────────────────────────────────────────────
// Auto-delete: lưu KV { del:{ts}:{chatId}:{messageId} = "1" } với TTL = delay+buffer.
// Cron 5p quét list prefix "del:", với key có ts <= now → call deleteMessage + xoá KV entry.
//
// Thời gian delay user-configurable qua /xoa <time>. KV "config:auto_delete_min"
// lưu số phút (vd "60", "120") hoặc "off" để tắt auto-delete.
// ──────────────────────────────────────────────────────────
const DEFAULT_AUTO_DELETE_MIN = 60; // mặc định 1 giờ

/**
 * Đọc config auto-delete (phút) từ KV. Trả về delayMs (số mili-giây).
 * Trả 0 nếu user đã tắt (/xoa off).
 */
async function getAutoDeleteMs(env) {
  if (!env.CACHE) return DEFAULT_AUTO_DELETE_MIN * 60 * 1000;
  try {
    const v = await env.CACHE.get("config:auto_delete_min");
    if (v === "off") return 0;
    if (v) {
      const n = parseInt(v);
      if (!isNaN(n) && n > 0) return n * 60 * 1000;
    }
  } catch {}
  return DEFAULT_AUTO_DELETE_MIN * 60 * 1000;
}

async function setAutoDeleteMin(env, minOrOff) {
  if (!env.CACHE) return false;
  await env.CACHE.put("config:auto_delete_min", String(minOrOff));
  return true;
}

function msToReadable(ms) {
  if (ms <= 0) return "TẮT";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} phút`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} giờ` : `${h.toFixed(1)} giờ`;
}

async function scheduleAutoDelete(env, chatId, messageId, delayMsOverride = null) {
  if (!env.CACHE || !messageId) return;
  const delayMs = delayMsOverride != null ? delayMsOverride : await getAutoDeleteMs(env);
  if (delayMs <= 0) return; // user đã /xoa off
  const ts = Date.now() + delayMs;
  const key = `del:${ts}:${chatId}:${messageId}`;
  // TTL = delay + 10 phút buffer (phòng cron lệch hoặc delete fail tạm)
  try {
    await env.CACHE.put(key, "1", { expirationTtl: Math.ceil(delayMs / 1000) + 600 });
  } catch (e) {
    console.log(`[auto-delete] schedule fail: ${e.message}`);
  }
}

async function cleanupExpiredMessages(env) {
  if (!env.CACHE || !env.TELEGRAM_BOT_TOKEN) return { deleted: 0, failed: 0, errors: [] };
  const errors = [];
  try {
    let cursor;
    let deleted = 0, failed = 0, skipped = 0;
    do {
      const list = await env.CACHE.list({ prefix: "del:", cursor });
      const now = Date.now();
      for (const item of list.keys) {
        const parts = item.name.split(":");
        if (parts.length < 4) { await env.CACHE.delete(item.name); continue; }
        const ts = parseInt(parts[1]);
        if (isNaN(ts) || ts > now) { skipped++; continue; }
        // chat_id phải là INTEGER cho Telegram API. KV split giữ string,
        // parseInt để chuyển. Supergroup id âm (vd -1003960272432) — parseInt giữ dấu.
        const chatId = parts[2].startsWith("-") ? parseInt(parts[2]) : parts[2];
        const messageId = parseInt(parts[3]);
        try {
          const r = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
            }
          );
          if (r.ok) {
            deleted++;
          } else {
            failed++;
            const body = await r.text();
            const err = `msg ${messageId}: HTTP ${r.status} ${body.slice(0, 150)}`;
            errors.push(err);
            console.log(`[auto-delete] fail ${err}`);
          }
          await env.CACHE.delete(item.name);
        } catch (e) {
          failed++;
          errors.push(`msg ${messageId}: ${e.message}`);
          console.log(`[auto-delete] fail msg ${messageId}: ${e.message}`);
        }
      }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);
    if (deleted > 0 || failed > 0) {
      console.log(`[auto-delete] xoá ${deleted} OK, ${failed} fail, ${skipped} đợi`);
    }
    return { deleted, failed, errors };
  } catch (e) {
    console.log(`[auto-delete] cleanup error: ${e.message}`);
    return { deleted: 0, failed: 0, errors: [e.message] };
  }
}

/**
 * Gửi message Telegram + (mặc định) tự động xoá sau 1 giờ để khỏi nhiễu group.
 * Pass autoDelete=false cho message dài hạn (vd /help, /tudien).
 */
async function sendTelegramTo(env, chatId, text, replyToMessageId = null, parseMode = "Markdown", autoDelete = true) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const buildBody = (mode) => {
    const b = { chat_id: chatId, text, disable_web_page_preview: true };
    if (mode) b.parse_mode = mode;
    if (replyToMessageId) b.reply_to_message_id = replyToMessageId;
    return JSON.stringify(b);
  };
  const post = async (mode) => {
    return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildBody(mode),
    });
  };
  try {
    let r = await post(parseMode);
    let bodyText = null;
    // Nếu parse mode fail (Markdown/HTML) → retry plain text
    if (!r.ok && (parseMode === "Markdown" || parseMode === "HTML")) {
      bodyText = await r.text();
      if (bodyText.includes("can't parse entities") || bodyText.includes("parse_mode")) {
        console.log(`[tg-reply] ${parseMode} fail, retry plain. Err: ${bodyText.slice(0, 150)}`);
        r = await post(null);
        bodyText = null;
      } else {
        console.log(`[tg-reply] ${r.status}: ${bodyText.slice(0, 200)}`);
      }
    } else if (!r.ok) {
      bodyText = await r.text();
      console.log(`[tg-reply] ${r.status}: ${bodyText.slice(0, 200)}`);
    }

    // Schedule auto-delete sau 1h nếu gửi thành công + opt-in
    if (r.ok && autoDelete) {
      try {
        const data = await r.json();
        const messageId = data?.result?.message_id;
        if (messageId) await scheduleAutoDelete(env, chatId, messageId);
      } catch {}
    }
    return r.ok;
  } catch (e) {
    console.log(`[tg-reply] error: ${e.message}`);
    return false;
  }
}

const TF_TO_TD = { "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" };
const TF_HORIZON = { "5m": "30-60 phút", "15m": "2-4 giờ", "1h": "1-2 ngày", "4h": "2-3 ngày", "1d": "1-2 tuần" };

// HTML escape cho Telegram parse_mode=HTML (chỉ cần escape <, >, &)
function htmlEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Convert Markdown-flavored text (AI output thường có) → Telegram HTML parse mode.
// Telegram Markdown legacy chỉ hỗ trợ *bold*, _italic_, `code` — không hỗ trợ
// **bold** (Markdown V2 style) → ta tự convert. Cũng escape HTML special chars
// đúng cách, không bị inject thẻ ngoài ý muốn.
function markdownToTgHtml(s) {
  if (!s) return "";
  // Placeholder để escape HTML mà không phá tag mình sẽ generate
  const BO = "BO", BC = "BC";
  const IO = "IO", IC = "IC";
  const CO = "CO", CC = "CC";

  let out = String(s);
  // 1) Bold: **X** / __X__ / *X* (single, không trong word)
  out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, `${BO}$1${BC}`);
  out = out.replace(/__([^_\n][^_\n]*?)__/g, `${BO}$1${BC}`);
  out = out.replace(/(^|[^\w*])\*([^*\n][^*\n]*?)\*(?=[^\w*]|$)/g, `$1${BO}$2${BC}`);
  // 2) Code: `X`
  out = out.replace(/`([^`\n]+?)`/g, `${CO}$1${CC}`);
  // 3) Italic: _X_ (chỉ khi không ở giữa word — phổ biến với placeholder)
  out = out.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, `$1${IO}$2${IC}`);

  // Escape HTML
  out = out.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Restore tag
  out = out
    .replace(new RegExp(BO, "g"), "<b>")
    .replace(new RegExp(BC, "g"), "</b>")
    .replace(new RegExp(IO, "g"), "<i>")
    .replace(new RegExp(IC, "g"), "</i>")
    .replace(new RegExp(CO, "g"), "<code>")
    .replace(new RegExp(CC, "g"), "</code>");
  return out;
}

// Extract JSON từ AI response — robust với multiple format quirks
function extractJSON(text) {
  if (!text) return null;
  text = text.trim();
  // 1. Direct parse
  try { return JSON.parse(text); } catch {}
  // 2. Markdown code block ```json...```
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  // 3. Tìm { ... } cuối cùng (có thể có text trước/sau)
  const start = text.indexOf("{");
  if (start === -1) return null;
  const end = text.lastIndexOf("}");
  if (end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  // 4. Truncated JSON: scan đến } cuối cùng ở depth 0 từ start
  let depth = 0, lastValidEnd = -1, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) lastValidEnd = i;
    }
  }
  if (lastValidEnd > start) {
    try { return JSON.parse(text.slice(start, lastValidEnd + 1)); } catch {}
  }
  return null;
}

function glossaryMessage() {
  return `📚 *Từ điển thuật ngữ XAU/USD*

*Smart Money Concepts (SMC):*
• BOS (Break of Structure) — Phá vỡ cấu trúc
• CHOCH (Change of Character) — Đổi tính chất xu hướng
• OB (Order Block) — Khối lệnh tổ chức
• FVG (Fair Value Gap) — Khoảng trống công bằng
• Liquidity Sweep — Quét thanh khoản (smart money quét stop)
• SMC — Phương pháp dòng tiền thông minh

*Chỉ báo:*
• EMA (Exponential MA) — Đường trung bình hàm mũ
• SMA (Simple MA) — Đường trung bình đơn giản
• RSI (Relative Strength Index) — Chỉ số sức mạnh tương đối
• ATR (Average True Range) — Biên độ thực trung bình
• BB (Bollinger Bands) — Dải Bollinger
• MACD — chỉ báo phân kỳ hội tụ trung bình
• Pivot Point — Điểm xoay (mốc S/R quan trọng)

*Pattern nến:*
• Pin Bar / Hammer / Shooting Star — Nến rút râu
• Engulfing — Nến nhấn chìm
• Marubozu — Nến đặc (body chiếm gần hết range)
• Doji — Nến do dự (open ≈ close)

*Tín hiệu:*
• Golden Cross — Giao cắt vàng (SMA50 cắt lên SMA200)
• Death Cross — Giao cắt tử thần (SMA50 cắt xuống SMA200)
• Divergence — Phân kỳ (RSI/MACD đi ngược price)
• Overbought / Oversold — Quá mua / Quá bán
• Breakout / Breakdown — Phá vỡ kháng cự / Vỡ đáy hỗ trợ
• Bullish / Bearish — Tăng giá / Giảm giá
• Sideways / Consolidation — Đi ngang / Tích lũy
• Reversal / Continuation — Đảo chiều / Tiếp diễn
• Pullback / Retest — Hồi giá ngược trend / Kiểm tra lại
• Rejection — Phản ứng từ chối tại cản
• Exhaustion — Kiệt sức (đà yếu dần)
• Impulse / Correction — Sóng đẩy / Sóng điều chỉnh
• Momentum / Volatility — Động lượng / Biến động

*Trading:*
• Long / Short — Lệnh mua / bán
• Entry / SL / TP — Điểm vào / Cắt lỗ / Chốt lời
• R:R (Risk:Reward) — Tỷ lệ rủi ro/lợi nhuận
• HTF / MTF / LTF — Khung lớn / trung / nhỏ
• Top-down — Phân tích từ HTF xuống LTF
• Pullback — Hồi giá ngược trend
• BTD / STR — Buy The Dip / Sell The Rally`;
}

function helpMessage() {
  return `🥇 *XAU Bot — Lệnh*

*Tức thời (no AI):*
\`/gia\` — giá + indicators 1 khung
\`/nhanh\` — Pulse 5 khung (bias mỗi khung, kết luận chung)

*Quick scan AI (~5s/khung):*
\`/nhanh5p\` \`/nhanh15p\` \`/nhanh1h\` \`/nhanh4h\` \`/nhanh1d\`

*Phân tích chi tiết (~15s/khung, có entry/SL/TP1-2-3):*
\`/5p\` \`/15p\` \`/1h\` \`/4h\` \`/1d\`

*Combo top-down nhiều khung:*
\`/5p15p1h\` — chi tiết 3 khung intraday
\`/1h4h1d\` — chi tiết 3 khung HTF
\`/nhanh5p15p1h\` — scan 3 khung
\`/nhanh1h4h1d\` — scan HTF

*Tin tức (AI tổng hợp + dự đoán):*
\`/tin\` — tổng hợp tin XAU 7 ngày + catalyst sắp tới
\`/tin NFP\` — deep-dive 1 event (3 kịch bản + chiến lược trước/trong/sau)
\`/tin CPI\` \`/tin FOMC\` \`/tin Fed\` \`/tin rate\` \`/tin GDP\` …

*Tư vấn cá nhân (AI):*
\`/ai <câu hỏi>\` — risk management + position sizing
Vd:
• \`/ai vốn 5tr lệnh 0.05 lot SL TP thế nào\`
• \`/ai đã mua giá 4520 hiện lỗ xử lý ra sao\`
• \`/ai muốn risk 2% với SL 8 điểm thì bao nhiêu lot\`

*Inter-market context (correlation):*
Thêm \`oil\` hoặc \`dxy\` (hoặc \`all\`) sau lệnh để kèm context giá dầu / chỉ số đô:
• \`/nhanh oil\` — pulse + giá OIL
• \`/15p dxy\` — phân tích 15p + DXY
• \`/1h oil dxy\` — kèm cả 2
• \`/nhanh1h all\` — quick scan 1h + cả OIL+DXY

*Khác:*
\`/tudien\` — Từ điển thuật ngữ Việt-Anh
\`/xoa <time>\` — Cấu hình thời gian tự xoá tin (vd \`/xoa 30p\`, \`/xoa 1h\`, \`/xoa off\`)

ℹ️ _Bot tự xoá tin (cả phân tích và lệnh user) sau 1 giờ mặc định để khỏi nhiễu group._
_/help, /tudien, /xoa giữ lại không tự xoá. Đổi thời gian: \`/xoa 30p|1h|2h|4h|6h|8h|off\`._

App đầy đủ: [xau-smc-analyzer.pages.dev](https://xau-smc-analyzer.pages.dev)`;
}

// Map lệnh tiếng Việt → TF nội bộ (cho /5p, /15p... = phân tích SMC chi tiết)
const VN_CMD_TO_TF = {
  "/5p": "5m", "/5m": "5m",
  "/15p": "15m", "/15m": "15m",
  "/1h": "1h", "/1g": "1h", "/1gio": "1h",
  "/4h": "4h", "/4g": "4h", "/4gio": "4h",
  "/1d": "1d", "/1ngay": "1d", "/ngay": "1d",
};

// Map lệnh /nhanhXX → TF (quick scan AI theo khung — KHÔNG có /nhanh)
const VN_SCAN_CMD_TO_TF = {
  "/nhanh5p": "5m",
  "/nhanh15p": "15m",
  "/nhanh1h": "1h",
  "/nhanh4h": "4h",
  "/nhanh1d": "1d",
  "/scan": "15m", "/quick": "15m", // backward compat
};
// /nhanh (không TF) = Pulse all-TF overview, không dùng AI, instant

/**
 * Parse combo TF command như /5p15p1h hoặc /nhanh5p15p1h.
 * Trả null nếu không match pattern combo.
 * @returns {null | { isNhanh: boolean, tfs: string[] }}
 */
function parseMultiTfCommand(cmd) {
  if (!cmd.startsWith("/")) return null;
  let body = cmd.slice(1).toLowerCase();
  let isNhanh = false;
  if (body.startsWith("nhanh")) {
    isNhanh = true;
    body = body.slice("nhanh".length);
  }
  if (!body) return null;
  // TF tokens: 5p, 15p, 1h, 4h, 1d (longest match first để 15p không bị parse là 1+5p)
  const tfMap = { "15p": "15m", "5p": "5m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tfTokens = Object.keys(tfMap).sort((a, b) => b.length - a.length); // longest first
  const tfs = [];
  let i = 0;
  while (i < body.length) {
    let matched = false;
    for (const tk of tfTokens) {
      if (body.startsWith(tk, i)) {
        tfs.push(tfMap[tk]);
        i += tk.length;
        matched = true;
        break;
      }
    }
    if (!matched) return null;  // có ký tự lạ → không phải combo
  }
  if (tfs.length < 2) return null;  // single TF đã có handler riêng
  return { isNhanh, tfs };
}

/**
 * Handler /xoa <time> — cấu hình thời gian tự xoá tin của bot.
 * Param: 30p, 1h, 2h, 4h, 6h, 8h, off
 * Không param → hiện cấu hình hiện tại.
 */
async function handleXoaCmd(env, chatId, replyTo, args) {
  // Reply của /xoa KHÔNG auto-delete (config-related, user cần xem rõ)
  const send = (text) => sendTelegramTo(env, chatId, text, replyTo, "HTML", false);

  if (args.length === 0) {
    const ms = await getAutoDeleteMs(env);
    const status = ms === 0 ? "<b>TẮT</b> (tin bot không tự xoá)" : `sau <b>${msToReadable(ms)}</b>`;
    await send(
      `ℹ️ <b>Tự xoá tin:</b> ${status}\n\n` +
      `<b>Đổi cấu hình:</b>\n` +
      `<code>/xoa 30p</code> — xoá sau 30 phút\n` +
      `<code>/xoa 1h</code> — xoá sau 1 giờ (mặc định)\n` +
      `<code>/xoa 2h</code> — xoá sau 2 giờ\n` +
      `<code>/xoa 4h</code> — xoá sau 4 giờ\n` +
      `<code>/xoa 6h</code> — xoá sau 6 giờ\n` +
      `<code>/xoa 8h</code> — xoá sau 8 giờ\n` +
      `<code>/xoa off</code> — TẮT tự xoá\n\n` +
      `<i>Áp dụng cho cả tin bot trả lời + lệnh user gửi (trừ /help, /tudien, /xoa).</i>`
    );
    return;
  }

  const param = args[0].toLowerCase().replace(/[áàảãạâấầẩẫậăắằẳẵặ]/g, "a").replace(/[íìỉĩị]/g, "i");
  const validMap = {
    "off": "off", "tat": "off",
    "30p": 30, "30m": 30, "30min": 30,
    "1h": 60, "1g": 60, "1gio": 60,
    "2h": 120, "2g": 120, "2gio": 120,
    "4h": 240, "4g": 240, "4gio": 240,
    "6h": 360, "6g": 360, "6gio": 360,
    "8h": 480, "8g": 480, "8gio": 480,
  };

  if (!(param in validMap)) {
    await send(
      `❌ Tham số <code>${htmlEsc(args[0])}</code> không hợp lệ.\n` +
      `Dùng: <code>/xoa 30p</code> | <code>1h</code> | <code>2h</code> | <code>4h</code> | <code>6h</code> | <code>8h</code> | <code>off</code>`
    );
    return;
  }

  const value = validMap[param];
  await setAutoDeleteMin(env, value);

  if (value === "off") {
    await send(
      `✅ Đã <b>TẮT</b> tự xoá tin.\n` +
      `Tin bot sẽ giữ lại không tự xoá. Tin đang trong queue (đặt trước đó) vẫn bị xoá theo lịch cũ.\n` +
      `Bật lại bằng <code>/xoa 1h</code>.`
    );
  } else {
    await send(
      `✅ Đã đặt tự xoá tin sau <b>${msToReadable(value * 60 * 1000)}</b>.\n` +
      `Áp dụng cho lệnh kế tiếp. Tin đã đặt lịch trước vẫn theo lịch cũ.`
    );
  }
}

async function handlePriceCmd(env, chatId, replyTo) {
  try {
    const c15 = await fetchTdCandles(env, "15min", 220);
    if (c15.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(c15);
    const l = e[e.length - 1];
    const pivots = await getCachedDailyPivots(env);

    const c = l.close;

    // Trend determination từ EMA alignment
    let trend = "—", trendIcon = "❓", trendColor = "";
    if (l.ema200 != null && l.ema50 != null && l.ema21 != null) {
      if (c > l.ema200 && l.ema21 > l.ema50 && l.ema50 > l.ema200) { trend = "Tăng mạnh"; trendIcon = "🚀"; }
      else if (c > l.ema50 && c > l.ema200) { trend = "Tăng"; trendIcon = "📈"; }
      else if (c < l.ema200 && l.ema21 < l.ema50 && l.ema50 < l.ema200) { trend = "Giảm mạnh"; trendIcon = "🔻"; }
      else if (c < l.ema50 && c < l.ema200) { trend = "Giảm"; trendIcon = "📉"; }
      else { trend = "Sideways"; trendIcon = "↔️"; }
    }

    // RSI status
    const rsiVal = l.rsi;
    let rsiTag = "trung tính";
    if (rsiVal > 75) rsiTag = "QUÁ MUA";
    else if (rsiVal > 70) rsiTag = "cao";
    else if (rsiVal < 25) rsiTag = "QUÁ BÁN";
    else if (rsiVal < 30) rsiTag = "thấp";

    // Collect tất cả mức giá
    const levels = [];
    const add = (price, label) => {
      if (price != null && !isNaN(price)) levels.push({ price, label });
    };
    if (l.bbUpper) add(l.bbUpper, "BB Upper");
    if (l.bbLower) add(l.bbLower, "BB Lower");
    if (l.ema21) add(l.ema21, "EMA 21");
    if (l.ema50) add(l.ema50, "EMA 50");
    if (l.ema200) add(l.ema200, "EMA 200");
    if (pivots) {
      add(pivots.r2, "Pivot R2"); add(pivots.r1, "Pivot R1"); add(pivots.pp, "Pivot PP");
      add(pivots.s1, "Pivot S1"); add(pivots.s2, "Pivot S2");
    }
    const above = levels.filter(lv => lv.price > c).sort((a, b) => a.price - b.price).slice(0, 4);
    const below = levels.filter(lv => lv.price < c).sort((a, b) => b.price - a.price).slice(0, 4);

    let m = `<b>🥇 XAU/USD</b> — 15m\n`;
    m += `Giá: <b>$${c.toFixed(2)}</b>\n\n`;
    m += `${trendIcon} Trend: <b>${trend}</b>\n`;
    m += `RSI(14): <b>${rsiVal?.toFixed(1)}</b> (${rsiTag})\n`;
    m += `EMA 21/50/200: ${l.ema21?.toFixed(2)} / ${l.ema50?.toFixed(2)} / ${l.ema200?.toFixed(2)}\n`;
    m += `SMA 50/200: ${l.sma50?.toFixed(2)} / ${l.sma200?.toFixed(2)} ${l.sma50 > l.sma200 ? "(golden)" : "(death)"}\n`;
    m += `BB(20): ${l.bbLower?.toFixed(2)} – ${l.bbUpper?.toFixed(2)}\n`;

    if (above.length || below.length) {
      m += `\n<b>📍 Mức giá quan trọng:</b>\n`;
      for (const lv of above) {
        m += `▲ <b>$${lv.price.toFixed(2)}</b> — ${htmlEsc(lv.label)} <i>(+${(lv.price - c).toFixed(2)})</i>\n`;
      }
      for (const lv of below) {
        m += `▼ <b>$${lv.price.toFixed(2)}</b> — ${htmlEsc(lv.label)} <i>(-${(c - lv.price).toFixed(2)})</i>\n`;
      }
    }

    await sendTelegramTo(env, chatId, m, replyTo, "HTML");
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

/**
 * /tin — tổng hợp tin tức 7 ngày + AI dự đoán phản ứng XAU.
 */
const NEWS_FEEDS = [
  { url: "https://www.fxstreet.com/rss/news", source: "fxstreet" },
  { url: "https://www.investing.com/rss/news_285.rss", source: "investing" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", source: "marketwatch" },
];

const GOLD_NEWS_KEYWORDS = [
  "gold", "xau", "vàng", "bullion", "precious", "fed", "fomc", "powell",
  "cpi", "ppi", "pce", "nfp", "non-farm", "non farm", "payroll", "unemployment",
  "jobless", "jobs report", "inflation", "rate", "interest", "treasury",
  "yield", "dxy", "dollar", "usd", "ecb", "boj", "boe",
];

const HIGH_IMPACT_KEYWORDS = [
  "NFP", "non-farm", "non farm", "FOMC", "Fed decision", "Fed meeting",
  "Fed Chair", "Fed speech", "rate decision", "rate hike", "rate cut",
  "CPI", "PPI", "PCE", "core inflation",
  "GDP", "unemployment claims", "jobless claims",
  "ECB decision", "BOJ", "BOE",
];

/**
 * Parse RSS XML đơn giản — extract <item> với title/link/pubDate/description.
 * Dùng vì rss2json proxy block Cloudflare DC IPs.
 */
function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const itemMatches = xml.match(itemRegex) || [];
  for (const itemXml of itemMatches) {
    const get = (tag) => {
      // Match <tag>...</tag> hoặc <tag><![CDATA[...]]></tag>
      const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
      const m = itemXml.match(re);
      if (!m) return "";
      let val = m[1].trim();
      // Strip CDATA
      val = val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
      // Decode HTML entities cơ bản
      val = val.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
               .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
      // Strip HTML tags
      val = val.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      return val;
    };
    const title = get("title");
    const link = get("link") || get("guid");
    const pubDate = get("pubDate") || get("pubdate") || get("dc:date");
    const description = get("description") || get("content:encoded") || get("summary");
    if (title && link) {
      items.push({ title, link, pubDate, description });
    }
  }
  return items;
}

async function fetchNewsFromRSS(env) {
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async ({ url, source }) => {
      try {
        // Fetch RSS trực tiếp (Worker server-side, không cần proxy CORS)
        const r = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; xau-bot/1.0; +https://xau-smc-analyzer.pages.dev)",
            "Accept": "application/rss+xml, application/xml, text/xml",
          },
          // Cache edge 5 phút để giảm tải feed
          cf: { cacheEverything: true, cacheTtl: 300 },
        });
        if (!r.ok) {
          console.log(`[news] ${source} HTTP ${r.status}`);
          return [];
        }
        const xml = await r.text();
        const items = parseRssXml(xml);
        return items.map(it => ({
          ts: new Date(it.pubDate || Date.now()).getTime(),
          title: (it.title || "").slice(0, 300),
          summary: (it.description || "").slice(0, 300),
          url: it.link || "",
          source,
        }));
      } catch (e) {
        console.log(`[news] ${source} fail: ${e.message}`);
        return [];
      }
    })
  );
  const flat = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  const seen = new Set();
  return flat.filter(it => {
    if (!it.url || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

async function getCachedNews(env) {
  const bucket = Math.floor(Date.now() / (15 * 60 * 1000));
  const cacheKey = `news:${bucket}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) { try { return JSON.parse(cached); } catch {} }
  }
  const news = await fetchNewsFromRSS(env);
  if (env.CACHE && news.length > 0) {
    await env.CACHE.put(cacheKey, JSON.stringify(news), { expirationTtl: 1500 });
  }
  return news;
}

function isGoldRelevant(item) {
  const t = (item.title + " " + (item.summary || "")).toLowerCase();
  return GOLD_NEWS_KEYWORDS.some(k => t.includes(k));
}

function isHighImpact(item) {
  const t = item.title + " " + (item.summary || "");
  return HIGH_IMPACT_KEYWORDS.some(k => t.toLowerCase().includes(k.toLowerCase()));
}

function formatTimeAgo(ts) {
  const ms = Date.now() - ts;
  const h = ms / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}p`;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

async function handleTinCmd(env, chatId, replyTo, topic = null) {
  await sendChatAction(env, chatId, "typing");
  try {
    // Fetch song song: tin + giá XAU hiện tại (để AI dùng giá thật trong kịch bản)
    const [all, c15m] = await Promise.all([
      getCachedNews(env),
      fetchTdCandles(env, "15min", 220).catch(() => []),
    ]);
    if (all.length === 0) {
      await sendTelegramTo(env, chatId, "❌ Không lấy được tin tức (RSS feed lỗi).", replyTo);
      return;
    }
    // Giá hiện tại + ATR (cho AI tham chiếu khi dựng kịch bản)
    let currentPrice = null, currentAtr = null;
    if (c15m.length >= 50) {
      const e = enrichIndicators(c15m);
      const l = e[e.length - 1];
      currentPrice = l.close;
      currentAtr = l.atr;
    }
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const recent = all.filter(n => n.ts >= sevenDaysAgo).sort((a, b) => b.ts - a.ts);

    const today = new Date().toISOString().slice(0, 10);
    let filtered, topicLabel = null, systemText, userText;

    if (topic && topic.trim().length >= 2) {
      // ── MODE: deep-dive 1 sự kiện cụ thể ──
      topicLabel = topic.trim();
      const tokens = topicLabel.toLowerCase().split(/\s+/);
      filtered = recent.filter(n => {
        const t = (n.title + " " + (n.summary || "")).toLowerCase();
        return tokens.some(tk => t.includes(tk));
      });

      const newsList = filtered.slice(0, 20).map((n, i) => {
        const tag = isHighImpact(n) ? " 🚨" : "";
        return `${i + 1}.${tag} [${n.source} ${formatTimeAgo(n.ts)}] ${n.title}${n.summary ? `\n   ${n.summary.slice(0, 180)}` : ""}`;
      }).join("\n") || "(Không có tin chi tiết — dùng kiến thức general)";

      systemText = `Bạn là chuyên gia phân tích event-driven trading XAU/USD.

NHIỆM VỤ: Phân tích chuyên sâu sự kiện kinh tế cụ thể user hỏi → 3 kịch bản phản ứng + chiến lược trước/trong/sau event.

NGÔN NGỮ — bilingual Việt-Anh: "tăng giá (bullish)", "giảm giá (bearish)", "diều hâu (hawkish)", "bồ câu (dovish)", "trên dự báo (above forecast)", "dưới dự báo (below forecast)".

NGUYÊN TẮC CORRELATION:
- Số liệu USD tích cực (NFP cao, CPI cao, hawkish Fed) → DXY ↑ → XAU ↓ (giảm giá)
- Số liệu USD tiêu cực (NFP thấp, CPI thấp, dovish Fed) → DXY ↓ → XAU ↑ (tăng giá)
- Bất ổn địa chính trị / risk-off → XAU ↑ (safe-haven)
- Tăng trưởng GDP cao → có thể XAU giảm (risk-on rotation)

KIẾN THỨC SẴN VỀ MAJOR EVENTS:
- NFP (Non-Farm Payrolls): Thứ 6 đầu tháng 19:30 GMT+7. Forecast 150-250K. Tác động ±$30-100/oz cho XAU.
- CPI (Consumer Price Index): giữa tháng 19:30 GMT+7. Forecast YoY ~2-4%. Tác động ±$20-80. Core CPI quan trọng nhất.
- FOMC Decision: 8 lần/năm 02:00 GMT+7 + press conference của Fed Chair. Tác động lớn nhất ±$50-150.
- PPI: cuối tháng 19:30. Tác động vừa.
- GDP: hàng quý 19:30. Tác động vừa-thấp.
- Unemployment Claims: Thứ 5 hàng tuần 19:30. Tác động thấp.
- Retail Sales: giữa tháng 19:30.

FORMAT OUTPUT (Markdown) — MỌI TEXT TIẾNG VIỆT:
**📌 Bối cảnh**
- ${topicLabel} là gì + ý nghĩa với XAU
- Lần công bố trước (nếu suy được từ tin)

**📅 Lịch trình sắp tới**
- Ngày + giờ (GMT+7) ước tính
- Dự báo (Forecast) vs Lần trước (Prior) nếu biết

**🎯 3 KỊCH BẢN PHẢN ỨNG XAU**
1. Kịch bản TĂNG GIÁ (Bullish — số liệu USD yếu hơn dự báo): xác suất X%, biên độ +$Y → +$Z
   - Hành động: <nếu có giá hiện tại → đề xuất MUA (LONG) khi giá phá $... với SL $... TP $...; nếu KHÔNG có giá → ghi "chờ giá hiện tại để vào kịch bản này", KHÔNG viết "A/B/C" hoặc chữ placeholder>
2. Kịch bản TRUNG TÍNH (số liệu sát dự báo): xác suất X%, đi ngang (sideways) trong biên độ $...
   - Hành động: đứng ngoài hoặc lướt sóng (scalp) 2 chiều
3. Kịch bản GIẢM GIÁ (Bearish — số liệu USD mạnh hơn dự báo): xác suất X%, biên độ -$Y → -$Z
   - Hành động: <tương tự kịch bản 1 — chỉ ghi giá thật, KHÔNG dùng A/B/C>

**📋 QUẢN LÝ LỆNH**
- Trước event 30-60p: đóng một phần (partial close) / dời SL về hoà vốn (break-even) / đứng ngoài hoàn toàn
- Trong event: KHÔNG vào lệnh (biên độ chào giá — spread — giãn 5-10×), KHÔNG sửa SL/TP
- Sau event 5-15p: đợi nến 1-5p đóng + kiểm tra lại (retest), vào theo hướng phá vỡ

**⚠️ Rủi ro riêng cho ${topicLabel}**
- Săn dừng lỗ (stop hunt) cả 2 chiều — biến động loạn 2 chiều (whipsaw) 5-10p đầu
- Biên độ chào giá (spread) giãn → SL bị quét sớm
- Trượt giá (slippage) có thể $5-20

QUY TẮC TUYỆT ĐỐI:
- KHÔNG dùng chữ cái placeholder (A, B, C, D, E, F, G, H, X, Y, Z, $...) — phải LUÔN là giá tuyệt đối có $ và số.
- Nếu không có giá hiện tại trong input → BỎ phần "Hành động" cụ thể, chỉ giữ "xác suất X% + biên độ ±$Y → ±$Z" và ghi "(chờ giá để dựng kịch bản chi tiết)".
- KHÔNG dùng từ EN trần. Mọi thuật ngữ EN phải kèm tiếng Việt: "MUA (LONG)", "BÁN (SHORT)", "phá vỡ (breakout)", "kiểm tra lại (retest)", "lướt sóng (scalp)", "trượt giá (slippage)"...
- KHÔNG khuyến nghị mua/bán cụ thể, chỉ phân tích kịch bản + chiến lược.`;

      const priceLine = currentPrice != null
        ? `\n💰 GIÁ XAU/USD HIỆN TẠI: $${currentPrice.toFixed(2)} (ATR 15p ≈ $${currentAtr?.toFixed(2) || "?"}) — DÙNG GIÁ NÀY ĐỂ DỰNG KỊCH BẢN.\n`
        : `\n⚠️ Không có giá XAU hiện tại → BỎ phần Hành động cụ thể, chỉ ghi xác suất + biên độ.\n`;

      userText = `Hôm nay: ${today}
${priceLine}
🎯 PHÂN TÍCH CHUYÊN SÂU: ${topicLabel}

Tin liên quan đến "${topicLabel}" trong 7 ngày (${filtered.length} tin):

${newsList}

Phân tích theo format đã quy định. ${currentPrice != null ? "DÙNG GIÁ $" + currentPrice.toFixed(2) + " ± 1-3× ATR cho mọi mức giá trong kịch bản." : "KHÔNG có giá → BỎ phần Hành động chi tiết."}`;
    } else {
      // ── MODE: tổng hợp tuần (như cũ) ──
      filtered = recent.filter(isGoldRelevant);
      if (filtered.length === 0) {
        await sendTelegramTo(env, chatId, "ℹ️ Không có tin gold-relevant nào trong 7 ngày qua.", replyTo);
        return;
      }
      const highImpact = filtered.filter(isHighImpact);
      const top = filtered.slice(0, 20);
      const newsList = top.map((n, i) => {
        const tag = isHighImpact(n) ? " 🚨" : "";
        return `${i + 1}.${tag} [${n.source} ${formatTimeAgo(n.ts)}] ${n.title}${n.summary ? `\n   ${n.summary.slice(0, 180)}` : ""}`;
      }).join("\n");

      systemText = `Bạn là chuyên gia phân tích tin tức macro & tác động lên XAU/USD.

NHIỆM VỤ:
- Tổng hợp 3-5 chủ đề chính từ tin tức 7 ngày
- Highlight catalysts mạnh sắp tới (NFP, CPI, FOMC, Fed speech...)
- Dự đoán phản ứng XAU + đề xuất tiếp cận

NGÔN NGỮ — bilingual:
- "tăng giá (bullish)" / "giảm giá (bearish)"
- "Số liệu việc làm Mỹ (NFP)" / "Chỉ số giá tiêu dùng (CPI)"
- "Quyết định lãi suất (Rate Decision)"
- "diều hâu (hawkish)" / "bồ câu (dovish)"

NGUYÊN TẮC: tin USD tích cực → DXY ↑ → XAU ↓; tin USD tiêu cực → DXY ↓ → XAU ↑.
KHÔNG khuyến nghị mua/bán cụ thể.

FORMAT MARKDOWN.`;

      userText = `Hôm nay: ${today}

📰 ${filtered.length} tin gold-relevant 7 ngày (${highImpact.length} tin high-impact 🚨):

${newsList}

Tổng hợp theo format:

**📌 Chủ đề chính tuần qua**
- Chủ đề 1: ...

**🚨 Catalysts mạnh sắp tới**
- Sự kiện: ngày + giờ + dự đoán phản ứng XAU

**📈 Dự báo XAU**
- Bias tuần tới + vùng giá

**💡 Khuyến nghị tiếp cận**
- Ưu tiên + tránh

**⚠️ Rủi ro chính**

💡 Tip: Để phân tích sâu 1 event, dùng \`/tin NFP\` hoặc \`/tin CPI\` hoặc \`/tin FOMC\`.`;
    }

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        maxOutputTokens: 3500,
        temperature: 0.5,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    };

    const resp = await callGeminiSmart(env, body);
    const aiText = extractText(resp);
    if (!aiText) {
      await sendTelegramTo(env, chatId, "❌ AI không phản hồi.", replyTo);
      return;
    }

    let m;
    if (topicLabel) {
      m = `📰 **Phân tích chuyên sâu: ${topicLabel}**\n`;
      m += `_${filtered.length} tin liên quan đến "${topicLabel}" trong 7 ngày_\n\n`;
    } else {
      const highImp = filtered.filter(isHighImpact).length;
      m = `📰 **Tổng hợp tin XAU 7 ngày**\n`;
      m += `_${filtered.length} tin liên quan, ${highImp} tin high-impact 🚨_\n\n`;
    }
    m += aiText;
    m += `\n\n_Source: FXStreet, Investing.com, MarketWatch_`;

    // Convert Markdown → Telegram HTML (bold/italic/code) — robust hơn parse "Markdown" legacy
    // Telegram Markdown không hỗ trợ **X** (chỉ *X*) → AI thường output **X** sẽ không bold.
    const htmlMsg = markdownToTgHtml(m);
    const parts = splitForTelegram(htmlMsg, 3900);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n\n<i>[${i + 1}/${parts.length}]</i>` : "";
      await sendTelegramTo(env, chatId, parts[i] + suffix, i === 0 ? replyTo : null, "HTML");
    }
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

/**
 * /ask <câu hỏi> — tư vấn vị thế/khối lượng/SL/TP qua AI.
 * Ví dụ:
 *   /ask vốn 5tr lệnh 0.05 lot SL TP thế nào
 *   /ask đã mua giá 4520 hiện đang lỗ, xử lý ra sao
 */
async function handleAskCmd(env, chatId, replyTo, question) {
  if (!question || question.trim().length < 5) {
    await sendTelegramTo(env, chatId,
      "❌ Cần câu hỏi cụ thể.\n\nVí dụ:\n• <code>/ask vốn 5tr lệnh 0.05 lot đặt SL TP thế nào</code>\n• <code>/ask đã mua giá 4520 lỗ xử lý sao</code>\n• <code>/ask muốn risk 2% với SL 8 điểm thì bao nhiêu lot</code>",
      replyTo, "HTML");
    return;
  }
  await sendChatAction(env, chatId, "typing");

  try {
    const candles = await fetchTdCandles(env, "15min", 220);
    if (candles.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data thị trường", replyTo);
      return;
    }
    const enriched = enrichIndicators(candles);
    const latest = enriched[enriched.length - 1];
    const prev = enriched[enriched.length - 2];
    const pivots = await getCachedDailyPivots(env);
    const trend = getTrendAssessment(latest);
    const session = getTradingSession();
    const candlePattern = detectCandlePattern(latest, prev);

    const systemText = `Bạn là chuyên gia tư vấn quản lý rủi ro (Risk Management) và chiến lược giao dịch XAU/USD.

NGUYÊN TẮC TƯ VẤN:
- Risk Management ưu tiên: rủi ro 1-2% tài khoản/lệnh là chuẩn, KHÔNG bao giờ vượt 5%.
- Công thức tính khối lượng (Position Sizing) cho XAU/USD:
  • 0.01 lot ≈ $1 P&L mỗi $1 giá biến động
  • 0.05 lot ≈ $5/$1
  • 0.10 lot ≈ $10/$1
  • 1.00 lot ≈ $100/$1
  • Lot tối đa = (Tài khoản × Risk%) ÷ (SL distance × $ per 0.01 lot per $1)
- Quy đổi VND ↔ USD: 1 USD ≈ 25,000 VND (làm tròn).
- Nếu khối lượng user đang dự định quá to so với tài khoản → CẢNH BÁO mạnh + đề xuất giảm.
- Nếu user đã vào lệnh:
  • Tính P&L hiện tại
  • Phân tích vị trí hiện tại so với trend / S/R / EMA
  • Đề xuất: chốt lời 1 phần / dời SL về break-even / hold / cut loss
- KHÔNG khuyến nghị "mua/bán ngay". Đây là tư vấn quản lý risk giáo dục.

NGÔN NGỮ:
- Tiếng Việt dễ hiểu cho người mới.
- Thuật ngữ bilingual: "Cắt lỗ (SL)", "Chốt lời (TP)", "Khối lượng (Lot)", "Tỷ lệ rủi ro/lợi nhuận (R:R)", "Hòa vốn (Break-even)".
- Format Markdown đơn giản (KHÔNG HTML).

ĐỊNH DẠNG OUTPUT:
**📋 Tóm tắt câu hỏi:** 1 câu
**🧮 Tính toán:** số liệu cụ thể (lot, $ rủi ro, % tài khoản, SL distance, R:R nếu có)
**💡 Đề xuất:** hành động cụ thể với mức giá thật từ thị trường hiện tại
**⚠️ Cảnh báo:** nếu có rủi ro lớn`;

    const marketContext = `📊 BỐI CẢNH THỊ TRƯỜNG HIỆN TẠI:
- Giá XAU/USD: $${latest.close.toFixed(2)}
- Xu hướng 15m: ${trend?.label || "?"} ${trend?.note ? `(${trend.note})` : ""}
- RSI(14): ${latest.rsi?.toFixed(1)} | ATR(14): ${latest.atr?.toFixed(2)}
- EMA 21/50/200: ${latest.ema21?.toFixed(2)} / ${latest.ema50?.toFixed(2)} / ${latest.ema200?.toFixed(2)}
- BB(20): ${latest.bbLower?.toFixed(2)} – ${latest.bbUpper?.toFixed(2)}
- Pivots (daily): ${pivots ? `R2 ${pivots.r2.toFixed(2)} | R1 ${pivots.r1.toFixed(2)} | PP ${pivots.pp.toFixed(2)} | S1 ${pivots.s1.toFixed(2)} | S2 ${pivots.s2.toFixed(2)}` : "không có"}
- Nến mới: ${candlePattern}
- Phiên: ${session}`;

    const userText = `${marketContext}

❓ CÂU HỎI USER:
${question}

Trả lời câu hỏi của user dùng giá/indicators thực ở trên. Tính toán cụ thể nếu user đề cập đến số tiền/lot. Format Markdown đơn giản.`;

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        maxOutputTokens: 3000,
        temperature: 0.5,
      },
    };

    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    if (!text) {
      await sendTelegramTo(env, chatId, "❌ AI không phản hồi. Thử lại.", replyTo);
      return;
    }

    const fullMsg = `💬 *Tư vấn:* "${question.length > 80 ? question.slice(0, 80) + "..." : question}"\n\n${text}\n\n_⚠️ Đây là tư vấn quản lý risk giáo dục, KHÔNG phải khuyến nghị đầu tư._`;
    const parts = splitForTelegram(fullMsg, 3900);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n\n_[${i + 1}/${parts.length}]_` : "";
      // parseMode=Markdown với auto-fallback plain nếu AI Markdown lỗi
      await sendTelegramTo(env, chatId, parts[i] + suffix, i === 0 ? replyTo : null, "Markdown");
    }
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

/**
 * /nhanh = Pulse 5 khung (no AI, fast). Dùng EMA alignment + RSI rule-based.
 */
async function handleNhanhPulse(env, chatId, replyTo, auxArgs = []) {
  await sendChatAction(env, chatId, "typing");
  try {
    const tfs = ["5m", "15m", "1h", "4h", "1d"];
    const [data, auxCtx] = await Promise.all([
      Promise.all(tfs.map(async tf => {
        try {
          const candles = await fetchTdCandles(env, TF_TO_TD[tf], 220);
          if (candles.length < 50) return null;
          const e = enrichIndicators(candles);
          return { tf, latest: e[e.length - 1], prev: e[e.length - 2] };
        } catch { return null; }
      })),
      getAuxContext(env, auxArgs),
    ]);
    const valid = data.filter(Boolean);
    if (valid.length === 0) {
      await sendTelegramTo(env, chatId, "❌ Không fetch được data", replyTo);
      return;
    }
    const c = valid[0].latest.close;
    const pivots = await getCachedDailyPivots(env);

    const determineBias = (l) => {
      if (l.ema200 == null || l.ema50 == null || l.ema21 == null) return { icon: "❓", label: "?" };
      if (l.close > l.ema200 && l.ema21 > l.ema50 && l.ema50 > l.ema200) return { icon: "🚀", label: "Tăng mạnh (Strong Bullish)" };
      if (l.close > l.ema50 && l.close > l.ema200) return { icon: "🟢", label: "Tăng giá (Bullish)" };
      if (l.close < l.ema200 && l.ema21 < l.ema50 && l.ema50 < l.ema200) return { icon: "🔻", label: "Giảm mạnh (Strong Bearish)" };
      if (l.close < l.ema50 && l.close < l.ema200) return { icon: "🔴", label: "Giảm giá (Bearish)" };
      return { icon: "↔️", label: "Đi ngang (Sideways)" };
    };
    const rsiTag = (r) => {
      if (r == null) return "RSI ?";
      if (r > 70) return "Quá mua";   // overbought
      if (r < 30) return "Quá bán";   // oversold
      return "Trung tính";            // neutral
    };

    // Map TF tiếng Việt cho dễ hiểu
    const tfLabel = (tf) => ({ "5m": "5p", "15m": "15p", "1h": "1g", "4h": "4g", "1d": "1 ngày" }[tf] || tf);
    // Map TF cho label mức giá (không có space)
    const tfShort = (tf) => ({ "5m": "5p", "15m": "15p", "1h": "1g", "4h": "4g", "1d": "1d" }[tf] || tf);

    let m = `<b>🥇 Tổng quan nhanh XAU/USD</b>\n`;
    m += `Giá hiện tại: <b>$${c.toFixed(2)}</b>\n`;
    m += `<i>Phiên ${getTradingSession()}</i>\n`;
    if (auxCtx) {
      const auxLines = formatAuxBlock(auxCtx).split("\n").map(l => htmlEsc(l)).join("\n");
      m += `\n${auxLines}\n`;
      const impact = interpretAuxImpact(auxCtx);
      if (impact) m += `<i>↳ Tác động lên XAU: ${htmlEsc(impact)}</i>\n`;
    }
    m += `\n<b>📊 Xu hướng từng khung:</b>\n`;

    const biasLabels = [];
    for (const d of valid) {
      const b = determineBias(d.latest);
      biasLabels.push(b.label);
      const rsiVal = d.latest.rsi?.toFixed(0) || "?";
      m += `${b.icon} <b>${tfLabel(d.tf)}</b>: ${b.label} | RSI <b>${rsiVal}</b> (${rsiTag(d.latest.rsi)})\n`;
    }

    // Mức giá cần quan sát — top 3 trên + dưới
    const latest15m = valid.find(d => d.tf === "15m")?.latest;
    if (latest15m) {
      const tfL = tfShort("15m");
      const levels = [];
      if (latest15m.bbUpper) levels.push({ price: latest15m.bbUpper, label: `Biên trên Bollinger (BB upper) ${tfL}` });
      if (latest15m.bbLower) levels.push({ price: latest15m.bbLower, label: `Biên dưới Bollinger (BB lower) ${tfL}` });
      if (latest15m.recentHigh) levels.push({ price: latest15m.recentHigh, label: `Đỉnh 50 nến (${tfL})` });
      if (latest15m.recentLow)  levels.push({ price: latest15m.recentLow, label: `Đáy 50 nến (${tfL})` });
      if (pivots) {
        levels.push({ price: pivots.r1, label: "Điểm xoay R1 (Pivot)" });
        levels.push({ price: pivots.r2, label: "Điểm xoay R2 (Pivot)" });
        levels.push({ price: pivots.s1, label: "Điểm xoay S1 (Pivot)" });
        levels.push({ price: pivots.s2, label: "Điểm xoay S2 (Pivot)" });
      }
      const above = levels.filter(lv => lv.price > c).sort((a, b) => a.price - b.price).slice(0, 3);
      const below = levels.filter(lv => lv.price < c).sort((a, b) => b.price - a.price).slice(0, 3);
      if (above.length || below.length) {
        m += `\n<b>📍 Mức giá cần quan sát:</b>\n`;
        for (const lv of above) m += `▲ <b>$${lv.price.toFixed(2)}</b> ${htmlEsc(lv.label)} <i>(+${(lv.price - c).toFixed(2)})</i>\n`;
        for (const lv of below) m += `▼ <b>$${lv.price.toFixed(2)}</b> ${htmlEsc(lv.label)} <i>(-${(c - lv.price).toFixed(2)})</i>\n`;
      }
    }

    // Kết luận đồng thuận giữa các khung
    const upCount = biasLabels.filter(b => b.includes("Tăng")).length;
    const downCount = biasLabels.filter(b => b.includes("Giảm")).length;
    const sideCount = biasLabels.filter(b => b.includes("ngang")).length;
    let conclusion;
    if (upCount >= valid.length - 1) {
      conclusion = `Đa số khung TĂNG GIÁ (Bullish, ${upCount}/${valid.length}) — ưu tiên MUA (LONG), theo dõi cú phá vỡ lên (breakout)`;
    } else if (downCount >= valid.length - 1) {
      conclusion = `Đa số khung GIẢM GIÁ (Bearish, ${downCount}/${valid.length}) — ưu tiên BÁN (SHORT), theo dõi cú vỡ đáy xuống (breakdown)`;
    } else if (sideCount >= 2) {
      conclusion = `Nhiều khung ĐI NGANG (Sideways) — đợi giá xác nhận hướng, KHÔNG vội vào lệnh`;
    } else {
      conclusion = `Các khung phân vân (${upCount}↑ / ${downCount}↓ / ${sideCount}↔️) — phân tích từ khung lớn xuống nhỏ trước khi vào`;
    }
    m += `\n💡 <b>${conclusion}</b>\n`;

    // 🎯 KHUYẾN NGHỊ GIÁ VÀO LỆNH (rule-based, từ khung 15p + ATR + đồng thuận đa khung)
    if (latest15m && latest15m.atr > 0) {
      let dir = null;
      if (upCount >= valid.length - 1) dir = "BUY";
      else if (downCount >= valid.length - 1) dir = "SELL";

      if (dir) {
        const c15 = latest15m.close;
        const atr15 = latest15m.atr;
        // SL: 1.5 × ATR — practical cho intraday (15-20 điểm với XAU). KHÔNG dùng
        // recentLow/High vì swing 50 nến có thể quá xa khi giá đã chạy mạnh.
        // Nếu cần SL theo swing: dùng /15p (AI phân tích) thay vì /nhanh (quick).
        const slDist = 1.5 * atr15;
        const entry = c15;
        const sl  = dir === "BUY" ? entry - slDist : entry + slDist;
        const tp1 = dir === "BUY" ? entry + slDist     : entry - slDist;
        const tp2 = dir === "BUY" ? entry + 2 * slDist : entry - 2 * slDist;
        const tp3 = dir === "BUY" ? entry + 3 * slDist : entry - 3 * slDist;

        // Tin cậy theo số khung align
        const aligned = dir === "BUY" ? upCount : downCount;
        let confidence;
        if (aligned === valid.length) confidence = `<b>CAO</b> (${aligned}/${valid.length} khung đồng thuận)`;
        else if (aligned >= valid.length - 1) confidence = `trung bình-cao (${aligned}/${valid.length} khung)`;
        else confidence = `trung bình (${aligned}/${valid.length} khung)`;

        const dirLabel = dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
        const dirIcon = dir === "BUY" ? "🟢" : "🔴";
        const fmt = (n) => n.toFixed(2);

        m += `\n━━━ <b>🎯 KHUYẾN NGHỊ GIÁ VÀO LỆNH</b> ━━━\n`;
        m += `${dirIcon} <b>${dirLabel}</b> | Tin cậy: ${confidence}\n\n`;
        m += `📍 Điểm vào (Entry): <b>$${fmt(entry)}</b>\n`;
        m += `🛑 Cắt lỗ (SL): <b>$${fmt(sl)}</b> <i>(rủi ro ~${slDist.toFixed(2)} điểm)</i>\n`;
        m += `🎯 Chốt lời 1 (TP1, R:R 1:1 — an toàn): <b>$${fmt(tp1)}</b>\n`;
        m += `🎯 Chốt lời 2 (TP2, R:R 1:2 — kỳ vọng): <b>$${fmt(tp2)}</b>\n`;
        m += `🎯 Chốt lời 3 (TP3, R:R 1:3 — mở rộng): <b>$${fmt(tp3)}</b>\n`;
        // Cảnh báo nếu RSI 15p quá mua/bán đi ngược hướng
        if (dir === "BUY" && latest15m.rsi != null && latest15m.rsi > 75) {
          m += `<i>⚠️ RSI 15p ${latest15m.rsi.toFixed(0)} đang quá mua — đợi hồi giá (pullback) về EMA21 trước khi vào.</i>\n`;
        } else if (dir === "SELL" && latest15m.rsi != null && latest15m.rsi < 25) {
          m += `<i>⚠️ RSI 15p ${latest15m.rsi.toFixed(0)} đang quá bán — đợi hồi giá (bounce) về EMA21 trước khi vào.</i>\n`;
        }
        m += `<i>💡 Gợi ý theo quy tắc, không phải khuyến nghị đầu tư. Xác nhận thêm bằng /15p hoặc /1h trước khi vào lệnh.</i>\n`;
      } else {
        m += `\n━━━ <b>🎯 KHUYẾN NGHỊ GIÁ VÀO LỆNH</b> ━━━\n`;
        m += `⚪ <b>Đứng ngoài (Wait)</b> — các khung phân vân, chờ xác nhận hướng rõ ràng.\n`;
      }
    }

    m += `\n<i>Để xem chi tiết: /15p /1h /1h4h1d /nhanh15p ...</i>`;

    await sendTelegramTo(env, chatId, m, replyTo, "HTML");
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

async function handleScanCmd(env, chatId, replyTo, tf = "15m", auxArgs = []) {
  await sendChatAction(env, chatId, "typing");
  try {
    const tdInterval = TF_TO_TD[tf] || "15min";
    const horizon = TF_HORIZON[tf] || "ngắn hạn";
    const [candles, auxCtx] = await Promise.all([
      fetchTdCandles(env, tdInterval, 220),
      getAuxContext(env, auxArgs, tf),
    ]);
    if (candles.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(candles);
    const l = e[e.length - 1];
    const pivots = await getCachedDailyPivots(env);

    const pivotStr = pivots
      ? `Pivots: R2=${pivots.r2.toFixed(2)} R1=${pivots.r1.toFixed(2)} PP=${pivots.pp.toFixed(2)} S1=${pivots.s1.toFixed(2)} S2=${pivots.s2.toFixed(2)}`
      : "";

    const systemText = `Bạn là chuyên gia phân tích kỹ thuật XAU/USD. Đây là phân tích kỹ thuật giáo dục, KHÔNG phải khuyến nghị đầu tư.

NGÔN NGỮ:
- Toàn bộ câu trả lời TIẾNG VIỆT tự nhiên. KHÔNG dùng từ EN trần (bullish/bearish/breakout/pullback...).
- Thuật ngữ kỹ thuật viết "tiếng Việt (EN trong ngoặc)": tăng giá (bullish), phá vỡ (breakout), quá mua (overbought), điểm vào lệnh (entry), cắt lỗ (SL), chốt lời (TP)...

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble, KHÔNG markdown wrap.
- BẮT BUỘC điền đủ field. Mọi giá là số float cụ thể.
- Mọi khung 5m → 1d đều phân tích được.`;
    const auxText = auxCtx ? `\n\n💱 BỐI CẢNH LIÊN THỊ TRƯỜNG (cùng khung ${tf}):
${formatAuxBlock(auxCtx)}

YÊU CẦU BẮT BUỘC: Trong câu trả lời (tom_tat hoặc canh_bao), PHẢI giải thích cụ thể tác động của Chỉ số đô la Mỹ (DXY) / Giá dầu (OIL) lên XAU:
- DXY tăng → áp lực giảm XAU (tương quan nghịch ~-0.7).
- DXY giảm → hỗ trợ XAU.
- OIL tăng → đồng pha tăng giá với XAU (cùng phòng hộ lạm phát — inflation hedge).
- OIL giảm → áp lực giảm XAU.
Đối chiếu với setup XAU: nếu liên thị trường đồng thuận → tăng độ tin cậy. Nếu mâu thuẫn → giảm độ tin cậy + thêm vào canh_bao.` : "";
    const userText = `XAU/USD khung ${tf} (horizon ${horizon}), giá $${l.close.toFixed(2)}.
RSI: ${l.rsi?.toFixed(1)} | EMA 21/50/200: ${l.ema21?.toFixed(2)}/${l.ema50?.toFixed(2)}/${l.ema200?.toFixed(2)}
SMA 50/200: ${l.sma50?.toFixed(2)}/${l.sma200?.toFixed(2)} | BB: ${l.bbLower?.toFixed(2)}-${l.bbUpper?.toFixed(2)}
${pivotStr}${auxText}

QUY TẮC SETUP:
- Nếu setup rõ (LONG hoặc SHORT) → BẮT BUỘC điền đủ entry + sl + tp1 + tp2 + tp3.
- TP1 an toàn (R:R ~1:1), TP2 kỳ vọng (R:R ~1:2), TP3 mở rộng theo xu hướng (R:R 1:3+ hoặc tới mốc kháng/hỗ trợ kế tiếp).
- SL đặt NGOÀI vùng nhiễu (>1×ATR cách swing) để tránh quét thanh khoản.
- Nếu setup chưa rõ → set huong = "NEUTRAL" và để các trường giá = null.

Trả JSON:
{
  "huong": "LONG|SHORT|NEUTRAL",
  "tom_tat": "1-2 câu phe nào kiểm soát + lý do ngắn",
  "entry_goi_y": <float|null>,
  "sl_goi_y": <float|null>,
  "tp1_goi_y": <float|null>,
  "tp2_goi_y": <float|null>,
  "tp3_goi_y": <float|null>,
  "ly_do_setup": "1 câu lý do nếu có entry, hoặc 'chưa có setup rõ' nếu null",
  "khang_cu_gan": <float>,
  "ho_tro_gan": <float>,
  "canh_bao": "vd: 'RSI quá mua, coi chừng pullback' hoặc null nếu không có"
}`;

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 1500,
        temperature: 0.4,
      },
    };
    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    const d = extractJSON(text);
    if (!d) {
      const finish = resp?.candidates?.[0]?.finishReason || "?";
      const blocked = resp?.promptFeedback?.blockReason;
      console.log(`[bot] /nhanh${tf} JSON parse fail (len=${(text||"").length}, finish=${finish}, blocked=${blocked||"no"}), text: ${text||""}`);
      let errMsg = `❌ AI response không hợp lệ (len=${(text||"").length}, finish=${finish})`;
      if (blocked) errMsg += `\nBlocked: <code>${htmlEsc(blocked)}</code>`;
      if (text && text.length < 500) errMsg += `\n<i>${htmlEsc(text.slice(0, 300))}</i>`;
      errMsg += `\nThử lại sau.`;
      await sendTelegramTo(env, chatId, errMsg, replyTo, "HTML");
      return;
    }

    const huong = (d.huong || "NEUTRAL").toUpperCase();
    const huongIcon = { LONG: "📈", SHORT: "📉", NEUTRAL: "➡️" }[huong] || "❓";
    const huongLabel = { LONG: "MUA (LONG)", SHORT: "BÁN (SHORT)", NEUTRAL: "ĐỨNG NGOÀI" }[huong] || huong;
    const fmt2 = (n) => (typeof n === "number" && !isNaN(n)) ? n.toFixed(2) : "?";

    let m = `<b>🥇 Quét nhanh XAU/USD ${tf}</b> — Horizon ${horizon}\n`;
    m += `Giá hiện tại: <b>$${l.close.toFixed(2)}</b> | ${huongIcon} <b>${huongLabel}</b>\n`;
    if (auxCtx) {
      const auxLines = formatAuxBlock(auxCtx).split("\n");
      m += auxLines.map(l => htmlEsc(l)).join("\n") + "\n";
    }
    m += `\n`;

    if (d.tom_tat) m += `${htmlEsc(d.tom_tat)}\n\n`;

    // Khuyến nghị giá vào lệnh — Entry / SL / TP1-2-3
    const sgEntry = d.entry_goi_y, sgSl = d.sl_goi_y;
    const sgTp1 = d.tp1_goi_y ?? d.tp_goi_y; // backward compat
    const sgTp2 = d.tp2_goi_y;
    const sgTp3 = d.tp3_goi_y;
    if (sgEntry != null && sgSl != null && sgTp1 != null) {
      const slDist = Math.abs(sgEntry - sgSl);
      const rr1 = Math.abs((sgTp1 - sgEntry) / (sgEntry - sgSl));
      m += `<b>🎯 Khuyến nghị giá vào lệnh (${huongLabel}):</b>\n`;
      m += `📍 Điểm vào (Entry): <b>$${fmt2(sgEntry)}</b>\n`;
      m += `🛑 Cắt lỗ (SL): <b>$${fmt2(sgSl)}</b> <i>(rủi ro ~${slDist.toFixed(2)} điểm)</i>\n`;
      m += `🎯 Chốt lời 1 (TP1, R:R ${rr1.toFixed(1)} — an toàn): <b>$${fmt2(sgTp1)}</b>\n`;
      if (sgTp2 != null) {
        const rr2 = Math.abs((sgTp2 - sgEntry) / (sgEntry - sgSl));
        m += `🎯 Chốt lời 2 (TP2, R:R ${rr2.toFixed(1)} — kỳ vọng): <b>$${fmt2(sgTp2)}</b>\n`;
      }
      if (sgTp3 != null) {
        const rr3 = Math.abs((sgTp3 - sgEntry) / (sgEntry - sgSl));
        m += `🎯 Chốt lời 3 (TP3, R:R ${rr3.toFixed(1)} — mở rộng): <b>$${fmt2(sgTp3)}</b>\n`;
      }
      if (d.ly_do_setup) m += `<i>💡 ${htmlEsc(d.ly_do_setup)}</i>\n`;
    } else if (d.ly_do_setup) {
      m += `<b>🎯 Setup:</b> ${htmlEsc(d.ly_do_setup)}\n`;
    }

    if (d.khang_cu_gan || d.ho_tro_gan) {
      m += `\n<b>📍 Mức giá cần quan sát:</b>\n`;
      if (d.khang_cu_gan) m += `▲ <b>$${Number(d.khang_cu_gan).toFixed(2)}</b> kháng cự gần\n`;
      if (d.ho_tro_gan)  m += `▼ <b>$${Number(d.ho_tro_gan).toFixed(2)}</b> hỗ trợ gần\n`;
    }

    if (d.canh_bao) {
      m += `\n⚠️ <b>Cảnh báo:</b> ${htmlEsc(d.canh_bao)}`;
    }

    await sendTelegramTo(env, chatId, m, replyTo, "HTML");
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

async function handleAnalyzeCmd(env, chatId, replyTo, tfArg, auxArgs = []) {
  const tf = (tfArg || "15m").toLowerCase();
  if (!TF_TO_TD[tf]) {
    await sendTelegramTo(env, chatId, `❌ TF không hợp lệ. Dùng: ${Object.keys(TF_TO_TD).join(", ")}`, replyTo);
    return;
  }
  // sendChatAction → Telegram hiện 'typing...' indicator ~5s, đủ để user biết bot đang xử lý.
  // (Trước có sendQuickAck riêng nhưng gây nhiễu — đã bỏ, dựa vào typing indicator.)
  await sendChatAction(env, chatId, "typing");
  try {
    const [candles, auxCtx] = await Promise.all([
      fetchTdCandles(env, TF_TO_TD[tf], 220),
      getAuxContext(env, auxArgs, tf),
    ]);
    if (candles.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(candles);
    const l = e[e.length - 1];

    const pivots = await getCachedDailyPivots(env);

    const last10 = candles.slice(-10).map(c =>
      `O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`
    ).join(" | ");
    const horizon = TF_HORIZON[tf];
    const pivotStr = pivots
      ? `R2=${pivots.r2.toFixed(2)} R1=${pivots.r1.toFixed(2)} PP=${pivots.pp.toFixed(2)} S1=${pivots.s1.toFixed(2)} S2=${pivots.s2.toFixed(2)}`
      : "không có";

    // Bổ sung: candle pattern, session, HTF context (nếu LTF analysis)
    const candlePattern = detectCandlePattern(l, e[e.length - 2]);
    const session = getTradingSession();
    const isLTF = tf === "5m" || tf === "15m" || tf === "1h";
    const htfCtx = isLTF ? await getHTFContext(env) : null;
    const htfBlock = htfCtx
      ? `- Xu hướng khung lớn: 4h ${htfCtx.trend4h}, 1d ${htfCtx.trend1d}\n  (Tip: 4h/1d giống dòng sông lớn, ${tf} chỉ là gợn sóng. Đi ngược HTF = rủi ro cao.)`
      : "";

    const systemText = `Bạn là chuyên gia phân tích kỹ thuật XAU/USD, có sư phạm tốt.

NHIỆM VỤ: Đưa QUYẾT ĐỊNH (MUA/BÁN/ĐỨNG NGOÀI) + giải thích tiếng Việt dễ hiểu cho người mới.

NGÔN NGỮ:
- Tiếng Việt tự nhiên. KHÔNG dùng từ EN trần (bullish/bearish/breakout/pullback/divergence...).
- Thuật ngữ KT viết "tiếng Việt (EN trong ngoặc)" — vd: tăng giá (bullish), phá vỡ (breakout), phân kỳ (divergence), quá mua (overbought), giao cắt vàng (Golden Cross), quét thanh khoản (Liquidity Sweep), phá vỡ cấu trúc (BOS), khối lệnh (OB), khoảng trống công bằng (FVG), điểm vào lệnh (Entry), cắt lỗ (SL), chốt lời (TP), tỷ lệ rủi ro/lợi nhuận (R:R).

QUY TẮC:
- Trả JSON CHÍNH XÁC schema, KHÔNG preamble/markdown wrap.
- Giáo dục, không phải khuyến nghị đầu tư. Mọi giá là số float cụ thể.
- TP1 ~1:1, TP2 ~1:2, TP3 ~1:3+. SL >1×ATR ngoài swing để tránh quét thanh khoản.
- Setup chưa rõ → WAIT, KHÔNG bịa entry.`;

    const auxBlock = auxCtx ? `\n\n💱 BỐI CẢNH LIÊN THỊ TRƯỜNG (cùng khung ${tf}):
${formatAuxBlock(auxCtx)}

YÊU CẦU BẮT BUỘC trong giai_thich:
- buc_tranh_toan_canh PHẢI nhắc Chỉ số đô la (DXY) / Giá dầu (OIL): vd "DXY giảm 0.4% trong 24h → hỗ trợ XAU"
- ly_do_entry_sl PHẢI nói liên thị trường có xác nhận setup không
- rui_ro_can_luu_y PHẢI thêm rủi ro mâu thuẫn nếu liên thị trường đi ngược setup
Quy tắc tương quan:
- DXY ↑ → XAU ↓ (nghịch ~-0.7)
- OIL ↑ → XAU ↑ (đồng pha — cùng phòng hộ lạm phát/inflation hedge)` : "";

    const userText = `Phân tích XAU/USD khung ${tf} (horizon ${horizon}).

📊 DỮ LIỆU THỊ TRƯỜNG:
- Giá hiện tại: $${l.close.toFixed(2)}
- RSI(14): ${l.rsi?.toFixed(1)} | ATR: ${l.atr?.toFixed(2)}
- EMA 21/50/200: ${l.ema21?.toFixed(2)} / ${l.ema50?.toFixed(2)} / ${l.ema200?.toFixed(2)}
- SMA 50/200: ${l.sma50?.toFixed(2)} / ${l.sma200?.toFixed(2)} ${l.sma50 > l.sma200 ? "(Golden alignment — xu hướng tăng dài hạn)" : "(Death alignment — xu hướng giảm dài hạn)"}
- Bollinger Bands(20): Lower ${l.bbLower?.toFixed(2)} – Upper ${l.bbUpper?.toFixed(2)}
- Pivots (daily): ${pivotStr || "không có"}
- Nến vừa đóng: ${candlePattern}
- Phiên giao dịch hiện tại: ${session}
${htfBlock}
- 10 nến gần nhất (OHLC): ${last10}${auxBlock}

# CẤU TRÚC ĐẦU RA BẮT BUỘC (JSON)
{
  "quyet_dinh": {
    "huong": "BUY | SELL | WAIT",
    "do_tin_cay": "Cao | Trung bình | Thấp",
    "entry": <float | null nếu WAIT>,
    "sl": <float | null nếu WAIT>,
    "tp1": <float | null>,
    "tp2": <float | null>,
    "tp3": <float | null>,
    "rr_tp1": <float | null>,
    "rr_tp2": <float | null>
  },
  "giai_thich": {
    "buc_tranh_toan_canh": "1-2 câu plain Vietnamese: thị trường đang làm gì, phe nào kiểm soát, ở giai đoạn nào (impulse/correction/consolidation). Dùng từ ngữ dễ hình dung.",
    "ly_do_entry_sl": "Đoạn 3-5 câu giải thích vì sao chọn entry và SL ở đó. PHẢI bao gồm:\\n- Lý do confluence (vd 'EMA50 + Fib 0.5 + OB chồng nhau')\\n- Giải nghĩa từng thuật ngữ kỹ thuật xuất hiện (vd 'EMA = đường trung bình động — giá trung bình của X nến gần nhất, dùng làm hỗ trợ động')\\n- SL đặt ở đâu để tránh 'quét stop' (giải nghĩa: smart money cố tình đẩy giá chọc qua SL phổ biến trước khi đi theo hướng thật)",
    "rui_ro_can_luu_y": [
      "Lệnh thua nếu... (kịch bản 1, vd: tin Fed 19:30 hôm nay)",
      "Lệnh thua nếu... (kịch bản 2)"
    ]
  },
  "huong_HTF": {
    "khung_4h": "${htfCtx?.trend4h || "chưa rõ"}",
    "khung_1d": "${htfCtx?.trend1d || "chưa rõ"}",
    "ghi_chu": "1 câu — setup này có align với HTF không? Nếu không → giảm độ tin cậy"
  }
}`;

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 2000,
        temperature: 0.5,
        // 0 thinking: schema đã có template structure, AI không cần "nghĩ" nhiều.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    const d = extractJSON(text);
    if (!d) {
      const finish = resp?.candidates?.[0]?.finishReason || "?";
      const blocked = resp?.promptFeedback?.blockReason;
      console.log(`[bot] /analyze ${tf} JSON parse fail (len=${(text||"").length}, finish=${finish}, blocked=${blocked||"no"}), text: ${text||""}`);
      // AI fail (Gemini overload + Workers AI timeout) → graceful fallback rule-based
      const fallbackMsg = buildRuleBasedFallback(l, pivots, tf, horizon);
      await sendTelegramTo(env, chatId, fallbackMsg, replyTo, "HTML");
      return;
    }

    let html = formatAnalysisHTML(d, tf, horizon);
    if (auxCtx) {
      const auxLines = formatAuxBlock(auxCtx).split("\n").map(l => htmlEsc(l)).join("\n");
      // Insert aux block sau header (sau dòng đầu tiên — Phân tích...)
      html = html.replace(/(\n\n)/, `\n${auxLines}\n\n`);
    }
    const parts = splitForTelegram(html, 3900);
    console.log(`[bot] /analyze ${tf} text=${text?.length}c, html=${html.length}c, parts=${parts.length}`);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n\n<i>[${i + 1}/${parts.length}]</i>` : "";
      const ok = await sendTelegramTo(env, chatId, parts[i] + suffix, i === 0 ? replyTo : null, "HTML");
      console.log(`[bot] sent part ${i + 1}/${parts.length} (${(parts[i] + suffix).length}c) ok=${ok}`);
    }
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

/**
 * Format JSON theo schema mới (quyet_dinh + giai_thich) → Telegram HTML.
 * QUYẾT ĐỊNH lên đầu (BUY/SELL/WAIT, entry, SL, 3 TPs).
 * GIẢI THÍCH dưới (bức tranh + lý do entry/SL + rủi ro).
 */
function formatAnalysisHTML(d, tf, horizon) {
  const fmt2 = (n) => (typeof n === "number" && !isNaN(n)) ? n.toFixed(2) : "?";
  const fmtRr = (r) => (typeof r === "number" && !isNaN(r)) ? Number(r).toFixed(1) : null;
  const qd = d.quyet_dinh || {};
  const gt = d.giai_thich || {};
  const htf = d.huong_HTF || {};

  const huong = String(qd.huong || "WAIT").toUpperCase();
  const huongIcon = { BUY: "🟢", SELL: "🔴", WAIT: "🟡" }[huong] || "❓";
  const huongLabel = {
    BUY: "MUA (LONG)",
    SELL: "BÁN (SHORT)",
    WAIT: "ĐỨNG NGOÀI",
  }[huong] || huong;

  let m = `<b>🥇 Phân tích XAU/USD ${tf}</b> — Horizon ${horizon}\n\n`;

  // ══════ PHẦN 1: QUYẾT ĐỊNH ══════
  m += `━━━ <b>🎯 QUYẾT ĐỊNH</b> ━━━\n`;
  m += `${huongIcon} <b>${huongLabel}</b> | Tin cậy: <b>${htmlEsc(qd.do_tin_cay || "?")}</b>\n`;

  if (huong !== "WAIT" && qd.entry != null) {
    m += `\n📍 Entry: <b>$${fmt2(qd.entry)}</b>\n`;
    m += `🛑 SL: <b>$${fmt2(qd.sl)}</b>\n`;
    if (qd.tp1 != null) {
      const rr = fmtRr(qd.rr_tp1);
      m += `🎯 TP1 an toàn: <b>$${fmt2(qd.tp1)}</b>${rr ? ` <i>(R:R ${rr})</i>` : ""}\n`;
    }
    if (qd.tp2 != null) {
      const rr = fmtRr(qd.rr_tp2);
      m += `🎯 TP2 kỳ vọng: <b>$${fmt2(qd.tp2)}</b>${rr ? ` <i>(R:R ${rr})</i>` : ""}\n`;
    }
    if (qd.tp3 != null) m += `🎯 TP3 mở rộng theo xu hướng: <b>$${fmt2(qd.tp3)}</b>\n`;
  } else {
    m += `\n<i>Chưa có setup rõ ràng — chờ giá xác nhận hướng.</i>\n`;
  }

  // ══════ PHẦN 2: GIẢI THÍCH (cho người mới) ══════
  m += `\n━━━ <b>📚 GIẢI THÍCH</b> ━━━\n`;
  if (gt.buc_tranh_toan_canh) {
    m += `\n<b>🎨 Bức tranh toàn cảnh:</b>\n${htmlEsc(gt.buc_tranh_toan_canh)}\n`;
  }
  if (gt.ly_do_entry_sl) {
    m += `\n<b>💡 Lý do chọn Entry/SL:</b>\n${htmlEsc(gt.ly_do_entry_sl)}\n`;
  }
  if (Array.isArray(gt.rui_ro_can_luu_y) && gt.rui_ro_can_luu_y.length) {
    m += `\n<b>⚠️ Rủi ro cần lưu ý:</b>\n`;
    for (const r of gt.rui_ro_can_luu_y) m += `• ${htmlEsc(r)}\n`;
  }

  // HTF context
  if (htf.khung_4h || htf.khung_1d) {
    m += `\n<b>🌊 Bối cảnh khung lớn:</b> 4h <b>${htmlEsc(htf.khung_4h || "?")}</b> | 1d <b>${htmlEsc(htf.khung_1d || "?")}</b>`;
    if (htf.ghi_chu) m += `\n<i>${htmlEsc(htf.ghi_chu)}</i>`;
  }

  return m;
}

/**
 * Split text thành nhiều part fit Telegram 4096 char limit.
 * Cố gắng break ở paragraph boundary để giữ readability.
 */
function splitForTelegram(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Ưu tiên break ở \n\n (paragraph), fallback \n (line), cuối cùng cứng
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut === -1 || cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut === -1 || cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut === -1) cut = maxLen;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  return parts;
}

/**
 * Multi-TF top-down analysis — 1 AI call, 1 unified reply.
 * Khác với loop: cho AI xem data nhiều khung và tự tổng hợp consensus.
 */
async function handleMultiTfAnalyze(env, chatId, replyTo, tfs, isNhanh, auxArgs = []) {
  const t0 = Date.now();
  const log = (label) => console.log(`[multi-tf] ${tfs.join("+")} t+${((Date.now() - t0)/1000).toFixed(1)}s ${label}`);
  // sendChatAction → typing indicator (đã bỏ sendQuickAck "Đang phân tích..." riêng)
  await sendChatAction(env, chatId, "typing");
  try {
    // HTF (khung lớn nhất) cho aux interval
    const tfOrder = ["5m", "15m", "1h", "4h", "1d"];
    const htfForAux = [...tfs].sort((a, b) => tfOrder.indexOf(a) - tfOrder.indexOf(b))[tfs.length - 1];

    // Fetch tất cả TFs + aux parallel
    const [dataArrays, auxCtx] = await Promise.all([
      Promise.all(tfs.map(async tf => {
        const tdInterval = TF_TO_TD[tf];
        if (!tdInterval) return null;
        try {
          const candles = await fetchTdCandles(env, tdInterval, 220);
          if (candles.length < 50) return null;
          const enriched = enrichIndicators(candles);
          log(`fetch ${tf} ok (${candles.length} candles)`);
          return { tf, latest: enriched[enriched.length - 1], candles };
        } catch (e) {
          console.log(`[multi-tf] fetch ${tf} fail: ${e.message}`);
          return null;
        }
      })),
      getAuxContext(env, auxArgs, htfForAux),
    ]);
    const valid = dataArrays.filter(Boolean);
    if (valid.length < 2) {
      await sendTelegramTo(env, chatId, "❌ Không fetch đủ data cho combo", replyTo);
      return;
    }

    // Pivots từ daily
    const pivots = await getCachedDailyPivots(env);

    // Build prompt với data từng TF
    const tfDataLines = valid.map(({ tf, latest, candles }) => {
      const last5 = candles.slice(-5).map(c =>
        `O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`
      ).join(" | ");
      return `--- ${tf.toUpperCase()} ---
Giá: $${latest.close.toFixed(2)} | RSI: ${latest.rsi?.toFixed(1)}
EMA 21/50/200: ${latest.ema21?.toFixed(2)} / ${latest.ema50?.toFixed(2)} / ${latest.ema200?.toFixed(2)}
SMA 50/200: ${latest.sma50?.toFixed(2)} / ${latest.sma200?.toFixed(2)} ${latest.sma50 > latest.sma200 ? "(golden)" : "(death)"}
BB(20): ${latest.bbLower?.toFixed(2)} - ${latest.bbUpper?.toFixed(2)}
5 nến gần: ${last5}`;
    }).join("\n\n");

    const pivotStr = pivots
      ? `Pivots (daily): R2=${pivots.r2.toFixed(2)} R1=${pivots.r1.toFixed(2)} PP=${pivots.pp.toFixed(2)} S1=${pivots.s1.toFixed(2)} S2=${pivots.s2.toFixed(2)}`
      : "";

    const tfsLabel = valid.map(v => v.tf).join(" + ");
    // Reuse tfOrder đã khai báo trên cho htfForAux
    const sortedByTime = [...valid].sort((a, b) => tfOrder.indexOf(a.tf) - tfOrder.indexOf(b.tf));
    const htf = sortedByTime[sortedByTime.length - 1].tf;
    const ltf = sortedByTime[0].tf;
    const horizon = TF_HORIZON[htf] || "ngắn-trung hạn";

    const systemText = `Bạn là chuyên gia TA XAU/USD multi-timeframe top-down.

NGUYÊN TẮC TOP-DOWN:
- HTF ${htf} → BIAS chính. MTF → SETUP (entry/cản). LTF ${ltf} → timing vào lệnh.
- Khuyến nghị dựa trên hợp lực. Mâu thuẫn → ghi rõ ở 'alignment' + giảm độ tin cậy.

NGÔN NGỮ:
- Tiếng Việt tự nhiên. KHÔNG dùng từ EN trần (bullish/bearish/sideways/BOS...).
- Thuật ngữ viết "tiếng Việt (EN trong ngoặc)": tăng giá (bullish), phá vỡ cấu trúc (BOS), khối lệnh (OB — Order Block), khoảng trống công bằng (FVG), quét thanh khoản (Liquidity Sweep), khung lớn (HTF), điểm vào lệnh (Entry), cắt lỗ (SL), chốt lời (TP).

QUY TẮC:
- Trả JSON CHÍNH XÁC schema, KHÔNG preamble. Mọi giá là float.
- BẮT BUỘC điền 'by_tf' cho TẤT CẢ ${valid.length} khung.
- SL >1×ATR ngoài swing để tránh quét thanh khoản.
- kha_thi=true: entry + sl + tp1 + tp2 + tp3 (TP1 ~1:1, TP2 ~1:2, TP3 mở rộng/1:3+).
- "tp" = tp2 (backward compat). rr theo TP2.`;

    const auxBlock = auxCtx ? `\n\n💱 BỐI CẢNH LIÊN THỊ TRƯỜNG (khung ${htfForAux}):
${formatAuxBlock(auxCtx)}

LƯU Ý: Trong tom_tat / phan_tich_top_down PHẢI nhắc đến tác động Chỉ số đô la (DXY) / Giá dầu (OIL):
- DXY ↑ → áp lực giảm XAU (tương quan nghịch ~-0.7)
- OIL ↑ → đồng pha tăng XAU (cùng phòng hộ lạm phát — inflation hedge)
Liên thị trường mâu thuẫn với đồng thuận đa khung → giảm độ tin cậy + thêm vào rui_ro_chinh.` : "";

    const userText = `Phân tích TOP-DOWN XAU/USD ${valid.length} khung: ${tfsLabel}.
Horizon dự báo: ${horizon} (theo HTF ${htf})

DỮ LIỆU TỪNG KHUNG:
${tfDataLines}

${pivotStr}${auxBlock}

Trả JSON:
{
  "consensus_bias": "LONG | SHORT | NEUTRAL",
  "alignment": "all_align | majority | divergent",
  "do_tin_cay": "thấp | trung bình | cao",
  "tom_tat": "1-2 câu summary top-down (vd '1d bullish, 4h consolidate, 1h pullback về EMA21')",
  "by_tf": {
${valid.map(v => `    "${v.tf}": { "bias": "LONG|SHORT|NEUTRAL", "key_level": <float>, "ghi_chu": "1 câu" }`).join(",\n")}
  },
  "long": {
    "kha_thi": true | false,
    "entry": <float>, "sl": <float>, "tp": <float>, "rr": <float>,
    "tp1": <float|null>, "tp2": <float|null>, "tp3": <float|null>,
    "ly_do": "lý do confluence từ khung lớn xuống nhỏ",
    "dieu_kien_confirm": "vd 'đợi nến 15p đóng trên $X + RSI > 50'"
  },
  "short": { ...same fields... },
  "khang_cu": [{"gia": <float>, "ghi_chu": "vd 'HTF resistance + Fib 0.5'"}, ... 2-3 mức],
  "ho_tro": [{"gia": <float>, "ghi_chu": "..."}, ... 2-3 mức],
  "phan_tich_top_down": "1-2 đoạn giải thích cách 3 khung bổ trợ hoặc mâu thuẫn nhau, vai trò mỗi khung trong setup",
  "rui_ro_chinh": ["...", "...", "..."]
}`;

    const body = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: "application/json",
        // /nhanh combo: gọn, 1500 đủ. /5p15p1h full: 2500 cho LONG+SHORT setup + lý do.
        maxOutputTokens: isNhanh ? 1500 : 2500,
        temperature: 0.4,
        // 0 thinking — schema cứng, cắt ~5-10s latency.
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    log("calling gemini");
    const resp = await callGeminiSmart(env, body);
    log(`gemini done (source=${resp?.usageMetadata?.source || "gemini"})`);
    const text = extractText(resp);
    const d = extractJSON(text);
    if (!d) {
      console.log(`[bot] multi-tf parse fail (text len=${(text||"").length}), tail: ${(text||"").slice(-200)}`);
      // AI fail (Gemini outage + Workers AI timeout) → fallback rule-based dùng HTF data
      const htfData = sortedByTime[sortedByTime.length - 1];
      const fallbackMsg = buildRuleBasedFallback(htfData.latest, pivots, htf, horizon);
      const prefix = `<i>⚠️ AI tạm thời quá tải. Hiển thị phân tích đa khung rule-based (theo ${htf}):</i>\n\n`;
      await sendTelegramTo(env, chatId, prefix + fallbackMsg.replace(/^<b>🥇 Phân tích.*?\n.*?\n\n/, ""), replyTo, "HTML");
      return;
    }
    log("rendering");

    let html = formatMultiTfHTML(d, valid, horizon, isNhanh);
    if (auxCtx) {
      const auxLines = formatAuxBlock(auxCtx).split("\n").map(l => htmlEsc(l)).join("\n");
      html = html.replace(/(<i>[^<]*<\/i>\n)?\n(━━━ <b>📊 Bias)/, `$1${auxLines}\n\n$2`);
      // Fallback nếu regex không match: prepend
      if (!html.includes(auxLines)) {
        html = `${auxLines}\n\n${html}`;
      }
    }
    const parts = splitForTelegram(html, 3900);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n\n<i>[${i + 1}/${parts.length}]</i>` : "";
      await sendTelegramTo(env, chatId, parts[i] + suffix, i === 0 ? replyTo : null, "HTML");
    }
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

function formatMultiTfHTML(d, valid, horizon, isNhanh) {
  const fmt2 = (n) => (typeof n === "number" && !isNaN(n)) ? n.toFixed(2) : "?";
  const consensus = (d.consensus_bias || "NEUTRAL").toUpperCase();
  const consensusIcon = { LONG: "📈", SHORT: "📉", NEUTRAL: "➡️" }[consensus] || "❓";
  const alignment = {
    "all_align": "✅ Đồng thuận",
    "majority":  "⚠️ Đa số",
    "divergent": "❌ Phân vân",
  }[d.alignment] || htmlEsc(d.alignment || "?");

  const tfsLabel = valid.map(v => v.tf).join(" + ");
  const prefix = isNhanh ? "Quét nhanh" : "Phân tích chi tiết";

  let m = `<b>🥇 ${prefix} đa khung: ${tfsLabel}</b> (Horizon ${horizon})\n`;
  m += `${consensusIcon} Đồng thuận: <b>${consensus}</b> | Tin cậy: <b>${htmlEsc(d.do_tin_cay || "?")}</b> | ${alignment}\n`;
  if (d.tom_tat) m += `<i>${htmlEsc(d.tom_tat)}</i>\n`;

  // Xu hướng từng khung — luôn show TẤT CẢ valid TFs (dù AI có miss thì hiện "chưa rõ")
  m += `\n<b>📊 Xu hướng từng khung:</b>\n`;
  const byTf = d.by_tf || {};
  for (const v of valid) {
    // Try multiple key variants AI có thể dùng
    const b = byTf[v.tf] || byTf[v.tf.replace("m", "p")] || byTf[v.tf.toUpperCase()];
    if (!b) {
      m += `• <b>${v.tf}</b>: <i>chưa có (AI thiếu data)</i>\n`;
      continue;
    }
    const bIcon = { LONG: "📈", SHORT: "📉", NEUTRAL: "➡️" }[String(b.bias || "").toUpperCase()] || "•";
    m += `${bIcon} <b>${v.tf}</b>: ${htmlEsc(b.bias || "?")}`;
    if (b.key_level) m += ` | $${fmt2(b.key_level)}`;
    if (b.ghi_chu) m += ` <i>— ${htmlEsc(b.ghi_chu)}</i>`;
    m += `\n`;
  }

  m += `\n━━━ <b>🎯 KHUYẾN NGHỊ GIÁ VÀO LỆNH</b> ━━━\n\n`;

  const scenarioBlock = (sc, label, icon) => {
    if (!sc?.kha_thi) {
      return `${icon} <b>${label}</b>: ❌ chưa khả thi\n<i>${htmlEsc(sc?.ly_do || "Chưa thuận")}</i>`;
    }
    const slDist = (sc.entry != null && sc.sl != null) ? Math.abs(sc.entry - sc.sl) : null;
    let s = `${icon} <b>${label}</b> ✅`;
    if (sc.rr != null) s += ` | R:R: <b>${Number(sc.rr).toFixed(1)}</b>`;
    s += `\n📍 Điểm vào (Entry): <b>$${fmt2(sc.entry)}</b>\n`;
    s += `🛑 Cắt lỗ (SL): <b>$${fmt2(sc.sl)}</b>${slDist ? ` <i>(rủi ro ~${slDist.toFixed(2)} điểm)</i>` : ""}\n`;
    // TP — ưu tiên TP1/2/3 nếu có, fallback TP đơn
    const rrFor = (tp) => (slDist && tp != null) ? Math.abs((tp - sc.entry) / slDist).toFixed(1) : null;
    if (sc.tp1 != null || sc.tp2 != null || sc.tp3 != null) {
      if (sc.tp1 != null) s += `🎯 Chốt lời 1 (TP1, R:R ${rrFor(sc.tp1) || "?"} — an toàn): <b>$${fmt2(sc.tp1)}</b>\n`;
      if (sc.tp2 != null) s += `🎯 Chốt lời 2 (TP2, R:R ${rrFor(sc.tp2) || "?"} — kỳ vọng): <b>$${fmt2(sc.tp2)}</b>\n`;
      if (sc.tp3 != null) s += `🎯 Chốt lời 3 (TP3, R:R ${rrFor(sc.tp3) || "?"} — mở rộng): <b>$${fmt2(sc.tp3)}</b>\n`;
    } else if (sc.tp != null) {
      s += `🎯 Chốt lời (TP): <b>$${fmt2(sc.tp)}</b>\n`;
    }
    if (sc.dieu_kien_confirm) s += `✅ Điều kiện xác nhận: ${htmlEsc(sc.dieu_kien_confirm)}\n`;
    if (sc.ly_do) s += `<i>💡 ${htmlEsc(sc.ly_do)}</i>`;
    return s;
  };

  m += scenarioBlock(d.long, "MUA (LONG)", "📈") + "\n\n";
  m += scenarioBlock(d.short, "BÁN (SHORT)", "📉") + "\n\n";

  if ((Array.isArray(d.khang_cu) && d.khang_cu.length) || (Array.isArray(d.ho_tro) && d.ho_tro.length)) {
    m += `<b>📍 Mức giá quan trọng:</b>\n`;
    for (const k of (d.khang_cu || [])) {
      m += `▲ <b>$${fmt2(k.gia)}</b>${k.ghi_chu ? ` <i>— ${htmlEsc(k.ghi_chu)}</i>` : ""}\n`;
    }
    for (const h of (d.ho_tro || [])) {
      m += `▼ <b>$${fmt2(h.gia)}</b>${h.ghi_chu ? ` <i>— ${htmlEsc(h.ghi_chu)}</i>` : ""}\n`;
    }
    m += `\n`;
  }

  m += `━━━ <b>📊 PHÂN TÍCH TỪ KHUNG LỚN XUỐNG NHỎ</b> ━━━\n`;
  if (d.phan_tich_top_down) m += htmlEsc(d.phan_tich_top_down) + "\n\n";

  if (Array.isArray(d.rui_ro_chinh) && d.rui_ro_chinh.length) {
    m += `<b>⚠️ Rủi ro chính:</b>\n`;
    for (const r of d.rui_ro_chinh) m += `• ${htmlEsc(r)}\n`;
  }

  return m;
}

async function handleTelegramUpdate(env, update) {
  // Outer try/catch — bảo đảm không bao giờ silent fail trong waitUntil()
  try {
    return await _handleTelegramUpdate(env, update);
  } catch (e) {
    console.log(`[bot] FATAL handler error: ${e.message}\n${e.stack || ""}`);
    // Cố gắng báo user biết bot đã nhận lệnh nhưng lỗi
    try {
      const msg = update?.message || update?.channel_post;
      if (msg?.chat?.id && String(msg.chat.id) === String(env.TELEGRAM_CHAT_ID)) {
        await sendTelegramTo(
          env,
          msg.chat.id,
          `❌ <b>Lỗi xử lý lệnh:</b> <code>${htmlEsc(e.message).slice(0, 300)}</code>\nThử lại hoặc /help.`,
          msg.message_id,
          "HTML",
        );
      }
    } catch {}
  }
}

async function _handleTelegramUpdate(env, update) {
  // Log mọi update tới webhook (để debug "bot không trả lời")
  const updateType = update.message
    ? "message"
    : update.edited_message
    ? "edited_message"
    : update.channel_post
    ? "channel_post"
    : update.edited_channel_post
    ? "edited_channel_post"
    : Object.keys(update).find(k => k !== "update_id") || "unknown";

  const msg = update.message || update.channel_post;
  if (!msg) {
    // Edited message / callback / khác → bot không xử lý (Telegram thường gửi update kiểu này khi user sửa msg cũ)
    console.log(`[bot] skip update type=${updateType} (không phải message mới)`);
    return;
  }
  if (!msg.text) {
    console.log(`[bot] skip non-text message (sticker/photo/...) chat=${msg.chat?.id}`);
    return;
  }

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const replyTo = msg.message_id;
  const fromUser = msg.from?.username || msg.from?.first_name || "?";

  // Auth: chỉ chấp nhận từ chat đã configure (defense against random chats finding webhook)
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.log(`[bot] ignore chat=${chatId} (configured=${env.TELEGRAM_CHAT_ID}) from=${fromUser} text="${text.slice(0, 60)}"`);
    return;
  }

  // Parse command (strip @bot_username if mentioned)
  const tokens = text.split(/\s+/);
  const cmd = tokens[0].toLowerCase().split("@")[0];
  const args = tokens.slice(1);

  console.log(`[bot] receive type=${updateType} from=${fromUser} cmd=${cmd} args=[${args.join(",")}] textLen=${text.length}`);

  // Schedule xoá tin lệnh CỦA USER — bot phải có quyền 'Delete messages' trong group.
  // Trừ các lệnh muốn giữ lâu (help/tudien/xoa) — user thường xem lại.
  const KEEP_USER_CMD = new Set([
    "/help", "/start", "/trogiup",
    "/tudien", "/glossary",
    "/xoa", "/xóa", "/del", "/delete",
  ]);
  if (!KEEP_USER_CMD.has(cmd)) {
    await scheduleAutoDelete(env, chatId, msg.message_id);
  }

  // Help / start — KHÔNG auto-delete (reference dài hạn)
  if (cmd === "/start" || cmd === "/help" || cmd === "/trogiup") {
    await sendTelegramTo(env, chatId, helpMessage(), replyTo, "Markdown", false);
    return;
  }
  // Dictionary thuật ngữ — KHÔNG auto-delete (reference dài hạn)
  if (cmd === "/tudien" || cmd === "/glossary") {
    await sendTelegramTo(env, chatId, glossaryMessage(), replyTo, "Markdown", false);
    return;
  }
  // /xoa <time> — cấu hình thời gian tự xoá tin
  if (cmd === "/xoa" || cmd === "/xóa" || cmd === "/del" || cmd === "/delete") {
    await handleXoaCmd(env, chatId, replyTo, args);
    return;
  }
  // /tin — tổng hợp tin tức 7 ngày + AI dự đoán
  // /tin <topic> — phân tích chuyên sâu 1 event (NFP/CPI/FOMC/...)
  if (cmd === "/tin" || cmd === "/news") {
    const topic = text.replace(/^\S+\s*/, "").trim();
    await handleTinCmd(env, chatId, replyTo, topic || null);
    return;
  }
  // /ai (hoặc /AI), /ask, /hoi — tư vấn position sizing / risk management
  if (cmd === "/ai" || cmd === "/ask" || cmd === "/hoi") {
    const question = text.replace(/^\S+\s*/, "").trim();
    await handleAskCmd(env, chatId, replyTo, question);
    return;
  }
  // Giá hiện tại (no AI, instant)
  if (cmd === "/gia" || cmd === "/giá" || cmd === "/price") {
    await handlePriceCmd(env, chatId, replyTo);
    return;
  }
  // /nhanh = Pulse 5 khung (no AI, instant rule-based)
  if (cmd === "/nhanh") {
    await handleNhanhPulse(env, chatId, replyTo, args);
    return;
  }
  // /nhanh5p, /nhanh15p, /nhanh1h, /nhanh4h, /nhanh1d = AI quick scan single TF
  if (VN_SCAN_CMD_TO_TF[cmd]) {
    await handleScanCmd(env, chatId, replyTo, VN_SCAN_CMD_TO_TF[cmd], args);
    return;
  }
  // Phân tích SMC theo TF — match lệnh tiếng Việt /5p, /15p, /1h, /4h, /1d, ...
  if (VN_CMD_TO_TF[cmd]) {
    await handleAnalyzeCmd(env, chatId, replyTo, VN_CMD_TO_TF[cmd], args);
    return;
  }
  // Combo: /5p15p1h hoặc /nhanh5p15p1h → phân tích TOP-DOWN tổng hợp 1 reply
  // Optional aux args: oil/dxy/all (vd /5p15p1h all)
  const multi = parseMultiTfCommand(cmd);
  if (multi) {
    console.log(`[bot] multi-tf ${multi.isNhanh ? "scan" : "analyze"}: ${multi.tfs.join(",")} | args=${args.join(",")}`);
    await handleMultiTfAnalyze(env, chatId, replyTo, multi.tfs, multi.isNhanh, args);
    return;
  }
  // Backward compat: /analyze [tf] hoặc /smc [tf]
  if (cmd === "/analyze" || cmd === "/smc" || cmd === "/phantich") {
    await handleAnalyzeCmd(env, chatId, replyTo, args[0] || "15m");
    return;
  }
  // Lệnh bắt đầu với "/" nhưng không match → reply nhẹ để user biết bot đã nhận
  // (text thường không phải command thì silent — không spam group)
  if (cmd.startsWith("/")) {
    console.log(`[bot] unknown cmd=${cmd}`);
    await sendTelegramTo(
      env,
      chatId,
      `❓ Lệnh <code>${htmlEsc(cmd)}</code> chưa hỗ trợ. Gõ /help để xem danh sách.`,
      replyTo,
      "HTML",
    );
    return;
  }
  // Text bình thường (không phải command) — bỏ qua, không spam group
}

// Main cron handler — chạy mỗi 5 phút.
// Luôn dọn auto-delete trước, ngay cả khi không có alert mới.
async function runAlertCheck(env, { force = false } = {}) {
  // Dọn message hết hạn — ALWAYS chạy (kể cả thiếu Telegram secret, kể cả cuối tuần).
  await cleanupExpiredMessages(env);

  // Pre-event check (LUÔN chạy, kể cả T7/CN) — event sáng thứ Hai cần alert
  // 4h trước = chiều Chủ Nhật. Không tốn TD credit, chỉ Telegram + KV.
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await checkAndFirePreEventAlerts(env);
    } catch (e) {
      console.log(`[cron] pre-event check fail: ${e.message}`);
    }
  }

  // Vàng (XAU/USD) đóng cửa cuối tuần: thị trường ngừng giao dịch từ Sat 00 UTC
  // đến hết Sun 21 UTC. Skip alert check để tiết kiệm quota TwelveData và tránh
  // gửi cảnh báo trên dữ liệu nến cũ. Manual trigger ({force:true}) vẫn chạy.
  if (!force) {
    const utcDay = new Date().getUTCDay(); // 0=CN, 6=T7
    if (utcDay === 0 || utcDay === 6) {
      console.log(`[cron] cuối tuần (UTC day=${utcDay}) — vàng nghỉ, skip alert check (pre-event đã chạy)`);
      return;
    }
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("[cron] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID chưa set, skip");
    return;
  }
  if (!hasAnyTdKey(env)) {
    console.log("[cron] Chưa có TWELVEDATA_API_KEY_* nào, skip");
    return;
  }
  try {
    // BƯỚC 1: Chỉ fetch 15m (mandatory) + pivots cache để detect signals.
    // Nếu không có alert/mega → RETURN ngay, không tốn credit 5m/1h/4h.
    // Tiết kiệm ~60-70% TD credits/day (cron đa số tick không có signal).
    const [c15m, pivots] = await Promise.all([
      fetchTdCandles(env, "15min", 220),
      getCachedDailyPivots(env),
    ]);

    if (c15m.length < 200) {
      console.log(`[cron] insufficient 15m candles: ${c15m.length}`);
      return;
    }

    const e15m = enrichIndicators(c15m);
    const latest = e15m[e15m.length - 1];
    const prev = e15m[e15m.length - 2];

    const regime = classifyVolRegime(e15m);
    const regimeShiftAlert = await trackVolRegime(env, regime);
    const mega = detectMegaMove(e15m);
    const alerts = await detectFreshAlerts(env, latest, prev, pivots, e15m);
    if (regimeShiftAlert) alerts.unshift(regimeShiftAlert);

    const session = getSessionInfo();
    if (alerts.length === 0 && !mega.triggered) {
      console.log(`[cron] no signal, price=${latest.close.toFixed(2)} rsi=${latest.rsi?.toFixed(1)} atr=${latest.atr?.toFixed(2)} session=${session.code} M=${session.volMult} regime=${regime.code}(${regime.ratio?.toFixed(2)}x) [skip 5m/1h fetch]`);
      return;
    }

    // BƯỚC 2: Có signal → fetch supplementary (5m + 1h song song; 4h chỉ khi mega)
    const supplFetches = [
      fetchTdCandles(env, "5min", 220).catch(e => { console.log(`[cron] 5m fail: ${e.message}`); return []; }),
      fetchTdCandles(env, "1h", 220).catch(e => { console.log(`[cron] 1h fail: ${e.message}`); return []; }),
    ];
    if (mega.triggered) {
      supplFetches.push(fetchTdCandles(env, "4h", 220).catch(e => { console.log(`[cron] 4h fail: ${e.message}`); return []; }));
    }
    const supplRes = await Promise.all(supplFetches);
    const c5m = supplRes[0], c1h = supplRes[1], c4h = supplRes[2] || [];
    const e5m = c5m.length >= 50 ? enrichIndicators(c5m) : null;
    const e1h = c1h.length >= 50 ? enrichIndicators(c1h) : null;
    const e4h = c4h.length >= 50 ? enrichIndicators(c4h) : null;

    const mtfContext = {
      "5p":  e5m  ? e5m[e5m.length - 1]   : null,
      "15p": latest,
      "1g":  e1h  ? e1h[e1h.length - 1]   : null,
    };

    if (mega.triggered) {
      // MEGA-MOVE active → gộp 1 message: mega + alerts non-vol-redundant
      const REDUNDANT_WITH_MEGA = new Set([
        "big_move_up", "big_move_dn",
        "multi_move_up", "multi_move_dn",
        "vol_spike", "bb_expand",
        "wick_top", "wick_bottom",
      ]);
      const extraAlerts = alerts.filter(a => !REDUNDANT_WITH_MEGA.has(a.key));

      console.log(`[cron] MEGA-MOVE triggered: ${mega.direction} $${mega.dollarMove.toFixed(2)} (${mega.atrRatio.toFixed(1)}× ATR, ${mega.type}). Extra alerts: ${extraAlerts.length}/${alerts.length}`);

      let result = null;
      try {
        result = await runDeepAnalysis(env, { mode: "mega", mega, e15m, e1h, e4h, regime, session, alerts: extraAlerts, latest, pivots, mtfContext });
      } catch (e) {
        console.log(`[cron] mega deep analysis fail: ${e.message}`);
      }

      // Fallback: mega cooldown nhưng còn non-redundant alerts → gửi regular alerts
      if (result?.skipped === "cooldown" && extraAlerts.length > 0) {
        const msg = formatAlertMessage(latest, extraAlerts, pivots, mtfContext);
        const ok = await sendTelegram(env, msg);
        console.log(`[cron] mega cooldown, fallback ${extraAlerts.length} non-redundant alerts, telegram=${ok}`);
      }
    } else if (alerts.length > 0) {
      // Regular alerts → deep analysis (AI + trade setups + news)
      console.log(`[cron] ${alerts.length} alerts triggered, run deep analysis (no mega)`);
      try {
        await runDeepAnalysis(env, { mode: "alerts", alerts, e15m, e1h, e4h, regime, session, latest, pivots, mtfContext });
      } catch (e) {
        console.log(`[cron] alerts deep analysis fail: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`[cron] error: ${e.message}`);
  }
}

async function tryWorkersAI(env, body) {
  if (!env.AI) {
    console.log(`[workers-ai] env.AI binding không có → bỏ qua`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }

  const messages = [];
  if (parsed.systemInstruction?.parts) {
    messages.push({
      role: "system",
      content: parsed.systemInstruction.parts.map(p => p.text || "").join("\n"),
    });
  }
  for (const c of parsed.contents || []) {
    messages.push({
      role: c.role === "model" ? "assistant" : "user",
      content: (c.parts || []).map(p => p.text || "").join("\n"),
    });
  }

  const opts = {
    messages,
    max_tokens: parsed.generationConfig?.maxOutputTokens || 2048,
    temperature: parsed.generationConfig?.temperature ?? 0.5,
  };
  if (parsed.generationConfig?.responseMimeType === "application/json") {
    opts.response_format = { type: "json_object" };
  }

  const totalChars = messages.reduce((s, m) => s + m.content.length, 0);
  // Llama 3.1 8B nhanh hơn 3.3 70B nhiều (~3-5s vs 10-20s) cho output schema cứng.
  // Quality kém hơn nhưng đủ cho structured JSON khi Gemini outage.
  const model = "@cf/meta/llama-3.1-8b-instruct-fast";
  console.log(`[workers-ai] gọi ${model} (${totalChars} chars input, max ${opts.max_tokens} tokens)`);

  // Timeout 20s — Worker waitUntil 30s tổng, đã dùng ~7s cho 2 keys Gemini
  // còn ~23s, để 3s buffer cho format + send Telegram
  const t0 = Date.now();
  let aiResp;
  try {
    aiResp = await Promise.race([
      env.AI.run(model, opts),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Workers AI timeout 20s")), 20_000)),
    ]);
  } catch (e) {
    console.log(`[workers-ai] error after ${Date.now() - t0}ms: ${e.message}`);
    return null;
  }
  console.log(`[workers-ai] xong sau ${Date.now() - t0}ms`);

  // Workers AI với response_format=json_object có thể trả .response là object
  // (đã parse) thay vì string. Convert về string để Gemini-format wrapper consistent.
  let text = aiResp?.response;
  if (text && typeof text !== "string") {
    text = JSON.stringify(text);
  }
  if (!text) {
    console.log(`[workers-ai] response trống — aiResp keys: ${Object.keys(aiResp || {}).join(",")}`);
    return null;
  }
  console.log(`[workers-ai] text length=${text.length}, head=${text.slice(0, 100).replace(/\n/g, " ")}`);

  return {
    candidates: [{
      content: { parts: [{ text }] },
      finishReason: "STOP",
    }],
    usageMetadata: { source: "workers-ai-llama-3.3" },
  };
}

export default {
  // Cron handler: chạy theo schedule trong wrangler.toml [triggers] crons
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAlertCheck(env));
  },

  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health check + diagnostic location (debug Smart Placement)
    if (url.pathname === "/" || url.pathname === "/health") {
      const allKeys = collectGeminiKeys(env);
      const cooldownState = {};
      for (const k of allKeys) {
        const s = keyState.get(k.label);
        const remaining = s ? Math.max(0, Math.floor((s.until - Date.now()) / 1000)) : 0;
        cooldownState[k.label] = remaining > 0
          ? `cooldown ${remaining}s (last status ${s.lastStatus})`
          : "active";
      }
      const tdKeys = collectTdKeys(env);
      const tdCooldownState = {};
      for (const k of tdKeys) {
        const s = tdKeyState.get(k.label);
        const remaining = s ? Math.max(0, Math.floor((s.until - Date.now()) / 1000)) : 0;
        tdCooldownState[k.label] = remaining > 0
          ? `cooldown ${remaining}s (${s.kind})`
          : "active";
      }

      // Session + volatility regime (regime đọc từ KV, do cron lưu)
      const session = getSessionInfo();
      let volRegime = null;
      try {
        const raw = await cacheGet(env, VOL_REGIME_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          volRegime = {
            code: s.code,
            ratio: s.ratio,
            since: new Date(s.since).toISOString(),
            since_minutes_ago: Math.floor((Date.now() - s.since) / 60000),
          };
        }
      } catch {}

      return jsonResponse(200, {
        ok: true,
        service: "xau-gemini-proxy",
        gemini_keys_count: allKeys.length,
        gemini_keys_state: cooldownState,
        td_keys_count: tdKeys.length,
        td_keys_state: tdCooldownState,
        session: { code: session.code, name: session.name, vol_multiplier: session.volMult },
        vol_regime: volRegime,
        worker_dc: request.cf?.colo || "unknown",
        worker_country: request.cf?.country || "unknown",
        endpoints: [
          "/health",
          "/v1beta/models/{model}:generateContent",
          "/twelvedata/time_series",
          "/twelvedata/price",
          "/probe",
        ],
      }, origin);
    }

    // Telegram webhook endpoint — Telegram POST update tới đây mỗi khi có message
    //
    // Telegram timeout của họ ~10s. Worker phải trả 200 OK NGAY, sau đó
    // ctx.waitUntil() tiếp tục xử lý nền (~30s wall time).
    //
    // Để chắc xử lý <30s, các handler đã tối ưu: thinking=0, maxTokens nhỏ,
    // candles fetch giảm còn 150, không HTF context cho LTF analysis.
    //
    // Dedup theo update_id phòng Telegram retry trùng (TTL 5 phút).
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      let update;
      try {
        update = await request.json();
      } catch (e) {
        console.log(`[webhook] parse error: ${e.message}`);
        return new Response("OK", { status: 200 });
      }

      const updateId = update?.update_id;
      if (updateId && env.CACHE) {
        const dedupKey = `tg_processed:${updateId}`;
        const seen = await env.CACHE.get(dedupKey);
        if (seen) {
          console.log(`[webhook] skip duplicate update_id=${updateId}`);
          return new Response("OK", { status: 200 });
        }
        ctx.waitUntil(env.CACHE.put(dedupKey, "1", { expirationTtl: 300 }));
      }

      // Trả 200 OK NGAY (Telegram timeout ~10s) + xử lý trong waitUntil.
      ctx.waitUntil(handleTelegramUpdate(env, update).catch(e => {
        console.log(`[webhook] handler fatal: ${e.message}`);
      }));
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // Debug: chạy 1 lệnh bot synchronous + dump error nếu có.
    // Sử dụng: /test-cmd?text=/5p15p1h%20all
    if (url.pathname === "/test-cmd") {
      const text = url.searchParams.get("text") || "/help";
      const sendReply = url.searchParams.get("send") === "1"; // mặc định KHÔNG gửi vào group
      const fakeUpdate = {
        update_id: Date.now(),
        message: {
          message_id: 0,
          from: { id: 0, is_bot: false, first_name: "test-cmd" },
          chat: { id: parseInt(env.TELEGRAM_CHAT_ID), type: "supergroup", title: "test" },
          date: Math.floor(Date.now() / 1000),
          text,
          entities: text.startsWith("/") ? [{ offset: 0, length: text.split(" ")[0].length, type: "bot_command" }] : [],
        },
      };
      const logs = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); origLog(...args); };

      // Stub sendTelegramTo nếu không send → tránh spam group khi test
      const origFetch = globalThis.fetch;
      let sentMessages = [];
      if (!sendReply) {
        globalThis.fetch = async (u, opts) => {
          if (typeof u === "string" && u.includes("api.telegram.org") && u.includes("/sendMessage")) {
            try { sentMessages.push(JSON.parse(opts.body)); } catch {}
            return new Response(JSON.stringify({ ok: true, result: { message_id: 0 } }), { status: 200 });
          }
          if (typeof u === "string" && u.includes("api.telegram.org") && u.includes("/sendChatAction")) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return origFetch(u, opts);
        };
      }

      let err = null, errStack = null;
      const t0 = Date.now();
      try {
        await handleTelegramUpdate(env, fakeUpdate);
      } catch (e) {
        err = e.message;
        errStack = e.stack;
      } finally {
        console.log = origLog;
        globalThis.fetch = origFetch;
      }

      return jsonResponse(200, {
        text,
        elapsedMs: Date.now() - t0,
        error: err,
        errorStack: errStack?.slice(0, 1000),
        sentMessages: sentMessages.map(m => ({
          text: m.text || "",  // full text, không cắt
          textLen: (m.text || "").length,
          parse_mode: m.parse_mode,
        })),
        logs,
      }, origin);
    }

    // Test economic calendar fetch + pre-event scan: GET /test-precal?dry=1
    //   dry=1 — trả JSON danh sách event sắp tới, không gửi Telegram
    if (url.pathname === "/test-precal") {
      const dry = url.searchParams.get("dry") === "1";
      try {
        const events = await fetchEconomicCalendar(env);
        const now = Date.now();
        const upcoming = events
          .filter(e => e.ts > now && e.ts < now + 7 * 24 * 3600 * 1000)
          .map(e => ({
            title: e.title,
            vn_label: vietnameseEventLabel(e.title),
            date_vn: new Date(e.ts).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
            date_utc: new Date(e.ts).toISOString().slice(0, 16).replace("T", " "),
            minutes_to_event: ((e.ts - now) / 60000).toFixed(1),
            impact: e.impact,
            forecast: e.forecast,
            previous: e.previous,
          }))
          .sort((a, b) => parseFloat(a.minutes_to_event) - parseFloat(b.minutes_to_event));

        if (dry) {
          return jsonResponse(200, { events_count: events.length, upcoming_count: upcoming.length, upcoming: upcoming.slice(0, 10) }, origin);
        }
        const fired = await checkAndFirePreEventAlerts(env);
        return jsonResponse(200, { ok: true, fired, upcoming_count: upcoming.length }, origin);
      } catch (e) {
        return jsonResponse(500, { error: e.message }, origin);
      }
    }

    // Test alerts deep analysis: GET /test-alerts?force=1&reset_cooldown=1&dry=1
    //   force=1 — bỏ qua trigger check (dùng alerts giả nếu không có alerts thật)
    //   dry=1 — KHÔNG gửi Telegram
    //   reset_cooldown=1 — xoá KV cooldown
    if (url.pathname === "/test-alerts") {
      const force = url.searchParams.get("force") === "1";
      const dry = url.searchParams.get("dry") === "1";
      const resetCooldown = url.searchParams.get("reset_cooldown") === "1";
      if (resetCooldown && env.CACHE) {
        await env.CACHE.delete("deep:alerts:last");
        console.log(`[test-alerts] cooldown reset`);
      }
      try {
        const [c15m, c1h] = await Promise.all([
          fetchTdCandles(env, "15min", 220),
          fetchTdCandles(env, "1h", 220),
        ]);
        if (c15m.length < 50) return jsonResponse(500, { error: `insufficient candles` }, origin);
        const e15m = enrichIndicators(c15m);
        const e1h = c1h.length >= 50 ? enrichIndicators(c1h) : null;
        const latest = e15m[e15m.length - 1];
        const prev = e15m[e15m.length - 2];
        const pivots = await getCachedDailyPivots(env);

        let alerts = await detectFreshAlerts(env, latest, prev, pivots, e15m);
        if (alerts.length === 0 && force) {
          // Seed fake alerts cho test format
          alerts = [
            { key: "test_rsi", icon: "🔴", text: `RSI 15p quá mua *${latest.rsi?.toFixed(1) || 70}* — coi chừng điều chỉnh`, suggestion: null },
            { key: "test_pivot", icon: "🎯", text: `Phá điểm xoay R1 (Pivot) *$${(latest.close + 5).toFixed(2)}* lên`, suggestion: null },
          ];
        }

        const regime = classifyVolRegime(e15m);
        const session = getSessionInfo();

        if (dry) {
          return jsonResponse(200, {
            alerts_count: alerts.length,
            alerts: alerts.map(a => ({ key: a.key, icon: a.icon, text: a.text })),
            regime, session,
            note: "dry=1: không gửi Telegram",
          }, origin);
        }

        const result = await runDeepAnalysis(env, { mode: "alerts", alerts, e15m, e1h, e4h: null, regime, session, latest, pivots });
        return jsonResponse(200, { ok: true, alerts_count: alerts.length, result }, origin);
      } catch (e) {
        return jsonResponse(500, { error: e.message, stack: e.stack?.slice(0, 500) }, origin);
      }
    }

    // Test mega-move analysis: GET /test-megamove?force=1&dry=1
    //   force=1 — bỏ qua trigger check (chạy dù chưa thực sự mega-move)
    //   dry=1 — KHÔNG gửi Telegram, trả JSON thay vì
    // Mục đích: xem format output + verify rule scan + AI call hoạt động.
    if (url.pathname === "/test-megamove") {
      const force = url.searchParams.get("force") === "1";
      const dry = url.searchParams.get("dry") === "1";
      const resetCooldown = url.searchParams.get("reset_cooldown") === "1";
      if (resetCooldown && env.CACHE) {
        await Promise.all([
          env.CACHE.delete("mega_move:last"),
          env.CACHE.delete("deep:mega:last"),
        ]);
        console.log(`[test-megamove] cooldown reset (both legacy + deep:mega)`);
      }
      try {
        const [c15m, c1h, c4h] = await Promise.all([
          fetchTdCandles(env, "15min", 220),
          fetchTdCandles(env, "1h", 220),
          fetchTdCandles(env, "4h", 220),
        ]);
        if (c15m.length < 50) return jsonResponse(500, { error: `insufficient 15m candles: ${c15m.length}` }, origin);
        const e15m = enrichIndicators(c15m);
        const e1h = c1h.length >= 50 ? enrichIndicators(c1h) : null;
        const e4h = c4h.length >= 50 ? enrichIndicators(c4h) : null;
        const latest = e15m[e15m.length - 1];

        let mega = detectMegaMove(e15m);
        if (!mega.triggered && force) {
          // Force: fake mega-move based on actual last candle direction
          const prev = e15m[e15m.length - 4];
          const movement = latest.close - (prev?.close || latest.open);
          mega = {
            triggered: true,
            type: "forced_test",
            direction: movement >= 0 ? "up" : "down",
            dollarMove: Math.max(Math.abs(movement), 20),
            atrRatio: Math.max(Math.abs(movement) / (latest.atr || 1), 2),
            pctMove: Math.abs(movement) / (prev?.close || latest.close) * 100,
            windowMinutes: 45,
          };
        }

        const regime = classifyVolRegime(e15m);
        const session = getSessionInfo();
        const reversal = scanReversalSignals(e15m, e1h, e4h, mega);
        const news = await fetchTopGoldNews(env, 5).catch(() => []);

        if (dry) {
          return jsonResponse(200, {
            mega_detected_naturally: detectMegaMove(e15m).triggered,
            mega_used: mega,
            regime,
            session: { code: session.code, name: session.name, volMult: session.volMult },
            reversal,
            news_count: news.length,
            news_preview: news.slice(0, 3),
            note: "dry=1: không gửi Telegram. Bỏ dry để gửi thật.",
          }, origin);
        }

        // Chạy thật (sẽ gửi Telegram nếu trigger + chưa cooldown)
        const result = await runMegaMoveAnalysis(env, { mega, e15m, e1h, e4h, regime, session });
        return jsonResponse(200, {
          ok: true,
          mega_triggered: mega.triggered,
          mega,
          regime,
          reversal: { score: reversal.score, verdict: reversal.verdict },
          orchestrator_result: result || null,
        }, origin);
      } catch (e) {
        return jsonResponse(500, { error: e.message, stack: e.stack?.slice(0, 500) }, origin);
      }
    }

    // Debug toàn diện: webhook + bot + TwelveData + Gemini key cooldowns
    if (url.pathname === "/diag") {
      const out = {
        timestamp: new Date().toISOString(),
        secrets: {
          TELEGRAM_BOT_TOKEN: !!env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || null,
          TWELVEDATA_API_KEY_1: !!env.TWELVEDATA_API_KEY_1,
          TWELVEDATA_API_KEY_2: !!env.TWELVEDATA_API_KEY_2,
          TWELVEDATA_API_KEY_3: !!env.TWELVEDATA_API_KEY_3,
          TWELVEDATA_API_KEY_legacy: !!env.TWELVEDATA_API_KEY,
          GEMINI_API_KEY_1: !!env.GEMINI_API_KEY_1,
          GEMINI_API_KEY_2: !!env.GEMINI_API_KEY_2,
          GEMINI_API_KEY_3: !!env.GEMINI_API_KEY_3,
          GEMINI_API_KEY_4: !!env.GEMINI_API_KEY_4,
          GEMINI_API_KEY_5: !!env.GEMINI_API_KEY_5,
        },
      };

      // Telegram webhook + bot info
      if (env.TELEGRAM_BOT_TOKEN) {
        try {
          const [whR, meR] = await Promise.all([
            fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`),
            fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`),
          ]);
          out.webhook = (await whR.json()).result;
          out.bot = (await meR.json()).result;
        } catch (e) { out.telegramErr = e.message; }
      }

      // TwelveData: probe từng key riêng để biết key nào còn quota.
      // Mỗi probe consume 1 credit, nên check cẩn thận khi gần hết.
      const tdKeys = collectTdKeys(env);
      out.twelvedata = { keys_count: tdKeys.length, per_key: [] };
      for (const k of tdKeys) {
        const t0 = Date.now();
        try {
          const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=15min&outputsize=2&apikey=${k.key}`);
          const j = await r.json();
          out.twelvedata.per_key.push({
            label: k.label,
            source: k.source,
            status: r.status,
            ok: j.status !== "error",
            message: j.status === "error" ? j.message : "OK",
            elapsedMs: Date.now() - t0,
          });
        } catch (e) {
          out.twelvedata.per_key.push({ label: k.label, source: k.source, error: e.message });
        }
      }
      // Cooldown state in-memory
      out.twelvedata.cooldown = {};
      for (const k of tdKeys) {
        const s = tdKeyState.get(k.label);
        const remaining = s ? Math.max(0, Math.floor((s.until - Date.now()) / 1000)) : 0;
        out.twelvedata.cooldown[k.label] = remaining > 0
          ? { remaining_s: remaining, kind: s.kind, message: s.message }
          : "active";
      }

      // Cooldown của Gemini keys lưu trong in-memory Map (per isolate),
      // không lưu KV → /diag không read được. Chỉ đếm số key có cấu hình:
      const keys = collectGeminiKeys(env);
      out.geminiKeysActive = {
        count: keys.length,
        slots: keys.map(k => ({ label: k.label, source: k.source })),
        note: "Cooldown 429 lưu in-memory per isolate, không readable từ /diag. Xem qua wrangler tail.",
      };

      return jsonResponse(200, out, origin);
    }

    // Debug: get webhook health từ Telegram (có pending updates / lỗi delivery không)
    if (url.pathname === "/webhook-info") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonResponse(500, { error: "TELEGRAM_BOT_TOKEN chưa set" }, origin);
      }
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      const info = await r.json();
      const meR = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      const me = await meR.json();
      return jsonResponse(200, {
        chatIdConfigured: env.TELEGRAM_CHAT_ID,
        botInfo: me.result,
        webhookInfo: info.result,
        diagnostics: {
          pendingUpdates: info.result?.pending_update_count || 0,
          lastErrorDate: info.result?.last_error_date
            ? new Date(info.result.last_error_date * 1000).toISOString()
            : null,
          lastErrorMessage: info.result?.last_error_message || null,
          lastSyncErrorDate: info.result?.last_synchronization_error_date
            ? new Date(info.result.last_synchronization_error_date * 1000).toISOString()
            : null,
        },
      }, origin);
    }

    // Setup webhook (chạy 1 lần sau deploy để register URL với Telegram)
    if (url.pathname === "/setup-webhook") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonResponse(500, { error: "TELEGRAM_BOT_TOKEN chưa set" }, origin);
      }
      const webhookUrl = `https://${url.host}/telegram-webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const result = await r.json();
      return jsonResponse(200, { webhookUrl, telegramResponse: result }, origin);
    }

    // Register bot commands với Telegram (loại bỏ 'Unknown command' warning + autocomplete)
    if (url.pathname === "/register-commands") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return jsonResponse(500, { error: "TELEGRAM_BOT_TOKEN chưa set" }, origin);
      }
      const commands = [
        { command: "gia",      description: "Giá XAU + indicators" },
        { command: "nhanh",    description: "Pulse 5 khung (no AI, instant)" },
        { command: "nhanh5p",  description: "Quick scan 5 phút" },
        { command: "nhanh15p", description: "Quick scan 15 phút" },
        { command: "nhanh1h",  description: "Quick scan 1 giờ" },
        { command: "nhanh4h",  description: "Quick scan 4 giờ" },
        { command: "nhanh1d",  description: "Quick scan 1 ngày" },
        { command: "5p",       description: "SMC chi tiết 5 phút" },
        { command: "15p",      description: "SMC chi tiết 15 phút" },
        { command: "1h",       description: "SMC chi tiết 1 giờ" },
        { command: "4h",       description: "SMC chi tiết 4 giờ" },
        { command: "1d",       description: "SMC chi tiết 1 ngày" },
        // Combo phổ biến (top-down analysis)
        { command: "5p15p1h",       description: "SMC 3 khung intraday" },
        { command: "1h4h1d",        description: "SMC 3 khung HTF" },
        { command: "nhanh5p15p1h",  description: "Scan 3 khung intraday" },
        { command: "nhanh1h4h1d",   description: "Scan 3 khung HTF" },
        { command: "tin",      description: "Tin tức XAU 7 ngày + dự báo catalyst" },
        { command: "ai",       description: "Tư vấn risk + lot size + TP/SL" },
        { command: "tudien",   description: "Từ điển thuật ngữ Việt-Anh" },
        { command: "xoa",      description: "Cấu hình thời gian tự xoá tin (vd /xoa 30p, /xoa 1h, /xoa off)" },
        { command: "help",     description: "Hướng dẫn lệnh" },
      ];
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
      });
      const result = await r.json();
      return jsonResponse(200, { registered: commands.length, telegramResponse: result }, origin);
    }

    // Test Telegram setup: gửi message + return chi tiết error nếu fail
    if (url.pathname === "/test-telegram") {
      const configured = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
      if (!configured) {
        return jsonResponse(200, { ok: false, configured: false, error: "TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID chưa set" }, origin);
      }
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: "🔔 Test message từ /test-telegram",
          }),
        });
        const data = await r.json();
        return jsonResponse(200, {
          ok: r.ok && data.ok,
          status: r.status,
          telegramResponse: data,
          chatIdConfigured: env.TELEGRAM_CHAT_ID,
        }, origin);
      } catch (e) {
        return jsonResponse(200, { ok: false, error: e.message }, origin);
      }
    }

    // Trigger alert check thủ công (real data — bypass cron schedule + weekend gate)
    if (url.pathname === "/run-alert-check") {
      await runAlertCheck(env, { force: true });
      return jsonResponse(200, { ok: true, message: "Đã chạy kiểm tra cảnh báo giá, xem console log" }, origin);
    }

    // Trigger cleanup auto-delete thủ công + trả chi tiết errors
    if (url.pathname === "/cleanup-now") {
      const result = await cleanupExpiredMessages(env);
      return jsonResponse(200, {
        ok: true,
        ...result,
        message: `Xoá ${result.deleted} OK, ${result.failed} fail`,
      }, origin);
    }

    // Send + delete IMMEDIATELY (sanity check Telegram API works)
    if (url.pathname === "/test-instant-delete") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return jsonResponse(500, { error: "Token/ChatID chưa set" }, origin);
      }
      const sendR = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `🧪 Instant delete test ${new Date().toISOString().slice(11, 19)}`,
        }),
      });
      const sendData = await sendR.json();
      const messageId = sendData?.result?.message_id;

      // Delete ngay không đợi
      const delR = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: parseInt(env.TELEGRAM_CHAT_ID), // try as int
          message_id: messageId,
        }),
      });
      const delData = await delR.json();

      return jsonResponse(200, {
        sent: sendR.ok,
        messageId,
        chatIdFromSend: sendData?.result?.chat?.id,
        chatIdSentAs: parseInt(env.TELEGRAM_CHAT_ID),
        deleteOk: delR.ok,
        deleteResp: delData,
      }, origin);
    }

    // Test auto-delete end-to-end: gửi 1 test message + schedule xoá sau 60s + trả msg_id
    if (url.pathname === "/test-auto-delete") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return jsonResponse(500, { error: "Token/ChatID chưa set" }, origin);
      }
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text: `🧪 Test auto-delete ${new Date().toISOString().slice(11, 19)} — tự xoá sau 60s`,
        }),
      });
      const data = await r.json();
      const messageId = data?.result?.message_id;
      if (messageId) {
        // Schedule xoá sau 60s thay vì 1h
        await scheduleAutoDelete(env, env.TELEGRAM_CHAT_ID, messageId, 60_000);
      }
      return jsonResponse(200, {
        sent: r.ok,
        messageId,
        scheduledDelete: messageId ? "60 giây sau" : null,
        note: "Đợi 65s rồi gọi /cleanup-now để verify",
      }, origin);
    }

    // Check chat info (auto-delete timer, message_auto_delete_time, ...)
    if (url.pathname === "/chat-info") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return jsonResponse(500, { error: "Token/ChatID chưa set" }, origin);
      }
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${env.TELEGRAM_CHAT_ID}`
      );
      const data = await r.json();
      return jsonResponse(200, data, origin);
    }

    // Check bot permissions trong group (cần Delete messages cho auto-delete)
    if (url.pathname === "/bot-permissions") {
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return jsonResponse(500, { error: "Token/ChatID chưa set" }, origin);
      }
      try {
        const meR = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
        const me = (await meR.json()).result;
        const memR = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getChatMember?chat_id=${env.TELEGRAM_CHAT_ID}&user_id=${me.id}`
        );
        const mem = (await memR.json()).result;
        return jsonResponse(200, {
          botId: me.id,
          username: me.username,
          status: mem?.status,
          can_delete_messages: mem?.can_delete_messages,
          can_post_messages: mem?.can_post_messages,
          can_edit_messages: mem?.can_edit_messages,
          allMember: mem,
        }, origin);
      } catch (e) {
        return jsonResponse(500, { error: e.message }, origin);
      }
    }

    // List queue auto-delete (debug — xem có bao nhiêu message đang chờ xoá)
    if (url.pathname === "/cleanup-queue") {
      if (!env.CACHE) return jsonResponse(500, { error: "KV not configured" }, origin);
      const list = await env.CACHE.list({ prefix: "del:", limit: 100 });
      const now = Date.now();
      const items = list.keys.map(k => {
        const parts = k.name.split(":");
        const ts = parseInt(parts[1]);
        const remainingSec = Math.max(0, Math.floor((ts - now) / 1000));
        return {
          chatId: parts[2],
          messageId: parts[3],
          deleteAt: new Date(ts).toISOString(),
          remainingMin: Math.floor(remainingSec / 60),
        };
      });
      return jsonResponse(200, { count: items.length, items }, origin);
    }

    // Debug news fetching
    if (url.pathname === "/test-news") {
      try {
        const all = await fetchNewsFromRSS(env);
        const byFeed = {};
        for (const it of all) {
          byFeed[it.source] = (byFeed[it.source] || 0) + 1;
        }
        const recent = all.filter(n => n.ts >= Date.now() - 7 * 24 * 3600 * 1000);
        const goldRel = recent.filter(isGoldRelevant);
        const highImp = goldRel.filter(isHighImpact);
        return jsonResponse(200, {
          totalFetched: all.length,
          byFeed,
          last7Days: recent.length,
          goldRelevant: goldRel.length,
          highImpact: highImp.length,
          sampleTitles: goldRel.slice(0, 5).map(n => `[${n.source}] ${n.title}`),
        }, origin);
      } catch (e) {
        return jsonResponse(500, { error: e.message, stack: e.stack?.slice(0, 500) }, origin);
      }
    }

    // Test full alert pipeline với fake data — verify Telegram delivery + format
    if (url.pathname === "/test-cron-alert") {
      const dryRun = url.searchParams.get("dryRun") === "1"; // dryRun=1 → không gửi vào group, chỉ trả preview
      const fakeLatest = {
        close: 4520.50, rsi: 78.5, atr: 12.3,
        ema21: 4515.20, ema50: 4505.10, ema200: 4480.50,
        bbUpper: 4540, bbLower: 4500,
      };
      const fakePivots = { pp: 4510, r1: 4525, r2: 4540, s1: 4495, s2: 4480 };
      const fakeAlerts = [
        { icon: "🎣", text: `Quét thanh khoản DƯỚI (Liquidity Sweep Down) — râu nến $4515 phá đáy $4520 rồi đóng cửa lại trong`, suggestion: "Tín hiệu đảo chiều tăng. Theo dõi đóng cửa trên EMA21 + RSI xác nhận." },
        { icon: "🎯", text: `Phá điểm xoay R1 (Pivot) *$4525* lên`, suggestion: "Theo dõi retest R1 làm hỗ trợ. Mục tiêu R2 $4540." },
      ];
      // Fake multi-TF context — 5p tăng giá, 15p tăng giá, 1g tăng mạnh
      const fakeMtf = {
        "5p":  { close: 4521, rsi: 65, ema21: 4518, ema50: 4515, ema200: 4485 }, // bullish
        "15p": fakeLatest,                                                       // primary
        "1g":  { close: 4520, rsi: 72, ema21: 4510, ema50: 4495, ema200: 4470 }, // strong bullish
      };
      const msg = formatAlertMessage(fakeLatest, fakeAlerts, fakePivots, fakeMtf);
      let ok = false;
      if (!dryRun) ok = await sendTelegram(env, msg);
      return jsonResponse(200, {
        ok,
        dryRun,
        message: dryRun ? "Preview only (dryRun=1)" : (ok ? "✅ Cảnh báo giá test đã gửi vào group" : "❌ Gửi thất bại"),
        previewMessage: msg,
      }, origin);
    }

    // Clear alert cooldowns (KV) — để re-test cùng alert ngay không phải đợi 1h
    if (url.pathname === "/clear-alert-cooldowns") {
      if (!env.CACHE) return jsonResponse(500, { error: "KV not configured" }, origin);
      // Note: KV không list keys dễ dàng từ Worker. Manual delete known alert keys.
      const knownKeys = [
        "alert:rsi_overbought", "alert:rsi_oversold",
        "alert:bb_up", "alert:bb_dn",
        "alert:golden", "alert:death",
        "alert:ema_up", "alert:ema_dn",
        "alert:piv_up_r1", "alert:piv_up_r2", "alert:piv_dn_s1", "alert:piv_dn_s2",
        "alert:big_move_up", "alert:big_move_dn",
        "alert:multi_move_up", "alert:multi_move_dn",
        "alert:vol_spike", "alert:bb_expand",
        "alert:wick_top", "alert:wick_bottom",
        "alert:gap_up", "alert:gap_dn",
        "alert:liq_sweep_up", "alert:liq_sweep_dn",
      ];
      let cleared = 0;
      for (const k of knownKeys) {
        try { await env.CACHE.delete(k); cleared++; } catch {}
      }
      return jsonResponse(200, { cleared, message: `Đã xóa ${cleared} khóa cooldown cảnh báo giá` }, origin);
    }

    // Block non-allowed origins for actual API calls
    // (preflight already handled; this catches direct curl-like calls without origin too)
    if (!isAllowedOrigin(origin)) {
      return jsonResponse(403, { error: "Origin không được phép" }, origin);
    }

    // Diagnostic endpoint: probe từng Gemini key, trả status + error message ngắn
    // (Allow cả khi không có Origin để dễ curl debug — nhưng không leak key)
    if (url.pathname === "/probe" || (url.pathname === "/probe-public" && true)) {
      const keys = collectGeminiKeys(env);
      const results = [];
      for (const { key, label } of keys) {
        try {
          const r = await fetch(`${GOOGLE_BASE}/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: "hi" }] }],
              generationConfig: { maxOutputTokens: 1 },
            }),
          });
          const text = await r.text();
          let errMsg = "";
          try { errMsg = JSON.parse(text).error?.message || ""; } catch {}
          results.push({
            label,
            status: r.status,
            ok: r.ok,
            // Mask key, chỉ giữ 4 ký tự cuối
            key_suffix: "..." + key.slice(-6),
            error: errMsg.slice(0, 180),
          });
        } catch (e) {
          results.push({ label, status: 0, error: e.message });
        }
      }
      return jsonResponse(200, { worker_dc: request.cf?.colo, results }, origin);
    }

    // ──────────────────────────────────────────────────────────
    // TwelveData proxy: GET /twelvedata/{time_series|price}?symbol=...&interval=...
    // ──────────────────────────────────────────────────────────
    // Free 800 req/ngày/key, real-time XAU/USD. Worker xoay nhiều keys
    // (TWELVEDATA_API_KEY_1..3) khi key trước hết quota daily / per-minute.
    if (url.pathname.startsWith("/twelvedata/")) {
      if (request.method !== "GET") {
        return jsonResponse(405, { error: "TwelveData chỉ accept GET" }, origin);
      }
      if (!hasAnyTdKey(env)) {
        return jsonResponse(500, {
          error: "Worker chưa cấu hình TWELVEDATA_API_KEY_*. Chạy: wrangler secret put TWELVEDATA_API_KEY_1",
        }, origin);
      }

      // Whitelist endpoint TD để tránh dùng Worker gọi endpoint paid
      const tdPath = url.pathname.slice("/twelvedata".length); // "/time_series" hoặc "/price"
      const ALLOWED_PATHS = ["/time_series", "/price"];
      if (!ALLOWED_PATHS.includes(tdPath)) {
        return jsonResponse(404, { error: `Endpoint TD "${tdPath}" không được phép` }, origin);
      }

      // Whitelist params
      const ALLOWED_PARAMS = ["symbol", "interval", "outputsize", "format", "timezone", "start_date", "end_date"];
      const params = {};
      for (const k of ALLOWED_PARAMS) {
        const v = url.searchParams.get(k);
        if (v) params[k] = v;
      }
      // Validate symbol (chữ + số + slash, vd "XAU/USD")
      const symbol = params.symbol || "";
      if (!/^[A-Za-z0-9/]+$/.test(symbol)) {
        return jsonResponse(400, { error: "symbol không hợp lệ" }, origin);
      }

      const result = await tdFetch(env, tdPath, params);
      if (!result.ok) {
        // Tất cả keys fail — trả lỗi giữ format giống TD để frontend xử lý quen
        return jsonResponse(429, {
          status: "error",
          message: result.lastError || "Tất cả TD keys đều cooldown",
          attempts: result.attempts,
        }, origin);
      }
      const respHeaders = new Headers(corsHeaders(origin));
      respHeaders.set("Content-Type", result.headers.get("Content-Type") || "application/json");
      respHeaders.set("Cache-Control", "public, max-age=30");
      respHeaders.set("X-TD-Key", result.label);
      return new Response(result.text, { status: result.status, headers: respHeaders });
    }

    // ──────────────────────────────────────────────────────────
    // Gemini proxy: POST /v1beta/models/{model}:generateContent
    // ──────────────────────────────────────────────────────────
    const match = url.pathname.match(/^\/v1beta\/models\/([^:/]+):generateContent$/);
    if (!match || request.method !== "POST") {
      return jsonResponse(404, { error: "Endpoint không tồn tại" }, origin);
    }
    const model = match[1];

    // Multi-key rotation: smart skip keys đang cooldown.
    const allKeys = collectGeminiKeys(env);
    if (allKeys.length === 0) {
      return jsonResponse(500, {
        error: "Worker chưa cấu hình Gemini API key. Chạy: wrangler secret put GEMINI_API_KEY_1 (rồi _2, _3, _4, _5).",
      }, origin);
    }

    const body = await request.text();

    // ── Step 0: KV cache lookup ──
    // Hash body → cache key. Nếu hit → trả ngay, không tốn Gemini quota.
    const bodyHash = await hashBody(body);
    const cacheKey = `gemini:${model}:${bodyHash}`;
    const cached = await cacheGet(env, cacheKey);
    if (cached) {
      console.log(`[cache] HIT ${cacheKey}`);
      const respHeaders = new Headers(corsHeaders(origin));
      respHeaders.set("Content-Type", "application/json");
      respHeaders.set("X-Cache", "HIT");
      return new Response(cached, { status: 200, headers: respHeaders });
    }

    // ── Step 1: thử Gemini keys (smart rotation, skip cooldown) ──
    const activeKeys = allKeys.filter(k => !isKeyOnCooldown(k.label));
    const tryKeys = activeKeys.length > 0 ? activeKeys : allKeys;
    if (activeKeys.length === 0) {
      console.log("[gemini] all keys on cooldown, trying all anyway");
      keyState.clear();
    }

    let upstream = null;
    let lastError = null;
    let success = false;

    for (const { key, label } of tryKeys) {
      const targetUrl = `${GOOGLE_BASE}/v1beta/models/${model}:generateContent?key=${key}`;
      try {
        upstream = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch (e) {
        lastError = e;
        upstream = null;
        console.log(`[gemini] ${label} fetch error: ${e.message}`);
        continue;
      }
      console.log(`[gemini] ${label} status=${upstream.status}`);
      if (upstream.status === 200) {
        clearKeyCooldown(label);
        success = true;
        break;
      }
      markKeyCooldown(label, upstream.status);
    }

    // ── Step 2: nếu Gemini success → cache response và trả ──
    if (success && upstream) {
      const respText = await upstream.text();
      await cachePut(env, cacheKey, respText);
      const respHeaders = new Headers(corsHeaders(origin));
      respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      respHeaders.set("X-Cache", "MISS");
      return new Response(respText, { status: 200, headers: respHeaders });
    }

    // ── Step 3: tất cả Gemini fail → fallback Workers AI (Llama 3.3 70B) ──
    console.log("[gemini] all keys failed, fallback to Workers AI");
    const aiResult = await tryWorkersAI(env, body);
    if (aiResult) {
      console.log("[ai-fallback] success");
      const aiBody = JSON.stringify(aiResult);
      await cachePut(env, cacheKey, aiBody);
      const respHeaders = new Headers(corsHeaders(origin));
      respHeaders.set("Content-Type", "application/json");
      respHeaders.set("X-Cache", "MISS");
      respHeaders.set("X-Source", "workers-ai");
      return new Response(aiBody, { status: 200, headers: respHeaders });
    }

    // ── Step 4: tất cả đều fail → trả response cuối từ Gemini cho client ──
    if (!upstream) {
      return jsonResponse(502, { error: `Không gọi được Google API: ${lastError?.message || "unknown"}` }, origin);
    }
    const respHeaders = new Headers(corsHeaders(origin));
    respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  },
};
