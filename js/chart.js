// ============================================================
// Chart manager — 2 panes synced (price+RSI sub-pane + MACD)
// ============================================================
// Dùng TradingView Lightweight Charts v4. RSI lồng vào priceChart
// qua leftPriceScale (sub-pane). MACD pane riêng, sync time scale.
//
// Globals: window.LightweightCharts (CDN trong index.html)
import { computeFib, detectCrosses } from "./indicators.js";

// Số nến hiển thị mặc định — nhỏ hơn = candle to hơn (matching user preference).
const DEFAULT_VISIBLE_BARS = 70;

// Format tick time axis theo TF — 1d ẩn giờ phút, intraday hiện giờ:phút.
function makeTickFormatter(tf) {
  // TickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  const pad = n => String(n).padStart(2, "0");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return (time, tickMarkType) => {
    const d = new Date(time * 1000);
    const dateStr = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
    const timeStr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    if (tickMarkType === 0) return String(d.getUTCFullYear());
    if (tickMarkType === 1) return MONTHS[d.getUTCMonth()];
    if (tickMarkType === 2) return dateStr;
    // Time ticks — 1d không cần giờ
    return tf === "1d" ? dateStr : timeStr;
  };
}

let priceChart = null, macdChart = null;
let candleSeries;
let ema9Series, ema21Series, ema50Series, ema200Series;
let sma50Series, sma200Series;
let bbUpperSeries, bbMiddleSeries, bbLowerSeries;
let rsiSeries;  // attached vào priceChart, dùng leftPriceScale
let macdLineSeries, macdSignalSeries, macdHistSeries;

// Fibonacci priceLines — track để xóa khi update
let fibPriceLines = [];
// Pivot priceLines — track riêng, toggle on/off
let pivotPriceLines = [];

// Flag chống loop khi sync visible range giữa các chart
let isSyncingRange = false;

function getThemeColors() {
  const isDark = document.documentElement.classList.contains("dark");
  return {
    isDark,
    bg: isDark ? "#0f172a" : "#ffffff",
    text: isDark ? "#cbd5e1" : "#1e293b",
    grid: isDark ? "#1e293b" : "#e2e8f0",
    border: isDark ? "#334155" : "#cbd5e1",
  };
}

function commonOptions(c, { showTimeAxis = true } = {}) {
  return {
    layout: {
      background: { color: c.bg },
      textColor: c.text,
    },
    grid: {
      vertLines: { color: c.grid },
      horzLines: { color: c.grid },
    },
    timeScale: {
      timeVisible: showTimeAxis,
      secondsVisible: false,
      borderColor: c.border,
      visible: showTimeAxis,
    },
    rightPriceScale: { borderColor: c.border },
    crosshair: { mode: 0 },
    autoSize: true,
  };
}

/**
 * Init 2 charts: priceChart (candles + EMAs + BB + RSI sub-pane) + macdChart.
 */
