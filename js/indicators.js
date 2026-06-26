// ============================================================
// Technical indicators — pure JS, không phụ thuộc lib
// ============================================================
import { detectLiquiditySweep, detectRsiDivergence } from "./smc-detect.js";

/**
 * Exponential Moving Average.
 * @param {number[]} values
 * @param {number} period
 * @returns {Array<number|null>}
 */
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      // Seed với SMA của period đầu
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/**
 * Simple Moving Average.
 */
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

/**
 * Wilder's smoothing — dùng cho RSI và ATR.
 */
function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      prev = sum / period;
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
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const avgGain = wilderSmooth(gains, period);
  const avgLoss = wilderSmooth(losses, period);
  return closes.map((_, i) => {
    if (avgGain[i] === null || avgLoss[i] === null) return null;
    if (avgLoss[i] === 0) return 100;
    const rs = avgGain[i] / avgLoss[i];
    return 100 - 100 / (1 + rs);
  });
}

function atr(highs, lows, closes, period = 14) {
  const trs = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i];
    return Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  });
  return wilderSmooth(trs, period);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  // Signal: EMA của macd, bỏ null đầu
  const cleanIdxStart = macdLine.findIndex(v => v !== null);
  if (cleanIdxStart === -1) return { macd: macdLine, signal: macdLine.map(() => null) };
  const cleanMacd = macdLine.slice(cleanIdxStart).map(v => v ?? 0);
  const sigClean = ema(cleanMacd, signal);
  const sigOut = new Array(cleanIdxStart).fill(null).concat(sigClean);
  return { macd: macdLine, signal: sigOut };
}

function bollinger(closes, period = 20, mult = 2) {
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const middle = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    middle[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, middle, lower };
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

/**
 * Compute all indicators và gắn vào nến (mutate input copy).
 * @param {Array} candles
 * @returns {Array} new array với fields bổ sung
 */
export function computeIndicators(candles) {
  if (!candles || candles.length < 50) return candles.map(c => ({ ...c }));

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema9   = ema(closes, 9);
  const ema20  = ema(closes, 20);
  const ema21  = ema(closes, 21);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const sma50  = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14  = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const { macd: macdLine, signal: macdSignal } = macd(closes);
  const { upper: bbUpper, middle: bbMiddle, lower: bbLower } = bollinger(closes, 20, 2);
  const recentHigh = rollingMax(highs, 50);
  const recentLow = rollingMin(lows, 50);

  return candles.map((c, i) => ({
    ...c,
    ema9: ema9[i],
    ema20: ema20[i],
    ema21: ema21[i],
    ema50: ema50[i],
    ema200: ema200[i],
    sma50: sma50[i],
    sma200: sma200[i],
    rsi: rsi14[i],
    atr: atr14[i],
    macd: macdLine[i],
    macdSignal: macdSignal[i],
    bbUpper: bbUpper[i],
    bbMiddle: bbMiddle[i],
    bbLower: bbLower[i],
    recentHigh: recentHigh[i],
    recentLow: recentLow[i],
  }));
}

/**
 * Fibonacci retracement từ swing high/low trong N nến gần nhất.
 * Trả 5 levels: 0.236, 0.382, 0.5, 0.618, 0.786
 * - Uptrend (low đến trước high): levels = HH - range × fib (giá retrace xuống)
 * - Downtrend (high đến trước low): levels = LL + range × fib (giá retrace lên)
 */
export function computeFib(candles, lookback = 50) {
  if (!candles || candles.length < 5) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  let hhIdx = 0, llIdx = 0;
  for (let i = 0; i < window.length; i++) {
    if (window[i].high > window[hhIdx].high) hhIdx = i;
    if (window[i].low  < window[llIdx].low)  llIdx = i;
  }
  const hh = window[hhIdx].high;
  const ll = window[llIdx].low;
  const range = hh - ll;
  if (range <= 0) return null;
  const isUptrend = llIdx < hhIdx; // low xuất hiện trước high
  const fibs = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = fibs.map(f => ({
    level: f,
    price: isUptrend ? hh - range * f : ll + range * f,
  }));
  return { hh, ll, isUptrend, levels };
}

/**
 * Classical Pivot Points từ 1 candle (thường là yesterday's daily).
 * PP = (H + L + C) / 3
 * R1 = 2×PP − L,  R2 = PP + (H − L)
 * S1 = 2×PP − H,  S2 = PP − (H − L)
 */
export function computePivots(candle) {
  if (!candle) return null;
  const H = candle.high, L = candle.low, C = candle.close;
  const PP = (H + L + C) / 3;
  const range = H - L;
  return {
    pp: PP,
    r1: 2 * PP - L,
    r2: PP + range,
    s1: 2 * PP - H,
    s2: PP - range,
  };
}

/**
 * Detect Golden Cross / Death Cross historical events trong candles.
 * Golden Cross: SMA 50 cắt LÊN SMA 200 → bullish
 * Death Cross:  SMA 50 cắt XUỐNG SMA 200 → bearish
 */
export function detectCrosses(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1], c = candles[i];
    if (p.sma50 == null || p.sma200 == null || c.sma50 == null || c.sma200 == null) continue;
    if (p.sma50 <= p.sma200 && c.sma50 > c.sma200) {
      out.push({ time: c.time, type: "golden" });
    } else if (p.sma50 >= p.sma200 && c.sma50 < c.sma200) {
      out.push({ time: c.time, type: "death" });
    }
  }
  return out;
}

