// Rule-based SMC detection — đồng bộ với js/smc-detect.js (web)

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

export function detectFVGs(candles, lookback = 30) {
  if (!candles || candles.length < 3) return [];
  const start = Math.max(2, candles.length - lookback);
  const fvgs = [];
  for (let i = start; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c2.low > c0.high) {
      const top = c2.low;
      const bottom = c0.high;
      // Mitigated khi giá chạm vào gap (entry), không cần fill hết
      const mitigated = candles.slice(i + 1).some(c => c.low <= top);
      fvgs.push({ type: "bullish", top, bottom, mid: (top + bottom) / 2, mitigated });
    }
    if (c2.high < c0.low) {
      const top = c0.low;
      const bottom = c2.high;
      const mitigated = candles.slice(i + 1).some(c => c.high >= bottom);
      fvgs.push({ type: "bearish", top, bottom, mid: (top + bottom) / 2, mitigated });
    }
  }
  return fvgs;
}

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
    const obBullish = prev.close < prev.open;
    if (bullDisp && obBullish) {
      obs.push({ type: "bullish", high: prev.high, low: prev.low, displacementAtr: body / c.atr });
    }
    if (!bullDisp && !obBullish) {
      obs.push({ type: "bearish", high: prev.high, low: prev.low, displacementAtr: body / c.atr });
    }
  }
  return obs;
}

/** Equal highs/lows (EQH/EQL) — cụm thanh khoản trong biên ~tolerance×ATR */
export function detectLiquidityPools(candles, toleranceAtr = 0.15, lookback = 50) {
  if (!candles || candles.length < 10) return { eqh: [], eql: [] };
  const window = candles.slice(-lookback);
  const atr = window[window.length - 1]?.atr || 0;
  const tol = atr > 0 ? atr * toleranceAtr : (window[window.length - 1]?.close || 0) * 0.0008;
  const highs = findLocalExtremes(window, "high");
  const lows = findLocalExtremes(window, "low");

  const cluster = (points, kind) => {
    const pools = [];
    const used = new Set();
    for (let i = 0; i < points.length; i++) {
      if (used.has(i)) continue;
      const group = [points[i]];
      used.add(i);
      for (let j = i + 1; j < points.length; j++) {
        if (used.has(j)) continue;
        if (Math.abs(points[j].value - points[i].value) <= tol) {
          group.push(points[j]);
          used.add(j);
        }
      }
      if (group.length >= 2) {
        const level = group.reduce((s, p) => s + p.value, 0) / group.length;
        pools.push({ type: kind, level, touches: group.length, points: group });
      }
    }
    return pools.sort((a, b) => b.touches - a.touches);
  };

  return { eqh: cluster(highs, "eqh"), eql: cluster(lows, "eql") };
}

export function detectLiquiditySweep(latest, prev, candles = null) {
  if (!latest || !prev) return null;

  const atr = latest.atr || prev.atr || 0;
  const pools = candles ? detectLiquidityPools(candles) : { eqh: [], eql: [] };

  // Ưu tiên sweep EQH/EQL (≥2 touch)
  for (const pool of pools.eqh) {
    if (latest.high > pool.level && latest.close < pool.level) {
      return { type: "bearish", level: pool.level, wick: latest.high, source: "EQH", touches: pool.touches };
    }
  }
  for (const pool of pools.eql) {
    if (latest.low < pool.level && latest.close > pool.level) {
      return { type: "bullish", level: pool.level, wick: latest.low, source: "EQL", touches: pool.touches };
    }
  }

  // Fallback: rolling extreme — chỉ khi wick vượt đủ xa (≥0.1×ATR) và close reject rõ
  const minWick = atr > 0 ? atr * 0.1 : 0;
  if (prev.recentHigh != null && latest.high > prev.recentHigh + minWick && latest.close < prev.recentHigh) {
    return { type: "bearish", level: prev.recentHigh, wick: latest.high, source: "swing_high", touches: 1 };
  }
  if (prev.recentLow != null && latest.low < prev.recentLow - minWick && latest.close > prev.recentLow) {
    return { type: "bullish", level: prev.recentLow, wick: latest.low, source: "swing_low", touches: 1 };
  }
  return null;
}