export function initChart(_container) {
  // Cleanup chart cũ nếu có (idempotent)
  [priceChart, macdChart].forEach(ch => ch && ch.remove());

  const c = getThemeColors();
  const priceEl = document.getElementById("chart-container");
  const macdEl = document.getElementById("macd-container");

  // ── Price chart: 2 priceScales
  //   - Right scale: candles + EMAs + BB → chiếm 70% trên (margins top 5%, bottom 30%)
  //   - Left scale:  RSI                 → chiếm 25% dưới (margins top 75%, bottom 5%)
  priceChart = LightweightCharts.createChart(priceEl, {
    ...commonOptions(c, { showTimeAxis: false }),
    leftPriceScale: {
      visible: true,
      borderColor: c.border,
      scaleMargins: { top: 0.75, bottom: 0.05 },
    },
    rightPriceScale: {
      visible: true,
      borderColor: c.border,
      scaleMargins: { top: 0.05, bottom: 0.30 },
    },
  });

  candleSeries = priceChart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#ef4444",
    borderUpColor: "#22c55e", borderDownColor: "#ef4444",
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    priceScaleId: "right",
  });
  // Fast EMAs (short-term) — vàng nhạy biến động
  ema9Series   = priceChart.addLineSeries({ color: "#fde68a", lineWidth: 1, title: "EMA 9",   priceScaleId: "right" });
  ema21Series  = priceChart.addLineSeries({ color: "#ec4899", lineWidth: 1, title: "EMA 21",  priceScaleId: "right" });
  // Medium/long-term EMAs (EMA 20 vẫn compute trong indicators để dùng metric card, không vẽ trên chart vì gần trùng EMA 21)
  ema50Series  = priceChart.addLineSeries({ color: "#f97316", lineWidth: 1, title: "EMA 50",  priceScaleId: "right" });
  ema200Series = priceChart.addLineSeries({ color: "#a855f7", lineWidth: 2, title: "EMA 200", priceScaleId: "right" });
  // SMA 50/200 — golden cross visualization (dashed, mờ hơn EMAs)
  sma50Series  = priceChart.addLineSeries({ color: "rgba(253,186,116,0.7)", lineWidth: 1, lineStyle: 2, title: "SMA 50",  priceScaleId: "right" });
  sma200Series = priceChart.addLineSeries({ color: "rgba(196,181,253,0.7)", lineWidth: 1, lineStyle: 2, title: "SMA 200", priceScaleId: "right" });
  // BB(20, 2) — line solid cyan rõ ràng để detect breakout, middle là SMA20 dashed
  bbUpperSeries  = priceChart.addLineSeries({ color: "rgba(34,211,238,0.85)", lineWidth: 1, lineStyle: 0, title: "BB Upper",  priceScaleId: "right" });
  bbMiddleSeries = priceChart.addLineSeries({ color: "rgba(34,211,238,0.55)", lineWidth: 1, lineStyle: 2, title: "BB Mid (SMA20)", priceScaleId: "right" });
  bbLowerSeries  = priceChart.addLineSeries({ color: "rgba(34,211,238,0.85)", lineWidth: 1, lineStyle: 0, title: "BB Lower",  priceScaleId: "right" });

  // RSI vào left scale — sub-pane phía dưới của priceChart
  rsiSeries = priceChart.addLineSeries({
    priceScaleId: "left",
    color: "#fb923c", lineWidth: 1, title: "RSI(14)",
  });
  rsiSeries.createPriceLine({ price: 70, color: "#ef4444", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
  rsiSeries.createPriceLine({ price: 50, color: c.grid,    lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
  rsiSeries.createPriceLine({ price: 30, color: "#22c55e", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });

  // ── MACD chart riêng (pane cuối, có time axis) ──
  macdChart = LightweightCharts.createChart(macdEl, commonOptions(c, { showTimeAxis: true }));
  macdHistSeries = macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
  macdLineSeries = macdChart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "MACD" });
  macdSignalSeries = macdChart.addLineSeries({ color: "#fb923c", lineWidth: 1, title: "Signal" });

  // Sync visible range giữa price + macd
  syncTimeScale([priceChart, macdChart]);

  return priceChart;
}

function syncTimeScale(charts) {
  charts.forEach(source => {
    source.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (isSyncingRange || !range) return;
      isSyncingRange = true;
      try {
        charts.forEach(target => {
          if (target !== source) {
            target.timeScale().setVisibleLogicalRange(range);
          }
        });
      } finally {
        isSyncingRange = false;
      }
    });
  });
}

/**
 * Cập nhật toàn bộ data lên 3 charts.
 * @param {Array} candles
 * @param {string} tf - timeframe để chọn time axis formatter
 */
export function updateChart(candles, tf = "15m") {
  if (!priceChart || !candleSeries) return;
  if (!candles || candles.length === 0) return;

  // Apply tickMarkFormatter cho macdChart (chart duy nhất hiện time axis).
  // applyOptions có thể gọi mỗi lần update — Lightweight Charts re-render axis hiệu quả.
  if (macdChart) {
    macdChart.applyOptions({
      timeScale: { tickMarkFormatter: makeTickFormatter(tf) },
    });
  }

  // ── Price ──
  candleSeries.setData(candles.map(c => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  })));
  ema9Series.setData(candles.filter(c => c.ema9 != null).map(c => ({ time: c.time, value: c.ema9 })));
  ema21Series.setData(candles.filter(c => c.ema21 != null).map(c => ({ time: c.time, value: c.ema21 })));
  ema50Series.setData(candles.filter(c => c.ema50 != null).map(c => ({ time: c.time, value: c.ema50 })));
  ema200Series.setData(candles.filter(c => c.ema200 != null).map(c => ({ time: c.time, value: c.ema200 })));
  sma50Series.setData(candles.filter(c => c.sma50 != null).map(c => ({ time: c.time, value: c.sma50 })));
  sma200Series.setData(candles.filter(c => c.sma200 != null).map(c => ({ time: c.time, value: c.sma200 })));
  bbUpperSeries.setData(candles.filter(c => c.bbUpper != null).map(c => ({ time: c.time, value: c.bbUpper })));
  bbMiddleSeries.setData(candles.filter(c => c.bbMiddle != null).map(c => ({ time: c.time, value: c.bbMiddle })));
  bbLowerSeries.setData(candles.filter(c => c.bbLower != null).map(c => ({ time: c.time, value: c.bbLower })));

  // ── Markers: BB breakout + Golden/Death Cross ──
  const markers = [];
  // BB breakout
  for (const c of candles) {
    if (c.bbUpper == null || c.bbLower == null) continue;
    if (c.close > c.bbUpper) {
      markers.push({ time: c.time, position: "aboveBar", color: "#ef4444", shape: "arrowDown", text: "BB↑" });
    } else if (c.close < c.bbLower) {
      markers.push({ time: c.time, position: "belowBar", color: "#22c55e", shape: "arrowUp", text: "BB↓" });
    }
  }
  // Golden Cross / Death Cross (SMA 50 cross SMA 200)
  for (const x of detectCrosses(candles)) {
    if (x.type === "golden") {
      markers.push({ time: x.time, position: "belowBar", color: "#facc15", shape: "circle", text: "★ GC" });
    } else {
      markers.push({ time: x.time, position: "aboveBar", color: "#dc2626", shape: "circle", text: "✖ DC" });
    }
  }
  // setMarkers yêu cầu sort theo time ascending
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);

  // ── Fibonacci retracement (auto từ swing 50 nến gần nhất) ──
  fibPriceLines.forEach(line => candleSeries.removePriceLine(line));
  fibPriceLines = [];
  const fib = computeFib(candles, 50);
  if (fib) {
    for (const { level, price } of fib.levels) {
      const line = candleSeries.createPriceLine({
        price,
        color: "rgba(217,70,239,0.55)",   // magenta dotted để phân biệt với EMA/BB
        lineWidth: 1,
        lineStyle: 1, // dotted
        title: `Fib ${(level * 100).toFixed(1)}%`,
        axisLabelVisible: true,
      });
      fibPriceLines.push(line);
    }
  }

  // ── RSI ──
  rsiSeries.setData(candles.filter(c => c.rsi != null).map(c => ({ time: c.time, value: c.rsi })));

  // ── MACD ──
  macdLineSeries.setData(
    candles.filter(c => c.macd != null).map(c => ({ time: c.time, value: c.macd }))
  );
  macdSignalSeries.setData(
    candles.filter(c => c.macdSignal != null).map(c => ({ time: c.time, value: c.macdSignal }))
  );
  // Histogram = macd - signal, màu xanh nếu > 0, đỏ nếu < 0
  macdHistSeries.setData(
    candles
      .filter(c => c.macd != null && c.macdSignal != null)
      .map(c => {
        const v = c.macd - c.macdSignal;
        return {
          time: c.time,
          value: v,
          color: v >= 0 ? "rgba(34,197,94,0.7)" : "rgba(239,68,68,0.7)",
        };
      })
  );

  // Zoom mặc định: N nến cuối (sync sẽ lan sang RSI/MACD chart)
  const total = candles.length;
  const from = Math.max(0, total - DEFAULT_VISIBLE_BARS);
  priceChart.timeScale().setVisibleLogicalRange({ from, to: total - 1 });
}

