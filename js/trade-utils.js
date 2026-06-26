// Shared trade helpers — logic đồng bộ với worker/src/index.js (pickTriggerCandle, validateTradeGeometry)

export const TF_INTERVAL_SEC = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

/**
 * Trigger trên nến đã đóng; displayCandle = nến mới nhất (có thể đang chạy).
 */
export function pickTriggerCandle(candlesEnriched, intervalSec = 15 * 60) {
  if (!Array.isArray(candlesEnriched) || candlesEnriched.length < 3) return null;
  const n = candlesEnriched.length;
  const last = candlesEnriched[n - 1];
  const nowSec = Math.floor(Date.now() / 1000);
  const isLatestClosed = last.time && (last.time + intervalSec) <= nowSec;
  if (isLatestClosed) {
    return {
      latest: last,
      prev: candlesEnriched[n - 2],
      displayCandle: last,
      isLatestClosed: true,
    };
  }
  return {
    latest: candlesEnriched[n - 2],
    prev: candlesEnriched[n - 3],
    displayCandle: last,
    isLatestClosed: false,
  };
}

/**
 * Validate Entry/SL/TP — returns { valid, reason }.
 */
export function validateTradeGeometry(setup, ctx = {}) {
  const toNum = (v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "string" ? parseFloat(v) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const entry = toNum(setup.entry);
  const sl = toNum(setup.sl);
  const tp1 = toNum(setup.tp1);
  const tp2 = toNum(setup.tp2);
  const tp3 = toNum(setup.tp3);
  const bias = String(setup.bias || "").toUpperCase();
  const minRr = ctx.minRr ?? 0.7;

  if (entry == null || sl == null || tp1 == null) {
    return { valid: false, reason: "thiếu entry/SL/TP1 (hoặc không phải số hợp lệ)" };
  }

  const isLong = bias === "BUY" || bias === "LONG";
  const isShort = bias === "SELL" || bias === "SHORT";
  if (!isLong && !isShort) {
    return { valid: false, reason: `bias không hợp lệ: ${setup.bias}` };
  }

  if (isLong && !(sl < entry && entry < tp1)) {
    return { valid: false, reason: `LONG cần sl<entry<tp1` };
  }
  if (isShort && !(sl > entry && entry > tp1)) {
    return { valid: false, reason: `SHORT cần sl>entry>tp1` };
  }

  if (tp2 != null) {
    if (isLong && tp2 <= tp1) return { valid: false, reason: "LONG cần tp2>tp1" };
    if (isShort && tp2 >= tp1) return { valid: false, reason: "SHORT cần tp2<tp1" };
  }
  if (tp3 != null) {
    const ref = tp2 != null ? tp2 : tp1;
    if (isLong && tp3 <= ref) return { valid: false, reason: "LONG cần tp3>tp2/tp1" };
    if (isShort && tp3 >= ref) return { valid: false, reason: "SHORT cần tp3<tp2/tp1" };
  }

  const slDist = Math.abs(entry - sl);
  const tp1Dist = Math.abs(tp1 - entry);
  if (slDist === 0) return { valid: false, reason: "SL trùng entry" };
  const rr = tp1Dist / slDist;
  if (rr < minRr) {
    return { valid: false, reason: `R:R đến TP1 = ${rr.toFixed(2)} < ${minRr}` };
  }

  const atrNum = toNum(ctx.atr);
  if (atrNum != null && atrNum > 0 && slDist < atrNum * 0.8) {
    return { valid: false, reason: `SL quá gần (< 0.8× ATR)` };
  }

  return { valid: true, reason: null };
}
