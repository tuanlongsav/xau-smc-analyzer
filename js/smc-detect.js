// ============================================================
// Rule-based SMC detection — đồng bộ concept với worker alerts
// Tham chiếu: top-down HTF bias → liquidity sweep → displacement/FVG → OB retest
// ============================================================

/** Local swing đỉnh/đáy (window 3-3). */
export function findLocalExtremes(candles, kind = "high") {
  const out = [];
  if (!candles || candles.length < 7) return out;
  for (let i = 3; i < candles.length - 3; i++) {
    const v = kind === "high" ? candles[i].high : candles[i].low;
    if (v == null) continue;
    let isExtreme = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      const cmp = kind === "high" ? candles[j].high : candles[j].low;
      if (cmp == null) { isExtreme = false; break; }
      if (kind === "high" ? cmp > v : cmp < v) { isExtreme = false; break; }
    }
    if (isExtreme) out.push({ idx: i, value: v, rsi: candles[i].rsi, time: candles[i].time });
  }
  return out;
}

/**
 * Fair Value Gap — bullish: low[i] > high[i-2]; bearish: high[i] < low[i-2].
 */
export function detectFVGs(candles, lookback = 30) {
  if (!candles || candles.length < 3) return [];
  const start = Math.max(2, candles.length - lookback);
  const fvgs = [];
  for (let i = start; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c1 = candles[i - 1];
    const c2 = candles[i];
    if (c2.low > c0.high) {
      const top = c2.low;
      const bottom = c0.high;
      const mitigated = candles.slice(i + 1).some(c => c.low <= bottom);
      fvgs.push({
        type: "bullish",
        top,
        bottom,
        mid: (top + bottom) / 2,
        time: c1.time,
        mitigated,
      });
    }
    if (c2.high < c0.low) {
      const top = c0.low;
      const bottom = c2.high;
      const mitigated = candles.slice(i + 1).some(c => c.high >= top);
      fvgs.push({
        type: "bearish",
        top,
        bottom,
        mid: (top + bottom) / 2,
        time: c1.time,
        mitigated,
      });
    }
  }
  return fvgs;
}

/**
 * Order Block — nến đối lập ngay trước displacement (body > 1.3×ATR).
 */
export function detectOrderBlocks(candles, lookback = 25) {
  if (!candles || candles.length < 4) return [];
  const start = Math.max(1, candles.length - lookback);
  const obs = [];
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (!c.atr || c.atr <= 0) continue;
    const body = Math.abs(c.close - c.open);
    if (body < 1.3 * c.atr) continue;
    const bullDisp = c.close > c.open;
    const ob = prev;
    const obBullish = ob.close < ob.open;
    if (bullDisp && obBullish) {
      obs.push({
        type: "bullish",
        high: ob.high,
        low: ob.low,
        time: ob.time,
        displacementAtr: body / c.atr,
      });
    }
    if (!bullDisp && !obBullish) {
      obs.push({
        type: "bearish",
        high: ob.high,
        low: ob.low,
        time: ob.time,
        displacementAtr: body / c.atr,
      });
    }
  }
  return obs;
}

/** Liquidity sweep — quét recent high/low rồi đóng lại trong (giống worker). */
export function detectLiquiditySweep(latest, prev) {
  if (!latest || !prev) return null;
  if (prev.recentHigh != null && latest.high > prev.recentHigh && latest.close < prev.recentHigh) {
    return { type: "bearish", level: prev.recentHigh, wick: latest.high };
  }
  if (prev.recentLow != null && latest.low < prev.recentLow && latest.close > prev.recentLow) {
    return { type: "bullish", level: prev.recentLow, wick: latest.low };
  }
  return null;
}