export function resizeChart() {
  // autoSize=true tự handle width. Giữ nguyên zoom user đang xem.
}

/**
 * Helper: vẽ N priceLines song song giữa low-high → mô phỏng dải màu mờ.
 * (Lightweight Charts v4 không có rectangle/band primitive, dùng multi-line workaround.)
 */
function drawBand(low, high, color, count = 6) {
  const lines = [];
  if (!candleSeries || high <= low) return lines;
  for (let i = 1; i < count; i++) {
    const price = low + (high - low) * (i / count);
    lines.push(candleSeries.createPriceLine({
      price, color,
      lineWidth: 2, lineStyle: 0,
      title: "", axisLabelVisible: false,
    }));
  }
  return lines;
}

/**
 * Toggle Pivot Point lines + bands trên price chart.
 * Layout:
 *   ─── R2 (rose đậm)
 *   ▒▒▒ resistance band (rose mờ)        ← R1-R2 zone
 *   ─── R1 (rose nhạt)
 *   ─── PP (vàng)
 *   ─── S1 (teal nhạt)
 *   ▒▒▒ support band (teal mờ)           ← S1-S2 zone
 *   ─── S2 (teal đậm)
 *
 * @param {object|null} pivots - { pp, r1, r2, s1, s2 } hoặc null để xóa
 */
export function setPivots(pivots) {
  pivotPriceLines.forEach(line => candleSeries && candleSeries.removePriceLine(line));
  pivotPriceLines = [];
  if (!pivots || !candleSeries) return;

  // ── Bands (nền — vẽ trước, mờ, không label) ──
  // Resistance R1↔R2: rose mờ
  pivotPriceLines.push(...drawBand(pivots.r1, pivots.r2, "rgba(244, 63, 94, 0.13)", 6));
  // Support S1↔S2: teal mờ
  pivotPriceLines.push(...drawBand(pivots.s2, pivots.s1, "rgba(20, 184, 166, 0.13)", 6));

  // ── Main pivot lines (lineWidth 3, full opacity, label rõ) ──
  const styles = [
    { key: "r2", label: "▲ R2", color: "#f43f5e" },   // rose 500
    { key: "r1", label: "▲ R1", color: "#fb7185" },   // rose 400
    { key: "pp", label: "◆ PP", color: "#fde047" },   // yellow 300 — sáng nhất
    { key: "s1", label: "▼ S1", color: "#5eead4" },   // teal 300
    { key: "s2", label: "▼ S2", color: "#14b8a6" },   // teal 500
  ];
  for (const { key, label, color } of styles) {
    pivotPriceLines.push(candleSeries.createPriceLine({
      price: pivots[key],
      color,
      lineWidth: 3,
      lineStyle: 0,
      title: label,
      axisLabelVisible: true,
    }));
  }
}