/**
 * Tính vùng giá tham chiếu từ ATR + recent extremes + SMC equilibrium.
 */
export function calculateZones(latest, smcCtx = null) {
  if (!latest || !latest.atr) return {};
  const { close, atr: a, recentHigh, recentLow } = latest;
  const pd = smcCtx?.premiumDiscount;
  return {
    support: recentLow ?? close,
    resistance: recentHigh ?? close,
    slLong: close - 1.5 * a,
    slShort: close + 1.5 * a,
    targetLong: close + 3.0 * a,
    targetShort: close - 3.0 * a,
    atrValue: a,
    equilibrium: pd?.equilibrium ?? null,
    premiumDiscount: pd?.zone ?? null,
    nearestFvg: smcCtx?.nearestFvg ?? null,
    nearestOb: smcCtx?.nearestOb ?? null,
  };
}

/**
 * Rule-based alerts — đồng bộ worker (crossover, SMA, sweep, wick, RSI div).
 */
export function detectAlerts(latest, prev, candles = null) {
  const alerts = [];
  if (!latest) return alerts;

  if (latest.rsi != null) {
    if (latest.rsi > 70) alerts.push(`🔴 RSI quá mua (${latest.rsi.toFixed(1)}) — khả năng điều chỉnh`);
    else if (latest.rsi < 30) alerts.push(`🟢 RSI quá bán (${latest.rsi.toFixed(1)}) — khả năng phục hồi`);
  }

  if (prev && latest.bbUpper != null && prev.bbUpper != null) {
    if (latest.close > latest.bbUpper && prev.close <= prev.bbUpper) {
      alerts.push(`📈 Vượt biên Bollinger trên ($${latest.bbUpper.toFixed(2)}) — đà tăng mạnh`);
    }
    if (latest.bbLower != null && prev.bbLower != null
        && latest.close < latest.bbLower && prev.close >= prev.bbLower) {
      alerts.push(`📉 Phá biên Bollinger dưới ($${latest.bbLower.toFixed(2)}) — đà giảm mạnh`);
    }
  }

  if (prev && latest.macd != null && prev.macd != null) {
    if (prev.macd <= prev.macdSignal && latest.macd > latest.macdSignal) {
      alerts.push("🟢 MACD vừa cắt lên đường tín hiệu — tín hiệu tăng");
    } else if (prev.macd >= prev.macdSignal && latest.macd < latest.macdSignal) {
      alerts.push("🔴 MACD vừa cắt xuống đường tín hiệu — tín hiệu giảm");
    }
  }

  if (prev && latest.sma50 != null && prev.sma50 != null && latest.sma200 != null && prev.sma200 != null) {
    if (prev.sma50 <= prev.sma200 && latest.sma50 > latest.sma200) {
      alerts.push("⭐ Golden Cross (SMA50 cắt lên SMA200) — xu hướng tăng dài hạn");
    } else if (prev.sma50 >= prev.sma200 && latest.sma50 < latest.sma200) {
      alerts.push("💀 Death Cross (SMA50 cắt xuống SMA200) — xu hướng giảm dài hạn");
    }
  }

  const sweep = detectLiquiditySweep(latest, prev);
  if (sweep?.type === "bearish") {
    alerts.push(`🎣 Liquidity sweep TRÊN $${sweep.level.toFixed(2)} — đóng lại trong (bearish SMC)`);
  } else if (sweep?.type === "bullish") {
    alerts.push(`🎣 Liquidity sweep DƯỚI $${sweep.level.toFixed(2)} — đóng lại trong (bullish SMC)`);
  }

  if (latest.atr > 0 && latest.high != null && latest.low != null) {
    const body = Math.abs(latest.close - latest.open);
    const range = latest.high - latest.low;
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;
    if (range > 0.7 * latest.atr && body > 0) {
      if (upperWick > 1.5 * body && upperWick > lowerWick * 1.5) {
        alerts.push(`🪶 Rejection đỉnh — râu trên ${upperWick.toFixed(2)} (${(upperWick / body).toFixed(1)}× thân)`);
      }
      if (lowerWick > 1.5 * body && lowerWick > upperWick * 1.5) {
        alerts.push(`🪶 Rejection đáy — râu dưới ${lowerWick.toFixed(2)} (${(lowerWick / body).toFixed(1)}× thân)`);
      }
    }
  }

  if (candles) {
    const div = detectRsiDivergence(candles);
    if (div) alerts.push(div);
  }

  return alerts;
}
