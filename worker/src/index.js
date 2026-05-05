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

function enrichIndicators(candles) {
  const closes = candles.map(c => c.close);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes, 14);
  const { upper: bu, lower: bl } = bollinger(closes, 20, 2);
  return candles.map((c, i) => ({
    ...c,
    ema21: e21[i], ema50: e50[i], ema200: e200[i],
    sma50: s50[i], sma200: s200[i],
    rsi: r14[i],
    bbUpper: bu[i], bbLower: bl[i],
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

async function detectFreshAlerts(env, latest, prev, pivots) {
  const out = [];
  const push = async (key, icon, text) => {
    if (await alertCooldownOk(env, key)) {
      out.push({ icon, text });
      await markAlerted(env, key);
    }
  };

  // RSI extreme (state-based, dedup 1h)
  if (latest.rsi != null) {
    if (latest.rsi > 75) await push("rsi_overbought", "🔴", `RSI quá mua *${latest.rsi.toFixed(1)}* — coi chừng điều chỉnh`);
    if (latest.rsi < 25) await push("rsi_oversold", "🟢", `RSI quá bán *${latest.rsi.toFixed(1)}* — khả năng hồi phục`);
  }

  // BB breakout (event-based, vừa cross)
  if (latest.bbUpper != null && prev.bbUpper != null) {
    if (latest.close > latest.bbUpper && prev.close <= prev.bbUpper)
      await push("bb_up", "📈", `Vượt BB upper *$${latest.bbUpper.toFixed(2)}* — momentum tăng mạnh`);
    if (latest.close < latest.bbLower && prev.close >= prev.bbLower)
      await push("bb_dn", "📉", `Phá BB lower *$${latest.bbLower.toFixed(2)}* — momentum giảm mạnh`);
  }

  // Golden / Death Cross (SMA 50/200)
  if (prev.sma50 != null && prev.sma200 != null && latest.sma50 != null && latest.sma200 != null) {
    if (prev.sma50 <= prev.sma200 && latest.sma50 > latest.sma200)
      await push("golden", "⭐", `*Golden Cross* (SMA50 cắt lên SMA200) — bull trend dài hạn`);
    if (prev.sma50 >= prev.sma200 && latest.sma50 < latest.sma200)
      await push("death", "💀", `*Death Cross* (SMA50 cắt xuống SMA200) — bear trend dài hạn`);
  }

  // EMA 21/50 cross (short-term)
  if (prev.ema21 != null && prev.ema50 != null && latest.ema21 != null && latest.ema50 != null) {
    if (prev.ema21 <= prev.ema50 && latest.ema21 > latest.ema50)
      await push("ema_up", "📊", "EMA21 cắt lên EMA50 — short-term bullish");
    if (prev.ema21 >= prev.ema50 && latest.ema21 < latest.ema50)
      await push("ema_dn", "📊", "EMA21 cắt xuống EMA50 — short-term bearish");
  }

  // Pivot levels break
  if (pivots) {
    const levels = [
      { key: "r2", label: "R2", price: pivots.r2 },
      { key: "r1", label: "R1", price: pivots.r1 },
      { key: "s1", label: "S1", price: pivots.s1 },
      { key: "s2", label: "S2", price: pivots.s2 },
    ];
    for (const { key, label, price } of levels) {
      if (prev.close <= price && latest.close > price)
        await push(`piv_up_${key}`, "🎯", `Phá pivot ${label} *$${price.toFixed(2)}* lên`);
      if (prev.close >= price && latest.close < price)
        await push(`piv_dn_${key}`, "🎯", `Phá pivot ${label} *$${price.toFixed(2)}* xuống`);
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
  for (const a of alerts) m += `${a.icon} ${a.text}\n`;
  m += `\n*Indicators:*\n`;
  if (latest.rsi != null) m += `• RSI(14): ${latest.rsi.toFixed(1)}\n`;
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

  // Cache hit
  const cached = await cacheGet(env, cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch {}
  }

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
        await cachePut(env, cacheKey, JSON.stringify(json));
        return json;
      }
      markKeyCooldown(label, r.status);
    } catch (e) {
      console.log(`[gemini-smart] ${label} error: ${e.message}`);
    }
  }

  // Fallback Workers AI
  const ai = await tryWorkersAI(env, bodyStr);
  if (ai) {
    await cachePut(env, cacheKey, JSON.stringify(ai));
    return ai;
  }
  return null;
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
    // Nếu Markdown parse fail → retry plain text (auto-fallback)
    if (!r.ok && parseMode === "Markdown") {
      const errText = await r.text();
      if (errText.includes("can't parse entities") || errText.includes("parse_mode")) {
        console.log(`[tg-reply] markdown fail, retry plain`);
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

function helpMessage() {
  return `🥇 *XAU Bot — Lệnh*

\`/gia\` — giá hiện tại + indicators
\`/nhanh\` — AI quick scan 3-5 dòng

*Phân tích SMC theo khung:*
\`/5p\` — khung 5 phút
\`/15p\` — khung 15 phút
\`/1h\` — khung 1 giờ
\`/4h\` — khung 4 giờ
\`/1d\` — khung 1 ngày

Ví dụ: gõ \`/1h\` để phân tích khung 1 giờ.

App đầy đủ: [xau-smc-analyzer.pages.dev](https://xau-smc-analyzer.pages.dev)`;
}

// Map lệnh tiếng Việt → TF nội bộ
const VN_CMD_TO_TF = {
  "/5p": "5m", "/5m": "5m",
  "/15p": "15m", "/15m": "15m",
  "/1h": "1h", "/1g": "1h", "/1gio": "1h",
  "/4h": "4h", "/4g": "4h", "/4gio": "4h",
  "/1d": "1d", "/1ngay": "1d", "/ngay": "1d",
};

async function handlePriceCmd(env, chatId, replyTo) {
  try {
    const c15 = await fetchTdCandles(env, "15min", 220);
    if (c15.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(c15);
    const l = e[e.length - 1];
    let pivots = null;
    try {
      const c1d = await fetchTdCandles(env, "1day", 5);
      if (c1d.length >= 2) pivots = computePivots(c1d[c1d.length - 2]);
    } catch {}

    let m = `🥇 *XAU/USD* — 15m\n`;
    m += `Giá: *$${l.close.toFixed(2)}*\n\n`;
    m += `RSI(14): *${l.rsi?.toFixed(1)}*\n`;
    m += `EMA 21/50/200: ${l.ema21?.toFixed(2)} / ${l.ema50?.toFixed(2)} / ${l.ema200?.toFixed(2)}\n`;
    m += `SMA 50/200: ${l.sma50?.toFixed(2)} / ${l.sma200?.toFixed(2)}\n`;
    m += `BB(20): ${l.bbLower?.toFixed(2)} – ${l.bbUpper?.toFixed(2)}`;
    if (pivots) {
      m += `\n\n*Pivots (daily):*\nR2 ${pivots.r2.toFixed(2)} | R1 ${pivots.r1.toFixed(2)} | PP ${pivots.pp.toFixed(2)}\nS1 ${pivots.s1.toFixed(2)} | S2 ${pivots.s2.toFixed(2)}`;
    }
    await sendTelegramTo(env, chatId, m, replyTo);
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
}

async function handleScanCmd(env, chatId, replyTo) {
  await sendTelegramTo(env, chatId, "⏳ Đang scan...", replyTo);
  try {
    const c15 = await fetchTdCandles(env, "15min", 220);
    if (c15.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(c15);
    const l = e[e.length - 1];

    const prompt = `Giá XAU/USD: $${l.close.toFixed(2)} (khung 15m)
RSI(14): ${l.rsi?.toFixed(1)} | EMA 21/50/200: ${l.ema21?.toFixed(2)} / ${l.ema50?.toFixed(2)} / ${l.ema200?.toFixed(2)}
SMA 50/200: ${l.sma50?.toFixed(2)} / ${l.sma200?.toFixed(2)}
BB(20): ${l.bbLower?.toFixed(2)} – ${l.bbUpper?.toFixed(2)}

Trả lời tiếng Việt 3-5 dòng:
1. Phe mua/bán đang kiểm soát?
2. Mốc S/R cần watch?
3. Setup đáng quan tâm 2-4h tới?

KHÔNG khuyến nghị mua/bán cụ thể.`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.5 },
    };
    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    if (text) {
      // Plain text — AI output có thể có ký tự Markdown không cân
      await sendTelegramTo(env, chatId, `🥇 Quick Scan\n\n${text}`, replyTo, null);
    } else {
      await sendTelegramTo(env, chatId, "❌ AI unavailable", replyTo);
    }
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
  await sendTelegramTo(env, chatId, `⏳ Phân tích SMC khung ${tf}...`, replyTo);

  try {
    const candles = await fetchTdCandles(env, TF_TO_TD[tf], 220);
    if (candles.length < 50) {
      await sendTelegramTo(env, chatId, "❌ Lỗi fetch data", replyTo);
      return;
    }
    const e = enrichIndicators(candles);
    const l = e[e.length - 1];

    let pivots = null;
    try {
      const c1d = await fetchTdCandles(env, "1day", 5);
      if (c1d.length >= 2) pivots = computePivots(c1d[c1d.length - 2]);
    } catch {}

    const last10 = candles.slice(-10).map(c =>
      `O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`
    ).join(" | ");
    const horizon = TF_HORIZON[tf];
    const pivotStr = pivots
      ? `R2=${pivots.r2.toFixed(2)} R1=${pivots.r1.toFixed(2)} PP=${pivots.pp.toFixed(2)} S1=${pivots.s1.toFixed(2)} S2=${pivots.s2.toFixed(2)}`
      : "không có";

    const prompt = `Bạn là chuyên gia TA XAU/USD scalping/day trading + SMC. Phân tích khung ${tf}, horizon ${horizon}.

DỮ LIỆU:
- Giá: $${l.close.toFixed(2)} | RSI(14): ${l.rsi?.toFixed(1)}
- EMA 21/50/200: ${l.ema21?.toFixed(2)} / ${l.ema50?.toFixed(2)} / ${l.ema200?.toFixed(2)}
- SMA 50/200: ${l.sma50?.toFixed(2)} / ${l.sma200?.toFixed(2)} ${l.sma50 > l.sma200 ? "(golden)" : "(death)"}
- BB(20): ${l.bbLower?.toFixed(2)} - ${l.bbUpper?.toFixed(2)}
- Pivots: ${pivotStr}
- 10 nến: ${last10}

Trả lời tiếng Việt format Markdown:

📊 *Cấu trúc & Động lượng*
• Phe kiểm soát: ...
• BOS/CHOCH: ...
• RSI/MACD: ... (phân kỳ/kiệt sức/bình thường)

🎯 *Vùng cản quan trọng*
• Kháng cự: 2 mức + lý do
• Hỗ trợ: 2 mức + lý do

💡 *Kế hoạch ${horizon}*
LONG: Entry=$X, SL=$Y, TP=$Z, R:R=N (lý do ngắn) — hoặc "không khả thi"
SHORT: Entry=$X, SL=$Y, TP=$Z, R:R=N (lý do ngắn) — hoặc "không khả thi"

⚠️ *Rủi ro*
• 2-3 điểm

NGUYÊN TẮC: SL ngoài vùng nhiễu (>1×ATR cách swing) tránh liquidity sweep. R:R tối thiểu 1:1.5. Mọi mức giá phải là số cụ thể. KHÔNG khuyến nghị "mua/bán ngay".`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1500, temperature: 0.5 },
    };
    const resp = await callGeminiSmart(env, body);
    const text = extractText(resp);
    if (!text) {
      await sendTelegramTo(env, chatId, "❌ AI unavailable", replyTo);
      return;
    }
    // Telegram limit 4096 chars
    const safe = text.length > 3800 ? text.slice(0, 3800) + "\n…(cắt bớt)" : text;
    // Plain text vì AI output có Markdown không cân (vd "EMA 21 → bắt đầu *uptrend")
    await sendTelegramTo(env, chatId, `🧠 SMC ${tf}\n\n${safe}`, replyTo, null);
  } catch (e) {
    await sendTelegramTo(env, chatId, `❌ Error: ${e.message}`, replyTo);
  }
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
  // Quick scan AI
  if (cmd === "/nhanh" || cmd === "/scan" || cmd === "/quick") {
    await handleScanCmd(env, chatId, replyTo);
    return;
  }
  // Phân tích SMC theo TF — match lệnh tiếng Việt /5p, /15p, /1h, /4h, /1d, ...
  if (VN_CMD_TO_TF[cmd]) {
    await handleAnalyzeCmd(env, chatId, replyTo, VN_CMD_TO_TF[cmd]);
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

    let pivots = null;
    try {
      const c1d = await fetchTdCandles(env, "1day", 5);
      if (c1d.length >= 2) pivots = computePivots(c1d[c1d.length - 2]);
    } catch (e) {
      console.log(`[cron] daily fetch failed: ${e.message}`);
    }

    const alerts = await detectFreshAlerts(env, latest, prev, pivots);
    if (alerts.length === 0) {
      console.log(`[cron] no fresh alerts, price=${latest.close.toFixed(2)} rsi=${latest.rsi?.toFixed(1)}`);
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

    // Test Telegram setup: gửi message kiểm tra bot/chat_id config OK
    if (url.pathname === "/test-telegram") {
      const ok = await sendTelegram(env, "🔔 *Test alert* — Bot setup OK!\n\nNếu nhận được tin này thì cron alerts sẽ chạy ổn từ 15 phút tới.\n\n_xau-gemini-proxy_");
      return jsonResponse(200, {
        ok,
        configured: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
      }, origin);
    }

    // Trigger alert check thủ công (debug — bypass cron schedule)
    if (url.pathname === "/run-alert-check") {
      await runAlertCheck(env);
      return jsonResponse(200, { ok: true, message: "Alert check chạy xong, xem console log" }, origin);
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
