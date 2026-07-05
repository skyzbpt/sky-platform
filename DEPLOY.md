# 部署到 Cloudflare

本專案已改為 **Cloudflare Workers（靜態資產 + KV 儲存）** 架構：

```
public/          靜態頁面（index.html、logo.png、favicon），由 Workers Assets 直接服務
src/worker.js    Worker：/api/state 讀寫 KV 狀態，其餘路徑回退到靜態資產
wrangler.jsonc   Wrangler 設定（已綁定 KV namespace：sky-platform-store）
```

資料儲存於 KV（namespace `sky-platform-store`，id `82ba4ca48a8a4e96aa4953f5a530edde`），
key 為 `sky_state_v1`，是唯一資料來源。

## 首次部署

需要 Node.js 18+，不需事先安裝任何相依套件：

```bash
npx wrangler login    # 開瀏覽器授權 Cloudflare 帳號（只需一次）
npx wrangler deploy   # 部署，完成後會顯示 https://sky-platform.<your-subdomain>.workers.dev
```

## 本機開發

```bash
npx wrangler dev      # 本機模擬 Worker + KV（http://localhost:8787）
```

## 注意事項

- `/api/state` 目前屬**公開讀寫**端點（任何人都能 GET／PUT 狀態）。
  如需存取控制，後續可在 Worker 加上 Cloudflare Access 或自訂密鑰驗證。
- 狀態 JSON 上限約 24 MB（KV 單值上限 25 MiB）。照片／PDF 以 base64
  內嵌會快速吃掉額度，未來可考慮改存 R2。
- 免費方案即可運行（Workers 每日 100,000 次請求、KV 免費額度）。
