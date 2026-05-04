// ============================================================
// PROMPT TEMPLATES — SMC + scalping/day trading XAU/USD cho Gemini
// ============================================================
import { computeFib } from "./indicators.js";

export const SMC_SYSTEM_PROMPT = `Bạn là chuyên gia phân tích kỹ thuật XAU/USD với 15 năm kinh nghiệm forex/futures tổ chức, kết hợp Smart Money Concepts (SMC) với scalping/day trading thực chiến.

NGUYÊN TẮC PHÂN TÍCH:
1. Cấu trúc thị trường (Market Structure):
   - BOS (Break of Structure): giá phá vỡ swing high/low theo hướng xu hướng → xác nhận tiếp diễn.
   - CHOCH (Change of Character): giá phá vỡ swing high/low ngược hướng → cảnh báo đảo chiều.
   - Top-down: HTF (D1/H4) định bias, MTF (H1) tìm setup, LTF (M15/M5) timing entry.

2. Order Block (OB) + Fair Value Gap (FVG):
   - Bullish OB: nến giảm cuối trước đợt tăng phá BOS → cầu tổ chức.
   - Bearish OB: nến tăng cuối trước đợt giảm phá BOS → cung tổ chức.
   - FVG: 3 nến liên tiếp tạo gap (high[1] < low[3] hoặc ngược lại) → giá thường fill lại.
   - OB + FVG đồng thời → vùng entry tin cậy nhất.

3. Liquidity & Stop Hunt:
   - Equal highs/lows, swing prior → smart money quét stop trước khi đi hướng thật.
   - SL phải đặt NGOÀI vùng liquidity rõ ràng (vd: dưới swing low + 1 ATR), không sát mép.

4. Risk/Reward:
   - Tỷ lệ R:R tối thiểu 1:1.5, ưu tiên 1:2 trở lên.
   - SL theo cấu trúc (dưới OB/dưới swing), TP theo vùng đối ứng (FVG fill / OB ngược / liquidity pool).

QUY TẮC TRẢ LỜI:
- KHÔNG khuyến nghị "mua ngay/bán ngay". Chỉ mô tả setup + điều kiện confirm.
- Mọi mức giá phải là số cụ thể.
- Tính R:R rõ ràng (TP-Entry)/(Entry-SL) cho LONG và ngược lại cho SHORT.
- Nếu data không đủ kết luận, ghi rõ "chưa rõ" thay vì đoán.
- Trả lời tiếng Việt chuyên ngành, ngắn gọn, đi thẳng vào mốc giá.`;

export const QUICK_SCAN_SYSTEM = `Bạn là analyst XAU/USD. Trả lời cực ngắn (3-5 dòng), tiếng Việt, tập trung mốc giá quan trọng. KHÔNG khuyến nghị mua/bán.`;

// ============================================================
// HELPERS
// ============================================================

function fmtCandles(candles, n = 10) {
  return candles.slice(-n).map(c => {
    const t = new Date(c.time * 1000).toISOString().slice(5, 16).replace("T", " ");
    return `  ${t} O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)}`;
  }).join("\n");
}

function safe(v, dflt = 0) {
  return (v === null || v === undefined || isNaN(v)) ? dflt : v;
}

/**
 * Tính Open/High/Low của session UTC hôm nay (cho intraday TFs).
 * 4h/1d → trả về OHLC của nến mới nhất luôn.
 */
