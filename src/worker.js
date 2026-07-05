// sky 衛教平台 — Cloudflare Worker
// 靜態頁面由 Workers Assets（public/）提供；/api/state 讀寫 KV 中的單一狀態 JSON。

const STATE_KEY = 'sky_state_v1';
const MAX_BYTES = 24 * 1024 * 1024; // KV 單值上限 25 MiB，保留餘裕

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state') {
      if (request.method === 'GET') {
        const value = await env.SKY_KV.get(STATE_KEY);
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
