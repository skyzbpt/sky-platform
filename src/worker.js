// sky 衛教平台 — Cloudflare Worker
// 靜態頁面由 Workers Assets（public/）提供；/api/state 讀寫 KV 中的單一狀態 JSON。
//
// 多裝置同步協定（版本號存在 KV metadata，不必下載整份資料就能比對）：
//   GET  /api/state                     → 200 + 內容，標頭 X-Sky-Version: <版本>
//        可帶 X-Sky-Have: <版本>        → 版本相同時回 204（沒有新資料）
//   PUT  /api/state  X-Sky-Base: <版本> → 雲端版本與 Base 相同才寫入並回 {ok:true}；
//                    X-Sky-Version: <新版本>   不同則不寫入、回 {ok:false,conflict:true}（請先取回最新版再合併）
//        沒有 X-Sky-Base 的請求（舊版頁面）一律拒絕，避免拿過期資料覆蓋整份雲端資料。

const STATE_KEY = 'sky_state_v1';
const MAX_BYTES = 24 * 1024 * 1024; // KV 單值上限 25 MiB，保留餘裕
const VER_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NO_STORE = { 'cache-control': 'no-store' };

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE },
  });

// 以串流方式讀取：只需要版本號時可以不下載內容。
// cacheTtl 30 秒是 KV 允許的下限，可縮短其他地區讀到舊資料的時間。
async function readState(env) {
  try {
    return await env.SKY_KV.getWithMetadata(STATE_KEY, { type: 'stream', cacheTtl: 30 });
  } catch (e) {
    return await env.SKY_KV.getWithMetadata(STATE_KEY, { type: 'stream' });
  }
}
const versionOf = (entry) => (entry.metadata && entry.metadata.v ? String(entry.metadata.v) : '0');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      if (request.method === 'GET') {
        const entry = await readState(env);
        if (entry.value === null) return new Response('not found', { status: 404, headers: NO_STORE });
        const v = versionOf(entry);
        const have = request.headers.get('x-sky-have');
        if (have && v !== '0' && have === v) {
          await entry.value.cancel();
          return new Response(null, { status: 204, headers: { 'x-sky-version': v, ...NO_STORE } });
        }
        return new Response(entry.value, {
          headers: { 'content-type': 'application/json; charset=utf-8', 'x-sky-version': v, ...NO_STORE },
        });
      }

      if (request.method === 'PUT' || request.method === 'POST') {
        const base = request.headers.get('x-sky-base');
        if (!base) return json({ error: 'version required' }, 428);

        const body = await request.arrayBuffer();
        if (!body.byteLength) return json({ error: 'empty body' }, 400);
        if (body.byteLength > MAX_BYTES) return json({ error: 'payload too large' }, 413);
        // 狀態一定是 JSON 物件：粗略檢查以 { 開頭、以 } 結尾，擋掉其他內容或被截斷的資料
        // （不做完整解析，資料大時會超過免費方案的 CPU 時間）
        const bytes = new Uint8Array(body);
        if (bytes[0] !== 0x7b || bytes[bytes.length - 1] !== 0x7d) return json({ error: 'invalid json' }, 400);

        const entry = await readState(env);
        if (entry.value) await entry.value.cancel();
        const current = versionOf(entry);
        // 版本不符是多裝置同時使用時的正常情況，以 200 + ok:false 回覆（前端會取回新版、合併後重傳）
        if (current !== base) return json({ ok: false, conflict: true, v: current });

        const wanted = request.headers.get('x-sky-version');
        const v = wanted && VER_RE.test(wanted) ? wanted : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        try {
          await env.SKY_KV.put(STATE_KEY, body, { metadata: { v } });
        } catch (e) {
          // KV 同一個 key 每秒限寫一次；免費方案另有每日寫入上限。讓前端稍後重試。
          return json({ error: 'kv write failed', detail: String((e && e.message) || e) }, 503);
        }
        return json({ ok: true, v });
      }

      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, PUT, POST' } });
    }

    // 瀏覽器預設會抓 /favicon.ico；若交給 SPA fallback 會回 index.html（HTML 而非圖片），
    // 部分瀏覽器（含 iOS Safari）因此不顯示圖示。改為直接回傳 favicon.png。
    if (url.pathname === '/favicon.ico') {
      return env.ASSETS.fetch(new Request(new URL('/favicon.png', request.url)));
    }

    return env.ASSETS.fetch(request);
  },
};
