// ============================================================
// Gemini API proxy — Cloudflare Worker
// ============================================================
//
// Mục đích: giữ GEMINI_API_KEY trong Worker secret, frontend không bao giờ chạm vào key.
// Frontend gọi `${WORKER_URL}/v1beta/models/{model}:generateContent` (mirror path Google),
// Worker chèn `?key=...` rồi forward sang generativelanguage.googleapis.com.
//
// Set key: wrangler secret put GEMINI_API_KEY

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
 * Hỗ trợ: GEMINI_API_KEY, GEMINI_API_KEY_BACKUP, GEMINI_API_KEY_3..5
 */
function collectGeminiKeys(env) {
  const slots = [
    { name: "GEMINI_API_KEY",        label: "primary" },
    { name: "GEMINI_API_KEY_BACKUP", label: "backup"  },
    { name: "GEMINI_API_KEY_3",      label: "key_3"   },
    { name: "GEMINI_API_KEY_4",      label: "key_4"   },
    { name: "GEMINI_API_KEY_5",      label: "key_5"   },
  ];
  return slots
    .map(s => ({ key: env[s.name], label: s.label }))
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
async function fetchTdCandles(env, interval, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${outputsize}&apikey=${env.TWELVEDATA_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TD ${r.status}`);
  const d = await r.json();
  if (d.status === "error") throw new Error(`TD: ${d.message}`);
  if (!Array.isArray(d.values)) return [];
  return d.values.reverse().map(v => ({
    time: Math.floor(new Date(v.datetime + "Z").getTime() / 1000),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
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

  // ── 1. RSI extreme (chuẩn 70/30) ──
  if (latest.rsi != null) {
    if (latest.rsi > 70)
      await push("rsi_overbought", "🔴", `RSI quá mua *${latest.rsi.toFixed(1)}* — coi chừng điều chỉnh`,
        "Watch BB upper / Pivot R1 cho rejection. Không chase long.");
    if (latest.rsi < 30)
      await push("rsi_oversold", "🟢", `RSI quá bán *${latest.rsi.toFixed(1)}* — khả năng hồi phục`,
        "Watch hỗ trợ S1/Recent Low cho bounce. Đợi confirm trước khi long.");
  }

  // ── 2. Bollinger breakout ──
  if (latest.bbUpper != null && prev.bbUpper != null) {
    if (latest.close > latest.bbUpper && prev.close <= prev.bbUpper)
      await push("bb_up", "📈", `Vượt BB upper *$${latest.bbUpper.toFixed(2)}* — momentum tăng mạnh`,
        "BB break thường tiếp diễn 3-5 nến. Watch retest BB upper làm hỗ trợ.");
    if (latest.close < latest.bbLower && prev.close >= prev.bbLower)
      await push("bb_dn", "📉", `Phá BB lower *$${latest.bbLower.toFixed(2)}* — momentum giảm mạnh`,
        "BB break thường tiếp diễn. Watch retest BB lower làm kháng cự.");
  }

  // ── 3. Golden/Death Cross ──
  if (prev.sma50 != null && prev.sma200 != null && latest.sma50 != null && latest.sma200 != null) {
    if (prev.sma50 <= prev.sma200 && latest.sma50 > latest.sma200)
      await push("golden", "⭐", `*Golden Cross* (SMA50 cắt lên SMA200) — bull trend dài hạn`,
        "Tín hiệu trend reversal mạnh. Ưu tiên buy-the-dip về EMA21/50.");
    if (prev.sma50 >= prev.sma200 && latest.sma50 < latest.sma200)
      await push("death", "💀", `*Death Cross* (SMA50 cắt xuống SMA200) — bear trend dài hạn`,
        "Tín hiệu trend reversal mạnh. Ưu tiên sell-the-rally về EMA21/50.");
  }

  // ── 4. EMA 21/50 cross ──
  if (prev.ema21 != null && prev.ema50 != null && latest.ema21 != null && latest.ema50 != null) {
    if (prev.ema21 <= prev.ema50 && latest.ema21 > latest.ema50)
      await push("ema_up", "📊", "EMA21 cắt lên EMA50 — short-term bullish",
        "Momentum chuyển sang tăng. Watch close trên EMA50 confirm.");
    if (prev.ema21 >= prev.ema50 && latest.ema21 < latest.ema50)
      await push("ema_dn", "📊", "EMA21 cắt xuống EMA50 — short-term bearish",
        "Momentum chuyển sang giảm. Watch close dưới EMA50 confirm.");
  }

  // ── 5. Pivot break ──
  if (pivots) {
    const levels = [
      { key: "r2", label: "R2", price: pivots.r2 },
      { key: "r1", label: "R1", price: pivots.r1 },
      { key: "s1", label: "S1", price: pivots.s1 },
      { key: "s2", label: "S2", price: pivots.s2 },
    ];
    for (const { key, label, price } of levels) {
      if (prev.close <= price && latest.close > price)
        await push(`piv_up_${key}`, "🎯", `Phá pivot ${label} *$${price.toFixed(2)}* lên`,
          `Watch retest ${label} làm hỗ trợ. Mục tiêu mở rộng tới mốc trên.`);
      if (prev.close >= price && latest.close < price)
        await push(`piv_dn_${key}`, "🎯", `Phá pivot ${label} *$${price.toFixed(2)}* xuống`,
          `Watch retest ${label} làm kháng cự. Mục tiêu mở rộng tới mốc dưới.`);
    }
  }

  // ── 6. Biến động giá mạnh trong nến gần nhất (% move) ──
  if (latest.open && latest.close) {
    const change = latest.close - latest.open;
    const changePct = Math.abs(change / latest.open) * 100;
    if (changePct > 0.4) {  // 0.4% trong 1 nến 15m là đáng kể với XAU
      const direction = change > 0 ? "TĂNG" : "GIẢM";
      const icon = change > 0 ? "🚀" : "💥";
      await push(`big_move_${change > 0 ? "up" : "dn"}`, icon,
        `Biến động mạnh: ${direction} *${changePct.toFixed(2)}%* nến gần nhất ($${prev.close.toFixed(2)} → $${latest.close.toFixed(2)})`,
        change > 0
          ? "Watch follow-through 1-2 nến tới. Có thể continue hoặc retrace 50%."
          : "Watch hỗ trợ nearest. Có thể oversold bounce hoặc continue down.");
    }
  }

  // ── 7. Volatility spike (ATR > 1.5x avg gần đây) ──
  if (latest.atr != null && Array.isArray(candlesEnriched) && candlesEnriched.length >= 30) {
    const recentAtrs = candlesEnriched.slice(-30, -1).map(c => c.atr).filter(a => a != null);
    if (recentAtrs.length > 10) {
      const avgAtr = recentAtrs.reduce((s, a) => s + a, 0) / recentAtrs.length;
      if (latest.atr > avgAtr * 1.5) {
        await push("vol_spike", "⚡",
          `ATR spike: *${latest.atr.toFixed(2)}* (${(latest.atr / avgAtr).toFixed(1)}x avg)`,
          "Volatility cao bất thường — đợi candle close trước khi entry, mở rộng SL.");
      }
    }
  }

  // ── 8. Liquidity sweep (wick break recent high/low rồi close back) ──
  if (prev.recentHigh != null && prev.recentLow != null) {
    // Sweep above: high vượt prev's recent high, close lại < prev's recent high
    if (latest.high > prev.recentHigh && latest.close < prev.recentHigh) {
      await push("liq_sweep_up", "🎣",
        `Liquidity sweep TRÊN — wick $${latest.high.toFixed(2)} vượt $${prev.recentHigh.toFixed(2)} rồi close lại trong`,
        "Tín hiệu reversal bearish phổ biến (smart money quét stop). Watch RSI divergence + close dưới EMA21.");
    }
    if (latest.low < prev.recentLow && latest.close > prev.recentLow) {
      await push("liq_sweep_dn", "🎣",
        `Liquidity sweep DƯỚI — wick $${latest.low.toFixed(2)} phá $${prev.recentLow.toFixed(2)} rồi close lại trong`,
        "Tín hiệu reversal bullish (stop hunt). Watch close trên EMA21 + RSI confirm.");
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

function formatAlertMessage(latest, alerts, pivots) {
  const t = new Date().toISOString().slice(0, 16).replace("T", " ");
  let m = `🥇 *XAU/USD Alert* (15m)\n`;
  m += `Giá: *$${latest.close.toFixed(2)}* — ${t} UTC\n\n`;
  m += `*Setups vừa kích hoạt:*\n`;
  for (const a of alerts) {
    m += `${a.icon} ${a.text}\n`;
    if (a.suggestion) m += `   💡 _${a.suggestion}_\n`;
  }
  m += `\n*Indicators:*\n`;
  if (latest.rsi != null) m += `• RSI(14): ${latest.rsi.toFixed(1)} | ATR: ${latest.atr?.toFixed(2)}\n`;
  if (latest.ema21 != null) m += `• EMA 21/50/200: ${latest.ema21.toFixed(2)} / ${latest.ema50?.toFixed(2)} / ${latest.ema200?.toFixed(2)}\n`;
  if (latest.bbUpper != null) m += `• BB(20): ${latest.bbLower.toFixed(2)} - ${latest.bbUpper.toFixed(2)}\n`;
  if (pivots) {
    m += `\n*Pivots (daily):*\n`;
    m += `R2 $${pivots.r2.toFixed(2)} | R1 $${pivots.r1.toFixed(2)} | PP $${pivots.pp.toFixed(2)}\n`;
    m += `S1 $${pivots.s1.toFixed(2)} | S2 $${pivots.s2.toFixed(2)}\n`;
  }
  m += `\n[Mở app](https://xau-smc-analyzer.pages.dev/)`;
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
 * /nhanh = Pulse 5 khung (no AI, fast). Dùng EMA alignment + RSI rule-based.
 */
async function handleNhanhPulse(env, chatId, replyTo) {
  await sendChatAction(env, chatId, "typing");
  try {
    const tfs = ["5m", "15m", "1h", "4h", "1d"];
    const data = await Promise.all(tfs.map(async tf => {
      try {
        const candles = await fetchTdCandles(env, TF_TO_TD[tf], 220);
        if (candles.length < 50) return null;
        const e = enrichIndicators(candles);
        return { tf, latest: e[e.length - 1], prev: e[e.length - 2] };
      } catch { return null; }
    }));
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
    m += `<i>Phiên ${getTradingSession()}</i>\n\n`;
    m += `<b>📊 Bias các khung:</b>\n`;

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

async function handleScanCmd(env, chatId, replyTo, tf = "15m") {
  await sendChatAction(env, chatId, "typing");
  try {
    const tdInterval = TF_TO_TD[tf] || "15min";
    const horizon = TF_HORIZON[tf] || "ngắn hạn";
    const candles = await fetchTdCandles(env, tdInterval, 220);
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

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble.
- BẮT BUỘC điền tất cả field, không bỏ trống.
- Mọi mức giá là số cụ thể (float).
- Mọi khung từ 5m → 1d đều có thể phân tích được, không từ chối.`;
    const userText = `XAU/USD khung ${tf} (horizon ${horizon}), giá $${l.close.toFixed(2)}.
RSI: ${l.rsi?.toFixed(1)} | EMA 21/50/200: ${l.ema21?.toFixed(2)}/${l.ema50?.toFixed(2)}/${l.ema200?.toFixed(2)}
SMA 50/200: ${l.sma50?.toFixed(2)}/${l.sma200?.toFixed(2)} | BB: ${l.bbLower?.toFixed(2)}-${l.bbUpper?.toFixed(2)}
${pivotStr}

Trả JSON:
{
  "huong": "LONG|SHORT|NEUTRAL",
  "tom_tat": "1-2 câu phe nào kiểm soát + lý do ngắn",
  "entry_goi_y": <float|null>,
  "sl_goi_y": <float|null>,
  "tp_goi_y": <float|null>,
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

    let m = `<b>🥇 Quick Scan ${tf}</b> — horizon ${horizon}\n`;
    m += `Giá: <b>$${l.close.toFixed(2)}</b> | ${huongIcon} <b>${huong}</b>\n\n`;

    if (d.tom_tat) m += `${htmlEsc(d.tom_tat)}\n\n`;

    // Setup gợi ý
    if (d.entry_goi_y != null && d.sl_goi_y != null && d.tp_goi_y != null) {
      const rr = Math.abs((d.tp_goi_y - d.entry_goi_y) / (d.entry_goi_y - d.sl_goi_y));
      m += `<b>🎯 Setup gợi ý (${huong}):</b>\n`;
      m += `Entry: <b>$${d.entry_goi_y.toFixed(2)}</b> | SL: <b>$${d.sl_goi_y.toFixed(2)}</b> | TP: <b>$${d.tp_goi_y.toFixed(2)}</b> | R:R: <b>${rr.toFixed(1)}</b>\n`;
      if (d.ly_do_setup) m += `<i>${htmlEsc(d.ly_do_setup)}</i>\n`;
    } else if (d.ly_do_setup) {
      m += `<b>🎯 Setup:</b> ${htmlEsc(d.ly_do_setup)}\n`;
    }

    if (d.khang_cu_gan || d.ho_tro_gan) {
      m += `\n<b>📍 Mức cần watch:</b>\n`;
      if (d.khang_cu_gan) m += `▲ <b>$${Number(d.khang_cu_gan).toFixed(2)}</b> kháng cự\n`;
      if (d.ho_tro_gan) m += `▼ <b>$${Number(d.ho_tro_gan).toFixed(2)}</b> hỗ trợ\n`;
    }

    if (d.canh_bao) {
      m += `\n⚠️ <b>Cảnh báo:</b> ${htmlEsc(d.canh_bao)}`;
    }

    await sendTelegramTo(env, chatId, m, replyTo, "HTML");
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

async function handleAnalyzeCmd(env, chatId, replyTo, tfArg) {
  const tf = (tfArg || "15m").toLowerCase();
  if (!TF_TO_TD[tf]) {
    await sendTelegramTo(env, chatId, `❌ TF không hợp lệ. Dùng: ${Object.keys(TF_TO_TD).join(", ")}`, replyTo);
    return;
  }
  await sendChatAction(env, chatId, "typing");
  try {
    const candles = await fetchTdCandles(env, TF_TO_TD[tf], 220);
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
- Mỗi thuật ngữ kỹ thuật phải kèm giải nghĩa ngắn (vd "SMC = Smart Money Concepts, theo dấu chân các quỹ lớn").

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble, KHÔNG markdown wrap.
- Đây là phân tích kỹ thuật giáo dục, KHÔNG phải khuyến nghị đầu tư.
- Tất cả mức giá phải là số cụ thể (float).
- 3 mức TP: TP1 an toàn (R:R ~1:1), TP2 kỳ vọng (R:R ~1:2), TP3 tối đa theo trend (R:R ~1:3+).
- SL đặt NGOÀI vùng nhiễu (>1×ATR cách swing) để tránh "quét stop".
- Nếu setup chưa rõ → chọn WAIT (đứng ngoài), KHÔNG bịa entry.`;

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
- 10 nến gần nhất (OHLC): ${last10}

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

    const html = formatAnalysisHTML(d, tf, horizon);
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
async function handleMultiTfAnalyze(env, chatId, replyTo, tfs, isNhanh) {
  await sendChatAction(env, chatId, "typing");
  try {
    // Fetch tất cả TFs parallel
    const dataArrays = await Promise.all(tfs.map(async tf => {
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
    }));
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
    // TF lớn nhất = HTF cho horizon
    const tfOrder = ["5m", "15m", "1h", "4h", "1d"];
    const sortedByTime = [...valid].sort((a, b) => tfOrder.indexOf(a.tf) - tfOrder.indexOf(b.tf));
    const htf = sortedByTime[sortedByTime.length - 1].tf;
    const ltf = sortedByTime[0].tf;
    const horizon = TF_HORIZON[htf] || "ngắn-trung hạn";

    const systemText = `Bạn là chuyên gia TA XAU/USD scalping/day trading + SMC, chuyên top-down multi-timeframe.

NGUYÊN TẮC TOP-DOWN:
- HTF (khung lớn nhất ${htf}) → định BIAS chính (xu hướng tổng).
- MTF (khung giữa) → định SETUP (vùng entry/cản).
- LTF (khung nhỏ ${ltf}) → định ENTRY TIMING + confirm.
- Khuyến nghị PHẢI dựa trên hợp lực 3 khung. Nếu các khung mâu thuẫn → ghi rõ ở 'alignment' và giảm độ tin cậy.

QUY TẮC:
- Trả JSON CHÍNH XÁC theo schema, KHÔNG preamble.
- BẮT BUỘC điền field 'by_tf' cho TẤT CẢ ${valid.length} khung — không bỏ sót.
- Mọi mức giá là số cụ thể (float).
- SL ngoài vùng nhiễu (>1×ATR cách swing).
- R:R tối thiểu 1:1.5.`;

    const userText = `Phân tích TOP-DOWN XAU/USD ${valid.length} khung: ${tfsLabel}.
Horizon dự báo: ${horizon} (theo HTF ${htf})

DỮ LIỆU TỪNG KHUNG:
${tfDataLines}

${pivotStr}

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
    "ly_do": "lý do confluence top-down",
    "dieu_kien_confirm": "..."
  },
  "short": { ...same... },
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

    const html = formatMultiTfHTML(d, valid, horizon, isNhanh);
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
  const prefix = isNhanh ? "Quick" : "SMC";

  let m = `<b>🥇 ${prefix} Top-Down: ${tfsLabel}</b> (horizon ${horizon})\n`;
  m += `${consensusIcon} Consensus: <b>${consensus}</b> | Tin cậy: <b>${htmlEsc(d.do_tin_cay || "?")}</b> | ${alignment}\n`;
  if (d.tom_tat) m += `<i>${htmlEsc(d.tom_tat)}</i>\n`;

  // Bias từng TF — luôn show TẤT CẢ valid TFs (dù AI có miss thì hiện "chưa rõ")
  m += `\n<b>📊 Bias từng khung:</b>\n`;
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

  m += `\n━━━ <b>🎯 KHUYẾN NGHỊ</b> ━━━\n\n`;

  const scenarioBlock = (sc, label, icon) => {
    if (!sc?.kha_thi) {
      return `${icon} <b>${label}</b>: ❌ không khả thi\n<i>${htmlEsc(sc?.ly_do || "Chưa thuận")}</i>`;
    }
    let s = `${icon} <b>${label}</b> ✅`;
    if (sc.rr != null) s += ` | R:R: <b>${Number(sc.rr).toFixed(1)}</b>`;
    s += `\nEntry: <b>$${fmt2(sc.entry)}</b>\n`;
    s += `SL: <b>$${fmt2(sc.sl)}</b> | TP: <b>$${fmt2(sc.tp)}</b>\n`;
    if (sc.dieu_kien_confirm) s += `Confirm: ${htmlEsc(sc.dieu_kien_confirm)}\n`;
    if (sc.ly_do) s += `<i>${htmlEsc(sc.ly_do)}</i>`;
    return s;
  };

  m += scenarioBlock(d.long, "LONG", "📈") + "\n\n";
  m += scenarioBlock(d.short, "SHORT", "📉") + "\n\n";

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

  m += `━━━ <b>📊 PHÂN TÍCH TOP-DOWN</b> ━━━\n`;
  if (d.phan_tich_top_down) m += htmlEsc(d.phan_tich_top_down) + "\n\n";

  if (Array.isArray(d.rui_ro_chinh) && d.rui_ro_chinh.length) {
    m += `<b>⚠️ Rủi ro:</b>\n`;
    for (const r of d.rui_ro_chinh) m += `• ${htmlEsc(r)}\n`;
  }

  return m;
}

async function handleTelegramUpdate(env, update) {
  const msg = update.message || update.channel_post;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const replyTo = msg.message_id;

  // Auth: chỉ chấp nhận từ chat đã configure (defense against random chats finding webhook)
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
    console.log(`[bot] ignore from chat ${chatId}`);
    return;
  }

  // Parse command (strip @bot_username if mentioned)
  const tokens = text.split(/\s+/);
  const cmd = tokens[0].toLowerCase().split("@")[0];
  const args = tokens.slice(1);

  console.log(`[bot] cmd=${cmd} args=${args.join(",")}`);
  // Help / start
  if (cmd === "/start" || cmd === "/help" || cmd === "/trogiup") {
    await sendTelegramTo(env, chatId, helpMessage(), replyTo);
    return;
  }
  // Giá hiện tại (no AI, instant)
  if (cmd === "/gia" || cmd === "/giá" || cmd === "/price") {
    await handlePriceCmd(env, chatId, replyTo);
    return;
  }
  // /nhanh = Pulse 5 khung (no AI, instant rule-based)
  if (cmd === "/nhanh") {
    await handleNhanhPulse(env, chatId, replyTo);
    return;
  }
  // /nhanh5p, /nhanh15p, /nhanh1h, /nhanh4h, /nhanh1d = AI quick scan single TF
  if (VN_SCAN_CMD_TO_TF[cmd]) {
    await handleScanCmd(env, chatId, replyTo, VN_SCAN_CMD_TO_TF[cmd]);
    return;
  }
  // Phân tích SMC theo TF — match lệnh tiếng Việt /5p, /15p, /1h, /4h, /1d, ...
  if (VN_CMD_TO_TF[cmd]) {
    await handleAnalyzeCmd(env, chatId, replyTo, VN_CMD_TO_TF[cmd]);
    return;
  }
  // Combo: /5p15p1h hoặc /nhanh5p15p1h → phân tích TOP-DOWN tổng hợp 1 reply
  const multi = parseMultiTfCommand(cmd);
  if (multi) {
    console.log(`[bot] multi-tf ${multi.isNhanh ? "scan" : "analyze"}: ${multi.tfs.join(",")}`);
    await handleMultiTfAnalyze(env, chatId, replyTo, multi.tfs, multi.isNhanh);
    return;
  }
  // Backward compat: /analyze [tf] hoặc /smc [tf]
  if (cmd === "/analyze" || cmd === "/smc" || cmd === "/phantich") {
    await handleAnalyzeCmd(env, chatId, replyTo, args[0] || "15m");
    return;
  }
  // Bỏ qua các message khác (không spam group)
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
      return jsonResponse(200, { ok: true, message: "Alert check chạy xong, xem console log" }, origin);
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
        message: ok ? "✅ Test alert đã gửi vào group" : "❌ Gửi thất bại — check TELEGRAM_BOT_TOKEN/CHAT_ID",
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
      return jsonResponse(200, { cleared, message: `Đã xóa ${cleared} alert cooldown keys` }, origin);
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
        error: "Worker chưa cấu hình GEMINI_API_KEY. Chạy: wrangler secret put GEMINI_API_KEY",
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
