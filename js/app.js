// ============================================================
// XAU/USD SMC Analyzer — main UI logic
// ============================================================
import { fetchSpot, fetchOHLCV, TF_TO_TD } from "./data.js";
import { computeIndicators, calculateZones, detectAlerts, computePivots } from "./indicators.js";
import { analyzeSmc, quickScan } from "./gemini.js";
import { initChart, updateChart, resizeChart, setPivots } from "./chart.js";
import { fetchNews, formatNewsForPrompt } from "./news.js";
import { CONFIG } from "./config.js";

// ============================================================
// STATE
// ============================================================
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];
const TF_LABELS = { "5m": "5 phút", "15m": "15 phút", "1h": "1 giờ", "4h": "4 giờ", "1d": "1 ngày" };

const state = {
  tf: CONFIG.DEFAULT_TF || "15m",
  analysisTfs: [CONFIG.DEFAULT_TF || "15m"],
  candles: [],
  candlesByTf: {},        // cache OHLCV theo tf
  candleSourceByTf: {},   // 'twelvedata' | 'stooq'
  spot: null,
  smcResults: {},
  quickResult: null,
  news: [],               // RSS news items
  loading: false,
  history: JSON.parse(localStorage.getItem("xau_history") || "[]"),
  theme: localStorage.getItem("xau_theme") || "dark",
  showPivots: localStorage.getItem("xau_show_pivots") !== "false",  // default ON
};

