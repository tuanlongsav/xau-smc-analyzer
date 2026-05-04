// ============================================================
// CẤU HÌNH API KEYS
// ============================================================
//
// ⚠️ BẢO MẬT QUAN TRỌNG TRƯỚC KHI PUSH LÊN GITHUB ⚠️
//
// Cả 2 key bên dưới sẽ visible trong source HTML khi deploy.
// Để tránh bị abuse, BẮT BUỘC thiết lập restriction:
//
// 1. GEMINI_API_KEY — Google Cloud Console (https://console.cloud.google.com/apis/credentials):
//    - Edit key → Application restrictions → "HTTP referrers (web sites)"
//    - Thêm: https://YOUR_USERNAME.github.io/xau-smc-analyzer/*
//    - Có thể thêm http://localhost:* để test local
//    - Sau khi set → key chỉ hoạt động từ domain này, copy ra nơi khác sẽ fail.
//
// 2. TWELVEDATA_API_KEY — KHÔNG có HTTP referrer restriction trên free tier.
//    Free tier 800 req/ngày → nếu bị abuse sẽ hết quota, không bị bill.
//    Có thể tạo key riêng cho web app (khác key Docker dashboard).
//    Tham khảo: https://twelvedata.com/account/api-keys
//
// 3. Khi cần đổi key: chỉnh trực tiếp file này, commit + push.
// ============================================================

export const CONFIG = {
  GEMINI_API_KEY: "AIzaSyChIlQ3bP1bQbRaM48zS9vA46sRlHj1Stk",
  TWELVEDATA_API_KEY: "d6b0258d6529400a9a4f7670ae7cb35a",

  // Gemini model — 2.5-flash nhanh + free, lite làm fallback khi flash 503
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",

  // TwelveData symbol
  SYMBOL: "XAU/USD",

  // Số nến lấy về cho mỗi khung (max free tier mỗi req)
  // 5m × 1000 ≈ 3.5 ngày, 1h × 1000 ≈ 42 ngày
  OUTPUT_SIZE: 1000,

  // Intervals hợp lệ TwelveData → key chuẩn nội bộ
  INTERVALS: {
    "5min":  "5m",
    "15min": "15m",
    "1h":    "1h",
    "4h":    "4h",
    "1day":  "1d",
  },
};
