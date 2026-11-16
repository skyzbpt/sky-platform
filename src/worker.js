// sky 衛教平台 — Cloudflare Worker
// 靜態頁面由 Workers Assets（public/）提供；/api/* 負責「登入驗證」與「誰能讀寫哪一份資料」。
//
// ── 資料怎麼存（KV，全部以 sky2: 開頭）──
//   sky2:cfg          系統設定：簽發通行證用的金鑰、升級狀態（只有 Worker 讀得到）
//   sky2:a:t          治療師帳號（密碼只存加鹽雜湊）
//   sky2:a:p:<id>     個案帳號（同上）；sky2:u:<帳號雜湊> 是「帳號 → 個案 id」的索引
//   sky2:pub          登入頁的標題／Logo（公開）
//   sky2:m            治療師主文件（個案名單、標籤、衛教內容、病歷…）       只有治療師能讀寫
//   sky2:t:<id>       治療師給該個案的內容（治療師的訊息、公告、已傳送的病歷、推播的衛教）  治療師寫；該個案只能讀
//   sky2:p:<id>       該個案自己的內容（個案的訊息、相簿、記事、每日回報）   該個案與治療師可讀寫
//   sky2:b:<雜湊>     衛教 PDF（治療師上傳；登入後才能下載）
//   個案的通行證只對得上自己的 id，所以拿不到別人的文件。
//
// ── 為什麼分這麼多份 ──
//   免費方案每次請求只有約 10 ms 的 CPU 時間，Worker 不能解析整份（可能好幾 MB 的）資料。
//   分開存放後，Worker 只需要判斷「這個人能不能碰這一份」，內容原封不動地轉交，不必解析。
//   合併、整理都在瀏覽器進行；個案寫的內容一律視為不可信，治療師端讀取時會先消毒。
//
// ── 多裝置同步協定（每一份文件各自有版本號，存在 KV metadata）──
//   GET  /api/doc/<種類>[/<id>]            → 200 + 內容，標頭 X-Sky-Version；帶 X-Sky-Have 且版本相同時回 204
//   PUT  同上  X-Sky-Base: <手上的版本>     → 雲端版本與 Base 相同才寫入並回 {ok:true}；
//              X-Sky-Version: <新版本>        不同則回 {ok:false,conflict:true}（請先取回最新版、合併後再寫）
//   GET/POST /api/versions                 → 一次問完多份文件目前的版本（用來判斷要不要下載）
//
// ── 舊資料（sky_state_v1：帳密明碼＋全部病歷放在同一包）──
//   由治療師第一次登入時在瀏覽器裡拆成新格式；完成後舊的那一包會被移除（留一份不含密碼的備份 sky2:legacy），
//   舊版程式（包含還留著的預覽網址）就再也讀不到任何資料。升級只在正式網址進行。

const LEGACY_KEY = 'sky_state_v1';
const NS = 'sky2:';
const K = {
  cfg: NS + 'cfg',
  pub: NS + 'pub',
  m: NS + 'm',
  backup: NS + 'legacy',
  reset: NS + 'reset',
  tAcct: NS + 'a:t',
  pAcct: (pid) => NS + 'a:p:' + pid,
  idx: (h) => NS + 'u:' + h,
  t: (pid) => NS + 't:' + pid,
  p: (pid) => NS + 'p:' + pid,
  blob: (h) => NS + 'b:' + h,
};

const MAX_DOC = 24 * 1024 * 1024; // KV 單值上限 25 MiB，保留餘裕
const MAX_BLOB = 8 * 1024 * 1024; // PDF 上限 5 MB，轉成 base64 後約 6.7 MB
const MAX_PUB = 600 * 1024;
const MAX_JSON = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const PBKDF2_ITER = 50000; // 約 6～7 ms CPU；免費方案單次請求額度約 10 ms（付費方案可調高，舊雜湊會在下次登入時自動升級）
const PWD_MIN = 6;
const TTL_T = 12 * 3600 * 1000; // 治療師通行證有效 12 小時（使用中會自動延長）
const TTL_P = 30 * 86400 * 1000; // 個案 30 天
const NO_STORE = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const enc = new TextEncoder();
const dec = new TextDecoder();

class HttpError extends Error {
  constructor(response) {
    super('http');
    this.response = response;
  }
}
const json = (obj, status = 200, headers) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...headers },
  });
const fail = (status, error, extra) => new HttpError(json({ error, ...extra }, status));

