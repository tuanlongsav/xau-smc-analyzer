// ============================================================
// PROMPT TEMPLATES — XAU/USD scalping/day trading + SMC overlay
// ============================================================
// Cấu trúc 3 tasks (theo chuẩn TA professional):
//   1. Cấu trúc & Động lượng (phe kiểm soát? RSI/MACD phân kỳ?)
//   2. Vùng cản quan trọng (S/R + Fibonacci nếu vừa có sóng đẩy)
//   3. Kế hoạch giao dịch (kịch bản chính + entry/SL/TP/R:R cho LONG và SHORT)
import { computeFib } from "./indicators.js";
import { analyzeSmcContext, formatSmcContextForPrompt } from "./smc-detect.js";

export const SMC_SYSTEM_PROMPT = `Bạn là chuyên gia phân tích kỹ thuật và giao dịch XAU/USD chuyên nghiệp với 15 năm kinh nghiệm scalping/day trading + Smart Money Concepts (SMC).

NGUYÊN TẮC:
1. Cấu trúc & Động lượng:
   - Xác định phe đang kiểm soát (mua/bán) qua biên độ High-Low + vị trí giá hiện tại trong range.
   - BOS (Break of Structure) / CHOCH (Change of Character) làm anchor cho bias.
   - Phát hiện phân kỳ (divergence) RSI/MACD vs price hoặc dấu hiệu kiệt sức (RSI quá mua/bán + suy yếu momentum).

2. Vùng cản (S/R):
   - Recent swing high/low + Pivot points + Fibonacci retracement (nếu giá vừa trải qua sóng đẩy mạnh).
   - Order Block / FVG nếu có — giúp xác nhận vùng entry tin cậy.

3. Kế hoạch giao dịch:
   - Đặt SL NGOÀI vùng nhiễu giá (>1×ATR cách swing low/high) để tránh liquidity sweep / stop hunt.
   - R:R tối thiểu 1:1.5, ưu tiên 1:2+. Tính chính xác (TP-Entry)/(Entry-SL) cho LONG và (Entry-TP)/(SL-Entry) cho SHORT.
   - Horizon dự báo cụ thể theo TF.

QUY TẮC TRẢ LỜI:
- KHÔNG khuyến nghị "mua ngay/bán ngay". Chỉ mô tả setup + điều kiện confirm.
- Mọi mức giá phải là số cụ thể (float).
- Nếu data không đủ → ghi "chưa rõ" / kha_thi=false.
- Tiếng Việt chuyên ngành, ngắn gọn, đi thẳng vào mốc giá.`;

export const QUICK_SCAN_SYSTEM = `Bạn là analyst XAU/USD. Trả lời cực ngắn (3-5 dòng), tiếng Việt, tập trung mốc giá quan trọng. KHÔNG khuyến nghị mua/bán.`;

// ============================================================
// HELPERS
// ============================================================

function safe(v, dflt = 0) {
  return (v === null || v === undefined || isNaN(v)) ? dflt : v;
}

function fmtCandles(candles, n = 10) {
  return candles.slice(-n).map(c => {
    const t = new Date(c.time * 1000).toISOString().slice(5, 16).replace("T", " ");
    return `  ${t} O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`;
  }).join("\n");
}

function getIntradayOHL(candles, tf) {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  if (tf === "1d" || tf === "4h") {
    return { open: last.open, high: last.high, low: last.low, label: "Nến hiện tại" };
  }
  const lastDate = new Date(last.time * 1000);
  const dayStart = Date.UTC(lastDate.getUTCFullYear(), lastDate.getUTCMonth(), lastDate.getUTCDate()) / 1000;
  const todays = candles.filter(c => c.time >= dayStart);
  if (todays.length === 0) return null;
  return {
    open: todays[0].open,
    high: Math.max(...todays.map(c => c.high)),
    low: Math.min(...todays.map(c => c.low)),
    label: `Phiên UTC hôm nay (${todays.length} nến)`,
  };
}

function getTfHorizon(tf) {
  return {
    "5m":  "30-60 phút",
    "15m": "2-4 giờ",
    "1h":  "1-2 ngày",
    "4h":  "2-3 ngày",
    "1d":  "1-2 tuần",
  }[tf] || "ngắn hạn";
}

