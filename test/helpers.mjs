// 測試用小工具：以 Miniflare 在本機執行 Worker（含 KV），並模擬瀏覽器保管 cookie。
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ORIGIN = 'http://localhost';

export function newWorker(opts = {}) {
  return new Miniflare({
    modules: true,
    scriptPath: ROOT + 'src/worker.js',
    compatibilityDate: '2026-07-01',
    kvNamespaces: ['SKY_KV'],
    bindings: opts.bindings || {},
    ...(opts.ratelimits ? { ratelimits: opts.ratelimits } : {}),
  });
}

// 一個「瀏覽器」：記住 cookie，並自動帶上前端會帶的標頭
export function browser(mf, origin = ORIGIN) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (method !== 'GET' && method !== 'HEAD' && !('x-sky-req' in h)) h['x-sky-req'] = '1';
    if (h['x-sky-req'] === null) delete h['x-sky-req'];
    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || body instanceof Uint8Array) payload = body;
      else {
        payload = JSON.stringify(body);
        h['content-type'] = 'application/json';
      }
    }
    const r = await mf.dispatchFetch(origin + path, { method, headers: h, body: payload });
    const set = r.headers.get('set-cookie');
    if (set) {
      const m = /^([^=]+)=([^;]*)/.exec(set);
      cookie = m && m[2] ? m[1] + '=' + m[2] : '';
    }
    const text = method === 'HEAD' || r.status === 204 ? '' : await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {}
    return { status: r.status, headers: r.headers, text, data };
  };
  return {
    get: (p, h) => call('GET', p, null, h),
    head: (p, h) => call('HEAD', p, null, h),
    post: (p, b, h) => call('POST', p, b ?? {}, h),
    put: (p, b, h) => call('PUT', p, b, h),
    del: (p, h) => call('DELETE', p, null, h),
    login: (role, acct, pwd, extra) => call('POST', '/api/login', { role, acct, pwd, ...extra }),
    // 寫入一份文件（base＝手上的版本）
    putDoc: (path, doc, base = '0', extra = {}) => call('PUT', '/api/doc/' + path, typeof doc === 'string' ? doc : JSON.stringify(doc), { 'x-sky-base': base, ...extra }),
    get cookie() {
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
}

export async function kvAll(mf) {
  const kv = await mf.getKVNamespace('SKY_KV');
  const out = {};
  let cursor;
  do {
    const page = await kv.list({ cursor });
    for (const k of page.keys) out[k.name] = await kv.get(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}
