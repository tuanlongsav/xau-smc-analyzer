// ============================================================
// Technical indicators — pure JS, không phụ thuộc lib
// ============================================================
//
// Input format: array of OHLCV { time, open, high, low, close, volume }
// Output: gắn các trường tính toán (ema20, rsi, atr, ...) vào nến.

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

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(highs, lows, closes, 14);
  const { macd: macdLine, signal: macdSignal } = macd(closes);
  const { upper: bbUpper, lower: bbLower } = bollinger(closes, 20, 2);
  const recentHigh = rollingMax(highs, 50);
  const recentLow = rollingMin(lows, 50);

  return candles.map((c, i) => ({
    ...c,
    ema20: ema20[i],
    ema50: ema50[i],
    ema200: ema200[i],
    rsi: rsi14[i],
    atr: atr14[i],
    macd: macdLine[i],
    macdSignal: macdSignal[i],
    bbUpper: bbUpper[i],
    bbLower: bbLower[i],
    recentHigh: recentHigh[i],
    recentLow: recentLow[i],
  }));
}

/**
 * Tính vùng giá tham chiếu từ ATR + recent extremes.
 */
export function calculateZones(latest) {
  if (!latest || !latest.atr) return {};
  const { close, atr: a, recentHigh, recentLow } = latest;
  return {
    support: recentLow ?? close,
    resistance: recentHigh ?? close,
    slLong: close - 1.5 * a,
    slShort: close + 1.5 * a,
    targetLong: close + 3.0 * a,
    targetShort: close - 3.0 * a,
    atrValue: a,
  };
}

/**
 * Rule-based alerts không cần LLM.
 */
export function detectAlerts(latest, prev) {
  const alerts = [];
  if (!latest) return alerts;

  if (latest.rsi != null) {
    if (latest.rsi > 70) alerts.push(`🔴 RSI quá mua (${latest.rsi.toFixed(1)}) — khả năng điều chỉnh`);
    else if (latest.rsi < 30) alerts.push(`🟢 RSI quá bán (${latest.rsi.toFixed(1)}) — khả năng phục hồi`);
  }

  if (latest.bbUpper && latest.close > latest.bbUpper) {
    alerts.push(`📈 Giá $${latest.close.toFixed(2)} vượt biên Bollinger trên ($${latest.bbUpper.toFixed(2)})`);
  }
  if (latest.bbLower && latest.close < latest.bbLower) {
    alerts.push(`📉 Giá $${latest.close.toFixed(2)} phá biên Bollinger dưới ($${latest.bbLower.toFixed(2)})`);
  }

  if (prev && latest.macd != null && prev.macd != null) {
    if (prev.macd <= prev.macdSignal && latest.macd > latest.macdSignal) {
      alerts.push("🟢 MACD vừa cắt lên đường tín hiệu — tín hiệu tăng");
    } else if (prev.macd >= prev.macdSignal && latest.macd < latest.macdSignal) {
      alerts.push("🔴 MACD vừa cắt xuống đường tín hiệu — tín hiệu giảm");
    }
  }

  if (prev && latest.ema50 && prev.ema50 && latest.ema200 && prev.ema200) {
    if (prev.ema50 <= prev.ema200 && latest.ema50 > latest.ema200) {
      alerts.push("⭐ Golden Cross (EMA50 cắt lên EMA200) — xu hướng tăng dài hạn");
    } else if (prev.ema50 >= prev.ema200 && latest.ema50 < latest.ema200) {
      alerts.push("⚠️ Death Cross (EMA50 cắt xuống EMA200) — xu hướng giảm dài hạn");
    }
  }

  return alerts;
}