/** BOS đơn giản — phá swing high/low gần nhất. */
export function detectStructureBreak(candles, latest) {
  if (!candles || !latest) return null;
  const highs = findLocalExtremes(candles, "high");
  const lows = findLocalExtremes(candles, "low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  if (lastHigh && latest.close > lastHigh.value) {
    return { type: "BOS", direction: "bullish", level: lastHigh.value };
  }
  if (lastLow && latest.close < lastLow.value) {
    return { type: "BOS", direction: "bearish", level: lastLow.value };
  }
  if (lastHigh && latest.high > lastHigh.value && latest.close < lastHigh.value) {
    return { type: "CHOCH", direction: "bearish", level: lastHigh.value };
  }
  if (lastLow && latest.low < lastLow.value && latest.close > lastLow.value) {
    return { type: "CHOCH", direction: "bullish", level: lastLow.value };
  }
  return null;
}

/** Premium / discount theo range lookback (SMC equilibrium 50%). */
export function computePremiumDiscount(candles, lookback = 50) {
  if (!candles || candles.length < 5) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  const high = Math.max(...window.map(c => c.high));
  const low = Math.min(...window.map(c => c.low));
  if (high <= low) return null;
  const eq = (high + low) / 2;
  const price = candles[candles.length - 1].close;
  let zone = "equilibrium";
  if (price > eq * 1.001) zone = "premium";
  else if (price < eq * 0.999) zone = "discount";
  const pct = ((price - low) / (high - low)) * 100;
  return { high, low, equilibrium: eq, zone, pctInRange: pct };
}

/** Mức tâm lý vàng ($50 / $10 gần giá). */
export function nearPsychologicalLevels(price, largeStep = 50, smallStep = 10) {
  if (!Number.isFinite(price)) return [];
  const levels = new Set();
  for (const step of [largeStep, smallStep]) {
    const base = Math.round(price / step) * step;
    levels.add(base - step);
    levels.add(base);
    levels.add(base + step);
  }
  return [...levels]
    .filter(l => l > 0)
    .map(l => ({ price: l, distance: Math.abs(price - l) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4);
}

export function detectCandlePattern(latest, prev) {
  if (!latest) return null;
  const o = latest.open;
  const c = latest.close;
  const h = latest.high;
  const l = latest.low;
  const body = Math.abs(c - o);
  const range = h - l;
  if (range === 0) return "Doji";
  const bodyRatio = body / range;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  if (bodyRatio < 0.3 && lowerWick / range > 0.6) return "Hammer / Pin bar đáy";
  if (bodyRatio < 0.3 && upperWick / range > 0.6) return "Shooting Star / Pin bar đỉnh";
  if (bodyRatio < 0.1) return "Doji";

  if (prev) {
    const prevBull = prev.close > prev.open;
    const currBull = c > o;
    const prevBody = Math.abs(prev.close - prev.open);
    if (!prevBull && currBull && body > prevBody && o <= prev.close && c >= prev.open) {
      return "Bullish Engulfing";
    }
    if (prevBull && !currBull && body > prevBody && o >= prev.close && c <= prev.open) {
      return "Bearish Engulfing";
    }
  }
  if (bodyRatio > 0.7) return c > o ? "Marubozu tăng" : "Marubozu giảm";
  return c > o ? "Nến tăng" : "Nến giảm";
}

/** RSI divergence đơn giản (2 swing gần nhất). */
export function detectRsiDivergence(candles) {
  if (!candles || candles.length < 30) return null;
  const recent = candles.slice(-30);
  const highs = findLocalExtremes(recent, "high");
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    if (h2.value > h1.value && h2.rsi != null && h1.rsi != null && h2.rsi < h1.rsi - 2) {
      return "📉 Phân kỳ RSI giảm (bearish) — giá đỉnh cao hơn, RSI đỉnh thấp hơn";
    }
  }
  const lows = findLocalExtremes(recent, "low");
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2);
    if (l2.value < l1.value && l2.rsi != null && l1.rsi != null && l2.rsi > l1.rsi + 2) {
      return "📈 Phân kỳ RSI tăng (bullish) — giá đáy thấp hơn, RSI đáy cao hơn";
    }
  }
  return null;
}

