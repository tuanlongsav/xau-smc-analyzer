# 🥇 XAU/USD SMC Analyzer

## ✨ Tính năng

- 📊 **Chart real-time** XAU/USD (5m / 15m / 1h / 4h / 1d) từ TwelveData
- 📈 **Indicators tự tính**: EMA 20/50/200, RSI, MACD, ATR, Bollinger Bands
- 🚨 **Cảnh báo rule-based**: RSI extreme, MACD cross, BB breakout, Golden/Death Cross
- 📰 **RSS news** từ FXStreet + Kitco — đưa headlines vào prompt AI để cân nhắc tin tức khi phân tích bias
- 🤖 **Phân tích SMC bằng Gemini 2.5 Flash**:
  - Cấu trúc thị trường (BOS/CHOCH)
  - Order Block + FVG gần nhất
  - Setup LONG/SHORT với điều kiện confirm + SL/TP
  - 2-3 rủi ro chính
- 🔬 **Multi-timeframe analysis**: chạy song song nhiều khung → banner đồng thuận top-down
- ⚡ **Quick scan**: tóm tắt nhanh 3-5 dòng (~2-5s)
- 📜 **Lịch sử phân tích** lưu localStorage (50 bản gần nhất)
- 🌓 **Dark/light mode**, mobile responsive
- 📱 **PWA installable** — Add to Home Screen trên iOS/Android, chạy fullscreen như native app
- 🔄 **Auto retry + fallback** khi Gemini 503 (flash → flash-lite)