function getNearestFibs(candles, currentPrice) {
  const fib = computeFib(candles, 50);
  if (!fib) return null;
  const sorted = fib.levels
    .map(l => ({ ...l, distance: Math.abs(l.price - currentPrice) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  return { trend: fib.isUptrend ? "uptrend" : "downtrend", hh: fib.hh, ll: fib.ll, near: sorted };
}

function describeBbPosition(latest) {
  if (!latest.bbUpper || !latest.bbLower) return "chưa rõ";
  if (latest.close > latest.bbUpper) return "VƯỢT dải trên (overbought zone)";
  if (latest.close < latest.bbLower) return "PHÁ dải dưới (oversold zone)";
  if (latest.bbMiddle && latest.close > latest.bbMiddle) return "trên trục giữa (bull territory)";
  if (latest.bbMiddle && latest.close < latest.bbMiddle) return "dưới trục giữa (bear territory)";
  return "dao động quanh trục giữa";
}

function describeMacd(latest) {
  if (latest.macd == null || latest.macdSignal == null) return "chưa rõ";
  const cross = latest.macd > latest.macdSignal ? "cắt LÊN đường tín hiệu (bullish)" : "cắt XUỐNG đường tín hiệu (bearish)";
  const histVal = latest.macd - latest.macdSignal;
  const hist = histVal > 0 ? `histogram dương ${histVal.toFixed(2)}` : `histogram âm ${histVal.toFixed(2)}`;
  return `${cross}, ${hist}`;
}

// ============================================================
// PUBLIC BUILDERS
// ============================================================

export function buildSmcPrompt(latest, zones, candles, timeframe, crossCheck = null, newsBlock = "", prev = null, htfBlock = "") {
  const updateTime = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const prevCandle = prev ?? (candles.length >= 2 ? candles[candles.length - 2] : null);
  const smcCtx = analyzeSmcContext(candles, latest, prevCandle);
  const smcBlock = formatSmcContextForPrompt(smcCtx, latest);
  const ohl = getIntradayOHL(candles, timeframe);
  const fibInfo = getNearestFibs(candles, latest.close);
  const horizon = getTfHorizon(timeframe);

  const ccBlock = crossCheck && Object.keys(crossCheck).length
    ? `\n- Spot realtime: ${Object.entries(crossCheck).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(", ")}`
    : "";

  const isHtf = timeframe === "4h" || timeframe === "1d";
  const includeNews = isHtf && newsBlock && newsBlock.trim();
  const macroBlock = includeNews
    ? `\n## Bối cảnh vĩ mô (Macro)\n${newsBlock.trim()}`
    : `\n## Bối cảnh vĩ mô (Macro)\n(Không có dữ liệu kinh tế quan trọng — phân tích thuần kỹ thuật.)`;

  const ohlBlock = ohl
    ? `- Hành vi giá ${ohl.label}: Open $${ohl.open.toFixed(2)}, High $${ohl.high.toFixed(2)}, Low $${ohl.low.toFixed(2)}`
    : "";

  const fibBlock = fibInfo
    ? `\n## Fibonacci Retracement (${fibInfo.trend}, swing ${fibInfo.ll.toFixed(2)} → ${fibInfo.hh.toFixed(2)})\n` +
      fibInfo.near.map(l => `- ${(l.level * 100).toFixed(1)}%: $${l.price.toFixed(2)}`).join("\n")
    : "";

  const user = `# DỮ LIỆU XAU/USD KHUNG ${timeframe} — Cập nhật ${updateTime}

## Giá & Hành vi
- Giá hiện tại: $${safe(latest.close).toFixed(2)}${ccBlock}
${ohlBlock}
- Recent High/Low (50 nến): $${safe(latest.recentHigh).toFixed(2)} / $${safe(latest.recentLow).toFixed(2)}

## Chỉ báo Xu hướng (Trend)
- EMA 9 / 21:    ${safe(latest.ema9).toFixed(2)} / ${safe(latest.ema21).toFixed(2)}
- EMA 50 / 200:  ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}
- SMA 50 / 200:  ${safe(latest.sma50).toFixed(2)} / ${safe(latest.sma200).toFixed(2)} ${latest.sma50 > latest.sma200 ? "(SMA50>SMA200 — bullish trend)" : "(SMA50<SMA200 — bearish trend)"}
- Bollinger (20, 2): Upper ${safe(latest.bbUpper).toFixed(2)} / Mid ${safe(latest.bbMiddle).toFixed(2)} / Lower ${safe(latest.bbLower).toFixed(2)} → giá đang ${describeBbPosition(latest)}

## Chỉ báo Động lượng (Momentum)
- RSI(14): ${safe(latest.rsi).toFixed(1)} ${latest.rsi > 70 ? "[QUÁ MUA — cảnh báo điều chỉnh]" : latest.rsi < 30 ? "[QUÁ BÁN — cảnh báo phục hồi]" : "[trung tính]"}
- MACD: ${describeMacd(latest)}

## Chỉ báo Biến động (Volatility)
- ATR(14): ${safe(latest.atr).toFixed(2)} (dùng đặt SL cách swing >1×ATR để tránh liquidity sweep)

## Vùng giá tham chiếu
- Hỗ trợ gần: $${safe(zones.support).toFixed(2)}
- Kháng cự gần: $${safe(zones.resistance).toFixed(2)}
${zones.equilibrium != null ? `- Equilibrium (50% range): $${safe(zones.equilibrium).toFixed(2)} — giá đang ở vùng ${zones.premiumDiscount || "?"}` : ""}${fibBlock}

## Phân tích SMC (rule-based — dùng làm anchor, có thể bổ sung nếu thấy setup khác)
${smcBlock}
${htfBlock}
## 10 nến gần nhất (OHLC)
${fmtCandles(candles, 10)}${macroBlock}

# YÊU CẦU PHÂN TÍCH (3 tasks)

**TASK 1 — Đánh giá Cấu trúc & Động lượng (${timeframe})**
- Dựa vào block SMC rule-based ở trên + OHLC: phe MUA hay BÁN đang nắm quyền kiểm soát?
- Xác nhận hoặc điều chỉnh BOS/CHOCH, OB/FVG — ưu tiên setup có liquidity sweep + displacement (confluence model).
- Long chỉ khả thi khi discount zone + bullish sweep/FVG/OB; short khi premium + bearish confluence.
- Sự kết hợp RSI + MACD có dấu hiệu kiệt sức (exhaustion) hay phân kỳ (divergence) báo hiệu đảo chiều không?

**TASK 2 — Xác định Vùng Cản Quan Trọng**
- Liệt kê 2 mức KHÁNG CỰ và 2 mức HỖ TRỢ gần nhất (ưu tiên có confluence: swing + Fib + EMA + Pivot).
- Nếu giá vừa trải qua sóng đẩy mạnh → chỉ ra Fib retracement level đang active (ví dụ "đang test Fib 0.618 ở $X").

**TASK 3 — Kế hoạch Giao dịch (Action plan, horizon ${horizon})**
- Dự báo kịch bản xác suất cao nhất trong ${horizon} tới (long / short / sideways).
- Đưa ra setup LONG và SHORT (nếu không khả thi → kha_thi=false + lý do):
  - Entry point cụ thể (số chính xác).
  - Stop Loss đặt NGOÀI vùng nhiễu (>1×ATR cách swing) để tránh liquidity sweep.
  - Take Profit theo R:R tối thiểu 1:1.5, ưu tiên 1:2+.
  - Tính chính xác risk_reward = (TP-Entry)/(Entry-SL) cho LONG.

# ĐỊNH DẠNG TRẢ LỜI — JSON CHÍNH XÁC, KHÔNG markdown:
{
  "tom_tat": "<2-3 câu tóm tắt: phe nào control + horizon + setup chính>",
  "bias": "bullish | bearish | sideways",
  "do_tin_cay": "thấp | trung bình | cao",

  "task1_cau_truc_dong_luong": {
    "phe_kiem_soat": "phe mua | phe bán | trung lập",
    "ly_do_kiem_soat": "<1-2 câu giải thích dựa vào H/L/giá hiện tại>",
    "bos_choch": {
      "loai": "BOS | CHOCH | chưa rõ",
      "huong": "tăng | giảm | -",
      "muc_gia": <float>
    },
    "order_block_fvg": "<mô tả OB/FVG còn fresh nếu có, hoặc 'không có'>",
    "rsi_macd_signal": "phân kỳ bullish | phân kỳ bearish | kiệt sức quá mua | kiệt sức quá bán | bình thường",
    "phan_tich_dong_luong": "<1-2 câu kết luận về momentum>"
  },

  "task2_vung_can": {
    "khang_cu": [
      { "gia": <float>, "ghi_chu": "<vd: swing high + EMA 50 + Fib 0.5 confluence>" },
      { "gia": <float>, "ghi_chu": "..." }
    ],
    "ho_tro": [
      { "gia": <float>, "ghi_chu": "..." },
      { "gia": <float>, "ghi_chu": "..." }
    ],
    "fib_active": "<vd: 'đang test Fib 0.618 ở 2345.50' hoặc 'không có sóng đẩy gần đây'>"
  },

  "task3_ke_hoach": {
    "kich_ban_chinh": "long | short | sideways",
    "horizon": "${horizon}",
    "ly_do_kich_ban": "<1-2 câu>"
  },

  "scenario_long": {
    "kha_thi": true | false,
    "dieu_kien_xac_nhan": "<vd: 'giá đóng cửa M15 trên $X + RSI > 50'>",
    "entry": <float>,
    "stop_loss": <float>,
    "take_profit": <float>,
    "risk_reward": <float, vd 2.1>,
    "ly_do": "<confluence + tại sao SL ở vị trí này (ngoài liquidity)>"
  },
  "scenario_short": {
    "kha_thi": true | false,
    "dieu_kien_xac_nhan": "...",
    "entry": <float>,
    "stop_loss": <float>,
    "take_profit": <float>,
    "risk_reward": <float>,
    "ly_do": "..."
  },

  "rui_ro_chinh": [
    "<rủi ro 1: vd liquidity sweep dưới $X>",
    "<rủi ro 2: vd tin macro sắp ra>",
    "<rủi ro 3>"
  ],
  "ghi_chu": "<lưu ý đặc biệt nếu có catalyst sắp tới hoặc setup thiếu confluence>"
}`;

  return { system: SMC_SYSTEM_PROMPT, user };
}

export function buildQuickPrompt(latest, zones, candles = null, prev = null) {
  const prevCandle = prev ?? (candles?.length >= 2 ? candles[candles.length - 2] : null);
  let smcExtra = "";
  if (candles && latest) {
    const ctx = analyzeSmcContext(candles, latest, prevCandle);
    const parts = [];
    if (ctx.premiumDiscount) {
      parts.push(`zone ${ctx.premiumDiscount.zone} (${ctx.premiumDiscount.pctInRange.toFixed(0)}% range)`);
    }
    if (ctx.sweep) parts.push(`sweep ${ctx.sweep.type} @$${ctx.sweep.level.toFixed(2)}`);
    if (ctx.structure) parts.push(`${ctx.structure.type} ${ctx.structure.direction}`);
    if (parts.length) smcExtra = `\nSMC: ${parts.join(" | ")}`;
  }
  const user = `Giá: $${safe(latest.close).toFixed(2)} | RSI: ${safe(latest.rsi).toFixed(0)} | ATR: ${safe(latest.atr).toFixed(1)}
S/R: $${safe(zones.support).toFixed(2)} / $${safe(zones.resistance).toFixed(2)}
EMA 9/21/50/200: ${safe(latest.ema9).toFixed(2)} / ${safe(latest.ema21).toFixed(2)} / ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}
SMA 50/200: ${safe(latest.sma50).toFixed(2)} / ${safe(latest.sma200).toFixed(2)}${smcExtra}

Trả lời 3-5 dòng:
1. Phe nào kiểm soát + trend?
2. Mốc S/R cần watch?
3. Cảnh báo (BB break / RSI extreme / EMA cross)?`;

  return { system: QUICK_SCAN_SYSTEM, user };
}
