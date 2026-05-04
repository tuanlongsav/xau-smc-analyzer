# 🥇 XAU/USD SMC Analyzer

Phân tích kỹ thuật **giá vàng XAU/USD** theo phương pháp **Smart Money Concepts (SMC)** với **Gemini AI**, chạy hoàn toàn trên trình duyệt.

🌐 **Demo**: https://tuanlongsav.github.io/xau-smc-analyzer/

## ✨ Tính năng

- 📊 **Chart real-time** XAU/USD (5m / 15m / 1h / 4h / 1d) từ TwelveData
- 📈 **Indicators tự tính**: EMA 20/50/200, RSI, MACD, ATR, Bollinger Bands
- 🚨 **Cảnh báo rule-based**: RSI extreme, MACD cross, BB breakout, Golden/Death Cross
- 🤖 **Phân tích SMC bằng Gemini 2.5 Flash**:
  - Cấu trúc thị trường (BOS/CHOCH)
  - Order Block + FVG gần nhất
  - Setup LONG/SHORT với điều kiện confirm + SL/TP
  - 2-3 rủi ro chính
- 🔬 **Multi-timeframe analysis**: chạy song song nhiều khung → banner đồng thuận top-down
- ⚡ **Quick scan**: tóm tắt nhanh 3-5 dòng (~2-5s)
- 📜 **Lịch sử phân tích** lưu localStorage (50 bản gần nhất)
- 🌓 **Dark/light mode**, mobile responsive
- 🔄 **Auto retry + fallback** khi Gemini 503 (flash → flash-lite)

## 🏗️ Cấu trúc

```
xau-smc-analyzer/
├── index.html          ← UI chính
├── js/
│   ├── config.js       ← API keys + cấu hình
│   ├── data.js         ← TwelveData fetcher
│   ├── indicators.js   ← TA calculations (EMA, RSI, MACD, ATR, BB)
│   ├── prompts.js      ← SMC system prompt + builder
│   ├── gemini.js       ← Gemini REST API client (retry + fallback)
│   ├── chart.js        ← TradingView Lightweight Charts wrapper
│   └── app.js          ← Main UI logic + state
├── css/style.css       ← Custom styles ngoài Tailwind
└── README.md
```

**Tech stack** (toàn bộ qua CDN, không build):
- [Tailwind CSS](https://tailwindcss.com) (Play CDN)
- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) v4.2
- [Gemini API](https://ai.google.dev/) REST trực tiếp
- [TwelveData API](https://twelvedata.com/) free tier

## 🚀 Deploy lên GitHub Pages

### Lần đầu (đã làm)
```bash
git remote add origin git@github.com:tuanlongsav/xau-smc-analyzer.git
git push -u origin main
```

### Enable GitHub Pages
1. Vào https://github.com/tuanlongsav/xau-smc-analyzer/settings/pages
2. **Source**: Deploy from a branch
3. **Branch**: `main` / `/ (root)`
4. **Save** → đợi ~1 phút
5. Site live tại: https://tuanlongsav.github.io/xau-smc-analyzer/

### Update sau này
Chỉ cần `git push` lên main → GitHub Pages tự deploy lại.

## 🔐 Bảo mật API key

Cả 2 key (Gemini + TwelveData) được hardcode trong `js/config.js` và **sẽ public** khi push lên GitHub. Bảo vệ bằng các lớp sau:

### 1. Gemini API key — HTTP Referrer Restriction (CRITICAL)
Phải thiết lập trước khi push:
1. Vào https://console.cloud.google.com/apis/credentials
2. Edit key → **Application restrictions** → **Websites**
3. Thêm:
   ```
   https://tuanlongsav.github.io/xau-smc-analyzer/*
   https://tuanlongsav.github.io/*
   http://localhost:*/*
   http://127.0.0.1:*/*
   ```
4. Save. Key chỉ hoạt động khi origin khớp 4 URL trên.

### 2. TwelveData free tier — rate limit là barrier
- Free tier: 800 req/ngày, 8 req/phút
- Không hỗ trợ HTTP referrer restriction
- Nếu bị abuse → hết quota 1 ngày, **không bị bill**
- Có thể tạo key riêng (khác key dùng nội bộ)

### 3. Đổi key
Khi cần đổi key (nghi lộ, rotate định kỳ):
1. Tạo key mới trên Cloud Console / TwelveData
2. Sửa `js/config.js`
3. `git commit -am "rotate api keys" && git push`

## 🧪 Test local trước khi deploy

```bash
# Trong thư mục xau-smc-analyzer
python3 -m http.server 8080
# Mở http://localhost:8080
```

> Đảm bảo `http://localhost:*/*` đã có trong HTTP referrer của Gemini key.

## 📝 Cấu hình bổ sung

Sửa `js/config.js`:
- `GEMINI_MODEL`: `gemini-2.5-flash` (default), `gemini-2.5-pro` (chậm hơn nhưng sâu)
- `OUTPUT_SIZE`: số nến mỗi lần fetch (max 5000 free tier)

## ⚠️ Disclaimer

Công cụ này phục vụ **phân tích kỹ thuật cá nhân**. KHÔNG phải khuyến nghị đầu tư.
AI và indicators có thể sai. Mọi quyết định mua/bán và rủi ro tài chính thuộc về người dùng.

Áp dụng quản trị rủi ro nghiêm ngặt:
- Không risk quá 1-2% tài khoản mỗi lệnh
- Luôn dùng stop loss
- Đa dạng hoá
- **TEST TRÊN DEMO TRƯỚC**

## 📄 License

MIT
