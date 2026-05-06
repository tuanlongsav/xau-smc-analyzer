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
npx wrangler secret put GEMINI_API_KEY_5    # (tuỳ chọn) key 5
npx wrangler secret put TWELVEDATA_API_KEY  # cho data XAU/USD
npx wrangler secret put TELEGRAM_BOT_TOKEN  # cho bot + cron alert
npx wrangler secret put TELEGRAM_CHAT_ID    # vd -1001234567890 (group)
```

> Backward compat: code vẫn đọc `GEMINI_API_KEY` (= `_1`) và `GEMINI_API_KEY_BACKUP` (= `_2`) nếu tên mới chưa set.

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
npx wrangler secret put GEMINI_API_KEY_1   # paste key mới, ghi đè (hoặc _2/_3/_4/_5)
```

## Xoá key cũ (sau khi migrate sang tên mới)

```bash
npx wrangler secret delete GEMINI_API_KEY         # tên cũ — đã được _1 thay thế
npx wrangler secret delete GEMINI_API_KEY_BACKUP  # tên cũ — đã được _2 thay thế
```

## Xem logs

```bash
npx wrangler tail
```

## Bảo mật

- Key chỉ tồn tại trong Cloudflare Worker secret, không bao giờ ra client.
- CORS allowlist chỉ chấp nhận `xau-smc-analyzer.pages.dev` + preview branches + localhost.
- Browser enforce CORS → web khác không gọi được. Curl/script vẫn có thể nhưng phải fake `Origin` header.
- Để tăng cứng: thêm Cloudflare Rate Limiting rule trên dashboard, hoặc thêm shared-secret header trong code.