export function detectStructureBreak(candles, latest) {
  if (!candles || !latest) return null;
  const highs = findLocalExtremes(candles, "high");
  const lows = findLocalExtremes(candles, "low");
  if (!highs.length || !lows.length) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  let trend = "mixed";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].value > highs[highs.length - 2].value;
    const hl = lows[lows.length - 1].value > lows[lows.length - 2].value;
    const lh = highs[highs.length - 1].value < highs[highs.length - 2].value;
    const ll = lows[lows.length - 1].value < lows[lows.length - 2].value;
    if (hh && hl) trend = "bullish";
    else if (lh && ll) trend = "bearish";
  }

  if (latest.close > lastHigh.value) {
    return {
      type: trend === "bullish" ? "BOS" : "CHOCH",
      direction: "bullish",
      level: lastHigh.value,
      trend,
    };
  }
  if (latest.close < lastLow.value) {
    return {
      type: trend === "bearish" ? "BOS" : "CHOCH",
      direction: "bearish",
      level: lastLow.value,
      trend,
    };
  }
  if (lastHigh && latest.high > lastHigh.value && latest.close < lastHigh.value) {
    return { type: "CHOCH", direction: "bearish", level: lastHigh.value, trend };
  }
  if (lastLow && latest.low < lastLow.value && latest.close > lastLow.value) {
    return { type: "CHOCH", direction: "bullish", level: lastLow.value, trend };
  }
  return null;
}

export function computePremiumDiscount(candles, lookback = 50) {
  if (!candles || candles.length < 5) return null;
  const window = candles.slice(-Math.min(lookback, candles.length));
  const highs = findLocalExtremes(window, "high");
  const lows = findLocalExtremes(window, "low");

  let high, low;
  if (highs.length >= 1 && lows.length >= 1) {
    const swingHighs = highs.slice(-3).map(h => h.value);
    const swingLows = lows.slice(-3).map(l => l.value);
    high = Math.max(...swingHighs);
    low = Math.min(...swingLows);
  } else {
    high = Math.max(...window.map(c => c.high));
    low = Math.min(...window.map(c => c.low));
  }
  if (high <= low) return null;
  const eq = (high + low) / 2;
  const price = candles[candles.length - 1].close;
  let zone = "equilibrium";
  if (price > eq * 1.001) zone = "premium";
  else if (price < eq * 0.999) zone = "discount";
  const pct = ((price - low) / (high - low)) * 100;
  return { high, low, equilibrium: eq, zone, pctInRange: pct };
}

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

export function detectCandlePatternSmc(latest, prev) {
  if (!latest) return null;
  const o = latest.open, c = latest.close, h = latest.high, l = latest.low;
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
    if (!prevBull && currBull && body > prevBody && o <= prev.close && c >= prev.open) return "Bullish Engulfing";
    if (prevBull && !currBull && body > prevBody && o >= prev.close && c <= prev.open) return "Bearish Engulfing";
  }
  if (bodyRatio > 0.7) return c > o ? "Marubozu tăng" : "Marubozu giảm";
  return c > o ? "Nến tăng" : "Nến giảm";
}