function nearestToPrice(items, price, getPrice) {
  if (!items.length) return null;
  return items
    .map(it => ({ it, d: Math.abs(getPrice(it) - price) }))
    .sort((a, b) => a.d - b.d)[0]?.it ?? null;
}

/**
 * Tổng hợp SMC context cho prompt + UI.
 */
export function analyzeSmcContext(candles, latest, prev) {
  const freshFvgs = detectFVGs(candles).filter(f => !f.mitigated);
  const obs = detectOrderBlocks(candles);
  const price = latest?.close ?? 0;
  return {
    fvgs: freshFvgs.slice(-3),
    orderBlocks: obs.slice(-3),
    sweep: detectLiquiditySweep(latest, prev),
    structure: detectStructureBreak(candles, latest),
    premiumDiscount: computePremiumDiscount(candles),
    roundLevels: nearPsychologicalLevels(price),
    candlePattern: detectCandlePattern(latest, prev),
    rsiDivergence: detectRsiDivergence(candles),
    nearestFvg: nearestToPrice(freshFvgs, price, f => f.mid),
    nearestOb: nearestToPrice(obs, price, o => (o.high + o.low) / 2),
  };
}

const fmt = (n) => (n != null && Number.isFinite(n)) ? n.toFixed(2) : "?";

/** Format block tiếng Việt đưa vào Gemini prompt. */
export function formatSmcContextForPrompt(ctx, latest) {
  if (!ctx) return "(Không đủ data SMC)";
  const lines = [];

  if (ctx.premiumDiscount) {
    const pd = ctx.premiumDiscount;
    const zoneVi = { premium: "PREMIUM (đắt — ưu tiên SELL setup)", discount: "DISCOUNT (rẻ — ưu tiên BUY setup)", equilibrium: "EQUILIBRIUM (giữa range)" }[pd.zone] || pd.zone;
    lines.push(`- Vùng giá: ${zoneVi} — ${pd.pctInRange.toFixed(0)}% range (${fmt(pd.low)} → ${fmt(pd.high)}), EQ $${fmt(pd.equilibrium)}`);
  }

  if (ctx.structure) {
    lines.push(`- Cấu trúc: ${ctx.structure.type} ${ctx.structure.direction} tại $${fmt(ctx.structure.level)}`);
  }

  if (ctx.sweep) {
    const dir = ctx.sweep.type === "bullish" ? "quét ĐÁY → bullish reversal" : "quét ĐỈNH → bearish reversal";
    lines.push(`- Liquidity sweep: ${dir} (level $${fmt(ctx.sweep.level)}, wick $${fmt(ctx.sweep.wick)})`);
  }

  if (ctx.nearestFvg) {
    const f = ctx.nearestFvg;
    lines.push(`- FVG ${f.type} fresh: $${fmt(f.bottom)} – $${fmt(f.top)} (mid $${fmt(f.mid)})`);
  } else if (ctx.fvgs.length) {
    lines.push(`- FVG fresh: ${ctx.fvgs.length} vùng (không có vùng gần giá)`);
  } else {
    lines.push("- FVG fresh: không phát hiện");
  }

  if (ctx.nearestOb) {
    const o = ctx.nearestOb;
    lines.push(`- Order Block ${o.type}: $${fmt(o.low)} – $${fmt(o.high)} (displacement ${o.displacementAtr.toFixed(1)}×ATR)`);
  } else {
    lines.push("- Order Block: không phát hiện displacement rõ gần đây");
  }

  if (ctx.candlePattern) lines.push(`- Pattern nến trigger: ${ctx.candlePattern}`);
  if (ctx.rsiDivergence) lines.push(`- ${ctx.rsiDivergence}`);

  if (ctx.roundLevels?.length) {
    lines.push(`- Mức tâm lý gần: ${ctx.roundLevels.map(r => `$${fmt(r.price)}`).join(", ")}`);
  }

  lines.push(`- Gợi ý bias: long ưu tiên khi discount + sweep đáy + bullish FVG/OB; short khi premium + sweep đỉnh + bearish FVG/OB`);

  return lines.join("\n");
}