const b64u = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (str) => {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
// 比對時間不隨內容變化，避免從回應時間猜出雜湊
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
const sameText = async (a, b) => sameBytes(await sha256('s:' + a), await sha256('s:' + b));

// ── KV 小工具 ──
// cacheTtl 30 秒是 KV 允許的下限，可縮短其他地區讀到舊資料的時間
const kvJson = (env, key) => env.SKY_KV.get(key, { type: 'json', cacheTtl: 30 });
async function kvMeta(env, key) {
  const e = await env.SKY_KV.getWithMetadata(key, { type: 'stream', cacheTtl: 30 });
  if (e.value === null) return null;
  await e.value.cancel();
  return e.metadata || {};
}
const verOf = (meta) => (meta && meta.v ? String(meta.v) : '0');
async function kvPut(env, key, value, opts) {
  try {
    await env.SKY_KV.put(key, value, opts);
  } catch (e) {
    // KV 同一個 key 每秒限寫一次；免費方案另有每日寫入上限。讓前端稍後重試。
    throw fail(503, 'kv', { detail: String((e && e.message) || e) });
  }
}

// ── 系統設定與模式 ──
let _cfg = null;
let _cfgAt = 0;
async function getCfg(env, fresh) {
  if (!fresh && _cfg && _cfg.mig === 'done' && Date.now() - _cfgAt < 300000) return _cfg;
  _cfg = await kvJson(env, K.cfg);
  _cfgAt = Date.now();
  return _cfg;
}
// ready＝正常使用；migrating＝治療師已登入、舊資料升級中；legacy＝只有舊資料、尚未升級；setup＝全新安裝；
// reset＝帳號擁有者在 KV 放了重設碼，可以重設治療師帳密；locked＝系統設定不見了但資料還在（不允許任何人重新設定）
async function getMode(env) {
  const cfg = await getCfg(env);
  if (cfg) {
    if (cfg.mig !== 'done') return { mode: 'migrating', cfg };
    return { mode: (await kvMeta(env, K.reset)) ? 'reset' : 'ready', cfg };
  }
  if (await kvMeta(env, LEGACY_KEY)) return { mode: 'legacy', cfg: null };
  // 「首次設定」只允許在完全沒有資料時進行：否則一旦設定遺失，任何人都能自稱治療師、接管既有的資料
  return { mode: (await kvMeta(env, K.m)) ? 'locked' : 'setup', cfg: null };
}
// 預覽網址（<前綴>-sky-platform.<帳號>.workers.dev）與正式站共用同一個 KV：
// 升級會讓舊版頁面讀不到資料，所以只允許在正式網址進行。可用環境變數 SKY_PREVIEW=0／1 強制指定。
function isPreview(url, env) {
  if (env.SKY_PREVIEW === '1') return true;
  if (env.SKY_PREVIEW === '0') return false;
  const h = url.hostname.toLowerCase();
  return h.endsWith('.workers.dev') && !h.startsWith('sky-platform.');
}

// ── 密碼雜湊（PBKDF2-SHA256＋每個帳號各自的鹽）──
async function pbkdf2(pwd, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pwd), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function makeHash(pwd) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64u(salt), hash: b64u(await pbkdf2(pwd, salt, PBKDF2_ITER)), it: PBKDF2_ITER };
}
async function verifyHash(rec, pwd) {
  if (!rec || !rec.hash || !rec.salt) {
    await pbkdf2(pwd, new Uint8Array(16), PBKDF2_ITER); // 帳號不存在也花一樣的時間，不讓人從速度看出帳號是否存在
    return false;
  }
  return sameBytes(await pbkdf2(pwd, unb64u(rec.salt), rec.it || PBKDF2_ITER), unb64u(rec.hash));
}
const validAcct = (a) => typeof a === 'string' && a.length >= 1 && a.length <= 64 && !/[\u0000-\u001f\u007f]/.test(a);
const validPwd = (p) => typeof p === 'string' && p.length >= PWD_MIN && p.length <= 200;

// ── 帳號資料 ──
const _acctCache = new Map(); // 同一個執行個體內短暫快取（10 秒），減少 KV 讀取次數
async function getAcct(env, key, fresh) {
  const hit = _acctCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < 10000) return hit.rec;
  const rec = await kvJson(env, key);
  if (_acctCache.size > 2000) _acctCache.clear();
  _acctCache.set(key, { rec, at: Date.now() });
  return rec;
}
async function putAcct(env, key, rec) {
  await kvPut(env, key, JSON.stringify(rec), { metadata: { a: rec.acct } }); // 帳號名稱另放一份在 metadata，列出帳號時不必逐筆讀取
  _acctCache.set(key, { rec, at: Date.now() });
}
async function delAcct(env, key) {
  await env.SKY_KV.delete(key);
  _acctCache.set(key, { rec: null, at: Date.now() });
}
const acctHash = async (acct) => hex(await sha256('p\n' + acct)).slice(0, 40);
async function idxAdd(env, acct, pid) {
  const k = K.idx(await acctHash(acct));
  const cur = (await kvJson(env, k)) || { pids: [] };
  if (!cur.pids.includes(pid)) {
    cur.pids.push(pid);
    await kvPut(env, k, JSON.stringify(cur));
  }
}
async function idxDel(env, acct, pid) {
  const k = K.idx(await acctHash(acct));
  const cur = await kvJson(env, k);
  if (!cur || !Array.isArray(cur.pids) || !cur.pids.includes(pid)) return;
  const pids = cur.pids.filter((x) => x !== pid);
  if (pids.length) await kvPut(env, k, JSON.stringify({ pids }));
  else await env.SKY_KV.delete(k);
}
async function idxPids(env, acct) {
  const cur = await kvJson(env, K.idx(await acctHash(acct)));
  return cur && Array.isArray(cur.pids) ? cur.pids.filter((x) => ID_RE.test(x)) : [];
}
async function acctTaken(env, acct, exceptPid) {
  for (const pid of await idxPids(env, acct)) {
    if (pid === exceptPid) continue;
    const r = await getAcct(env, K.pAcct(pid), true);
    if (r && r.acct === acct) return true;
  }
  return false;
}

