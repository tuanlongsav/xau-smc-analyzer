// ============================================================
// PROMPT TEMPLATES — SMC analysis cho Gemini
// ============================================================

export const SMC_SYSTEM_PROMPT = `Bạn là chuyên gia phân tích kỹ thuật XAU/USD chuyên sâu về SMC (Smart Money Concepts) với 15 năm kinh nghiệm trên thị trường vàng và forex tổ chức.

NGUYÊN TẮC PHÂN TÍCH:
1. Cấu trúc thị trường (Market Structure):
   - BOS (Break of Structure): giá phá vỡ swing high/low theo hướng xu hướng → xác nhận tiếp diễn.
   - CHOCH (Change of Character): giá phá vỡ swing high/low ngược hướng → cảnh báo đảo chiều.
   - Top-down: HTF (D1/H4) định bias, MTF (H1) tìm setup, LTF (M15/M5) timing entry.

2. Order Block (OB):
   - Bullish OB: nến giảm cuối cùng trước đợt tăng phá BOS → vùng cầu tổ chức.
   - Bearish OB: nến tăng cuối cùng trước đợt giảm phá BOS → vùng cung tổ chức.
   - OB đáng tin: gắn với BOS, có FVG đi kèm, chưa bị mitigated.

3. Fair Value Gap (FVG / Imbalance):
   - 3 nến liên tiếp: high của nến 1 < low của nến 3 (FVG bullish) hoặc ngược lại.
   - Giá thường quay lại fill FVG trước khi đi tiếp → vùng entry tiềm năng.

4. Liquidity zones:
   - Equal highs/lows, swing prior, Asian range → smart money quét stop trước khi ra hướng thật.

QUY TẮC TRẢ LỜI:
- KHÔNG khuyến nghị "mua ngay/bán ngay". Chỉ mô tả setup + điều kiện confirm.
- Mọi mức giá phải là số cụ thể.
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

// ============================================================
// PUBLIC BUILDERS
// ============================================================

/**
 * Build SMC user prompt từ indicators + candles.
 * @param {object} latest - last bar indicators
 * @param {object} zones - support/resistance zones
 * @param {Array} candles - OHLCV array
 * @param {string} timeframe - '5m' | '15m' | ...
 * @param {object} crossCheck - { twelvedata: price } (single source for web version)
 * @param {string} newsBlock - pre-formatted news block (chỉ inject khi tf === "1d")
 */
export function buildSmcPrompt(latest, zones, candles, timeframe, crossCheck = null, newsBlock = "") {
  const ccBlock = crossCheck && Object.keys(crossCheck).length
    ? `\n## Giá realtime tham chiếu\n${Object.entries(crossCheck).map(([k, v]) => `- ${k}: $${v.toFixed(2)}`).join("\n")}`
    : "";

  // News chỉ relevant khi phân tích khung ngày — macro/Fed/CPI tác động xu hướng trung-dài hạn,
  // intraday chủ yếu là price action thuần kỹ thuật.
  const includeNews = timeframe === "1d" && newsBlock && newsBlock.trim();
  const newsSection = includeNews ? `\n${newsBlock}\n` : "";
  const newsTask = includeNews
    ? "\n6. **Đối chiếu tin tức macro với phân tích kỹ thuật**: tin tức trên có củng cố hay mâu thuẫn bias không? Chỉ ra 1-2 catalyst quan trọng nhất ảnh hưởng xu hướng 1-2 tuần tới."
    : "";

  const user = `DỮ LIỆU XAU/USD KHUNG ${timeframe}:

## Giá & indicators (nến mới nhất)
- Close: $${safe(latest.close).toFixed(2)}
- EMA 20/50/200: ${safe(latest.ema20).toFixed(2)} / ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}
- RSI(14): ${safe(latest.rsi).toFixed(1)}
- MACD / Signal: ${safe(latest.macd).toFixed(2)} / ${safe(latest.macdSignal).toFixed(2)}
- ATR(14): ${safe(latest.atr).toFixed(2)}
- Bollinger Upper / Lower: ${safe(latest.bbUpper).toFixed(2)} / ${safe(latest.bbLower).toFixed(2)}
- Recent High / Low (50 nến): ${safe(latest.recentHigh).toFixed(2)} / ${safe(latest.recentLow).toFixed(2)}

## Vùng giá tham chiếu (tính từ ATR)
- Hỗ trợ gần: $${safe(zones.support).toFixed(2)}
- Kháng cự gần: $${safe(zones.resistance).toFixed(2)}
- SL tham khảo nếu LONG: $${safe(zones.slLong).toFixed(2)}
- SL tham khảo nếu SHORT: $${safe(zones.slShort).toFixed(2)}

## 10 nến gần nhất (OHLC)
${fmtCandles(candles, 10)}${ccBlock}${newsSection}

## NHIỆM VỤ
1. Xác định cấu trúc thị trường hiện tại (BOS/CHOCH gần nhất + mốc giá).
2. Định vị Order Block và FVG gần nhất trong 10 nến — ghi rõ vùng [low - high].
3. Nhận định bias chính: Bullish / Bearish / Sideways.
4. Đề xuất 1 setup LONG và 1 setup SHORT (nếu không khả thi, ghi "không khả thi" + lý do).
5. Liệt kê 2-3 rủi ro chính cho 24h tới.${newsTask}

## ĐỊNH DẠNG TRẢ LỜI — JSON CHÍNH XÁC, KHÔNG markdown:
{
  "tom_tat": "<2-3 câu tóm tắt>",
  "bias": "bullish | bearish | sideways",
  "do_tin_cay": "thấp | trung bình | cao",
  "cau_truc_thi_truong": {
    "loai": "BOS | CHOCH | chưa rõ",
    "huong": "tăng | giảm",
    "muc_gia": <float>,
    "ghi_chu": "<1 câu>"
  },
  "order_block": {
    "loai": "bullish | bearish | không có",
    "vung_thap": <float | null>,
    "vung_cao": <float | null>,
    "ghi_chu": "<1 câu>"
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
    "ly_do": "<1-2 câu>"
  },
  "scenario_short": {
    "kha_thi": true | false,
    "dieu_kien_xac_nhan": "<điều kiện cụ thể>",
    "vung_vao_lenh": "<low - high>",
    "stop_loss": <float>,
    "target": <float>,
    "ly_do": "<1-2 câu>"
  },
  "rui_ro_chinh": ["<rủi ro 1>", "<rủi ro 2>", "<rủi ro 3>"],
  "ghi_chu": "<lưu ý>"
}`;

  return { system: SMC_SYSTEM_PROMPT, user };
}

export function buildQuickPrompt(latest, zones) {
  const user = `Giá: $${safe(latest.close).toFixed(2)} | RSI: ${safe(latest.rsi).toFixed(0)} | ATR: ${safe(latest.atr).toFixed(1)}
Hỗ trợ/kháng cự: $${safe(zones.support).toFixed(2)} / $${safe(zones.resistance).toFixed(2)}
EMA 20/50/200: ${safe(latest.ema20).toFixed(2)} / ${safe(latest.ema50).toFixed(2)} / ${safe(latest.ema200).toFixed(2)}

Trả lời 3-5 dòng:
1. Trend hiện tại?
2. Mốc cần watch?
3. Cảnh báo nếu có?`;

  return { system: QUICK_SCAN_SYSTEM, user };
}
