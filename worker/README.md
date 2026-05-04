# xau-gemini-proxy

Cloudflare Worker giấu Gemini API key. Frontend `xau-smc-analyzer.pages.dev` gọi qua đây thay vì gọi thẳng Google.

## Deploy lần đầu

```bash
cd worker
npx wrangler login                       # mở trình duyệt, login Cloudflare
npx wrangler deploy                      # deploy → in ra URL https://xau-gemini-proxy.<subdomain>.workers.dev
npx wrangler secret put GEMINI_API_KEY   # paste key từ clipboard, Enter
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
npx wrangler secret put GEMINI_API_KEY   # paste key mới, ghi đè
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
