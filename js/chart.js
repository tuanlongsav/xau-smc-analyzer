// ============================================================
// Chart manager — TradingView Lightweight Charts wrapper
// ============================================================
//
// Globals: window.LightweightCharts (loaded từ CDN trong index.html)

// Mặc định hiển thị 150 nến cuối — đủ context nhưng candle to, dễ đọc.
// User vẫn scroll/zoom-out để xem toàn bộ history (1000 candles).
const DEFAULT_VISIBLE_BARS = 150;

let chart = null;
let candleSeries = null;
let ema20Series = null;
let ema50Series = null;
let ema200Series = null;
let bbUpperSeries = null;
let bbLowerSeries = null;

/**
 * Init chart vào container element. Idempotent.
 */
export function initChart(container) {
  if (chart) {
    chart.remove();
    chart = null;
  }

  const isDark = document.documentElement.classList.contains("dark");
  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { color: isDark ? "#0f172a" : "#ffffff" },
      textColor: isDark ? "#cbd5e1" : "#1e293b",
    },
    grid: {
      vertLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
      horzLines: { color: isDark ? "#1e293b" : "#e2e8f0" },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      borderColor: isDark ? "#334155" : "#cbd5e1",
    },
    rightPriceScale: {
      borderColor: isDark ? "#334155" : "#cbd5e1",
    },
    crosshair: { mode: 0 },
    autoSize: true,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444",
  });

  ema20Series = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "EMA 20" });
  ema50Series = chart.addLineSeries({ color: "#f97316", lineWidth: 1, title: "EMA 50" });
  ema200Series = chart.addLineSeries({ color: "#a855f7", lineWidth: 2, title: "EMA 200" });
  bbUpperSeries = chart.addLineSeries({
    color: "rgba(148,163,184,0.5)", lineWidth: 1, lineStyle: 2, title: "BB Upper",
  });
  bbLowerSeries = chart.addLineSeries({
    color: "rgba(148,163,184,0.5)", lineWidth: 1, lineStyle: 2, title: "BB Lower",
  });

  return chart;
}

/**
 * Cập nhật toàn bộ data lên chart.
 */
export function updateChart(candlesWithIndicators) {
  if (!chart || !candleSeries) return;
  if (!candlesWithIndicators || candlesWithIndicators.length === 0) return;

  candleSeries.setData(candlesWithIndicators.map(c => ({
    time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
  })));

  const ema20Data = candlesWithIndicators
    .filter(c => c.ema20 != null)
    .map(c => ({ time: c.time, value: c.ema20 }));
  ema20Series.setData(ema20Data);

  const ema50Data = candlesWithIndicators
    .filter(c => c.ema50 != null)
    .map(c => ({ time: c.time, value: c.ema50 }));
  ema50Series.setData(ema50Data);

  const ema200Data = candlesWithIndicators
    .filter(c => c.ema200 != null)
    .map(c => ({ time: c.time, value: c.ema200 }));
  ema200Series.setData(ema200Data);

  const bbU = candlesWithIndicators.filter(c => c.bbUpper != null)
    .map(c => ({ time: c.time, value: c.bbUpper }));
  bbUpperSeries.setData(bbU);

  const bbL = candlesWithIndicators.filter(c => c.bbLower != null)
    .map(c => ({ time: c.time, value: c.bbLower }));
  bbLowerSeries.setData(bbL);

  // Zoom vào N nến cuối thay vì fitContent (1000 nến → mỗi nến tí hon).
  const total = candlesWithIndicators.length;
  const from = Math.max(0, total - DEFAULT_VISIBLE_BARS);
  chart.timeScale().setVisibleLogicalRange({ from, to: total - 1 });
}

export function resizeChart() {
  // Khi resize window, GIỮ nguyên zoom state user đang xem (không reset về 150 cuối).
  // Lightweight Charts với autoSize tự handle width, không cần làm gì.
}
