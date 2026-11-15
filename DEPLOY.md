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

## 多裝置同步

治療師與個案各用各的裝置，所有裝置共用同一份狀態 JSON：

- 每次寫入都帶版本號（存在 KV metadata）。頁面只在資料有變更時才寫入，並附上自己手上的版本；
  雲端若已被別的裝置更新，Worker 會拒絕寫入，頁面取回新版、合併後再寫。
- 頁面定時向雲端確認有沒有新版（操作中約每 8 秒，閒置時拉長到 20～60 秒；
  切回頁面與登入時也會立刻確認），有新版就合併並更新畫面，不必重新整理。
- 合併以個案 id 為準，所以治療師排序／刪除個案時，個案同時送出的訊息或回報不會對錯人。
- 沒有帶版本的寫入（舊版頁面）一律拒絕。**部署新版後，還開著舊版頁面的裝置要重新整理才能儲存。**

已知限制：KV 是「最終一致」的儲存，不同地區的裝置最多可能晚 30～60 秒才看到對方的更新。
這段時間內雙方各自的修改通常都會自動合併；但若其中一方修改後**馬上關閉頁面**，
而另一方剛好在這幾十秒內也寫入，先寫的那筆有極小機率被蓋掉。若需要完全不會遺失，
要把寫入改經由 Durable Object（或改用 D1／R2）排隊處理。

## 注意事項

- `/api/state` 目前屬**公開讀寫**端點（任何人都能 GET／PUT 狀態），登入只在瀏覽器端比對帳密。
  這份資料包含所有帳號密碼與病歷，**知道網址的人不必登入就讀得到**。
  正式收治個案前，建議在 Worker 加上存取控制（例如 Cloudflare Access，或由 Worker 驗證登入後才回傳資料）。
- 狀態 JSON 上限約 24 MB（KV 單值上限 25 MiB）。上傳的圖片會先在瀏覽器縮小再存，
  PDF 單檔上限 5 MB；超過總上限時頁面會提示。資料量再大可考慮改存 R2。
- 免費方案即可運行，但有每日額度：Workers 100,000 次請求、KV 讀取 100,000 次、**KV 寫入 1,000 次**
  （UTC 0 點重置）。寫入額度用完時當天無法再儲存，頁面會提示並自動重試。