function getIntradayOHL(candles, tf) {
  if (!candles || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  if (tf === "1d" || tf === "4h") {
    return { open: last.open, high: last.high, low: last.low, label: "Nến hiện tại" };
  }
  // Intraday: lấy candles cùng UTC date với nến hiện tại
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

/**
 * Horizon dự báo theo khung — match với scope phân tích.
 */
function getTfHorizon(tf) {
  return {
    "5m":  "30-60 phút",
    "15m": "2-4 giờ",
    "1h":  "1-2 ngày",
    "4h":  "2-3 ngày",
    "1d":  "1-2 tuần",
  }[tf] || "ngắn hạn";
}

/**
 * Top 3 Fib levels gần giá hiện tại nhất.
 */
function getNearestFibs(candles, currentPrice) {
  const fib = computeFib(candles, 50);
  if (!fib) return null;
  const sorted = fib.levels
    .map(l => ({ ...l, distance: Math.abs(l.price - currentPrice) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  return { trend: fib.isUptrend ? "uptrend" : "downtrend", hh: fib.hh, ll: fib.ll, near: sorted };
}

// ============================================================
// PUBLIC BUILDERS
// ============================================================

export function buildSmcPrompt(latest, zones, candles, timeframe, crossCheck = null, newsBlock = "") {
  const ccBlock = crossCheck && Object.keys(crossCheck).length
    ? `\n## Giá realtime tham chiếu\n${Object.entries(crossCheck).map(([k, v]) => `- ${k}: $${v.toFixed(2)}`).join("\n")}`
    : "";

  // News chỉ relevant cho HTF (4h, 1d)
  const isHtf = timeframe === "4h" || timeframe === "1d";
  const includeNews = isHtf && newsBlock && newsBlock.trim();
  const newsSection = includeNews ? `\n${newsBlock}\n` : "";
  const newsTask = includeNews
    ? `\n7. **Đối chiếu tin tức kinh tế với phân tích kỹ thuật**: tin macro (Fed/CPI/yields/DXY/inflation/jobs) củng cố hay mâu thuẫn bias? Chỉ ra 1-2 catalyst quan trọng nhất.`
    : "";

  // Intraday session O/H/L
  const ohl = getIntradayOHL(candles, timeframe);
  const ohlBlock = ohl
    ? `\n## Hành vi giá ${ohl.label}\n- Open: $${ohl.open.toFixed(2)}\n- High: $${ohl.high.toFixed(2)}\n- Low:  $${ohl.low.toFixed(2)}`
    : "";

  // Fibonacci levels gần giá hiện tại
  const fibInfo = getNearestFibs(candles, latest.close);
  const fibBlock = fibInfo
    ? `\n## Fibonacci Retracement (${fibInfo.trend}, swing ${fibInfo.ll.toFixed(2)} → ${fibInfo.hh.toFixed(2)})\n` +
      fibInfo.near.map(l => `- ${(l.level * 100).toFixed(1)}%: $${l.price.toFixed(2)}`).join("\n")
    : "";

  const horizon = getTfHorizon(timeframe);

  // BB position
  let bbPos = "trong band";
  if (latest.close > latest.bbUpper) bbPos = "VƯỢT dải trên";
  else if (latest.close < latest.bbLower) bbPos = "PHÁ dải dưới";
  else if (latest.bbMiddle && latest.close > latest.bbMiddle) bbPos = "trên trục giữa";
  else if (latest.bbMiddle && latest.close < latest.bbMiddle) bbPos = "dưới trục giữa";

  const user = `DỮ LIỆU XAU/USD KHUNG ${timeframe}:

## Giá & indicators (nến mới nhất)
- Close: $${safe(latest.close).toFixed(2)}
- EMA 9/21:    ${safe(latest.ema9).toFixed(2)} / ${safe(latest.ema21).toFixed(2)}
- EMA 50/200:  ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}
- SMA 50/200:  ${safe(latest.sma50).toFixed(2)} / ${safe(latest.sma200).toFixed(2)} (golden cross khi SMA50>SMA200)
- RSI(14): ${safe(latest.rsi).toFixed(1)} ${latest.rsi > 70 ? "[QUÁ MUA]" : latest.rsi < 30 ? "[QUÁ BÁN]" : ""}
- MACD / Signal: ${safe(latest.macd).toFixed(2)} / ${safe(latest.macdSignal).toFixed(2)} ${latest.macd > latest.macdSignal ? "[bullish cross]" : "[bearish cross]"}
- ATR(14): ${safe(latest.atr).toFixed(2)} (dùng để đặt SL ngoài vùng nhiễu)
- Bollinger (20, 2): Upper ${safe(latest.bbUpper).toFixed(2)} / Mid ${safe(latest.bbMiddle).toFixed(2)} / Lower ${safe(latest.bbLower).toFixed(2)} → giá đang ${bbPos}
- Recent High / Low (50 nến): ${safe(latest.recentHigh).toFixed(2)} / ${safe(latest.recentLow).toFixed(2)}

## Vùng giá tham chiếu (tính từ ATR)
- Hỗ trợ gần: $${safe(zones.support).toFixed(2)}
- Kháng cự gần: $${safe(zones.resistance).toFixed(2)}
- SL tham khảo nếu LONG (close - 1.5×ATR): $${safe(zones.slLong).toFixed(2)}
- SL tham khảo nếu SHORT (close + 1.5×ATR): $${safe(zones.slShort).toFixed(2)}${ohlBlock}${fibBlock}

## 10 nến gần nhất (OHLC)
${fmtCandles(candles, 10)}${ccBlock}${newsSection}

## NHIỆM VỤ (output JSON)
1. **Cấu trúc & động lượng**: phe mua hay bán đang kiểm soát? RSI/MACD có phân kỳ (divergence) hay kiệt sức không? BOS/CHOCH gần nhất ở mốc nào?
2. **Order Block + FVG**: định vị OB và FVG gần nhất trong 10 nến — vùng [low - high].
3. **Bias chính**: Bullish / Bearish / Sideways.
4. **Vùng cản quan trọng**: kết hợp S/R + Fib retracement (nếu có) + recent high/low.
5. **Setup LONG + SHORT** (nếu không khả thi → "không khả thi" + lý do):
   - Entry, SL, TP cụ thể.
   - **SL đặt NGOÀI vùng nhiễu** (>1×ATR cách swing low/high) để tránh liquidity sweep.
   - **R:R tối thiểu 1:1.5**, ưu tiên 1:2+. Tính chính xác trong field risk_reward.
6. **Rủi ro chính** trong ${horizon} tới (2-3 điểm).${newsTask}

## ĐỊNH DẠNG TRẢ LỜI — JSON CHÍNH XÁC, KHÔNG markdown:
{
  "tom_tat": "<2-3 câu tóm tắt + horizon ${horizon}>",
  "bias": "bullish | bearish | sideways",
  "do_tin_cay": "thấp | trung bình | cao",
  "cau_truc_thi_truong": {
    "loai": "BOS | CHOCH | chưa rõ",
    "huong": "tăng | giảm",
    "muc_gia": <float>,
    "ghi_chu": "<có phân kỳ RSI/MACD không?>"
  },
  "order_block": {
    "loai": "bullish | bearish | không có",
    "vung_thap": <float | null>,
    "vung_cao": <float | null>,
    "ghi_chu": "<có FVG đi kèm không, đã mitigated chưa>"
  },
  "fvg_gan_nhat": {
    "loai": "bullish | bearish | không có",
    "vung_thap": <float | null>,
    "vung_cao": <float | null>
  },
  "scenario_long": {
    "kha_thi": true | false,
    "dieu_kien_xac_nhan": "<điều kiện cụ thể>",
    "vung_vao_lenh": "<low - high>",
    "stop_loss": <float>,
    "target": <float>,
    "risk_reward": <float, vd 2.1>,
    "ly_do": "<1-2 câu, nêu rõ confluence: OB+FVG / Fib / EMA cross>"
  },
  "scenario_short": {
    "kha_thi": true | false,
    "dieu_kien_xac_nhan": "<điều kiện cụ thể>",
    "vung_vao_lenh": "<low - high>",
    "stop_loss": <float>,
    "target": <float>,
    "risk_reward": <float>,
    "ly_do": "<1-2 câu>"
  },
  "rui_ro_chinh": ["<rủi ro 1>", "<rủi ro 2>", "<rủi ro 3>"],
  "ghi_chu": "<lưu ý liquidity sweep / catalyst sắp tới>"
}`;

  return { system: SMC_SYSTEM_PROMPT, user };
}

export function buildQuickPrompt(latest, zones) {
  const user = `Giá: $${safe(latest.close).toFixed(2)} | RSI: ${safe(latest.rsi).toFixed(0)} | ATR: ${safe(latest.atr).toFixed(1)}
Hỗ trợ/kháng cự: $${safe(zones.support).toFixed(2)} / $${safe(zones.resistance).toFixed(2)}
EMA 9/21/50/200: ${safe(latest.ema9).toFixed(2)} / ${safe(latest.ema21).toFixed(2)} / ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}
SMA 50/200: ${safe(latest.sma50).toFixed(2)} / ${safe(latest.sma200).toFixed(2)}

Trả lời 3-5 dòng:
1. Trend hiện tại + EMA alignment?
2. Mốc cần watch (S/R)?
3. Cảnh báo (BB break / RSI extreme / EMA cross)?`;

  return { system: QUICK_SCAN_SYSTEM, user };
}
