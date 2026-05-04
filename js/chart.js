// ============================================================
// Chart manager — 3 panes synced (price + RSI + MACD)
// ============================================================
// Dùng TradingView Lightweight Charts v4. v4 không có native panes,
// nên tạo 3 chart instance riêng và sync timeScale + crosshair.
//
// Globals: window.LightweightCharts (CDN trong index.html)

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
let candleSeries, ema20Series, ema50Series, ema200Series;
let bbUpperSeries, bbMiddleSeries, bbLowerSeries;
let rsiSeries;  // attached vào priceChart, dùng leftPriceScale
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
  ema20Series  = priceChart.addLineSeries({ color: "#3b82f6", lineWidth: 1, title: "EMA 20",  priceScaleId: "right" });
  ema50Series  = priceChart.addLineSeries({ color: "#f97316", lineWidth: 1, title: "EMA 50",  priceScaleId: "right" });
  ema200Series = priceChart.addLineSeries({ color: "#a855f7", lineWidth: 2, title: "EMA 200", priceScaleId: "right" });
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
  ema20Series.setData(candles.filter(c => c.ema20 != null).map(c => ({ time: c.time, value: c.ema20 })));
  ema50Series.setData(candles.filter(c => c.ema50 != null).map(c => ({ time: c.time, value: c.ema50 })));
  ema200Series.setData(candles.filter(c => c.ema200 != null).map(c => ({ time: c.time, value: c.ema200 })));
  bbUpperSeries.setData(candles.filter(c => c.bbUpper != null).map(c => ({ time: c.time, value: c.bbUpper })));
  bbMiddleSeries.setData(candles.filter(c => c.bbMiddle != null).map(c => ({ time: c.time, value: c.bbMiddle })));
  bbLowerSeries.setData(candles.filter(c => c.bbLower != null).map(c => ({ time: c.time, value: c.bbLower })));

  // ── Marker thủng BB: arrow đỏ ↓ (close vượt BB upper) / xanh ↑ (close phá BB lower)
  const bbMarkers = candles
    .filter(c => c.bbUpper != null && c.bbLower != null)
    .filter(c => c.close > c.bbUpper || c.close < c.bbLower)
    .map(c => {
      const breakUp = c.close > c.bbUpper;
      return {
        time: c.time,
        position: breakUp ? "aboveBar" : "belowBar",
        color: breakUp ? "#ef4444" : "#22c55e",
        shape: breakUp ? "arrowDown" : "arrowUp",
        text: breakUp ? "BB↑" : "BB↓",
      };
    });
  candleSeries.setMarkers(bbMarkers);

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
