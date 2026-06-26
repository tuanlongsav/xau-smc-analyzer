# xau-gemini-proxy

Cloudflare Worker giấu Gemini API key. Frontend `xau-smc-analyzer.pages.dev` gọi qua đây thay vì gọi thẳng Google.

## Deploy lần đầu

```bash
cd worker
npx wrangler login                          # mở trình duyệt, login Cloudflare
npx wrangler deploy                         # deploy → in ra URL https://xau-gemini-proxy.<subdomain>.workers.dev
npx wrangler secret put GEMINI_API_KEY_1    # paste key 1, Enter
npx wrangler secret put GEMINI_API_KEY_2    # (tuỳ chọn) key 2 — rotation khi key 1 bị 429
npx wrangler secret put GEMINI_API_KEY_3    # (tuỳ chọn) key 3
npx wrangler secret put GEMINI_API_KEY_4    # (tuỳ chọn) key 4
npx wrangler secret put GEMINI_API_KEY_5      # (tuỳ chọn) key 5
npx wrangler secret put TWELVEDATA_API_KEY_1  # data XAU/USD — free 800 credits/key/ngày
npx wrangler secret put TWELVEDATA_API_KEY_2  # (tuỳ chọn) key 2 — auto rotate khi key 1 hết quota daily
npx wrangler secret put TWELVEDATA_API_KEY_3  # (tuỳ chọn) key 3
npx wrangler secret put TELEGRAM_BOT_TOKEN    # cho bot + cron alert
npx wrangler secret put TELEGRAM_CHAT_ID      # vd -1001234567890 (group)

# Khuyến nghị (tùy chọn — không set = hành vi cũ, tương thích deploy hiện tại):
npx wrangler secret put ADMIN_SECRET          # bảo vệ /diag, /test-*, /setup-webhook, ...
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # chống spoof webhook; sau đó gọi lại /setup-webhook
```

Sau khi set `TELEGRAM_WEBHOOK_SECRET`, chạy lại webhook (cần `ADMIN_SECRET` nếu đã set):

```bash
curl -H "Authorization: Bearer <ADMIN_SECRET>" \
  "https://xau-gemini-proxy.<subdomain>.workers.dev/setup-webhook"
```

Sau khi deploy, copy URL ra và update `js/config.js` của frontend (field `GEMINI_PROXY_URL`).

## Test

```bash
# Health check (không cần key)
curl https://xau-gemini-proxy.<subdomain>.workers.dev/health
# → {"ok":true,"service":"xau-gemini-proxy","hasKey":true}
```

Test thật phải từ browser ở origin được phép (xem `isAllowedOrigin` trong `src/index.js`) — curl không có Origin sẽ bị 403.

## Rotate key

```bash
npx wrangler secret put GEMINI_API_KEY_1       # paste key mới, ghi đè (hoặc _2/_3/_4/_5)
npx wrangler secret put TWELVEDATA_API_KEY_1   # tương tự cho TD (hoặc _2/_3)
```

TD có 2 loại quota: **daily** (800 credits/key, reset 00:00 UTC) và **per-minute** (8 calls/free).
Worker rotate tự động:
- Daily exhausted → cooldown key đó đến 00:01 UTC hôm sau
- Per-minute / 429 → cooldown 60s
- Lỗi khác → cooldown 2 phút

Xem trạng thái: `curl https://<worker>/health` (field `td_keys_state`) hoặc `/diag?secret=<ADMIN_SECRET>` (khi đã set ADMIN_SECRET).

## Xem logs

```bash
npx wrangler tail
```

## Bảo mật

- Key chỉ tồn tại trong Cloudflare Worker secret, không bao giờ ra client.
- CORS allowlist chỉ chấp nhận `xau-smc-analyzer.pages.dev` + preview branches + localhost.
- Proxy Gemini/TD: từ chối Origin không hợp lệ; request có `ADMIN_SECRET` hợp lệ được bypass (curl debug).
- **`ADMIN_SECRET`** (khuyến nghị): khóa `/diag`, `/test-*`, `/setup-webhook`, `/probe`, … Không set → các route vẫn mở như trước.
- **`TELEGRAM_WEBHOOK_SECRET`** (khuyến nghị): chống POST giả vào `/telegram-webhook`. Không set → hành vi cũ.
- Để tăng cứng thêm: Cloudflare Rate Limiting trên dashboard.
