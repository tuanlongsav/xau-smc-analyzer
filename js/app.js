// ============================================================
// XAU/USD SMC Analyzer — main UI logic
// ============================================================
import { fetchSpot, fetchOHLCV, TF_TO_TD } from "./data.js";
import { computeIndicators, calculateZones, detectAlerts } from "./indicators.js";
import { analyzeSmc, quickScan } from "./gemini.js";
import { initChart, updateChart, resizeChart } from "./chart.js";

// ============================================================
// STATE
// ============================================================
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"];
const TF_LABELS = { "5m": "5 phút", "15m": "15 phút", "1h": "1 giờ", "4h": "4 giờ", "1d": "1 ngày" };

const state = {
  tf: "1h",
  analysisTfs: ["1h"],
  candles: [],
  candlesByTf: {},   // cache OHLCV theo tf
  spot: null,
  smcResults: {},    // { tf: result }
  quickResult: null,
  loading: false,
  history: JSON.parse(localStorage.getItem("xau_history") || "[]"),
  theme: localStorage.getItem("xau_theme") || "dark",
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
  const tdInterval = TF_TO_TD[tf];
  const raw = await fetchOHLCV(tdInterval);
  const withInd = computeIndicators(raw);
  state.candlesByTf[tf] = withInd;
  return withInd;
}

async function refreshAll() {
  setLoading(true, "Đang tải data từ TwelveData...");
  try {
    // Clear cache để fetch lại
    state.candlesByTf = {};
    const [candles, spot] = await Promise.all([
      loadTfData(state.tf),
      fetchSpot().catch(() => null),
    ]);
    state.candles = candles;
    state.spot = spot;
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
}

function renderChart() {
  updateChart(state.candles);
}

function renderAlerts() {
  const candles = state.candles;
  const container = $("#alerts");
  container.innerHTML = "";
  if (!candles || candles.length < 2) return;
  const latest = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const alerts = detectAlerts(latest, prev);
  if (alerts.length === 0) {
    container.innerHTML = `<div class="text-slate-500 text-sm">Không có cảnh báo rule-based.</div>`;
    return;
  }
  alerts.forEach(a => {
    const div = document.createElement("div");
    div.className = "alert-item bg-amber-500/10 border-l-4 border-amber-500 p-3 rounded text-sm";
    div.textContent = a;
    container.appendChild(div);
  });
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

  const ms = r.cau_truc_thi_truong || {};
  const ob = r.order_block || {};
  const fvg = r.fvg_gan_nhat || {};
  const sl = r.scenario_long || {};
  const ss = r.scenario_short || {};
  const risks = r.rui_ro_chinh || [];

  const scenarioCard = (sc, label, icon) => {
    const ok = sc.kha_thi;
    const okBadge = ok ? "✅" : "❌";
    const body = ok
      ? `<div class="text-xs mt-1"><strong>Vào:</strong> ${escapeHtml(sc.vung_vao_lenh || "")}</div>
         <div class="grid grid-cols-2 gap-2 mt-2 text-sm">
           <div>SL: <strong>$${fmt(sc.stop_loss)}</strong></div>
           <div>TP: <strong>$${fmt(sc.target)}</strong></div>
         </div>
         <div class="text-xs italic mt-2 text-slate-600 dark:text-slate-400">${escapeHtml(sc.ly_do || "")}</div>`
      : `<div class="text-xs italic mt-1 text-slate-600 dark:text-slate-400">${escapeHtml(sc.ly_do || "Chưa thuận")}</div>`;
    return `<div class="border border-slate-300 dark:border-slate-700 rounded p-3">
              <div class="font-semibold">${icon} ${label} ${okBadge}</div>
              ${body}
            </div>`;
  };

  return `
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-lg font-semibold">📊 Khung ${tf}</h3>
      <span class="${biasColor} font-semibold">${biasIcon} ${bias}</span>
    </div>
    <div class="bg-blue-500/10 border-l-4 border-blue-500 p-3 rounded text-sm mb-3">
      <strong>📋 Tóm tắt:</strong> ${escapeHtml(r.tom_tat || "")}
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 text-sm">
      <div class="border border-slate-300 dark:border-slate-700 rounded p-3">
        <div class="font-semibold">Market Structure: ${escapeHtml(ms.loai || "N/A")}</div>
        ${ms.muc_gia ? `<div class="text-xs mt-1">Mốc: <strong>$${fmt(ms.muc_gia)}</strong> (${escapeHtml(ms.huong || "")})</div>` : ""}
        ${ms.ghi_chu ? `<div class="text-xs italic mt-1 text-slate-500">${escapeHtml(ms.ghi_chu)}</div>` : ""}
      </div>
      <div class="border border-slate-300 dark:border-slate-700 rounded p-3">
        <div class="font-semibold">Order Block: ${escapeHtml(ob.loai || "N/A")}</div>
        ${ob.vung_thap && ob.vung_cao ? `<div class="text-xs mt-1">Vùng: <strong>$${fmt(ob.vung_thap)} – $${fmt(ob.vung_cao)}</strong></div>` : ""}
        ${ob.ghi_chu ? `<div class="text-xs italic mt-1 text-slate-500">${escapeHtml(ob.ghi_chu)}</div>` : ""}
      </div>
      <div class="border border-slate-300 dark:border-slate-700 rounded p-3">
        <div class="font-semibold">FVG gần nhất: ${escapeHtml(fvg.loai || "N/A")}</div>
        ${fvg.vung_thap && fvg.vung_cao ? `<div class="text-xs mt-1">Vùng: <strong>$${fmt(fvg.vung_thap)} – $${fmt(fvg.vung_cao)}</strong></div>` : ""}
      </div>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
      ${scenarioCard(sl, "LONG", "📈")}
      ${scenarioCard(ss, "SHORT", "📉")}
    </div>
    ${risks.length > 0 ? `
      <div class="text-sm">
        <div class="font-semibold mb-1">⚠️ Rủi ro chính</div>
        <ul class="list-disc list-inside text-xs space-y-1">${risks.map(rk => `<li>${escapeHtml(rk)}</li>`).join("")}</ul>
      </div>` : ""}
    ${r.ghi_chu ? `<div class="text-xs italic mt-3 text-slate-500">📌 ${escapeHtml(r.ghi_chu)}</div>` : ""}
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
    const jobs = await Promise.all(tfs.map(async (t) => {
      const candles = await loadTfData(t);
      const latest = candles[candles.length - 1];
      const zones = calculateZones(latest);
      const cc = state.spot ? { twelvedata: state.spot } : null;
      return analyzeSmc(latest, zones, candles, t, cc).then(r => [t, r]);
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
  $("#full-analysis-btn").addEventListener("click", onFullAnalysis);
  $("#quick-scan-btn").addEventListener("click", onQuickScan);
  $("#clear-results-btn").addEventListener("click", onClearResults);
  $("#clear-history-btn").addEventListener("click", onClearHistory);

  initChart($("#chart-container"));
  window.addEventListener("resize", resizeChart);

  await refreshAll();
}

document.addEventListener("DOMContentLoaded", init);
