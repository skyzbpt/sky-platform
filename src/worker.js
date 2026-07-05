// sky 衛教平台 — Cloudflare Worker
// 靜態頁面由 Workers Assets（public/）提供；/api/state 讀寫 KV 中的單一狀態 JSON。

const STATE_KEY = 'sky_state_v1';
const MAX_BYTES = 24 * 1024 * 1024; // KV 單值上限 25 MiB，保留餘裕

// 一次性遷移來源：原 Supabase 專案。部署後首次讀取且 KV 尚無資料時，
// 會自動把舊資料搬進 KV；確認遷移完成後，可將 LEGACY_SUPABASE 改為 null 再重新部署。
const LEGACY_SUPABASE = {
  url: 'https://emavpbedpxrrmvvnccxj.supabase.co',
  key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVtYXZwYmVkcHhycm12dm5jY3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxMTkwMDYsImV4cCI6MjA5NTY5NTAwNn0.NDR3rX_TCaqIW9ag3B5BOsSPqUqwFeEZBRqKPsZ9Ak8',
};

async function migrateFromLegacy(env) {
  if (!LEGACY_SUPABASE) return null;
  try {
    const r = await fetch(
      `${LEGACY_SUPABASE.url}/rest/v1/sky_store?key=eq.${encodeURIComponent(STATE_KEY)}&select=value`,
      { headers: { apikey: LEGACY_SUPABASE.key, Authorization: 'Bearer ' + LEGACY_SUPABASE.key } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const value = Array.isArray(rows) && rows.length ? rows[0].value : null;
    if (typeof value !== 'string' || !value) return null;
    await env.SKY_KV.put(STATE_KEY, value);
    return value;
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      if (request.method === 'GET') {
        let value = await env.SKY_KV.get(STATE_KEY);
        if (value === null) value = await migrateFromLegacy(env);
        if (value === null) return new Response('not found', { status: 404 });
        return new Response(value, {
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        const body = await request.text();
        if (!body) return new Response('empty body', { status: 400 });
        if (body.length > MAX_BYTES) return new Response('payload too large', { status: 413 });
        const c = body[0];
        if (c !== '{' && c !== '[') return new Response('invalid json', { status: 400 });
        await env.SKY_KV.put(STATE_KEY, body);
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      }
      return new Response('method not allowed', { status: 405, headers: { allow: 'GET, PUT, POST' } });
    }

    return env.ASSETS.fetch(request);
  },
};
