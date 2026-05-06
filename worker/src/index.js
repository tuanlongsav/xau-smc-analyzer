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
 * Phiên giao dịch hiện tại theo UTC (XAU: Á thấp, Âu/Mỹ cao).
 */
function getTradingSession() {
  const h = new Date().getUTCHours();
  if (h >= 0 && h < 7) return "Á (volatility thấp, thường đi ngang)";
  if (h >= 7 && h < 8) return "giao thoa Á-Âu (bắt đầu volatile)";
  if (h >= 8 && h < 13) return "Âu (volatility tăng, có xu hướng)";
  if (h >= 13 && h < 16) return "giao thoa Âu-Mỹ (volatility cao nhất)";
  if (h >= 16 && h < 21) return "Mỹ (volatility cao, có thể reversal)";
  return "ngoài giờ chính (thanh khoản thấp)";
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
      if (last.close > last.ema200 && last.ema21 > last.ema50 && last.ema50 > last.ema200) return "Tăng mạnh";
      if (last.close > last.ema50 && last.close > last.ema200) return "Tăng";
      if (last.close < last.ema200 && last.ema21 < last.ema50 && last.ema50 < last.ema200) return "Giảm mạnh";
      if (last.close < last.ema50 && last.close < last.ema200) return "Giảm";
      return "Sideways";
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
// TwelveData fetch (cron context — direct call, không qua /twelvedata route)
// ──────────────────────────────────────────────────────────
async function fetchTdCandles(env, interval, outputsize, symbol = "XAU/USD") {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${env.TWELVEDATA_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TD ${r.status}`);
  const d = await r.json();
  if (d.status === "error") throw new Error(`TD ${symbol}: ${d.message}`);
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
          trendLabel: { "Tăng mạnh": "Giảm mạnh", "Tăng": "Giảm", "Sideways": "Sideways", "Giảm": "Tăng", "Giảm mạnh": "Tăng mạnh" }[d.trendLabel] || "?",
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
    if (p > 0.3) lines.push("USD mạnh lên → áp lực GIẢM giá (bearish) cho XAU (correlation nghịch ~-0.7)");
    else if (p < -0.3) lines.push("USD yếu đi → ủng hộ TĂNG giá (bullish) cho XAU");
    else lines.push("USD đi ngang (sideways) → ít tác động lên XAU");
  }
  if (auxCtx.oil) {
    const p = auxCtx.oil.pct24h;
    if (p > 0.5) lines.push("Dầu tăng → đồng pha TĂNG giá (bullish) với XAU (cùng hedge lạm phát)");
    else if (p < -0.5) lines.push("Dầu giảm → áp lực GIẢM giá (bearish) cho XAU");
    else lines.push("Dầu đi ngang (sideways) → trung tính với XAU");
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
  const push = async (key, icon, text, suggestion = null) => {
    if (await alertCooldownOk(env, key)) {
      out.push({ icon, text, suggestion });
      await markAlerted(env, key);
    }
  };

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

  // ── 6. Biến động giá mạnh (Strong move) ──
  if (latest.open && latest.close) {
    const change = latest.close - latest.open;
    const changePct = Math.abs(change / latest.open) * 100;
    if (changePct > 0.4) {
      const direction = change > 0 ? "TĂNG" : "GIẢM";
      const icon = change > 0 ? "🚀" : "💥";
      await push(`big_move_${change > 0 ? "up" : "dn"}`, icon,
        `Biến động mạnh: ${direction} *${changePct.toFixed(2)}%* nến gần nhất ($${prev.close.toFixed(2)} → $${latest.close.toFixed(2)})`,
        change > 0
          ? "Theo dõi 1-2 nến kế tiếp xem có tiếp diễn không. Có thể continue hoặc thoái lui (retrace) 50%."
          : "Theo dõi vùng hỗ trợ gần nhất. Có thể nảy ngược (oversold bounce) hoặc tiếp tục giảm.");
    }
  }

  // ── 7. ATR tăng vọt (Volatility spike — biên độ thực trung bình) ──
  if (latest.atr != null && Array.isArray(candlesEnriched) && candlesEnriched.length >= 30) {
    const recentAtrs = candlesEnriched.slice(-30, -1).map(c => c.atr).filter(a => a != null);
    if (recentAtrs.length > 10) {
      const avgAtr = recentAtrs.reduce((s, a) => s + a, 0) / recentAtrs.length;
      if (latest.atr > avgAtr * 1.5) {
        await push("vol_spike", "⚡",
          `ATR tăng vọt (Volatility Spike): *${latest.atr.toFixed(2)}* (${(latest.atr / avgAtr).toFixed(1)}x trung bình)`,
          "Biến động cao bất thường — đợi nến đóng cửa trước khi vào lệnh, mở rộng dừng lỗ (SL).");
      }
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

  return out;
}

// ──────────────────────────────────────────────────────────
// Telegram send
// ──────────────────────────────────────────────────────────
async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) {
      console.log(`[telegram] send failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return false;
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

  // 1. Tiếp diễn theo trend
  if (isUptrend && lv.above[0]) {
    scenarios.push(`Tiếp diễn *TĂNG*: phá ${lv.above[0].label} *$${lv.above[0].price.toFixed(2)}* → target ${lv.above[1] ? `*$${lv.above[1].price.toFixed(2)}*` : "mức cao kế tiếp"}`);
  }
  if (isDowntrend && lv.below[0]) {
    scenarios.push(`Tiếp diễn *GIẢM*: phá ${lv.below[0].label} *$${lv.below[0].price.toFixed(2)}* → target ${lv.below[1] ? `*$${lv.below[1].price.toFixed(2)}*` : "mức thấp kế tiếp"}`);
  }

  // 2. Pullback (RSI extreme hoặc BB break trong trend)
  if (hasRsiExt || hasBbBreak) {
    if (isUptrend && lv.below[0]) {
      scenarios.push(`Pullback nhẹ về ${lv.below[0].label} *$${lv.below[0].price.toFixed(2)}* → bounce continue trend`);
    } else if (isDowntrend && lv.above[0]) {
      scenarios.push(`Bounce nhẹ về ${lv.above[0].label} *$${lv.above[0].price.toFixed(2)}* → reject continue down`);
    }
  }

  // 3. Reversal (liquidity sweep)
  if (hasLiqSweep) {
    const isUpSweep = alerts.some(a => /sweep TRÊN/.test(a.text));
    if (isUpSweep && lv.below[1]) {
      scenarios.push(`Đảo chiều *BEARISH* (smart money quét stop trên) → đẩy xuống *$${lv.below[1].price.toFixed(2)}*`);
    } else if (!isUpSweep && lv.above[1]) {
      scenarios.push(`Đảo chiều *BULLISH* (smart money quét stop dưới) → đẩy lên *$${lv.above[1].price.toFixed(2)}*`);
    }
  }

  // 4. Cross signal — trend change scenarios
  if (hasCross && scenarios.length < 3) {
    if (lv.above[0] && lv.below[0]) {
      scenarios.push(`Cross báo trend đổi → watch close ${isUptrend ? "trên" : "dưới"} *$${(isUptrend ? lv.above[0] : lv.below[0]).price.toFixed(2)}* để confirm`);
    }
  }

  // Default fallback
  if (scenarios.length === 0 && lv.above[0] && lv.below[0]) {
    scenarios.push(`Sideways trong vùng *$${lv.below[0].price.toFixed(2)}* – *$${lv.above[0].price.toFixed(2)}*`);
    scenarios.push(`Break ra ngoài vùng → đi theo hướng break (>1×ATR ${latest.atr?.toFixed(1)})`);
  }

  return scenarios.slice(0, 3);
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

function formatAlertMessage(latest, alerts, pivots) {
  const t = new Date().toISOString().slice(0, 16).replace("T", " ");
  let m = `🥇 *Cảnh báo giá XAU/USD* (khung 15p)\n`;
  m += `Giá hiện tại: *$${latest.close.toFixed(2)}* — ${t} UTC\n\n`;

  m += `*🔔 Sự kiện vừa kích hoạt:*\n`;
  for (const a of alerts) {
    m += `${a.icon} ${a.text}\n`;
    if (a.suggestion) m += `   💡 _${a.suggestion}_\n`;
  }

  // Xu hướng tổng
  const trend = getTrendAssessment(latest);
  if (trend) {
    m += `\n📈 *Xu hướng tổng:* ${trend.emoji} ${trend.label}\n`;
    m += `   _${trend.note}_\n`;
  }

  // Mức giá quan sát (Việt-Anh)
  const lv = getKeyLevelsAround(latest, pivots, latest.close);
  if (lv.above.length || lv.below.length) {
    m += `\n📍 *Mức giá cần quan sát:*\n`;
    for (const l of lv.above) m += `▲ *$${l.price.toFixed(2)}* ${l.label} _(+${(l.price - latest.close).toFixed(2)})_\n`;
    for (const l of lv.below) m += `▼ *$${l.price.toFixed(2)}* ${l.label} _(-${(latest.close - l.price).toFixed(2)})_\n`;
  }

  // 🎯 Gợi ý vào lệnh — Entry / SL / TP1-2-3 (rule-based)
  const sg = generateTradeSuggestion(latest, alerts, trend, lv);
  if (sg) {
    const dirLabel = sg.dir === "BUY" ? "MUA (LONG)" : "BÁN (SHORT)";
    const dirIcon = sg.dir === "BUY" ? "🟢" : "🔴";
    m += `\n*🎯 Gợi ý vào lệnh:* ${dirIcon} *${dirLabel}*\n`;
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

  // Chỉ báo tóm tắt
  m += `\n_Chỉ báo: RSI ${latest.rsi?.toFixed(1)} | ATR ${latest.atr?.toFixed(2)} | EMA 21/50/200: ${latest.ema21?.toFixed(0)}/${latest.ema50?.toFixed(0)}/${latest.ema200?.toFixed(0)}_\n`;
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

  for (const { key, label } of tryKeys) {
    try {
      const r = await fetch(`${GOOGLE_BASE}/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });
      if (r.status === 200) {
        clearKeyCooldown(label);
        const json = await r.json();
        if (isValidResponse(json)) {
          await cachePut(env, cacheKey, JSON.stringify(json));
          return json;
        }
        // Response 200 nhưng JSON invalid (content empty/safety filter/...) → log + thử key khác
        const t = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const finish = json?.candidates?.[0]?.finishReason || "?";
        console.log(`[gemini-smart] ${label} invalid response (finish=${finish}, text len=${t.length}, tail=${t.slice(-100)})`);
        continue;
      }
      markKeyCooldown(label, r.status);
    } catch (e) {
      console.log(`[gemini-smart] ${label} error: ${e.message}`);
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

async function sendTelegramTo(env, chatId, text, replyToMessageId = null, parseMode = "Markdown") {
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
    // Nếu parse mode fail (Markdown/HTML) → retry plain text
    if (!r.ok && (parseMode === "Markdown" || parseMode === "HTML")) {
      const errText = await r.text();
      if (errText.includes("can't parse entities") || errText.includes("parse_mode")) {
        console.log(`[tg-reply] ${parseMode} fail, retry plain. Err: ${errText.slice(0, 150)}`);
        r = await post(null);
      } else {
        console.log(`[tg-reply] ${r.status}: ${errText.slice(0, 200)}`);
      }
    } else if (!r.ok) {
      console.log(`[tg-reply] ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
    const all = await getCachedNews(env);
    if (all.length === 0) {
      await sendTelegramTo(env, chatId, "❌ Không lấy được tin tức (RSS feed lỗi).", replyTo);
      return;
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

FORMAT OUTPUT (Markdown):
**📌 Bối cảnh**
- ${topicLabel} là gì + ý nghĩa với XAU
- Lần công bố trước (nếu suy được từ tin)

**📅 Lịch trình sắp tới**
- Ngày + giờ (GMT+7) ước tính
- Forecast (dự báo) vs Prior (lần trước) nếu biết

**🎯 3 KỊCH BẢN PHẢN ỨNG XAU**
1. Kịch bản BULLISH (số liệu USD yếu hơn dự báo): xác suất X%, biên độ +$Y → +$Z
   - Action: ưu tiên LONG khi giá phá vùng A, SL B, TP C
2. Kịch bản TRUNG TÍNH (số liệu sát forecast): xác suất X%, sideways trong vùng D-E
   - Action: đứng ngoài hoặc scalp 2 chiều
3. Kịch bản BEARISH (số liệu USD mạnh hơn dự báo): xác suất X%, biên độ -$Y → -$Z
   - Action: SHORT khi giá break dưới F, SL G, TP H

**📋 QUẢN LÝ LỆNH**
- Trước event 30-60p: đóng partial / dời SL về break-even / đứng ngoài hoàn toàn
- Trong event: KHÔNG vào lệnh (spread giãn 5-10x), KHÔNG sửa SL/TP
- Sau event 5-15p: đợi candle 1-5p đóng + retest, vào theo hướng break

**⚠️ Rủi ro specific cho ${topicLabel}**
- Stop hunt cả 2 chiều (whipsaw 5-10p đầu)
- Spread giãn → SL bị quét sớm
- Slippage có thể $5-20

KHÔNG khuyến nghị mua/bán cụ thể, chỉ phân tích kịch bản + chiến lược.`;

      userText = `Hôm nay: ${today}

🎯 PHÂN TÍCH CHUYÊN SÂU: ${topicLabel}

Tin liên quan đến "${topicLabel}" trong 7 ngày (${filtered.length} tin):

${newsList}

Phân tích theo format đã quy định.`;
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
      m = `📰 *Phân tích chuyên sâu: ${topicLabel}*\n`;
      m += `_${filtered.length} tin liên quan đến "${topicLabel}" trong 7 ngày_\n\n`;
    } else {
      const highImp = filtered.filter(isHighImpact).length;
      m = `📰 *Tổng hợp tin XAU 7 ngày*\n`;
      m += `_${filtered.length} tin liên quan, ${highImp} tin high-impact 🚨_\n\n`;
    }
    m += aiText;
    m += `\n\n_Source: FXStreet, Investing.com, MarketWatch_`;

    const parts = splitForTelegram(m, 3900);
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `\n\n_[${i + 1}/${parts.length}]_` : "";
      await sendTelegramTo(env, chatId, parts[i] + suffix, i === 0 ? replyTo : null, "Markdown");
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
      if (l.close > l.ema200 && l.ema21 > l.ema50 && l.ema50 > l.ema200) return { icon: "🚀", label: "Tăng mạnh" };
      if (l.close > l.ema50 && l.close > l.ema200) return { icon: "🟢", label: "Tăng" };
      if (l.close < l.ema200 && l.ema21 < l.ema50 && l.ema50 < l.ema200) return { icon: "🔻", label: "Giảm mạnh" };
      if (l.close < l.ema50 && l.close < l.ema200) return { icon: "🔴", label: "Giảm" };
      return { icon: "↔️", label: "Sideways" };
    };
    const rsiTag = (r) => {
      if (r == null) return "?";
      if (r > 70) return "QM";   // quá mua
      if (r < 30) return "QB";   // quá bán
      return "TT";               // trung tính
    };

    let m = `<b>🥇 XAU Pulse</b> — Giá: <b>$${c.toFixed(2)}</b>\n`;
    m += `<i>Phiên ${getTradingSession()}</i>\n`;
    if (auxCtx) {
      const auxLines = formatAuxBlock(auxCtx).split("\n").map(l => htmlEsc(l)).join("\n");
      m += `\n${auxLines}\n`;
      const impact = interpretAuxImpact(auxCtx);
      if (impact) m += `<i>↳ Tác động lên XAU: ${htmlEsc(impact)}</i>\n`;
    }
    m += `\n<b>📊 Bias các khung:</b>\n`;

    const biasLabels = [];
    for (const d of valid) {
      const b = determineBias(d.latest);
      biasLabels.push(b.label);
      const rsiVal = d.latest.rsi?.toFixed(0) || "?";
      m += `${b.icon} <b>${d.tf}</b>: ${b.label} | RSI <b>${rsiVal}</b> ${rsiTag(d.latest.rsi)}\n`;
    }

    // Mức cần watch — top 2 above + below
    const latest15m = valid.find(d => d.tf === "15m")?.latest;
    if (latest15m) {
      const levels = [];
      if (latest15m.bbUpper) levels.push({ price: latest15m.bbUpper, label: "BB upper 15m" });
      if (latest15m.bbLower) levels.push({ price: latest15m.bbLower, label: "BB lower 15m" });
      if (latest15m.recentHigh) levels.push({ price: latest15m.recentHigh, label: "High 50 nến 15m" });
      if (latest15m.recentLow) levels.push({ price: latest15m.recentLow, label: "Low 50 nến 15m" });
      if (pivots) {
        levels.push({ price: pivots.r1, label: "Pivot R1" });
        levels.push({ price: pivots.r2, label: "Pivot R2" });
        levels.push({ price: pivots.s1, label: "Pivot S1" });
        levels.push({ price: pivots.s2, label: "Pivot S2" });
      }
      const above = levels.filter(lv => lv.price > c).sort((a, b) => a.price - b.price).slice(0, 3);
      const below = levels.filter(lv => lv.price < c).sort((a, b) => b.price - a.price).slice(0, 3);
      if (above.length || below.length) {
        m += `\n<b>📍 Mức cần watch:</b>\n`;
        for (const lv of above) m += `▲ <b>$${lv.price.toFixed(2)}</b> ${htmlEsc(lv.label)} <i>(+${(lv.price - c).toFixed(2)})</i>\n`;
        for (const lv of below) m += `▼ <b>$${lv.price.toFixed(2)}</b> ${htmlEsc(lv.label)} <i>(-${(c - lv.price).toFixed(2)})</i>\n`;
      }
    }

    // Consensus
    const upCount = biasLabels.filter(b => b.includes("Tăng")).length;
    const downCount = biasLabels.filter(b => b.includes("Giảm")).length;
    const sideCount = biasLabels.filter(b => b === "Sideways").length;
    let conclusion;
    if (upCount >= valid.length - 1) conclusion = `Đa số khung BULLISH (${upCount}/${valid.length}) — ưu tiên long, watch breakout lên`;
    else if (downCount >= valid.length - 1) conclusion = `Đa số khung BEARISH (${downCount}/${valid.length}) — ưu tiên short, watch breakdown xuống`;
    else if (sideCount >= 2) conclusion = `Nhiều khung sideways — đợi rõ hướng, không vội vào lệnh`;
    else conclusion = `Phân vân giữa các khung (${upCount}↑/${downCount}↓/${sideCount}↔️) — top-down trước khi vào`;
    m += `\n💡 <b>${conclusion}</b>`;
    m += `\n\n<i>Để chi tiết: /15p /1h /1h4h1d /nhanh15p ...</i>`;

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

    const systemText = `Bạn là chuyên gia TA XAU/USD. Đây là phân tích kỹ thuật giáo dục, KHÔNG phải khuyến nghị đầu tư.

NGÔN NGỮ — bilingual cho thuật ngữ:
- Tiếng Việt trước, tiếng Anh trong ngoặc. VD:
  • "tăng giá (bullish)" / "giảm giá (bearish)" / "đi ngang (sideways)"
  • "phá vỡ (breakout)" / "đảo chiều (reversal)" / "hồi giá (pullback)"
  • "phân kỳ (divergence)" / "kiệt sức (exhaustion)"
  • "Quá mua (Overbought)" / "Quá bán (Oversold)"
  • "Đường EMA" / "Dải Bollinger (BB)"

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble.
- BẮT BUỘC điền tất cả field, không bỏ trống.
- Mọi mức giá là số cụ thể (float).
- Mọi khung từ 5m → 1d đều có thể phân tích được, không từ chối.`;
    const auxText = auxCtx ? `\n\n💱 INTER-MARKET CONTEXT (cùng khung ${tf}):
${formatAuxBlock(auxCtx)}

YÊU CẦU BẮT BUỘC: Trong câu trả lời (tom_tat hoặc canh_bao), PHẢI giải thích cụ thể tác động của DXY/OIL lên XAU:
- Nếu DXY tăng → áp lực giảm XAU (correlation nghịch ~-0.7).
- Nếu DXY giảm → hỗ trợ XAU.
- Nếu OIL tăng → đồng pha bullish XAU (cùng inflation hedge).
- Nếu OIL giảm → áp lực giảm XAU.
Đối chiếu với setup XAU: nếu inter-market đồng thuận → tăng độ tin cậy. Nếu mâu thuẫn → giảm độ tin cậy + thêm vào canh_bao.` : "";
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
        maxOutputTokens: 3500,
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

    const systemText = `Bạn là chuyên gia phân tích kỹ thuật (Trader) XAU/USD nhiều năm kinh nghiệm + sư phạm.

NHIỆM VỤ:
- Phân tích dữ liệu thị trường, đưa ra QUYẾT ĐỊNH GIAO DỊCH cụ thể (BUY/SELL/WAIT) ở phần đầu.
- Sau đó GIẢI THÍCH bằng tiếng Việt đời thường, dễ hiểu cho người mới.

NGÔN NGỮ — BẮT BUỘC bilingual cho thuật ngữ kỹ thuật:
- Viết tiếng Việt TRƯỚC, tiếng Anh trong NGOẶC sau.

Từ vựng common:
  • bullish → "tăng giá (bullish)"
  • bearish → "giảm giá (bearish)"
  • sideways → "đi ngang (sideways)"
  • consolidation → "tích lũy (consolidation)"
  • breakout → "phá vỡ (breakout)"
  • breakdown → "vỡ đáy (breakdown)"
  • pullback → "hồi giá (pullback)"
  • retest → "kiểm tra lại (retest)"
  • rejection → "phản ứng từ chối (rejection)"
  • reversal → "đảo chiều (reversal)"
  • continuation → "tiếp diễn (continuation)"
  • divergence → "phân kỳ (divergence)"
  • exhaustion → "kiệt sức (exhaustion)"
  • momentum → "động lượng (momentum)"
  • volatility → "biến động (volatility)"
  • impulse → "sóng đẩy (impulse)"
  • correction → "sóng điều chỉnh (correction)"
  • swing high/low → "đỉnh/đáy swing"

Từ SMC + indicators:
  • "Phá vỡ cấu trúc (BOS — Break of Structure)"
  • "Đổi tính chất (CHOCH — Change of Character)"
  • "Khối lệnh (OB — Order Block)"
  • "Khoảng trống công bằng (FVG — Fair Value Gap)"
  • "Quét thanh khoản (Liquidity Sweep)"
  • "Giao cắt vàng/tử thần (Golden/Death Cross)"
  • "Nến rút râu đáy (Hammer)" / "Nến nhấn chìm (Engulfing)"
  • "Đường trung bình động hàm mũ (EMA)"
  • "Dải Bollinger (BB)"
  • "Biên độ thực trung bình (ATR)"
  • "Điểm xoay (Pivot Point)"
  • "Khung lớn/trung/nhỏ (HTF/MTF/LTF)"
  • "Mua / Bán / Đứng ngoài (Long / Short / Wait)"
  • "Điểm vào / Cắt lỗ / Chốt lời (Entry / SL / TP)"

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble, KHÔNG markdown wrap.
- Đây là phân tích kỹ thuật giáo dục, KHÔNG phải khuyến nghị đầu tư.
- Tất cả mức giá phải là số cụ thể (float).
- 3 mức TP: TP1 an toàn (R:R ~1:1), TP2 kỳ vọng (R:R ~1:2), TP3 tối đa theo trend (R:R ~1:3+).
- SL đặt NGOÀI vùng nhiễu (>1×ATR cách swing) để tránh quét thanh khoản.
- Nếu setup chưa rõ → chọn WAIT (Đứng ngoài), KHÔNG bịa entry.`;

    const auxBlock = auxCtx ? `\n\n💱 INTER-MARKET CONTEXT (cùng khung ${tf}):
${formatAuxBlock(auxCtx)}

YÊU CẦU BẮT BUỘC trong giai_thich:
- buc_tranh_toan_canh PHẢI nhắc đến DXY/OIL: vd "DXY giảm 0.4% trong 24h → hỗ trợ XAU"
- ly_do_entry_sl PHẢI nói có inter-market confirm setup không
- rui_ro_can_luu_y PHẢI thêm rủi ro mâu thuẫn nếu inter-market đi ngược setup
Quy tắc correlation:
- DXY ↑ → XAU ↓ (nghịch ~-0.7)
- OIL ↑ → XAU ↑ (đồng pha inflation hedge)` : "";

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
        maxOutputTokens: 4096,
        temperature: 0.5,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    };
    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    const d = extractJSON(text);
    if (!d) {
      const finish = resp?.candidates?.[0]?.finishReason || "?";
      const blocked = resp?.promptFeedback?.blockReason;
      console.log(`[bot] /analyze ${tf} JSON parse fail (len=${(text||"").length}, finish=${finish}, blocked=${blocked||"no"}), text: ${text||""}`);
      let errMsg = `❌ AI response không hợp lệ (len=${(text||"").length}, finish=${finish})`;
      if (blocked) errMsg += `\nBlocked: <code>${htmlEsc(blocked)}</code>`;
      if (text && text.length < 500) errMsg += `\n<i>${htmlEsc(text.slice(0, 300))}</i>`;
      errMsg += `\nThử <code>/${tf.replace("m", "p")}</code> lại.`;
      await sendTelegramTo(env, chatId, errMsg, replyTo, "HTML");
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
    if (qd.tp3 != null) m += `🎯 TP3 tối đa (theo trend): <b>$${fmt2(qd.tp3)}</b>\n`;
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

    const systemText = `Bạn là chuyên gia TA XAU/USD chuyên top-down nhiều khung (multi-timeframe).

NGUYÊN TẮC TOP-DOWN:
- Khung lớn (HTF — Higher Timeframe = ${htf}) → định BIAS chính (xu hướng tổng).
- Khung trung (MTF) → định SETUP (vùng entry/cản).
- Khung nhỏ (LTF — Lower Timeframe = ${ltf}) → định timing vào lệnh + xác nhận.
- Khuyến nghị PHẢI dựa trên hợp lực 3 khung. Nếu các khung mâu thuẫn → ghi rõ ở 'alignment' và giảm độ tin cậy.

NGÔN NGỮ — bilingual cho thuật ngữ:
- Tiếng Việt trước, tiếng Anh trong ngoặc. VD:
  • "tăng giá (bullish)" / "giảm giá (bearish)" / "đi ngang (sideways)"
  • "Phá vỡ cấu trúc (BOS)" / "Đổi tính chất (CHOCH)"
  • "Khối lệnh (OB)" / "Khoảng trống công bằng (FVG)"
  • "Quét thanh khoản (Liquidity Sweep)" / "Phân kỳ (Divergence)"
  • "Đường trung bình EMA" / "Dải Bollinger (BB)" / "Biên độ ATR"
  • "Khung lớn/trung/nhỏ (HTF/MTF/LTF)"

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble.
- BẮT BUỘC điền field 'by_tf' cho TẤT CẢ ${valid.length} khung — không bỏ sót.
- Mọi mức giá là số cụ thể (float).
- SL đặt NGOÀI vùng nhiễu (>1×ATR cách swing) để tránh quét thanh khoản.
- Nếu kha_thi=true: BẮT BUỘC điền entry + sl + tp1 + tp2 + tp3 (TP1 R:R ~1:1, TP2 ~1:2, TP3 mở rộng tới mức kháng/hỗ trợ kế tiếp hoặc R:R 1:3+).
- Field "tp" giữ nguyên = tp2 (kỳ vọng) cho backward compat.
- R:R (rr) lấy theo TP2.`;

    const auxBlock = auxCtx ? `\n\n💱 INTER-MARKET CONTEXT (khung ${htfForAux}):
${formatAuxBlock(auxCtx)}

LƯU Ý: Trong tom_tat / phan_tich_top_down PHẢI nhắc đến tác động DXY/OIL:
- DXY ↑ → áp lực giảm XAU (correlation nghịch ~-0.7)
- OIL ↑ → đồng pha tăng XAU (cùng inflation hedge)
Mâu thuẫn inter-market với consensus → giảm độ tin cậy + thêm vào rui_ro_chinh.` : "";

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
        maxOutputTokens: isNhanh ? 3000 : 4500,
        temperature: 0.4,
        thinkingConfig: { thinkingBudget: isNhanh ? 0 : 1500 },
      },
    };

    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    const d = extractJSON(text);
    if (!d) {
      console.log(`[bot] multi-tf parse fail (text len=${(text||"").length}), tail: ${(text||"").slice(-200)}`);
      await sendTelegramTo(env, chatId, "❌ AI response không hợp lệ. Thử lại.", replyTo);
      return;
    }

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

  // Help / start
  if (cmd === "/start" || cmd === "/help" || cmd === "/trogiup") {
    await sendTelegramTo(env, chatId, helpMessage(), replyTo);
    return;
  }
  // Dictionary thuật ngữ
  if (cmd === "/tudien" || cmd === "/glossary") {
    await sendTelegramTo(env, chatId, glossaryMessage(), replyTo);
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

// Main cron handler
async function runAlertCheck(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("[cron] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID chưa set, skip");
    return;
  }
  if (!env.TWELVEDATA_API_KEY) {
    console.log("[cron] TWELVEDATA_API_KEY chưa set, skip");
    return;
  }
  try {
    const c15 = await fetchTdCandles(env, "15min", 220);
    if (c15.length < 200) {
      console.log(`[cron] insufficient candles: ${c15.length}`);
      return;
    }
    const enriched = enrichIndicators(c15);
    const latest = enriched[enriched.length - 1];
    const prev = enriched[enriched.length - 2];

    const pivots = await getCachedDailyPivots(env);

    const alerts = await detectFreshAlerts(env, latest, prev, pivots, enriched);
    if (alerts.length === 0) {
      console.log(`[cron] no fresh alerts, price=${latest.close.toFixed(2)} rsi=${latest.rsi?.toFixed(1)} atr=${latest.atr?.toFixed(2)}`);
      return;
    }
    const msg = formatAlertMessage(latest, alerts, pivots);
    const ok = await sendTelegram(env, msg);
    console.log(`[cron] sent ${alerts.length} alerts, telegram=${ok}`);
  } catch (e) {
    console.log(`[cron] error: ${e.message}`);
  }
}

async function tryWorkersAI(env, body) {
  if (!env.AI) return null;
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
  // Nếu Gemini yêu cầu JSON, hint AI cũng trả JSON
  if (parsed.generationConfig?.responseMimeType === "application/json") {
    opts.response_format = { type: "json_object" };
  }

  let aiResp;
  try {
    aiResp = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", opts);
  } catch (e) {
    console.log(`[gemini→AI fallback] error: ${e.message}`);
    return null;
  }

  const text = aiResp?.response || "";
  if (!text) return null;

  // Wrap thành format Gemini cho frontend không cần biết
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
      return jsonResponse(200, {
        ok: true,
        service: "xau-gemini-proxy",
        gemini_keys_count: allKeys.length,
        gemini_keys_state: cooldownState,
        hasTwelveDataKey: !!env.TWELVEDATA_API_KEY,
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
    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        // Process async để Telegram không phải đợi
        ctx.waitUntil(handleTelegramUpdate(env, update));
      } catch (e) {
        console.log(`[webhook] parse error: ${e.message}`);
      }
      return new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // Debug toàn diện: webhook + bot + TwelveData + Gemini key cooldowns
    if (url.pathname === "/diag") {
      const out = {
        timestamp: new Date().toISOString(),
        secrets: {
          TELEGRAM_BOT_TOKEN: !!env.TELEGRAM_BOT_TOKEN,
          TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID || null,
          TWELVEDATA_API_KEY: !!env.TWELVEDATA_API_KEY,
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

      // TwelveData rate-limit probe
      if (env.TWELVEDATA_API_KEY) {
        const t0 = Date.now();
        try {
          const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=15min&outputsize=2&apikey=${env.TWELVEDATA_API_KEY}`);
          const j = await r.json();
          out.twelvedata = {
            status: r.status,
            ok: j.status !== "error",
            message: j.status === "error" ? j.message : "OK",
            elapsedMs: Date.now() - t0,
          };
        } catch (e) {
          out.twelvedata = { error: e.message };
        }
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

    // Trigger alert check thủ công (real data — bypass cron schedule)
    if (url.pathname === "/run-alert-check") {
      await runAlertCheck(env);
      return jsonResponse(200, { ok: true, message: "Đã chạy kiểm tra cảnh báo giá, xem console log" }, origin);
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
      const fakeLatest = {
        close: 4520.50, rsi: 78.5, atr: 12.3,
        ema21: 4515.20, ema50: 4505.10, ema200: 4480.50,
        bbUpper: 4540, bbLower: 4500,
      };
      const fakePivots = { pp: 4510, r1: 4525, r2: 4540, s1: 4495, s2: 4480 };
      const fakeAlerts = [
        { icon: "🔴", text: `RSI quá mua *78.5* — coi chừng điều chỉnh`, suggestion: "Watch BB upper rejection. Không chase long." },
        { icon: "🎯", text: `Phá pivot R1 *$4525* lên`, suggestion: "Watch retest R1 làm hỗ trợ. Mục tiêu R2 $4540." },
        { icon: "⚡", text: `ATR spike: *12.30* (1.7x avg)`, suggestion: "Volatility cao bất thường — đợi candle close trước khi entry." },
      ];
      const msg = formatAlertMessage(fakeLatest, fakeAlerts, fakePivots);
      const ok = await sendTelegram(env, msg);
      return jsonResponse(200, {
        ok,
        message: ok ? "✅ Cảnh báo giá test đã gửi vào group" : "❌ Gửi thất bại — kiểm tra TELEGRAM_BOT_TOKEN/CHAT_ID",
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
        "alert:vol_spike",
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
    // Free 800 req/ngày, real-time XAU/USD. Worker chèn apikey từ secret TWELVEDATA_API_KEY.
    if (url.pathname.startsWith("/twelvedata/")) {
      if (request.method !== "GET") {
        return jsonResponse(405, { error: "TwelveData chỉ accept GET" }, origin);
      }
      if (!env.TWELVEDATA_API_KEY) {
        return jsonResponse(500, {
          error: "Worker chưa cấu hình TWELVEDATA_API_KEY. Chạy: wrangler secret put TWELVEDATA_API_KEY",
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
      const fwd = new URLSearchParams();
      for (const k of ALLOWED_PARAMS) {
        const v = url.searchParams.get(k);
        if (v) fwd.set(k, v);
      }
      // Validate symbol (chữ + số + slash, vd "XAU/USD")
      const symbol = fwd.get("symbol") || "";
      if (!/^[A-Za-z0-9/]+$/.test(symbol)) {
        return jsonResponse(400, { error: "symbol không hợp lệ" }, origin);
      }
      // Worker chèn apikey
      fwd.set("apikey", env.TWELVEDATA_API_KEY);

      const tdUrl = `https://api.twelvedata.com${tdPath}?${fwd}`;
      let upstream;
      try {
        upstream = await fetch(tdUrl, {
          cf: { cacheEverything: true, cacheTtl: 30 },
        });
      } catch (e) {
        return jsonResponse(502, { error: `Không gọi được TwelveData: ${e.message}` }, origin);
      }
      const respHeaders = new Headers(corsHeaders(origin));
      respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      respHeaders.set("Cache-Control", "public, max-age=30");
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
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
