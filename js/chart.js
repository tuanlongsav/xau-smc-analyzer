// ============================================================
// Chart manager — 3 panes synced (price + RSI + MACD)
// ============================================================
// Dùng TradingView Lightweight Charts v4. v4 không có native panes,
// nên tạo 3 chart instance riêng và sync timeScale + crosshair.
//
// Globals: window.LightweightCharts (CDN trong index.html)

// 100 nến cuối — candle to hơn, dễ đọc.
const DEFAULT_VISIBLE_BARS = 100;

let priceChart = null, rsiChart = null, macdChart = null;
let candleSeries, ema20Series, ema50Series, ema200Series, bbUpperSeries, bbLowerSeries;
let rsiSeries;
let macdLineSeries, macdSignalSeries, macdHistSeries;

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
 * Init 3 charts.
 * @param {HTMLElement} _container - kept for backward compat (unused; ta dùng query selectors)
 */
export function initChart(_container) {
  // Cleanup chart cũ nếu có (idempotent)
  [priceChart, rsiChart, macdChart].forEach(c => c && c.remove());

  const c = getThemeColors();
  const priceEl = document.getElementById("chart-container");
  const rsiEl = document.getElementById("rsi-container");
  const macdEl = document.getElementById("macd-container");

  // ── Price chart (candles + EMAs + BB) — chart trên cùng, không hiện time axis (RSI/MACD dưới sẽ hiện) ──
  priceChart = LightweightCharts.createChart(priceEl, commonOptions(c, { showTimeAxis: false }));
  candleSeries = priceChart.addCandlestickSeries({
    upColor: "#22c55e", downColor: "#ef4444",
    borderUpColor: "#22c55e", borderDownColor: "#ef4444",
    wickUpColor: "#22c55e", wickDownColor: "#ef4444",
  });
  ema20Series  = priceChart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "EMA 20" });
  ema50Series  = priceChart.addLineSeries({ color: "#f97316", lineWidth: 1, title: "EMA 50" });
  ema200Series = priceChart.addLineSeries({ color: "#a855f7", lineWidth: 2, title: "EMA 200" });
  bbUpperSeries = priceChart.addLineSeries({ color: "rgba(148,163,184,0.6)", lineWidth: 1, lineStyle: 2, title: "BB Upper" });
  bbLowerSeries = priceChart.addLineSeries({ color: "rgba(148,163,184,0.6)", lineWidth: 1, lineStyle: 2, title: "BB Lower" });

  // ── RSI chart ──
  rsiChart = LightweightCharts.createChart(rsiEl, {
    ...commonOptions(c, { showTimeAxis: false }),
    rightPriceScale: { borderColor: c.border, autoScale: false, mode: 0 },
  });
  rsiSeries = rsiChart.addLineSeries({ color: "#fb923c", lineWidth: 1, title: "RSI(14)" });
  // Reference 30/70
  rsiSeries.createPriceLine({ price: 70, color: "#ef4444", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
  rsiSeries.createPriceLine({ price: 50, color: c.grid,   lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
  rsiSeries.createPriceLine({ price: 30, color: "#22c55e", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });

  // ── MACD chart (line + signal + histogram) — pane cuối có time axis ──
  macdChart = LightweightCharts.createChart(macdEl, commonOptions(c, { showTimeAxis: true }));
  macdHistSeries = macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
  macdLineSeries = macdChart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "MACD" });
  macdSignalSeries = macdChart.addLineSeries({ color: "#fb923c", lineWidth: 1, title: "Signal" });

  // Sync visible range giữa 3 charts
  syncTimeScale([priceChart, rsiChart, macdChart]);

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
 */
export function updateChart(candles) {
  if (!priceChart || !candleSeries) return;
  if (!candles || candles.length === 0) return;

  // ── Price ──
  candleSeries.setData(candles.map(c => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  })));
  ema20Series.setData(candles.filter(c => c.ema20 != null).map(c => ({ time: c.time, value: c.ema20 })));
  ema50Series.setData(candles.filter(c => c.ema50 != null).map(c => ({ time: c.time, value: c.ema50 })));
  ema200Series.setData(candles.filter(c => c.ema200 != null).map(c => ({ time: c.time, value: c.ema200 })));
  bbUpperSeries.setData(candles.filter(c => c.bbUpper != null).map(c => ({ time: c.time, value: c.bbUpper })));
  bbLowerSeries.setData(candles.filter(c => c.bbLower != null).map(c => ({ time: c.time, value: c.bbLower })));

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