// ── 通行證（HMAC 簽章的 cookie；HttpOnly，網頁程式讀不到）──
const cookieName = (url) => (url.protocol === 'https:' ? '__Host-sky_s' : 'sky_s');
function getCookie(request, name) {
  const h = request.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
let _hk = { secret: '', key: null };
async function hmacKey(secret) {
  if (_hk.secret !== secret) {
    _hk = { secret, key: await crypto.subtle.importKey('raw', unb64u(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  }
  return _hk.key;
}
async function signToken(cfg, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(cfg.secret), enc.encode(body)));
  return body + '.' + b64u(sig);
}
async function readToken(cfg, tok) {
  const i = tok.indexOf('.');
  if (i < 1) return null;
  try {
    const body = tok.slice(0, i);
    const want = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(cfg.secret), enc.encode(body)));
    if (!sameBytes(want, unb64u(tok.slice(i + 1)))) return null;
    const p = JSON.parse(dec.decode(unb64u(body)));
    return p && (p.r === 't' || p.r === 'p') && typeof p.x === 'number' ? p : null;
  } catch (e) {
    return null;
  }
}
async function sessionCookie(url, cfg, role, pid, ep) {
  const ttl = role === 't' ? TTL_T : TTL_P;
  const tok = await signToken(cfg, { r: role, p: pid || '', e: ep, x: Date.now() + ttl });
  return `${cookieName(url)}=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
const clearCookie = (url) => `${cookieName(url)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`;

// 驗證通行證：簽章正確、未過期、帳號還在、密碼沒有被改過（改密碼或刪除帳號後，舊通行證立刻失效）
async function auth(request, env, url) {
  const cfg = await getCfg(env);
  if (!cfg) throw fail(401, 'auth');
  const tok = getCookie(request, cookieName(url));
  const s = tok ? await readToken(cfg, tok) : null;
  if (!s) throw fail(401, 'auth');
  if (s.x < Date.now()) throw fail(401, 'expired');
  if (s.r === 'p' && !ID_RE.test(s.p || '')) throw fail(401, 'auth');
  const rec = await getAcct(env, s.r === 't' ? K.tAcct : K.pAcct(s.p));
  if (!rec) throw fail(401, s.r === 't' ? 'auth' : 'gone');
  if (rec.ep !== s.e) throw fail(401, 'expired');
  if (s.r === 'p' && cfg.mig !== 'done') throw fail(409, 'upgrading');
  return { role: s.r, pid: s.r === 'p' ? s.p : '', rec, cfg, exp: s.x };
}
const needTherapist = (sess) => {
  if (sess.role !== 't') throw fail(403, 'forbidden');
};

// ── 登入嘗試次數限制（防止猜密碼）──
const _hits = new Map();
async function tooMany(env, binding, key, max) {
  let over = false;
  try {
    if (env[binding]) over = !(await env[binding].limit({ key })).success;
  } catch (e) {}
  const now = Date.now();
  const w = _hits.get(key);
  if (!w || now - w.t > 60000) {
    if (_hits.size > 5000) _hits.clear();
    _hits.set(key, { t: now, n: 1 });
  } else if (++w.n > max) over = true;
  return over;
}

async function readJson(request, max = MAX_JSON) {
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) throw fail(413, 'toobig');
  try {
    const v = JSON.parse(dec.decode(buf));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (e) {}
  throw fail(400, 'bad');
}

// ── 舊資料（單一 JSON）的處理：不解析整份內容，只找出需要的欄位位置 ──
// 內容裡常有好幾 MB 的 base64 圖片；用 indexOf 直接跳過字串，掃完 20 MB 只要幾毫秒。
function skipStr(b, i) {
  for (let j = i + 1; ; ) {
    const q = b.indexOf(0x22, j);
    if (q < 0) throw new Error('json');
    let k = q - 1;
    let n = 0;
    while (k > i && b[k] === 0x5c) {
      n++;
      k--;
    }
    if (!(n & 1)) return q + 1;
    j = q + 1;
  }
}
const isWs = (c) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
function skipWs(b, i) {
  while (isWs(b[i])) i++;
  return i;
}
function skipVal(b, i) {
  const c = b[i];
  if (c === 0x22) return skipStr(b, i);
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    for (;;) {
      const ch = b[i];
      if (ch === undefined) throw new Error('json');
      if (ch === 0x22) {
        i = skipStr(b, i);
        continue;
      }
      if (ch === 0x7b || ch === 0x5b) depth++;
      else if ((ch === 0x7d || ch === 0x5d) && --depth === 0) return i + 1;
      i++;
    }
  }
  for (; ; i++) {
    const ch = b[i];
    if (ch === undefined || ch === 0x2c || ch === 0x7d || ch === 0x5d || isWs(ch)) return i;
  }
}
// 物件的各個成員：[{key, vs, ve}]（vs/ve＝值的起訖位置）
function members(b, i) {
  i = skipWs(b, i);
  if (b[i] !== 0x7b) return null;
  const out = [];
  i = skipWs(b, i + 1);
  if (b[i] === 0x7d) return out;
  for (;;) {
    if (b[i] !== 0x22) throw new Error('json');
    const ke = skipStr(b, i);
    const key = JSON.parse(dec.decode(b.subarray(i, ke)));
    let j = skipWs(b, ke);
    if (b[j] !== 0x3a) throw new Error('json');
    const vs = skipWs(b, j + 1);
    const ve = skipVal(b, vs);
    out.push({ key, vs, ve });
    i = skipWs(b, ve);
    if (b[i] === 0x2c) {
      i = skipWs(b, i + 1);
      continue;
    }
    if (b[i] === 0x7d) return out;
    throw new Error('json');
  }
}
function elements(b, i) {
  i = skipWs(b, i);
  if (b[i] !== 0x5b) return null;
  const out = [];
  i = skipWs(b, i + 1);
  if (b[i] === 0x5d) return out;
  for (;;) {
    const ve = skipVal(b, i);
    out.push({ vs: i, ve });
    i = skipWs(b, ve);
    if (b[i] === 0x2c) {
      i = skipWs(b, i + 1);
      continue;
    }
    if (b[i] === 0x5d) return out;
    throw new Error('json');
  }
}
const last = (list, key) => {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].key === key) return list[i];
  return null;
};
const parseAt = (b, m, max = 4096) => {
  if (!m || m.ve - m.vs > max) return undefined;
  try {
    return JSON.parse(dec.decode(b.subarray(m.vs, m.ve)));
  } catch (e) {
    return undefined;
  }
};
// 舊資料的預設值規則與舊版頁面相同：治療師缺帳密＝test；個案缺帳號＝patient、缺密碼＝與帳號相同；
// 個案沒有 id（或重複）時依位置給 L0、L1…（各裝置算出來會一致）。
function legacyInfo(b) {
  const top = members(b, 0);
  if (!top) throw new Error('json');
  const text = (v, dflt) => (typeof v === 'string' ? v : v === 0 || v ? String(v) : '') || dflt;
  const info = { pwd: [], therapist: { acct: 'test', pwd: 'test' }, patients: [], front: last(top, 'frontState') };
  const ts = last(top, 'therapistState');
  const tm = ts ? members(b, ts.vs) : null;
  if (tm) {
    info.therapist.acct = text(parseAt(b, last(tm, 'acct')), 'test');
    info.therapist.pwd = text(parseAt(b, last(tm, 'pwd')), 'test');
    tm.forEach((m) => m.key === 'pwd' && info.pwd.push([m.vs, m.ve]));
  }
  const ps = last(top, 'patients');
  const list = (ps && elements(b, ps.vs)) || [];
  const used = new Set();
  const raw = list.map((el) => {
    const mm = members(b, el.vs);
    if (!mm) return { id: '', acct: null, pwd: null };
    mm.forEach((m) => m.key === 'pwd' && info.pwd.push([m.vs, m.ve]));
    const id = parseAt(b, last(mm, 'id'));
    const acct = text(parseAt(b, last(mm, 'acct')), 'patient').slice(0, 64);
    return { id: typeof id === 'string' && ID_RE.test(id) ? id : '', acct, pwd: text(parseAt(b, last(mm, 'pwd')), acct) };
  });
  raw.forEach((p) => {
    if (p.id && !used.has(p.id)) used.add(p.id);
    else p.id = '';
  });
  raw.forEach((p, i) => {
    if (!p.id) {
      let k = i;
      while (used.has('L' + k)) k++;
      p.id = 'L' + k;
      used.add(p.id);
    }
  });
  info.patients = raw;
  return info;
}
// 把密碼欄位原地塗掉（長度不變，仍是合法 JSON）
function blankPwds(b, ranges) {
  for (const [vs, ve] of ranges) {
    b.fill(0x20, vs, ve);
    if (ve - vs >= 2) {
      b[vs] = 0x22;
      b[vs + 1] = 0x22;
    } else b[vs] = 0x30;
  }
}
async function readLegacy(env) {
  const buf = await env.SKY_KV.get(LEGACY_KEY, { type: 'arrayBuffer' });
  return buf ? new Uint8Array(buf) : null;
}

// ── 公開資訊：登入頁的標題與 Logo、目前的系統狀態 ──
let _brand = null;
let _brandAt = 0;
async function handlePublic(request, env, url) {
  if (request.method === 'PUT') {
    needTherapist(await auth(request, env, url));
    const d = await readJson(request, MAX_PUB);
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const brand = { title: s(d.title, 80), sub: s(d.sub, 120), logoSrc: s(d.logoSrc, MAX_PUB) };
    await kvPut(env, K.pub, JSON.stringify(brand));
    _brand = brand;
    _brandAt = Date.now();
    return json({ ok: true });
  }
  if (request.method !== 'GET') throw fail(405, 'method');
  const { mode } = await getMode(env);
  let brand = null;
  if (_brand && Date.now() - _brandAt < 60000) brand = _brand;
  else {
    try {
      if (mode === 'ready') brand = await kvJson(env, K.pub);
      else if (mode !== 'setup') {
        // 尚未升級完成：沿用舊資料裡的標題與 Logo，登入頁看起來和原本一樣
        const b = await readLegacy(env);
        const f = b ? parseAt(b, legacyInfo(b).front, MAX_PUB) : null;
        if (f && typeof f === 'object') brand = { title: String(f.title || ''), sub: String(f.sub || ''), logoSrc: String(f.logoSrc || '') };
      }
    } catch (e) {}
    if (brand) {
      _brand = brand;
      _brandAt = Date.now();
    }
  }
  return json({ mode, preview: isPreview(url, env), brand });
}

// ── 登入／登出 ──
async function handleLogin(request, env, url) {
  if (request.method !== 'POST') throw fail(405, 'method');
  const d = await readJson(request);
  const role = d.role === 'patient' ? 'p' : 't';
  const acct = typeof d.acct === 'string' ? d.acct.trim() : '';
  const pwd = typeof d.pwd === 'string' ? d.pwd : '';
  if (!acct || !pwd || acct.length > 64 || pwd.length > 200) throw fail(400, 'bad');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if ((await tooMany(env, 'LOGIN_IP_RL', 'ip:' + ip, 60)) || (await tooMany(env, 'LOGIN_RL', role + ':' + acct, 10))) throw fail(429, 'rate');

  let { mode, cfg } = await getMode(env);
  const done = async (rec, pid, extra) =>
    json({ ok: true, role, pid: pid || '', acct: rec.acct, ...extra }, 200, { 'set-cookie': await sessionCookie(url, cfg, role, pid, rec.ep) });
  const newCfg = async (mig) => {
    cfg = { v: 1, secret: b64u(crypto.getRandomValues(new Uint8Array(32))), mig, at: Date.now() };
    await kvPut(env, K.cfg, JSON.stringify(cfg));
    _cfg = cfg;
    _cfgAt = Date.now();
  };

  if (mode === 'locked') throw fail(503, 'locked');

  if (mode === 'reset' && role === 't' && d.setup === true) {
    // 忘記治療師密碼時的重設：只有能進 Cloudflare 後台的人（帳號擁有者）才放得進重設碼。
    // 重設碼用過即刪；舊的通行證全部失效。
    const code = ((await env.SKY_KV.get(K.reset)) || '').trim();
    if (code.length < 8 || !(await sameText(typeof d.code === 'string' ? d.code.trim() : '', code))) throw fail(401, 'code');
    if (!validAcct(acct)) throw fail(400, 'bad');
    if (!validPwd(pwd)) throw fail(400, 'weak');
    const old = await getAcct(env, K.tAcct, true);
    const rec = { acct, ...(await makeHash(pwd)), ep: Math.max(Date.now(), ((old && old.ep) || 0) + 1) };
    await putAcct(env, K.tAcct, rec);
    await env.SKY_KV.delete(K.reset);
    return done(rec, '', { reset: true });
  }

  if (mode === 'setup') {
    // 全新安裝：第一位登入的治療師設定帳密（前端會先顯示「首次設定」並請使用者確認）
    if (role !== 't') throw fail(401, 'login');
    if (d.setup !== true) throw fail(409, 'setup');
    if (!validAcct(acct)) throw fail(400, 'bad');
    if (!validPwd(pwd)) throw fail(400, 'weak');
    const rec = { acct, ...(await makeHash(pwd)), ep: 1 };
    await putAcct(env, K.tAcct, rec);
    await newCfg('done');
    return done(rec, '', { setup: true });
  }

  if (mode === 'legacy') {
    // 只有舊資料：治療師以原本的帳密登入後開始升級。個案要等升級完成。
    if (isPreview(url, env)) throw fail(409, 'preview');
    if (role !== 't') throw fail(409, 'upgrading');
    const b = await readLegacy(env);
    let info = null;
    try {
      info = b && legacyInfo(b);
    } catch (e) {
      throw fail(500, 'legacy');
    }
    if (!info) throw fail(409, 'retry');
    const ok = (await sameText(acct, info.therapist.acct)) & (await sameText(pwd, info.therapist.pwd));
    if (!ok) throw fail(401, 'login');
    const rec = { acct, ...(await makeHash(pwd)), ep: 1 };
    await putAcct(env, K.tAcct, rec);
    await newCfg('pending');
    return done(rec, '', { mig: 'pending' });
  }

  if (role === 't') {
    const rec = await getAcct(env, K.tAcct, true);
    if (!(await verifyHash(rec, pwd)) || !(await sameText(rec.acct, acct))) throw fail(401, 'login');
    if ((rec.it || 0) < PBKDF2_ITER) await putAcct(env, K.tAcct, { ...rec, ...(await makeHash(pwd)) });
    return done(rec, '', cfg.mig === 'done' ? {} : { mig: 'pending' });
  }

  if (mode === 'migrating') throw fail(409, 'upgrading');
  // 舊資料裡可能有重複的帳號（靠密碼區分），逐一比對
  const pids = (await idxPids(env, acct)).slice(0, 5);
  for (const pid of pids) {
    const rec = await getAcct(env, K.pAcct(pid), true);
    if (rec && rec.acct === acct && (await verifyHash(rec, pwd))) {
      if ((rec.it || 0) < PBKDF2_ITER) await putAcct(env, K.pAcct(pid), { ...rec, ...(await makeHash(pwd)) });
      return done(rec, pid);
    }
  }
  if (!pids.length) await verifyHash(null, pwd);
  throw fail(401, 'login');
}

// ── 文件讀寫（內容不解析，原樣存取）──
function docKey(sess, kind, pid, write) {
  if (kind === 'm' && !pid) {
    needTherapist(sess);
    return K.m;
  }
  if ((kind === 't' || kind === 'p') && ID_RE.test(pid || '')) {
    const mine = sess.role === 'p' && sess.pid === pid;
    if (sess.role !== 't' && !(mine && (kind === 'p' || !write))) throw fail(403, 'forbidden');
    return kind === 't' ? K.t(pid) : K.p(pid);
  }
  throw fail(404, 'notfound');
}
async function handleDoc(request, env, sess, kind, pid) {
  const method = request.method;
  if (method === 'GET') {
    const key = docKey(sess, kind, pid, false);
    const e = await env.SKY_KV.getWithMetadata(key, { type: 'stream', cacheTtl: 30 });
    if (e.value === null) return json({ error: 'notfound' }, 404);
    const v = verOf(e.metadata);
    const head = { 'x-sky-version': v, 'x-sky-at': String((e.metadata && e.metadata.at) || 0), ...NO_STORE };
    if (v !== '0' && request.headers.get('x-sky-have') === v) {
      await e.value.cancel();
      return new Response(null, { status: 204, headers: head });
    }
    return new Response(e.value, { headers: { 'content-type': 'application/json; charset=utf-8', ...head } });
  }
  if (method !== 'PUT') throw fail(405, 'method');
  const key = docKey(sess, kind, pid, true);
  const base = request.headers.get('x-sky-base');
  if (!base) throw fail(428, 'version');
  const body = await request.arrayBuffer();
  if (!body.byteLength) throw fail(400, 'bad');
  if (body.byteLength > MAX_DOC) throw fail(413, 'toobig');
  // 文件一定是 JSON 物件：粗略檢查以 { 開頭、以 } 結尾，擋掉其他內容或被截斷的資料
  const bytes = new Uint8Array(body);
  if (bytes[0] !== 0x7b || bytes[bytes.length - 1] !== 0x7d) throw fail(400, 'bad');
  const current = verOf(await kvMeta(env, key));
  // 升級期間由治療師的瀏覽器重建全部文件，允許直接覆寫（中途失敗可以整個重來）
  const force = sess.role === 't' && sess.cfg.mig !== 'done' && request.headers.get('x-sky-force') === '1';
  // 版本不符是多裝置同時使用時的正常情況，以 200 + ok:false 回覆（前端會取回新版、合併後重傳）
  if (current !== base && !force) return json({ ok: false, conflict: true, v: current });
  const wanted = request.headers.get('x-sky-version');
  const v = wanted && ID_RE.test(wanted) ? wanted : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const at = Date.now();
  await kvPut(env, key, body, { metadata: { v, at } });
  return json({ ok: true, v, at });
}

// 一次回報多份文件的版本：[版本, 最後寫入時間]；不存在為 0
async function handleVersions(request, env, sess) {
  const one = async (key) => {
    const m = await kvMeta(env, key);
    return m ? [verOf(m), m.at || 0] : 0;
  };
  if (sess.role === 'p') {
    const [t, p] = await Promise.all([one(K.t(sess.pid)), one(K.p(sess.pid))]);
    return json({ t, p });
  }
  const d = request.method === 'POST' ? await readJson(request) : {};
  const pids = (Array.isArray(d.p) ? d.p : []).filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, 400);
  const out = { m: 0, p: {}, t: {} };
  await Promise.all([
    one(K.m).then((v) => (out.m = v)),
    ...pids.map((pid) => one(K.p(pid)).then((v) => (out.p[pid] = v))),
    ...(d.t ? pids.map((pid) => one(K.t(pid)).then((v) => (out.t[pid] = v))) : []),
  ]);
  return json(out);
}

// ── 衛教 PDF（以內容雜湊為名；治療師上傳，登入後才能下載）──
async function handleBlob(request, env, sess, hash) {
  if (!HASH_RE.test(hash || '')) throw fail(404, 'notfound');
  const key = K.blob(hash);
  const method = request.method;
  if (method === 'GET' || method === 'HEAD') {
    if (method === 'HEAD') return new Response(null, { status: (await kvMeta(env, key)) ? 200 : 404, headers: NO_STORE });
    const v = await env.SKY_KV.get(key, { type: 'stream' });
    if (v === null) return json({ error: 'notfound' }, 404);
    return new Response(v, { headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });
  }
  needTherapist(sess);
  if (method === 'DELETE') {
    await env.SKY_KV.delete(key);
    return json({ ok: true });
  }
  if (method !== 'PUT') throw fail(405, 'method');
  if (await kvMeta(env, key)) return json({ ok: true, existed: true }); // 已經有了就不重複寫入（節省每日寫入額度）
  const body = await request.arrayBuffer();
  if (!body.byteLength) throw fail(400, 'bad');
  if (body.byteLength > MAX_BLOB) throw fail(413, 'toobig');
  await kvPut(env, key, body, { metadata: { at: Date.now() } });
  return json({ ok: true });
}

// ── 帳號管理 ──
async function dropPatient(env, pid) {
  const rec = await getAcct(env, K.pAcct(pid), true);
  if (rec) await idxDel(env, rec.acct, pid);
  await delAcct(env, K.pAcct(pid));
  await Promise.all([env.SKY_KV.delete(K.p(pid)), env.SKY_KV.delete(K.t(pid))]);
}
async function handleAccount(request, env, url, sess) {
  if (request.method !== 'POST') throw fail(405, 'method');
  const d = await readJson(request);
  const acct = d.acct == null ? null : typeof d.acct === 'string' ? d.acct.trim() : '';
  const pwd = d.pwd == null || d.pwd === '' ? null : d.pwd;
  if (acct !== null && !validAcct(acct)) throw fail(400, 'bad');
  if (pwd !== null && !validPwd(pwd)) throw fail(400, 'weak');

  // 改自己的帳號或密碼：要先輸入目前的密碼
  if (d.op === 'self') {
    const key = sess.role === 't' ? K.tAcct : K.pAcct(sess.pid);
    const rec = await getAcct(env, key, true);
    if (!rec) throw fail(401, 'gone');
    if (await tooMany(env, 'LOGIN_RL', 'cur:' + sess.role + ':' + sess.pid, 10)) throw fail(429, 'rate');
    if (!(await verifyHash(rec, typeof d.cur === 'string' ? d.cur : ''))) throw fail(403, 'cur');
    const next = { ...rec };
    if (acct !== null && acct !== rec.acct) {
      if (sess.role === 'p') {
        if (await acctTaken(env, acct, sess.pid)) throw fail(409, 'dup');
        await idxAdd(env, acct, sess.pid);
      }
      next.acct = acct;
    }
    if (pwd !== null) Object.assign(next, await makeHash(pwd), { ep: (rec.ep || 1) + 1 }); // 其他裝置上的舊通行證立刻失效
    await putAcct(env, key, next);
    if (sess.role === 'p' && next.acct !== rec.acct) await idxDel(env, rec.acct, sess.pid);
    return json({ ok: true, acct: next.acct }, 200, { 'set-cookie': await sessionCookie(url, sess.cfg, sess.role, sess.pid, next.ep) });
  }

  needTherapist(sess);

  // 列出所有個案帳號（匯入備份時用來對應原本的帳號）
  if (d.op === 'list') {
    const accounts = {};
    const prefix = K.pAcct('');
    let cursor;
    do {
      const page = await env.SKY_KV.list({ prefix, cursor });
      for (const k of page.keys) accounts[k.name.slice(prefix.length)] = (k.metadata && k.metadata.a) || '';
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ ok: true, accounts });
  }

  const pid = d.pid;
  if (typeof pid !== 'string' || !ID_RE.test(pid)) throw fail(400, 'bad');

  // 建立個案帳號，或由治療師改個案的帳號／重設密碼
  if (d.op === 'set') {
    const rec = await getAcct(env, K.pAcct(pid), true);
    if (!rec) {
      if (acct === null) throw fail(400, 'bad');
      if (pwd === null) throw fail(400, 'needpwd');
      if (await acctTaken(env, acct, pid)) throw fail(409, 'dup');
      const fresh = { acct, ...(await makeHash(pwd)), ep: 1 };
      await putAcct(env, K.pAcct(pid), fresh);
      await idxAdd(env, acct, pid);
      return json({ ok: true, acct, created: true });
    }
    const next = { ...rec };
    if (acct !== null && acct !== rec.acct) {
      if (await acctTaken(env, acct, pid)) throw fail(409, 'dup');
      await idxAdd(env, acct, pid);
      next.acct = acct;
    }
    if (pwd !== null) Object.assign(next, await makeHash(pwd), { ep: (rec.ep || 1) + 1 });
    await putAcct(env, K.pAcct(pid), next);
    if (next.acct !== rec.acct) await idxDel(env, rec.acct, pid);
    return json({ ok: true, acct: next.acct });
  }

  // 刪除個案：帳號與該個案的文件一併移除
  if (d.op === 'delete') {
    await dropPatient(env, pid);
    return json({ ok: true });
  }

  // 匯入備份時把舊個案的帳密搬到新的 id（沿用原本的密碼），舊 id 的文件一併移除
  if (d.op === 'move') {
    const from = d.from;
    if (typeof from !== 'string' || !ID_RE.test(from) || from === pid) throw fail(400, 'bad');
    const rec = await getAcct(env, K.pAcct(from), true);
    if (!rec) return json({ ok: false, missing: true });
    await putAcct(env, K.pAcct(pid), { ...rec, ep: (rec.ep || 1) + 1 });
    await idxAdd(env, rec.acct, pid);
    await dropPatient(env, from);
    return json({ ok: true, acct: rec.acct });
  }
  throw fail(400, 'bad');
}

// ── 舊資料升級（由治療師的瀏覽器一步一步推進，每一步都很小，不會超過 CPU 額度）──
// 1) /api/migrate/accounts：一次替一位個案建立帳號（把舊的明碼密碼換成雜湊）
// 2) /api/legacy：取回塗掉密碼後的舊資料，由瀏覽器拆成新格式並上傳
// 3) /api/migrate/finish：確認新資料已存在 → 保留一份不含密碼的備份 → 移除舊資料
async function handleMigrate(request, env, sess, step) {
  needTherapist(sess);
  if (sess.cfg.mig === 'done') throw fail(409, 'done');
  if (step === 'legacy') {
    if (request.method !== 'GET') throw fail(405, 'method');
    const b = await readLegacy(env);
    if (!b) return json({ error: 'notfound' }, 404);
    blankPwds(b, legacyInfo(b).pwd);
    return new Response(b, { headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
  }
  if (request.method !== 'POST') throw fail(405, 'method');
  const d = await readJson(request);
  const b = await readLegacy(env);

  if (step === 'accounts') {
    if (!b) return json({ i: 0, total: 0, ids: [], gone: true });
    const info = legacyInfo(b);
    const total = info.patients.length;
    let i = Math.max(0, Math.min(total, Number(d.i) | 0));
    if (i < total) {
      const p = info.patients[i];
      if (p.acct !== null && !(await getAcct(env, K.pAcct(p.id), true))) {
        await putAcct(env, K.pAcct(p.id), { acct: p.acct, ...(await makeHash(p.pwd)), ep: 1 });
        await idxAdd(env, p.acct, p.id);
      }
      i++;
    }
    return json({ i, total, ids: info.patients.map((p) => p.id) });
  }

  if (step === 'finish') {
    if (!(await kvMeta(env, K.m))) throw fail(409, 'nodata');
    if (b) {
      blankPwds(b, legacyInfo(b).pwd);
      await kvPut(env, K.backup, b, { metadata: { at: Date.now() } });
      await env.SKY_KV.delete(LEGACY_KEY);
    }
    const cfg = { ...sess.cfg, mig: 'done', migAt: Date.now() };
    await kvPut(env, K.cfg, JSON.stringify(cfg));
    _cfg = cfg;
    _cfgAt = Date.now();
    _brandAt = 0;
    return json({ ok: true });
  }
  throw fail(404, 'notfound');
}

async function handleApi(request, env, url) {
  if (!env.SKY_KV) throw fail(503, 'nokv');
  const path = url.pathname.slice(5).split('/'); // 去掉 /api/
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    // 跨站請求防護：其他網站無法替使用者加上自訂標頭，來源不同也一律拒絕
    const origin = request.headers.get('origin');
    if (!request.headers.get('x-sky-req') || (origin && origin !== url.origin)) throw fail(403, 'forbidden');
  }
  const [a, b, c] = path;
  if (a === 'public' && path.length === 1) return handlePublic(request, env, url);
  if (a === 'login' && path.length === 1) return handleLogin(request, env, url);
  if (a === 'logout' && path.length === 1) return json({ ok: true }, 200, { 'set-cookie': clearCookie(url) });
  // 舊版頁面用的端點：資料已改由登入後的端點提供
  if (a === 'state') return json({ error: 'upgrade', msg: '請重新整理頁面' }, 410);

  // 「目前是誰登入」：沒有登入也是正常情況（每次開啟頁面都會問一次），回 200 而不是 401
  const isSession = a === 'session' && path.length === 1;
  let sess;
  try {
    sess = await auth(request, env, url);
  } catch (e) {
    if (isSession && e instanceof HttpError) return json({ role: null });
    throw e;
  }
  let resp;
  if (isSession) resp = json({ role: sess.role, pid: sess.pid, acct: sess.rec.acct, ...(sess.cfg.mig === 'done' ? {} : { mig: 'pending' }) });
  else if (a === 'versions' && path.length === 1) resp = await handleVersions(request, env, sess);
  else if (a === 'doc' && path.length <= 3) resp = await handleDoc(request, env, sess, b, c ? decodeURIComponent(c) : '');
  else if (a === 'blob' && path.length === 2) resp = await handleBlob(request, env, sess, b);
  else if (a === 'account' && path.length === 1) resp = await handleAccount(request, env, url, sess);
  else if (a === 'migrate' && path.length === 2) resp = await handleMigrate(request, env, sess, b);
  else if (a === 'legacy' && path.length === 1) resp = await handleMigrate(request, env, sess, 'legacy');
  else throw fail(404, 'notfound');

  // 告訴頁面「這個請求是以誰的身分處理的」：同一個瀏覽器的其他分頁若改用別的帳號登入，頁面可以察覺
  resp.headers.set('x-sky-who', sess.role === 't' ? 't' : 'p:' + sess.pid);
  // 使用者還在操作時，通行證過半就自動延長
  const ttl = sess.role === 't' ? TTL_T : TTL_P;
  if (request.headers.get('x-sky-active') === '1' && sess.exp - Date.now() < ttl / 2 && !resp.headers.has('set-cookie')) {
    resp.headers.append('set-cookie', await sessionCookie(url, sess.cfg, sess.role, sess.pid, sess.rec.ep));
  }
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        if (e instanceof HttpError) return e.response;
        console.error('api error', (e && e.stack) || e);
        return json({ error: 'server' }, 500);
      }
    }

    // 瀏覽器預設會抓 /favicon.ico；若交給 SPA fallback 會回 index.html（HTML 而非圖片），
    // 部分瀏覽器（含 iOS Safari）因此不顯示圖示。改為直接回傳 favicon.png。
    if (url.pathname === '/favicon.ico') {
      return env.ASSETS.fetch(new Request(new URL('/favicon.png', request.url)));
    }

    return env.ASSETS.fetch(request);
  },
};