// ============================================================
// DOM HELPERS
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem("xau_theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
  $("#theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
}

function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function setLoading(on, msg = "") {
  state.loading = on;
  $("#loading-overlay").classList.toggle("hidden", !on);
  $("#loading-msg").textContent = msg;
}

// ============================================================
// DATA LOADING
// ============================================================
async function loadTfData(tf) {
  if (state.candlesByTf[tf]) return state.candlesByTf[tf];
  const { candles: raw, source } = await fetchOHLCV(tf);
  const withInd = computeIndicators(raw);
  state.candlesByTf[tf] = withInd;
  state.candleSourceByTf[tf] = source;
  return withInd;
}

async function refreshAll() {
  setLoading(true, "Đang tải data...");
  try {
    state.candlesByTf = {};
    state.candleSourceByTf = {};
    const [candles, spot, news] = await Promise.all([
      loadTfData(state.tf),
      fetchSpot().catch(() => null),
      fetchNews().catch(() => []),
    ]);
    state.candles = candles;
    state.spot = spot;
    state.news = news;
    render();
  } catch (e) {
    showError(`Lỗi tải data: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

// ============================================================
// RENDER
// ============================================================
function render() {
  renderHeader();
  renderNewsPanel();   // tách ra: render kể cả khi candles chưa load
  renderChart();
  renderAlerts();
  renderAnalysis();
  renderHistory();
}

function renderHeader() {
  const candles = state.candles;
  if (!candles || candles.length < 2) return;
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const price = state.spot ?? latest.close;
  const change = price - prev.close;
  const changePct = (change / prev.close) * 100;

  $("#price").textContent = `$${fmt(price)}`;
  $("#change").textContent = `${change >= 0 ? "+" : ""}${fmt(change)} (${change >= 0 ? "+" : ""}${fmt(changePct)}%)`;
  $("#change").className = change >= 0 ? "text-green-500 text-lg" : "text-red-500 text-lg";

  $("#rsi").textContent = fmt(latest.rsi, 1);
  $("#atr").textContent = fmt(latest.atr, 2);
  $("#ema-trio").textContent = `${fmt(latest.ema20)} / ${fmt(latest.ema50)} / ${fmt(latest.ema200)}`;
  $("#updated").textContent = new Date().toLocaleTimeString("vi-VN");

  // Show data source badge
  const src = state.candleSourceByTf[state.tf];
  const srcEl = $("#data-source");
  if (srcEl && src) {
    srcEl.textContent = "📡 TwelveData";
    srcEl.className = "text-xs text-green-500";
  }
}

function renderNewsPanel() {
  const wrapper = $("#news-panel");
  if (!wrapper) return;

  // Empty state — hiện vẫn có tiêu đề để user biết panel tồn tại
  if (!state.news || state.news.length === 0) {
    wrapper.innerHTML = `
      <div class="bg-slate-100 dark:bg-slate-800 rounded-lg p-3 text-sm">
        <div class="font-semibold mb-1">📰 Tin tức gold-relevant (24h)</div>
        <div class="text-xs text-slate-500">Chưa có tin lọc được. Có thể RSS proxy lỗi tạm hoặc không có tin gold trong 24h gần nhất.</div>
      </div>
    `;
    return;
  }

  const items = state.news.slice(0, 8);
  wrapper.innerHTML = `
    <details class="bg-slate-100 dark:bg-slate-800 rounded-lg p-3" open>
      <summary class="cursor-pointer font-semibold">📰 Tin tức 24h (${state.news.length}) — đã đưa vào prompt AI</summary>
      <div class="mt-3 space-y-2">
        ${items.map(it => {
          const ago = (Date.now() - new Date(it.ts).getTime()) / 3600000;
          const agoStr = ago >= 1 ? `${ago.toFixed(0)}h trước` : `${Math.round(ago * 60)} phút`;
          return `<div class="text-sm border-l-2 border-blue-500 pl-3">
            <div class="text-xs text-slate-500">[${it.source}] ${agoStr}</div>
            <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener" class="text-blue-500 hover:underline">${escapeHtml(it.title)}</a>
            ${it.summary ? `<div class="text-xs text-slate-600 dark:text-slate-400 mt-1">${escapeHtml(it.summary.slice(0, 200))}</div>` : ""}
          </div>`;
        }).join("")}
      </div>
    </details>
  `;
}

function renderChart() {
  updateChart(state.candles, state.tf);
  // Pivot Points: dùng candle hoàn thành trước nến hiện tại của TF đang xem
  // (5m → prev 5m, 15m → prev 15m, ..., 1d → yesterday daily)
  if (state.showPivots && state.candles && state.candles.length >= 2) {
    const previous = state.candles[state.candles.length - 2];
    setPivots(computePivots(previous));
  } else {
    setPivots(null);
  }
}

function updatePivotButton() {
  const btn = $("#pivot-toggle");
  if (!btn) return;
  btn.classList.toggle("bg-blue-600", state.showPivots);
  btn.classList.toggle("text-white", state.showPivots);
  btn.classList.toggle("border-blue-600", state.showPivots);
}

function onTogglePivot() {
  state.showPivots = !state.showPivots;
  localStorage.setItem("xau_show_pivots", state.showPivots ? "true" : "false");
  updatePivotButton();
  renderChart();
}

function renderAlerts() {
  const candles = state.candles;
  const container = $("#alerts");
  container.innerHTML = "";
  if (!candles || candles.length < 2) return;
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // ── Pivot Points cho key levels (always computed, độc lập với toggle hiển thị chart) ──
  const pivots = computePivots(prev);

  // ── Default panel: Xu hướng trong ngày + Key technical levels ──
  container.innerHTML = renderTrendSummary(latest, candles, pivots);

  // ── Rule-based alerts (nếu có) ──
  const alerts = detectAlerts(latest, prev);
  if (alerts.length === 0) {
    container.innerHTML += `<div class="text-slate-500 text-xs italic mt-2">Không có cảnh báo rule-based đặc biệt (RSI/BB/MACD/Cross).</div>`;
  } else {
    alerts.forEach(a => {
      const div = document.createElement("div");
      div.className = "alert-item bg-amber-500/10 border-l-4 border-amber-500 p-3 rounded text-sm mt-2";
      div.textContent = a;
      container.appendChild(div);
    });
  }
}

/**
 * Default panel: trend in day + key technical price levels around current price.
 * Hiện luôn (independent với rule-based alerts).
 */
function renderTrendSummary(latest, candles, pivots) {
  const c = latest.close;

  // Trend determination dựa vào EMA alignment + price position
  let trend, icon, color;
  const { ema21, ema50, ema200 } = latest;
  if (ema200 == null || ema21 == null || ema50 == null) {
    trend = "Chưa đủ data"; icon = "❓"; color = "text-slate-500";
  } else if (c > ema200 && ema21 > ema50 && ema50 > ema200) {
    trend = "Tăng mạnh"; icon = "🚀"; color = "text-green-500";
  } else if (c > ema50 && c > ema200) {
    trend = "Tăng"; icon = "📈"; color = "text-green-500";
  } else if (c < ema200 && ema21 < ema50 && ema50 < ema200) {
    trend = "Giảm mạnh"; icon = "🔻"; color = "text-red-500";
  } else if (c < ema50 && c < ema200) {
    trend = "Giảm"; icon = "📉"; color = "text-red-500";
  } else {
    trend = "Sideways"; icon = "↔️"; color = "text-amber-500";
  }

  // Today's UTC session O/H/L + position trong range
  const lastDate = new Date(latest.time * 1000);
  const dayStart = Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate()) / 1000;
  const todays = candles.filter(cn => cn.time >= dayStart);
  let sessionInfo = "";
  let todayHigh = null, todayLow = null;
  if (todays.length > 0) {
    const sOpen = todays[0].open;
    todayHigh = Math.max(...todays.map(cn => cn.high));
    todayLow = Math.min(...todays.map(cn => cn.low));
    const range = todayHigh - todayLow;
    const pct = range > 0 ? ((c - todayLow) / range * 100).toFixed(0) : "—";
    sessionInfo = `Phiên UTC: O <strong>$${fmt(sOpen)}</strong> / H <strong>$${fmt(todayHigh)}</strong> / L <strong>$${fmt(todayLow)}</strong> <span class="text-slate-500">(giá ở ${pct}% range)</span>`;
  }

  // SMA alignment
  const smaAlign = (latest.sma50 != null && latest.sma200 != null)
    ? (latest.sma50 > latest.sma200
       ? `<span class="text-green-500">golden alignment (SMA50>200)</span>`
       : `<span class="text-red-500">death alignment (SMA50<200)</span>`)
    : "";

  // RSI text
  const rsiText = latest.rsi != null
    ? (latest.rsi > 70 ? `<span class="text-red-500">${fmt(latest.rsi, 1)} quá mua</span>`
       : latest.rsi < 30 ? `<span class="text-green-500">${fmt(latest.rsi, 1)} quá bán</span>`
       : `${fmt(latest.rsi, 1)} trung tính`)
    : "—";

  // MACD text
  const macdText = (latest.macd != null && latest.macdSignal != null)
    ? (latest.macd > latest.macdSignal
       ? `<span class="text-green-500">bullish</span>`
       : `<span class="text-red-500">bearish</span>`)
    : "—";

  // ── Collect tất cả key levels ──
  const levels = [];
  const add = (price, label) => {
    if (price != null && !isNaN(price)) levels.push({ price, label });
  };
  add(latest.recentHigh, "Recent High (50)");
  add(latest.recentLow, "Recent Low (50)");
  add(latest.bbUpper, "BB Upper");
  add(latest.bbLower, "BB Lower");
  add(latest.ema21, "EMA 21");
  add(latest.ema50, "EMA 50");
  add(latest.ema200, "EMA 200");
  add(latest.sma50, "SMA 50");
  add(latest.sma200, "SMA 200");
  if (pivots) {
    add(pivots.r2, "Pivot R2");
    add(pivots.r1, "Pivot R1");
    add(pivots.pp, "Pivot PP");
    add(pivots.s1, "Pivot S1");
    add(pivots.s2, "Pivot S2");
  }
  if (todayHigh != null) add(todayHigh, "Today High");
  if (todayLow != null)  add(todayLow,  "Today Low");

  // Sort: above ascending (gần nhất trước), below descending
  const above = levels.filter(l => l.price > c).sort((a, b) => a.price - b.price).slice(0, 6);
  const below = levels.filter(l => l.price < c).sort((a, b) => b.price - a.price).slice(0, 6);

  return `
    <div class="bg-blue-500/10 border-l-4 border-blue-500 p-3 rounded text-sm mb-3">
      <div class="font-semibold mb-2">🧭 Xu hướng trong ngày</div>
      <div class="text-xs space-y-1 mb-3">
        <div>Trend: <strong class="${color}">${icon} ${trend}</strong> <span class="text-slate-500">| Giá hiện tại: <strong>$${fmt(c)}</strong></span></div>
        ${sessionInfo ? `<div>${sessionInfo}</div>` : ""}
        <div>RSI(14): ${rsiText} | MACD: ${macdText}${smaAlign ? ` | ${smaAlign}` : ""}</div>
      </div>

      <div class="font-semibold mb-2">📍 Mức giá kỹ thuật cần lưu ý</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div>
          <div class="text-red-500 font-semibold mb-1">▲ Cản phía trên</div>
          ${above.length === 0 ? `<div class="text-slate-500 italic">Không có data</div>` :
            above.map(l => `<div><span class="font-mono">$${fmt(l.price)}</span> <span class="text-slate-500">— ${escapeHtml(l.label)} <span class="text-slate-400">(+${fmt(l.price - c)})</span></span></div>`).join("")}
        </div>
        <div>
          <div class="text-green-500 font-semibold mb-1">▼ Đỡ phía dưới</div>
          ${below.length === 0 ? `<div class="text-slate-500 italic">Không có data</div>` :
            below.map(l => `<div><span class="font-mono">$${fmt(l.price)}</span> <span class="text-slate-500">— ${escapeHtml(l.label)} <span class="text-slate-400">(-${fmt(c - l.price)})</span></span></div>`).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderAnalysis() {
  const container = $("#analysis-results");
  const tfs = Object.keys(state.smcResults);

  if (tfs.length === 0) {
    container.innerHTML = `<div class="text-slate-500 text-sm">Bấm <strong>Phân tích SMC</strong> để bắt đầu.</div>`;
    if (state.quickResult) {
      container.innerHTML = "";
    }
  } else {
    container.innerHTML = "";
  }

  if (state.quickResult) {
    const div = document.createElement("div");
    div.className = "bg-blue-500/10 border-l-4 border-blue-500 p-4 rounded mb-4 whitespace-pre-line";
    div.innerHTML = `<div class="font-semibold mb-1">⚡ Quick scan</div><div class="text-sm">${escapeHtml(state.quickResult)}</div>`;
    container.appendChild(div);
  }

  if (tfs.length === 0) return;

  // Consensus
  const validResults = tfs.filter(t => !state.smcResults[t].error);
  if (validResults.length > 1) {
    const biases = validResults.map(t => state.smcResults[t].bias?.toLowerCase()).filter(Boolean);
    const counts = {};
    biases.forEach(b => counts[b] = (counts[b] || 0) + 1);
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const pct = (top[1] / biases.length) * 100;
      const icon = { bullish: "📈", bearish: "📉", sideways: "➡️" }[top[0]] || "❓";
      const banner = document.createElement("div");
      const cls = pct === 100 ? "bg-green-500/15 border-green-500" : pct >= 50 ? "bg-amber-500/15 border-amber-500" : "bg-red-500/15 border-red-500";
      banner.className = `${cls} border-l-4 p-4 rounded mb-4`;
      const msg = pct === 100
        ? `Đồng thuận 100%: ${icon} <strong>${top[0].toUpperCase()}</strong> trên ${biases.length} khung`
        : pct >= 50
        ? `Đa số: ${icon} <strong>${top[0].toUpperCase()}</strong> (${pct.toFixed(0)}%) — phân bố: ${Object.entries(counts).map(([k,v])=>`${v} ${k}`).join(", ")}`
        : `Phân vân — phân bố: ${Object.entries(counts).map(([k,v])=>`${v} ${k}`).join(", ")}`;
      banner.innerHTML = `<div class="font-semibold">🎯 ${msg}</div>`;
      container.appendChild(banner);
    }
  }

  // Per-TF panels
  tfs.forEach(t => {
    const result = state.smcResults[t];
    const card = document.createElement("div");
    card.className = "bg-slate-100 dark:bg-slate-800 rounded-lg p-4 mb-4";
    card.innerHTML = renderSmcCard(result, t);
    container.appendChild(card);
  });
}

function renderSmcCard(r, tf) {
  if (r.error) {
    return `<div class="text-red-500"><strong>Khung ${tf}:</strong> ${escapeHtml(r.error)}</div>`;
  }

  const bias = (r.bias || "N/A").toUpperCase();
  const biasIcon = { BULLISH: "📈", BEARISH: "📉", SIDEWAYS: "➡️" }[bias] || "❓";
  const biasColor = { BULLISH: "text-green-500", BEARISH: "text-red-500", SIDEWAYS: "text-slate-500" }[bias] || "";

  // Schema mới (3 tasks) — fallback các field cũ cho history legacy
  const t1 = r.task1_cau_truc_dong_luong || {};
  const t2 = r.task2_vung_can || {};
  const t3 = r.task3_ke_hoach || {};
  const sl = r.scenario_long || {};
  const ss = r.scenario_short || {};
  const risks = r.rui_ro_chinh || [];

  const bosChoch = t1.bos_choch || r.cau_truc_thi_truong || {};
  const phe = t1.phe_kiem_soat || "";
  const pheColor = phe.includes("mua") ? "text-green-500" : phe.includes("bán") ? "text-red-500" : "text-slate-500";

  // Helper render S/R level
  const renderLevels = (arr, label, color) => {
    if (!Array.isArray(arr) || arr.length === 0) return "";
    return arr.map(lv => {
      const gia = typeof lv === "object" ? lv.gia : lv;
      const note = typeof lv === "object" ? lv.ghi_chu : "";
      return `<div class="text-xs ${color}">• <strong>$${fmt(gia)}</strong>${note ? ` — ${escapeHtml(note)}` : ""}</div>`;
    }).join("");
  };

  const scenarioCard = (sc, label, icon) => {
    const ok = sc.kha_thi;
    const okBadge = ok ? "✅" : "❌";
    if (!ok) {
      return `<div class="border border-slate-300 dark:border-slate-700 rounded p-3">
        <div class="font-semibold">${icon} ${label} ${okBadge}</div>
        <div class="text-xs italic mt-1 text-slate-600 dark:text-slate-400">${escapeHtml(sc.ly_do || "Chưa thuận")}</div>
      </div>`;
    }
    const entry = sc.entry ?? sc.vung_vao_lenh ?? "";  // backward compat
    const tp = sc.take_profit ?? sc.target;
    const rr = sc.risk_reward;
    return `<div class="border border-slate-300 dark:border-slate-700 rounded p-3">
      <div class="flex items-center justify-between">
        <span class="font-semibold">${icon} ${label} ${okBadge}</span>
        ${rr != null ? `<span class="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-600 dark:text-blue-300 font-mono">R:R ${Number(rr).toFixed(2)}</span>` : ""}
      </div>
      <div class="text-xs mt-2"><strong>Entry:</strong> ${typeof entry === "number" ? `$${fmt(entry)}` : escapeHtml(String(entry))}</div>
      <div class="grid grid-cols-2 gap-2 mt-1 text-sm">
        <div class="text-red-500">SL: <strong>$${fmt(sc.stop_loss)}</strong></div>
        <div class="text-green-500">TP: <strong>$${fmt(tp)}</strong></div>
      </div>
      ${sc.dieu_kien_xac_nhan ? `<div class="text-xs mt-2"><strong>Confirm:</strong> ${escapeHtml(sc.dieu_kien_xac_nhan)}</div>` : ""}
      <div class="text-xs italic mt-2 text-slate-600 dark:text-slate-400">${escapeHtml(sc.ly_do || "")}</div>
    </div>`;
  };

  return `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-lg font-semibold">📊 Khung ${tf}</h3>
      <span class="${biasColor} font-semibold">${biasIcon} ${bias}</span>
    </div>

    <div class="bg-blue-500/10 border-l-4 border-blue-500 p-3 rounded text-sm mb-4">
      <strong>📋 Tóm tắt:</strong> ${escapeHtml(r.tom_tat || "")}
    </div>

    <!-- Task 1: Cấu trúc & Động lượng -->
    <div class="border border-slate-300 dark:border-slate-700 rounded p-3 mb-3">
      <div class="font-semibold mb-2">1️⃣ Cấu trúc & Động lượng</div>
      ${phe ? `<div class="text-sm mb-2">Phe kiểm soát: <strong class="${pheColor}">${escapeHtml(phe.toUpperCase())}</strong>${t1.ly_do_kiem_soat ? ` — <span class="text-slate-600 dark:text-slate-400">${escapeHtml(t1.ly_do_kiem_soat)}</span>` : ""}</div>` : ""}
      ${bosChoch.loai ? `<div class="text-xs mb-1">${escapeHtml(bosChoch.loai)} ${escapeHtml(bosChoch.huong || "")} tại <strong>$${fmt(bosChoch.muc_gia)}</strong></div>` : ""}
      ${t1.order_block_fvg ? `<div class="text-xs mb-1"><strong>OB/FVG:</strong> ${escapeHtml(t1.order_block_fvg)}</div>` : ""}
      ${t1.rsi_macd_signal ? `<div class="text-xs mb-1"><strong>RSI/MACD:</strong> ${escapeHtml(t1.rsi_macd_signal)}</div>` : ""}
      ${t1.phan_tich_dong_luong ? `<div class="text-xs italic text-slate-600 dark:text-slate-400">${escapeHtml(t1.phan_tich_dong_luong)}</div>` : ""}
    </div>

    <!-- Task 2: Vùng cản -->
    <div class="border border-slate-300 dark:border-slate-700 rounded p-3 mb-3">
      <div class="font-semibold mb-2">2️⃣ Vùng cản quan trọng</div>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm mb-2">
        <div>
          <div class="text-red-500 font-semibold mb-1">▲ Kháng cự</div>
          ${renderLevels(t2.khang_cu, "Kháng cự", "text-slate-700 dark:text-slate-300")}
        </div>
        <div>
          <div class="text-green-500 font-semibold mb-1">▼ Hỗ trợ</div>
          ${renderLevels(t2.ho_tro, "Hỗ trợ", "text-slate-700 dark:text-slate-300")}
        </div>
      </div>
      ${t2.fib_active ? `<div class="text-xs italic mt-2"><strong>Fib:</strong> ${escapeHtml(t2.fib_active)}</div>` : ""}
    </div>

    <!-- Task 3: Kế hoạch -->
    <div class="border border-slate-300 dark:border-slate-700 rounded p-3 mb-3">
      <div class="font-semibold mb-2">3️⃣ Kế hoạch giao dịch ${t3.horizon ? `<span class="text-xs font-normal text-slate-500">(horizon ${escapeHtml(t3.horizon)})</span>` : ""}</div>
      ${t3.kich_ban_chinh ? `<div class="text-sm mb-2">Kịch bản chính: <strong class="uppercase">${escapeHtml(t3.kich_ban_chinh)}</strong>${t3.ly_do_kich_ban ? ` — <span class="text-slate-600 dark:text-slate-400">${escapeHtml(t3.ly_do_kich_ban)}</span>` : ""}</div>` : ""}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${scenarioCard(sl, "LONG", "📈")}
        ${scenarioCard(ss, "SHORT", "📉")}
      </div>
    </div>

    ${risks.length > 0 ? `
      <div class="text-sm mb-2">
        <div class="font-semibold mb-1">⚠️ Rủi ro chính</div>
        <ul class="list-disc list-inside text-xs space-y-1">${risks.map(rk => `<li>${escapeHtml(rk)}</li>`).join("")}</ul>
      </div>` : ""}
    ${r.ghi_chu ? `<div class="text-xs italic mt-2 text-slate-500">📌 ${escapeHtml(r.ghi_chu)}</div>` : ""}
  `;
}

function renderHistory() {
  const container = $("#history-list");
  container.innerHTML = "";
  if (state.history.length === 0) {
    container.innerHTML = `<div class="text-slate-500 text-sm">Chưa có lịch sử.</div>`;
    return;
  }
  state.history.slice(0, 20).forEach((h, i) => {
    const div = document.createElement("div");
    div.className = "border-b border-slate-300 dark:border-slate-700 py-2 text-sm";
    const t = new Date(h.ts).toLocaleString("vi-VN");
    const biasIcon = { bullish: "📈", bearish: "📉", sideways: "➡️" }[h.bias?.toLowerCase()] || "❓";
    div.innerHTML = `
      <div class="flex justify-between items-center">
        <span>${t} • ${h.tf} • ${biasIcon} <strong>${h.bias?.toUpperCase() || "?"}</strong></span>
        <button data-idx="${i}" class="restore-btn text-blue-500 text-xs hover:underline">Xem lại</button>
      </div>
      <div class="text-xs text-slate-500 truncate">${escapeHtml(h.tom_tat || "")}</div>
    `;
    container.appendChild(div);
  });
  $$(".restore-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      const h = state.history[idx];
      state.smcResults = { [h.tf]: h.full };
      renderAnalysis();
      window.scrollTo({ top: $("#analysis-section").offsetTop, behavior: "smooth" });
    });
  });
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showError(msg) {
  const el = $("#error-banner");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 6000);
}

function saveHistory(tf, result) {
  if (!result || result.error) return;
  state.history.unshift({
    ts: Date.now(),
    tf,
    bias: result.bias,
    tom_tat: result.tom_tat,
    full: result,
  });
  state.history = state.history.slice(0, 50); // giữ 50 bản gần nhất
  localStorage.setItem("xau_history", JSON.stringify(state.history));
  renderHistory();
}

// ============================================================
// EVENT HANDLERS
// ============================================================
async function onTimeframeChange(newTf) {
  if (state.tf === newTf) return;
  state.tf = newTf;
  $$(".tf-btn").forEach(b => {
    b.classList.toggle("bg-blue-600", b.dataset.tf === newTf);
    b.classList.toggle("text-white", b.dataset.tf === newTf);
  });
  setLoading(true, `Đang tải data khung ${newTf}...`);
  try {
    state.candles = await loadTfData(newTf);
    render();
  } catch (e) {
    showError(`Lỗi: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

function onAnalysisTfsChange() {
  state.analysisTfs = $$(".analysis-tf-cb:checked").map(cb => cb.value);
  if (state.analysisTfs.length === 0) state.analysisTfs = [state.tf];
}

async function onFullAnalysis() {
  const tfs = state.analysisTfs;
  if (tfs.length === 0) return;
  setLoading(true, `Đang phân tích SMC trên ${tfs.length} khung song song...`);
  state.smcResults = {};
  state.quickResult = null;

  try {
    const newsBlock = formatNewsForPrompt(state.news, 8);
    // Stagger 400ms giữa các call để tránh Gemini overload heuristics + free tier RPM
    const jobs = await Promise.all(tfs.map(async (t, i) => {
      if (i > 0) await new Promise(r => setTimeout(r, i * 400));
      const candles = await loadTfData(t);
      const latest = candles[candles.length - 1];
      const zones = calculateZones(latest);
      const cc = state.spot ? { twelvedata: state.spot } : null;
      return analyzeSmc(latest, zones, candles, t, cc, newsBlock).then(r => [t, r]);
    }));
    jobs.forEach(([t, r]) => {
      state.smcResults[t] = r;
      saveHistory(t, r);
    });
    renderAnalysis();
  } catch (e) {
    showError(`Lỗi phân tích: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

async function onQuickScan() {
  if (!state.candles || state.candles.length === 0) return;
  setLoading(true, "Quick scan với Gemini...");
  try {
    const latest = state.candles[state.candles.length - 1];
    const zones = calculateZones(latest);
    state.quickResult = await quickScan(latest, zones);
    renderAnalysis();
  } catch (e) {
    showError(`Lỗi: ${e.message}`);
  } finally {
    setLoading(false);
  }
}

function onClearResults() {
  state.smcResults = {};
  state.quickResult = null;
  renderAnalysis();
}

function onClearHistory() {
  if (!confirm("Xoá toàn bộ lịch sử phân tích?")) return;
  state.history = [];
  localStorage.removeItem("xau_history");
  renderHistory();
}

// ============================================================
// INIT
// ============================================================
function buildTimeframeButtons() {
  const container = $("#tf-buttons");
  container.innerHTML = "";
  TIMEFRAMES.forEach(tf => {
    const btn = document.createElement("button");
    btn.dataset.tf = tf;
    btn.textContent = tf;
    btn.className = "tf-btn px-3 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700";
    if (tf === state.tf) {
      btn.classList.add("bg-blue-600", "text-white");
    }
    btn.addEventListener("click", () => onTimeframeChange(tf));
    container.appendChild(btn);
  });
}

function buildAnalysisTfCheckboxes() {
  const container = $("#analysis-tfs");
  container.innerHTML = "";
  TIMEFRAMES.forEach(tf => {
    const id = `atf-${tf}`;
    const wrapper = document.createElement("label");
    wrapper.className = "inline-flex items-center gap-1 text-sm";
    wrapper.innerHTML = `
      <input type="checkbox" id="${id}" class="analysis-tf-cb" value="${tf}" ${tf === state.tf ? "checked" : ""}>
      <span>${tf}</span>
    `;
    container.appendChild(wrapper);
  });
  $$(".analysis-tf-cb").forEach(cb => cb.addEventListener("change", onAnalysisTfsChange));
}

async function init() {
  setTheme(state.theme);

  buildTimeframeButtons();
  buildAnalysisTfCheckboxes();

  $("#theme-toggle").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));
  $("#refresh-btn").addEventListener("click", refreshAll);
  $("#pivot-toggle").addEventListener("click", onTogglePivot);
  updatePivotButton();
  $("#full-analysis-btn").addEventListener("click", onFullAnalysis);
  $("#quick-scan-btn").addEventListener("click", onQuickScan);
  $("#clear-results-btn").addEventListener("click", onClearResults);
  $("#clear-history-btn").addEventListener("click", onClearHistory);

  initChart($("#chart-container"));
  window.addEventListener("resize", resizeChart);

  await refreshAll();
}

document.addEventListener("DOMContentLoaded", init);

// Register PWA service worker (chỉ khi served qua http/https)
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js")
      .then(reg => console.log("SW registered:", reg.scope))
      .catch(err => console.warn("SW failed:", err));
  });
}