export function detectRsiDivergence(candles) {
  if (!candles || candles.length < 30) return null;
  const recent = candles.slice(-30);
  const highs = findLocalExtremes(recent, "high");
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2);
    if (h2.value > h1.value && h2.rsi != null && h1.rsi != null && h2.rsi < h1.rsi - 4) {
      return "Phân kỳ RSI giảm (bearish) — giá đỉnh cao hơn, RSI đỉnh thấp hơn";
    }
  }
  const lows = findLocalExtremes(recent, "low");
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2);
    if (l2.value < l1.value && l2.rsi != null && l1.rsi != null && l2.rsi > l1.rsi + 4) {
      return "Phân kỳ RSI tăng (bullish) — giá đáy thấp hơn, RSI đáy cao hơn";
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

export function analyzeSmcContext(candles, latest, prev) {
  const freshFvgs = detectFVGs(candles).filter(f => !f.mitigated);
  const obs = detectOrderBlocks(candles);
  const price = latest?.close ?? 0;
  const pools = detectLiquidityPools(candles);
  return {
    fvgs: freshFvgs.slice(-3),
    orderBlocks: obs.slice(-3),
    sweep: detectLiquiditySweep(latest, prev, candles),
    structure: detectStructureBreak(candles, latest),
    premiumDiscount: computePremiumDiscount(candles),
    liquidityPools: pools,
    roundLevels: nearPsychologicalLevels(price),
    candlePattern: detectCandlePatternSmc(latest, prev),
    rsiDivergence: detectRsiDivergence(candles),
    nearestFvg: nearestToPrice(freshFvgs, price, f => f.mid),
    nearestOb: nearestToPrice(obs, price, o => (o.high + o.low) / 2),
  };
}

const fmt = (n) => (n != null && Number.isFinite(n)) ? n.toFixed(2) : "?";

export function formatSmcContextForPrompt(ctx, latest) {
  if (!ctx) return "(Không đủ data SMC)";
  const lines = [];

  if (ctx.premiumDiscount) {
    const pd = ctx.premiumDiscount;
    const zoneVi = {
      premium: "PREMIUM (đắt — ưu tiên SELL setup)",
      discount: "DISCOUNT (rẻ — ưu tiên BUY setup)",
      equilibrium: "EQUILIBRIUM (giữa range)",
    }[pd.zone] || pd.zone;
    lines.push(`- Vùng giá: ${zoneVi} — ${pd.pctInRange.toFixed(0)}% dealing range (${fmt(pd.low)} → ${fmt(pd.high)}), EQ $${fmt(pd.equilibrium)}`);
  }

  if (ctx.structure) {
    const tr = ctx.structure.trend ? `, trend ${ctx.structure.trend}` : "";
    lines.push(`- Cấu trúc: ${ctx.structure.type} ${ctx.structure.direction} tại $${fmt(ctx.structure.level)}${tr}`);
  }

  if (ctx.sweep) {
    const dir = ctx.sweep.type === "bullish" ? "quét ĐÁY → bullish reversal" : "quét ĐỈNH → bearish reversal";
    const src = ctx.sweep.source ? ` (${ctx.sweep.source}${ctx.sweep.touches > 1 ? ` ×${ctx.sweep.touches}` : ""})` : "";
    lines.push(`- Liquidity sweep: ${dir}${src} level $${fmt(ctx.sweep.level)}, wick $${fmt(ctx.sweep.wick)}`);
  }

  if (ctx.liquidityPools?.eqh?.length || ctx.liquidityPools?.eql?.length) {
    const eqParts = [];
    for (const p of (ctx.liquidityPools.eqh || []).slice(0, 2)) {
      eqParts.push(`EQH $${fmt(p.level)} (×${p.touches})`);
    }
    for (const p of (ctx.liquidityPools.eql || []).slice(0, 2)) {
      eqParts.push(`EQL $${fmt(p.level)} (×${p.touches})`);
    }
    if (eqParts.length) lines.push(`- Liquidity pools: ${eqParts.join(", ")}`);
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

  lines.push("- Gợi ý bias: long khi discount + sweep đáy/EQL + BOS bullish; short khi premium + sweep đỉnh/EQH + BOS bearish. Đảo chiều cần ≥2 tín hiệu reversal + xác nhận HTF.");

  return lines.join("\n");
}

/** 1 dòng gọn cho Telegram alert / pulse. */
export function formatSmcCompactForTelegram(ctx) {
  if (!ctx) return null;
  const parts = [];
  if (ctx.premiumDiscount) {
    const z = { premium: "Premium", discount: "Discount", equilibrium: "EQ" }[ctx.premiumDiscount.zone] || ctx.premiumDiscount.zone;
    parts.push(`${z} (${ctx.premiumDiscount.pctInRange.toFixed(0)}% range)`);
  }
  if (ctx.sweep) {
    const src = ctx.sweep.source === "EQH" || ctx.sweep.source === "EQL" ? ` ${ctx.sweep.source}` : "";
    parts.push(`Sweep ${ctx.sweep.type === "bullish" ? "đáy" : "đỉnh"}${src} $${ctx.sweep.level.toFixed(2)}`);
  }
  if (ctx.structure) {
    parts.push(`${ctx.structure.type} ${ctx.structure.direction}`);
  }
  if (ctx.nearestFvg) {
    const f = ctx.nearestFvg;
    parts.push(`FVG ${f.type} $${f.bottom.toFixed(2)}–$${f.top.toFixed(2)}`);
  }
  if (ctx.rsiDivergence) {
    parts.push(ctx.rsiDivergence.split("—")[0].trim());
  }
  return parts.length ? parts.join(" · ") : null;
}
