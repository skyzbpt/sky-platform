// Worker API 測試：登入驗證、權限隔離、密碼雜湊、舊資料升級。
// 執行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorker, browser, kvAll } from './helpers.mjs';

const LEGACY_KEY = 'sky_state_v1';
const doc = (x) => JSON.stringify({ v: 2, ...x });

// 建立一個已完成首次設定的環境：治療師 boss／boss-pass-1，並回傳治療師的瀏覽器
async function ready(mf) {
  const t = browser(mf);
  const r = await t.login('therapist', 'boss', 'boss-pass-1', { setup: true });
  assert.equal(r.status, 200);
  return t;
}
async function addPatient(t, pid, acct, pwd) {
  const r = await t.post('/api/account', { op: 'set', pid, acct, pwd });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}

test('未登入：資料端點一律 401，舊端點已停用', async () => {
  const mf = newWorker();
  try {
    const b = browser(mf);
    assert.equal((await b.get('/api/public')).data.mode, 'setup');
    for (const p of ['/api/doc/m', '/api/doc/p/L0', '/api/doc/t/L0', '/api/versions', '/api/blob/' + 'a'.repeat(64), '/api/legacy']) {
      assert.equal((await b.get(p)).status, 401, p);
    }
    assert.deepEqual((await b.get('/api/session')).data, { role: null }, '沒登入時只回報「沒有人登入」');
    assert.equal((await b.putDoc('m', doc({}))).status, 401);
    assert.equal((await b.post('/api/account', { op: 'set', pid: 'x', acct: 'a', pwd: 'aaaaaa' })).status, 401);
    assert.equal((await b.post('/api/migrate/finish', {})).status, 401);
    assert.equal((await b.get('/api/state')).status, 410);
    assert.notEqual((await b.put('/api/state', '{}', { 'x-sky-base': '0', 'x-sky-req': null })).status, 200);
    // 完成設定後，沒有通行證一樣是 401
    await ready(mf);
    assert.equal((await b.get('/api/doc/m')).status, 401);
    assert.equal((await b.get('/api/public')).data.mode, 'ready');
  } finally {
    await mf.dispose();
  }
});

test('首次設定：要明確確認、密碼至少 6 個字元；之後不能再設定', async () => {
  const mf = newWorker();
  try {
    const b = browser(mf);
    assert.equal((await b.login('patient', 'x', 'yyyyyy')).status, 401);
    let r = await b.login('therapist', 'boss', 'boss-pass-1');
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'setup');
    r = await b.login('therapist', 'boss', '12345', { setup: true });
    assert.equal(r.data.error, 'weak');
    r = await b.login('therapist', 'boss', 'boss-pass-1', { setup: true });
    assert.equal(r.status, 200);
    assert.match(b.cookie, /^sky_s=/);
    assert.deepEqual((await b.get('/api/session')).data, { role: 't', pid: '', acct: 'boss' });
    // 第二個人不能再「首次設定」
    const c = browser(mf);
    r = await c.login('therapist', 'evil', 'evil-pass-1', { setup: true });
    assert.equal(r.status, 401);
    assert.equal((await c.login('therapist', 'boss', 'wrong-pass')).status, 401);
    assert.equal((await c.login('therapist', 'BOSS', 'boss-pass-1')).status, 401);
    assert.equal((await c.login('therapist', 'boss', 'boss-pass-1')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('https 網址使用 __Host- cookie，且帶 Secure／HttpOnly', async () => {
  const mf = newWorker();
  try {
    const r = await mf.dispatchFetch('https://sky-platform.example.workers.dev/api/login', {
      method: 'POST',
      headers: { 'x-sky-req': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'therapist', acct: 'boss', pwd: 'boss-pass-1', setup: true }),
    });
    const c = r.headers.get('set-cookie');
    assert.match(c, /^__Host-sky_s=/);
    assert.match(c, /; Secure/);
    assert.match(c, /; HttpOnly/);
    assert.match(c, /; SameSite=Lax/);
    assert.match(c, /; Path=\//);
  } finally {
    await mf.dispose();
  }
});

test('密碼只存加鹽雜湊；KV 內找不到明碼', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    await addPatient(t, 'p2', 'bob', 'amy-secret-9'); // 相同密碼
    const all = await kvAll(mf);
    const a1 = JSON.parse(all['sky2:a:p:p1']);
    const a2 = JSON.parse(all['sky2:a:p:p2']);
    assert.deepEqual(Object.keys(a1).sort(), ['acct', 'ep', 'hash', 'it', 'salt']);
    assert.ok(a1.it >= 50000);
    assert.notEqual(a1.salt, a2.salt);
    assert.notEqual(a1.hash, a2.hash, '相同密碼的雜湊也不能一樣');
    const dump = JSON.stringify(all);
    assert.ok(!dump.includes('amy-secret-9'));
    assert.ok(!dump.includes('boss-pass-1'));
    // 登入與工作階段回應都不含雜湊
    const p = browser(mf);
    const r = await p.login('patient', 'amy', 'amy-secret-9');
    assert.deepEqual(r.data, { ok: true, role: 'p', pid: 'p1', acct: 'amy' });
    assert.deepEqual((await p.get('/api/session')).data, { role: 'p', pid: 'p1', acct: 'amy' });
  } finally {
    await mf.dispose();
  }
});

test('權限：個案只能讀寫自己的文件，治療師可以讀寫全部', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    await addPatient(t, 'p2', 'bob', 'bob-secret-9');
    const m = doc({ order: ['p1', 'p2'], secret: '只有治療師看得到' });
    let r = await t.putDoc('m', m);
    assert.deepEqual([r.status, r.data.ok], [200, true]);
    for (const pid of ['p1', 'p2']) {
      assert.equal((await t.putDoc('t/' + pid, doc({ chat: { msgs: [{ id: 'a', txt: '給 ' + pid }] } }))).data.ok, true);
      assert.equal((await t.putDoc('p/' + pid, doc({ prof: { name: pid } }))).data.ok, true);
    }
    const amy = browser(mf);
    const bob = browser(mf);
    assert.equal((await amy.login('patient', 'amy', 'amy-secret-9')).status, 200);
    assert.equal((await bob.login('patient', 'bob', 'bob-secret-9')).status, 200);

    // 讀
    assert.equal((await amy.get('/api/doc/m')).status, 403);
    assert.match((await amy.get('/api/doc/t/p1')).text, /給 p1/);
    assert.equal((await amy.get('/api/doc/p/p1')).status, 200);
    assert.equal((await amy.get('/api/doc/t/p2')).status, 403);
    assert.equal((await amy.get('/api/doc/p/p2')).status, 403);
    assert.equal((await amy.get('/api/doc/p/' + encodeURIComponent('../m'))).status, 404);
    // 寫
    const v1 = (await amy.get('/api/doc/p/p1')).headers.get('x-sky-version');
    r = await amy.putDoc('p/p1', doc({ prof: { name: 'Amy' } }), v1);
    assert.equal(r.data.ok, true);
    assert.equal((await amy.putDoc('t/p1', doc({}), '0')).status, 403, '個案不能改治療師給他的內容');
    assert.equal((await amy.putDoc('p/p2', doc({}), '0')).status, 403);
    assert.equal((await amy.putDoc('m', doc({}), '0')).status, 403);
    assert.equal((await amy.put('/api/public', { title: 'hacked' })).status, 403);
    assert.equal((await amy.post('/api/account', { op: 'set', pid: 'p2', pwd: 'hacked-123' })).status, 403);
    assert.equal((await amy.post('/api/account', { op: 'delete', pid: 'p2' })).status, 403);
    assert.equal((await amy.post('/api/migrate/finish', {})).status, 403);
    assert.equal((await amy.get('/api/legacy')).status, 403);
    // 版本查詢只回自己的
    r = await amy.post('/api/versions', { p: ['p2'], t: 1 });
    assert.deepEqual(Object.keys(r.data).sort(), ['p', 't']);
    assert.equal(r.data.p[0], (await amy.get('/api/doc/p/p1')).headers.get('x-sky-version'));
    // bob 完全不受影響
    assert.match((await bob.get('/api/doc/p/p2')).text, /"name":"p2"/);
    // 治療師看得到個案寫的內容
    assert.match((await t.get('/api/doc/p/p1')).text, /"name":"Amy"/);
    r = await t.post('/api/versions', { p: ['p1', 'p2', 'nope'], t: 1 });
    assert.equal(r.data.p.nope, 0);
    assert.equal(r.data.p.p1[0], (await t.get('/api/doc/p/p1')).headers.get('x-sky-version'));
    assert.ok(Array.isArray(r.data.t.p2) && r.data.m[0]);
  } finally {
    await mf.dispose();
  }
});

test('版本檢查：過期的版本寫不進去；版本相同時回 204', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    let r = await t.putDoc('m', doc({ n: 1 }), '0', { 'x-sky-version': 'v-one' });
    assert.deepEqual([r.data.ok, r.data.v], [true, 'v-one']);
    r = await t.putDoc('m', doc({ n: 2 }), '0');
    assert.deepEqual([r.status, r.data.ok, r.data.conflict, r.data.v], [200, false, true, 'v-one']);
    r = await t.putDoc('m', doc({ n: 2 }), 'v-one', { 'x-sky-version': 'v-two' });
    assert.equal(r.data.ok, true);
    assert.equal((await t.get('/api/doc/m', { 'x-sky-have': 'v-two' })).status, 204);
    r = await t.get('/api/doc/m', { 'x-sky-have': 'v-one' });
    assert.deepEqual([r.status, r.headers.get('x-sky-version'), r.data.n], [200, 'v-two', 2]);
    assert.ok(Number(r.headers.get('x-sky-at')) > 0);
    // 沒帶版本、不是 JSON 物件、被截斷的內容都拒絕
    assert.equal((await t.put('/api/doc/m', doc({}))).status, 428);
    assert.equal((await t.putDoc('m', '[1,2]', 'v-two')).status, 400);
    assert.equal((await t.putDoc('m', '{"a":1', 'v-two')).status, 400);
    assert.equal((await t.putDoc('m', doc({ n: 3 }), 'v-two', { 'x-sky-force': '1' })).data.ok, true, '版本相符照常寫入');
    assert.equal((await t.putDoc('m', doc({ n: 4 }), 'stale', { 'x-sky-force': '1' })).data.conflict, true, '升級完成後不能強制覆寫');
    assert.equal((await t.get('/api/doc/x')).status, 404);
    assert.equal((await t.get('/api/doc/p/' + 'a'.repeat(41))).status, 404);
  } finally {
    await mf.dispose();
  }
});

test('改密碼：要輸入目前密碼；改完後舊通行證與舊密碼立刻失效', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    const phone = browser(mf);
    const laptop = browser(mf);
    await phone.login('patient', 'amy', 'amy-secret-9');
    await laptop.login('patient', 'amy', 'amy-secret-9');
    assert.equal((await phone.post('/api/account', { op: 'self', pwd: 'new-secret-1', cur: 'wrong' })).data.error, 'cur');
    assert.equal((await phone.post('/api/account', { op: 'self', pwd: '123', cur: 'amy-secret-9' })).data.error, 'weak');
    const r = await phone.post('/api/account', { op: 'self', pwd: 'new-secret-1', cur: 'amy-secret-9' });
    assert.equal(r.status, 200);
    assert.equal((await phone.get('/api/session')).data.role, 'p', '改密碼的這台裝置繼續登入中');
    const stale = await laptop.get('/api/doc/p/p1');
    assert.deepEqual([stale.status, stale.data.error], [401, 'expired']);
    assert.equal((await browser(mf).login('patient', 'amy', 'amy-secret-9')).status, 401);
    assert.equal((await browser(mf).login('patient', 'amy', 'new-secret-1')).status, 200);

    // 治療師重設個案密碼：個案被登出，要用新密碼
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p1', pwd: 'reset-by-pt-7' })).status, 200);
    assert.equal((await phone.get('/api/session')).data.role, null);
    assert.equal((await phone.get('/api/versions')).status, 401);
    assert.equal((await browser(mf).login('patient', 'amy', 'new-secret-1')).status, 401);
    assert.equal((await browser(mf).login('patient', 'amy', 'reset-by-pt-7')).status, 200);

    // 治療師改自己的密碼
    const t2 = browser(mf);
    await t2.login('therapist', 'boss', 'boss-pass-1');
    assert.equal((await t.post('/api/account', { op: 'self', acct: 'chief', pwd: 'chief-pass-2', cur: 'boss-pass-1' })).status, 200);
    assert.equal((await t.get('/api/session')).data.acct, 'chief');
    assert.equal((await t2.get('/api/session')).data.role, null);
    assert.equal((await t2.get('/api/doc/m')).status, 401);
    assert.equal((await browser(mf).login('therapist', 'boss', 'boss-pass-1')).status, 401);
    assert.equal((await browser(mf).login('therapist', 'chief', 'chief-pass-2')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('帳號：不可重複、可改名、刪除後資料與登入一併失效', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    await addPatient(t, 'p2', 'bob', 'bob-secret-9');
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p3', acct: 'amy', pwd: 'another-1' })).data.error, 'dup');
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p3', acct: 'cat' })).data.error, 'needpwd');
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p3', acct: 'cat', pwd: 'short' })).data.error, 'weak');
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'bad id', acct: 'cat', pwd: 'cat-secret-1' })).status, 400);
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p2', acct: 'amy' })).data.error, 'dup');
    // 治療師帳號與個案帳號是分開的，可以同名
    await addPatient(t, 'p3', 'boss', 'patient-boss-1');
    assert.equal((await browser(mf).login('patient', 'boss', 'patient-boss-1')).data.pid, 'p3');
    assert.equal((await browser(mf).login('patient', 'boss', 'boss-pass-1')).status, 401);

    // 改名：新帳號可登入、舊帳號不行、舊名字可以再被別人使用
    const bob = browser(mf);
    await bob.login('patient', 'bob', 'bob-secret-9');
    assert.equal((await bob.post('/api/account', { op: 'self', acct: 'amy', cur: 'bob-secret-9' })).data.error, 'dup');
    assert.equal((await bob.post('/api/account', { op: 'self', acct: 'bobby', cur: 'bob-secret-9' })).data.acct, 'bobby');
    assert.equal((await bob.get('/api/session')).data.acct, 'bobby');
    assert.equal((await browser(mf).login('patient', 'bob', 'bob-secret-9')).status, 401);
    assert.equal((await browser(mf).login('patient', 'bobby', 'bob-secret-9')).status, 200);
    await addPatient(t, 'p4', 'bob', 'new-bob-secret');
    assert.equal((await browser(mf).login('patient', 'bob', 'new-bob-secret')).data.pid, 'p4');
    assert.equal((await t.post('/api/account', { op: 'set', pid: 'p1', acct: 'amy2' })).data.acct, 'amy2');
    assert.equal((await browser(mf).login('patient', 'amy2', 'amy-secret-9')).data.pid, 'p1');

    // 刪除
    await t.putDoc('p/p2', doc({ prof: { name: 'Bob' } }));
    await t.putDoc('t/p2', doc({}));
    assert.equal((await t.post('/api/account', { op: 'delete', pid: 'p2' })).status, 200);
    const gone = await bob.get('/api/doc/p/p2');
    assert.deepEqual([gone.status, gone.data.error], [401, 'gone']);
    assert.equal((await browser(mf).login('patient', 'bobby', 'bob-secret-9')).status, 401);
    assert.equal((await t.get('/api/doc/p/p2')).status, 404);
    assert.equal((await t.get('/api/doc/t/p2')).status, 404);
    const all = await kvAll(mf);
    assert.ok(!Object.keys(all).some((k) => k.endsWith(':p2')));

    // 搬移（匯入備份用）：沿用密碼、換新 id、舊 id 的資料移除
    await t.putDoc('p/p1', doc({ prof: { name: 'Amy' } }));
    const amy = browser(mf);
    await amy.login('patient', 'amy2', 'amy-secret-9');
    assert.deepEqual((await t.post('/api/account', { op: 'move', from: 'p1', pid: 'n1' })).data, { ok: true, acct: 'amy2' });
    assert.equal((await amy.get('/api/session')).data.role, null);
    assert.equal((await browser(mf).login('patient', 'amy2', 'amy-secret-9')).data.pid, 'n1');
    assert.equal((await t.get('/api/doc/p/p1')).status, 404);
    assert.equal((await t.post('/api/account', { op: 'move', from: 'p1', pid: 'n2' })).data.missing, true);
    // 列出帳號（只有治療師可以）
    assert.deepEqual((await t.post('/api/account', { op: 'list' })).data, { ok: true, accounts: { n1: 'amy2', p3: 'boss', p4: 'bob' } });
    assert.equal((await amy.post('/api/account', { op: 'list' })).status, 401);
    const p4 = browser(mf);
    await p4.login('patient', 'bob', 'new-bob-secret');
    assert.equal((await p4.post('/api/account', { op: 'list' })).status, 403);
  } finally {
    await mf.dispose();
  }
});

test('PDF：治療師上傳、登入後才能下載', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    const amy = browser(mf);
    await amy.login('patient', 'amy', 'amy-secret-9');
    const h = 'c'.repeat(64);
    assert.equal((await t.head('/api/blob/' + h)).status, 404);
    assert.equal((await amy.put('/api/blob/' + h, 'data:application/pdf;base64,AAAA')).status, 403);
    assert.deepEqual((await t.put('/api/blob/' + h, 'data:application/pdf;base64,AAAA')).data, { ok: true });
    assert.equal((await t.put('/api/blob/' + h, 'data:application/pdf;base64,BBBB')).data.existed, true);
    assert.equal((await amy.head('/api/blob/' + h)).status, 200);
    assert.equal((await amy.get('/api/blob/' + h)).text, 'data:application/pdf;base64,AAAA');
    assert.equal((await browser(mf).get('/api/blob/' + h)).status, 401);
    assert.equal((await amy.get('/api/blob/nothex')).status, 404);
    assert.equal((await amy.del('/api/blob/' + h)).status, 403);
    assert.equal((await t.del('/api/blob/' + h)).status, 200);
    assert.equal((await amy.get('/api/blob/' + h)).status, 404);
  } finally {
    await mf.dispose();
  }
});

test('跨站請求與偽造的通行證都被拒絕', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    // 沒有自訂標頭（其他網站的表單送不出這個標頭）
    assert.equal((await t.post('/api/logout', {}, { 'x-sky-req': null })).status, 403);
    assert.equal((await t.putDoc('m', doc({}), '0', { 'x-sky-req': null })).status, 403);
    // 來源不是本站
    assert.equal((await t.putDoc('m', doc({}), '0', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.putDoc('m', doc({}), '0', { origin: 'http://localhost' })).data.ok, true);

    // 竄改通行證內容或簽章
    const good = t.cookie;
    const [name, tok] = [good.slice(0, good.indexOf('=')), good.slice(good.indexOf('=') + 1)];
    const [body, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ r: 't', p: '', e: 1, x: Date.now() + 1e9 })).toString('base64url');
    for (const bad of [`${forged}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, body, 'x.y', '']) {
      const b = browser(mf);
      b.cookie = `${name}=${bad}`;
      assert.equal((await b.get('/api/doc/m')).status, 401, bad.slice(0, 20));
    }
    // 過期的通行證（用真正的金鑰簽一張已過期的）
    const kv = await mf.getKVNamespace('SKY_KV');
    const cfg = JSON.parse(await kv.get('sky2:cfg'));
    const { createHmac } = await import('node:crypto');
    const sign = (payload) => {
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return p + '.' + createHmac('sha256', Buffer.from(cfg.secret, 'base64url')).update(p).digest('base64url');
    };
    const b = browser(mf);
    b.cookie = `${name}=${sign({ r: 't', p: '', e: 1, x: Date.now() + 60000 })}`;
    assert.equal((await b.get('/api/doc/m')).status, 200, '自己簽的有效通行證可用（確認測試方法正確）');
    b.cookie = `${name}=${sign({ r: 't', p: '', e: 1, x: Date.now() - 1000 })}`;
    assert.deepEqual([(await b.get('/api/doc/m')).status, (await b.get('/api/doc/m')).data.error], [401, 'expired']);
    b.cookie = `${name}=${sign({ r: 'p', p: 'ghost', e: 1, x: Date.now() + 60000 })}`;
    assert.equal((await b.get('/api/doc/p/ghost')).data.error, 'gone');
    b.cookie = `${name}=${sign({ r: 'p', p: '../m', e: 1, x: Date.now() + 60000 })}`;
    assert.equal((await b.get('/api/versions')).status, 401);
    // 登出後 cookie 被清掉
    await t.post('/api/logout');
    assert.equal(t.cookie, '');
  } finally {
    await mf.dispose();
  }
});

test('猜密碼會被限制次數', async () => {
  const mf = newWorker({ ratelimits: { LOGIN_RL: { simple: { limit: 10, period: 60 } }, LOGIN_IP_RL: { simple: { limit: 60, period: 60 } } } });
  try {
    await ready(mf);
    const b = browser(mf);
    const seen = [];
    for (let i = 0; i < 14; i++) seen.push((await b.login('therapist', 'boss', 'guess-' + i)).status);
    assert.ok(seen.slice(0, 9).every((s) => s === 401), seen.join());
    assert.equal(seen[13], 429);
    // 其他帳號不受影響
    assert.equal((await b.login('therapist', 'other', 'guess-000')).status, 401);
  } finally {
    await mf.dispose();
  }
});

test('使用中的通行證過半會自動延長', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    const kv = await mf.getKVNamespace('SKY_KV');
    const cfg = JSON.parse(await kv.get('sky2:cfg'));
    const { createHmac } = await import('node:crypto');
    const p = Buffer.from(JSON.stringify({ r: 't', p: '', e: 1, x: Date.now() + 3600 * 1000 })).toString('base64url');
    t.cookie = 'sky_s=' + p + '.' + createHmac('sha256', Buffer.from(cfg.secret, 'base64url')).update(p).digest('base64url');
    const before = t.cookie;
    await t.get('/api/versions');
    assert.equal(t.cookie, before, '沒有操作就不延長');
    await t.get('/api/versions', { 'x-sky-active': '1' });
    assert.notEqual(t.cookie, before);
    assert.equal((await t.get('/api/session')).data.role, 't');
  } finally {
    await mf.dispose();
  }
});

test('忘記治療師密碼：帳號擁有者在 KV 放入重設碼後才能重設', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    await addPatient(t, 'p1', 'amy', 'amy-secret-9');
    await t.putDoc('m', doc({ order: ['p1'] }));
    const anon = browser(mf);
    // 沒有重設碼：帶著「設定」的請求也只是一般登入，密碼不對就失敗
    assert.equal((await anon.login('therapist', 'new', 'new-pass-1', { setup: true, code: 'anything-123' })).status, 401);
    const kv = await mf.getKVNamespace('SKY_KV');
    await kv.put('sky2:reset', 'short'); // 太短的重設碼無效
    assert.equal((await anon.get('/api/public')).data.mode, 'reset');
    assert.equal((await anon.login('therapist', 'new', 'new-pass-1', { setup: true, code: 'short' })).data.error, 'code');
    await kv.put('sky2:reset', 'one-time-code-42\n');
    assert.equal((await anon.login('therapist', 'new', 'new-pass-1', { setup: true, code: 'wrong-code-000' })).data.error, 'code');
    assert.equal((await anon.login('therapist', 'new', 'new-pass-1', { setup: true })).data.error, 'code');
    assert.equal((await anon.login('therapist', 'new', '123', { setup: true, code: 'one-time-code-42' })).data.error, 'weak');
    // 等待重設期間，原本的帳密與個案登入都照常
    assert.equal((await browser(mf).login('therapist', 'boss', 'boss-pass-1')).status, 200);
    assert.equal((await browser(mf).login('patient', 'amy', 'amy-secret-9')).status, 200);
    assert.equal((await browser(mf).login('patient', 'amy', 'amy-secret-9', { setup: true, code: 'one-time-code-42' })).data.pid, 'p1', '個案不能用重設碼');
    const r = await anon.login('therapist', 'new', 'new-pass-1', { setup: true, code: 'one-time-code-42' });
    assert.deepEqual(r.data, { ok: true, role: 't', pid: '', acct: 'new', reset: true });
    assert.equal(await kv.get('sky2:reset'), null, '重設碼用過即刪');
    assert.equal((await anon.get('/api/public')).data.mode, 'ready');
    assert.equal((await t.get('/api/doc/m')).status, 401, '舊的通行證失效');
    assert.equal((await browser(mf).login('therapist', 'boss', 'boss-pass-1')).status, 401);
    assert.equal((await anon.get('/api/doc/m')).status, 200, '資料都還在');
    assert.equal((await browser(mf).login('therapist', 'x', 'another-1', { setup: true, code: 'one-time-code-42' })).status, 401);
    assert.equal((await browser(mf).login('patient', 'amy', 'amy-secret-9')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('系統設定不見了但資料還在：不允許任何人重新做「首次設定」', async () => {
  const mf = newWorker();
  try {
    const kv = await mf.getKVNamespace('SKY_KV');
    await kv.put('sky2:m', doc({ order: [] }));
    const b = browser(mf);
    assert.equal((await b.get('/api/public')).data.mode, 'locked');
    const r = await b.login('therapist', 'evil', 'evil-pass-1', { setup: true });
    assert.deepEqual([r.status, r.data.error], [503, 'locked']);
    assert.equal((await b.get('/api/doc/m')).status, 401);
    assert.deepEqual(Object.keys(await kvAll(mf)), ['sky2:m']);
  } finally {
    await mf.dispose();
  }
});

// ── 舊資料升級 ──
const BIG = 'data:image/jpeg;base64,' + 'QUJD'.repeat(300000); // 約 1.2 MB 的圖片
function legacyMain() {
  // 正式站目前的格式（沒有個案 id、訊息沒有 id／時間戳、帳密明碼）
  return {
    patients: [
      { name: '王小明', sex: '男', acct: 'ming', pwd: 'ming-plain-1', av: '王', imgSrc: BIG, tags: [0], note: '膝蓋', unread: 2, assignedVids: [0], assignedKnows: [] },
      { name: '陳美麗', sex: '女', acct: 'mei', pwd: '', av: '陳', imgSrc: '', tags: [], note: '', unread: 0, assignedVids: [], assignedKnows: [] },
      { name: '重複一', sex: '女', acct: 'dup', pwd: 'dup-first-1', av: '重', tags: [], note: '' },
      { name: '重複二', sex: '女', acct: 'dup', pwd: 'dup-second-2', av: '重', tags: [], note: '' },
      { name: '沒帳號', sex: '男', pwd: 'no-acct-pass', av: '沒', tags: [], note: '' },
    ],
    tags: [{ name: '術後恢復', clr: 'blue' }],
    cats: [],
    mediaSubs: ['入門'],
    videos: [{ title: '影片', cat: '', sub: '', desc: '', cv: '', url: '', coverSrc: BIG }],
    knows: [],
    medRecords: [{ ptIdx: 0, date: '2026-01-02', s: '主訴 "引號" \\ 反斜線\\', o: '', a: '', p: '', imgs: [BIG], sent: true }],
    notifications: [],
    msgMap: { 0: [{ who: 'me', t: '10:00', txt: '假的欄位 "pwd":"not-a-real-field" {[,]}' }, { who: 'them', t: '10:01', txt: '結尾反斜線\\' }, { who: 'them', t: '10:02', type: 'img', src: BIG }] },
    annMap: {},
    tAlbumsMap: {},
    tNotesMap: {},
    pAlbumsMap: {},
    pNotesMap: { 1: [{ title: '我的筆記', body: '"pwd":"x"' }] },
    ptStats: [],
    rptDraftMap: {},
    frontState: { title: '天空物理治療', sub: 'Sky PT', logoSrc: 'logo.png' },
    therapistState: { name: 'Sky', title: '物理治療師', initials: 'S', img: '', acct: 'skypt', pwd: 'therapist-plain-9' },
    patientSelf: { name: '測試', initials: '測', img: '' },
  };
}
const SECRETS = ['ming-plain-1', 'dup-first-1', 'dup-second-2', 'no-acct-pass', 'therapist-plain-9'];

async function seedLegacy(mf, obj, text) {
  const kv = await mf.getKVNamespace('SKY_KV');
  await kv.put(LEGACY_KEY, text ?? JSON.stringify(obj));
}
async function runMigration(t) {
  let i = 0;
  let info;
  do {
    const r = await t.post('/api/migrate/accounts', { i });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    info = r.data;
    i = info.i;
  } while (i < info.total);
  return info;
}

test('舊資料升級：帳密換成雜湊、原帳號照常登入、舊資料移除且找不到明碼', async () => {
  const mf = newWorker();
  try {
    const legacy = legacyMain();
    await seedLegacy(mf, legacy);
    const anon = browser(mf);
    let r = await anon.get('/api/public');
    assert.equal(r.data.mode, 'legacy');
    assert.deepEqual(r.data.brand, { title: '天空物理治療', sub: 'Sky PT', logoSrc: 'logo.png' });
    assert.equal(r.data.preview, false);
    assert.ok(!r.text.includes('plain'));
    // 升級前：個案先等等；治療師密碼錯誤不會開始升級；資料端點仍是 401
    assert.deepEqual([(await anon.login('patient', 'ming', 'ming-plain-1')).status, (await anon.login('patient', 'ming', 'ming-plain-1')).data.error], [409, 'upgrading']);
    assert.equal((await anon.login('therapist', 'skypt', 'wrong')).status, 401);
    assert.equal((await anon.login('therapist', 'wrong', 'therapist-plain-9')).status, 401);
    assert.equal((await anon.get('/api/legacy')).status, 401);
    assert.ok(!Object.keys(await kvAll(mf)).some((k) => k.startsWith('sky2:')), '登入失敗不能動到資料');

    const t = browser(mf);
    r = await t.login('therapist', 'skypt', 'therapist-plain-9');
    assert.deepEqual(r.data, { ok: true, role: 't', pid: '', acct: 'skypt', mig: 'pending' });
    assert.deepEqual((await t.get('/api/session')).data, { role: 't', pid: '', acct: 'skypt', mig: 'pending' });
    assert.equal((await anon.get('/api/public')).data.mode, 'migrating');
    assert.equal((await anon.login('patient', 'ming', 'ming-plain-1')).data.error, 'upgrading');

    // 取回的舊資料：密碼全部被塗掉，其餘內容一字不差
    r = await t.get('/api/legacy');
    assert.equal(r.status, 200);
    for (const s of SECRETS) assert.ok(!r.text.includes(s), s);
    const got = JSON.parse(r.text);
    const want = legacyMain();
    want.patients.forEach((p) => 'pwd' in p && (p.pwd = ''));
    want.therapistState.pwd = '';
    assert.deepEqual(got, want);

    // 逐一建立個案帳號；id 的給法與舊版頁面一致
    const info = await runMigration(t);
    assert.deepEqual(info.ids, ['L0', 'L1', 'L2', 'L3', 'L4']);
    assert.equal(info.total, 5);
    // 重跑一次不會出錯（中途關掉頁面可以從頭再來）
    assert.deepEqual((await runMigration(t)).ids, info.ids);

    // 還沒上傳新資料就不能結束
    assert.equal((await t.post('/api/migrate/finish', {})).data.error, 'nodata');
    assert.equal((await t.putDoc('m', doc({ order: info.ids }), 'whatever', { 'x-sky-force': '1' })).data.ok, true, '升級期間可直接覆寫');
    assert.equal((await t.putDoc('m', doc({ order: info.ids }), 'whatever2', { 'x-sky-force': '1' })).data.ok, true);
    for (const pid of info.ids) assert.equal((await t.putDoc('p/' + pid, doc({ prof: { name: pid } }), '0', { 'x-sky-force': '1' })).data.ok, true);
    assert.equal((await t.post('/api/migrate/finish', {})).data.ok, true);

    // 完成：舊資料不見了、備份不含密碼、KV 內任何地方都找不到明碼
    const all = await kvAll(mf);
    assert.ok(!(LEGACY_KEY in all));
    assert.ok(all['sky2:legacy'].length > 1e6);
    const dump = Object.values(all).join('\n');
    for (const s of SECRETS) assert.ok(!dump.includes(s), s);
    assert.equal((await anon.get('/api/public')).data.mode, 'ready');
    assert.equal((await t.get('/api/session')).data.mig, undefined);
    assert.equal((await t.get('/api/legacy')).status, 409);
    assert.equal((await t.post('/api/migrate/accounts', { i: 0 })).status, 409);

    // 原本的帳號都還能登入
    const who = async (acct, pwd) => (await browser(mf).login('patient', acct, pwd)).data;
    assert.equal((await who('ming', 'ming-plain-1')).pid, 'L0');
    assert.equal((await who('mei', 'mei')).pid, 'L1', '舊資料沒設密碼＝密碼與帳號相同');
    assert.equal((await who('dup', 'dup-first-1')).pid, 'L2', '重複的帳號靠密碼區分');
    assert.equal((await who('dup', 'dup-second-2')).pid, 'L3');
    assert.equal((await who('patient', 'no-acct-pass')).pid, 'L4', '舊資料沒有帳號＝patient');
    assert.equal((await who('ming', 'dup-first-1')).error, 'login');
    assert.equal((await browser(mf).login('therapist', 'skypt', 'therapist-plain-9')).status, 200);
    // 登入後才有資料，而且只有自己的
    const ming = browser(mf);
    await ming.login('patient', 'ming', 'ming-plain-1');
    assert.equal((await ming.get('/api/doc/p/L0')).status, 200);
    assert.equal((await ming.get('/api/doc/p/L1')).status, 403);
    // 舊資料若被舊版程式重新寫回，也不會再被採用
    await seedLegacy(mf, legacy);
    assert.equal((await anon.get('/api/public')).data.mode, 'ready');
    assert.equal((await browser(mf).login('patient', 'ming', 'ming-plain-1')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('舊資料升級：同步層格式（已有個案 id、重複 id、非物件的項目、缺帳密的預設值）', async () => {
  const mf = newWorker();
  try {
    const legacy = {
      patients: [
        { id: 'pabc123', name: 'A', acct: 'a1', pwd: 'aaa-plain' },
        { id: 'pabc123', name: 'B（id 重複）', acct: 'b1', pwd: 'bbb-plain' },
        null,
        { id: 'L1', name: 'C', acct: 'c1', pwd: 12345 },
        { id: 'bad id!', name: 'D', acct: 'd1', pwd: 'ddd-plain', pwd2: 'x' },
      ],
      therapistState: { name: 'T' }, // 沒有帳密 → 舊版預設 test／test
      _sync: { hist: ['v1'] },
    };
    await seedLegacy(mf, null, JSON.stringify(legacy, null, 2)); // 有縮排與換行
    const t = browser(mf);
    assert.equal((await t.login('therapist', 'test', 'nope')).status, 401);
    assert.equal((await t.login('therapist', 'test', 'test')).data.mig, 'pending');
    const info = await runMigration(t);
    // 與前端 prepState 相同的規則：重複或不合法的 id 依位置改給 L<n>，已被用掉就往後找
    assert.deepEqual(info.ids, ['pabc123', 'L2', 'L3', 'L1', 'L4']);
    const text = (await t.get('/api/legacy')).text;
    assert.ok(!/plain|12345/.test(text));
    assert.equal(JSON.parse(text).patients[3].pwd, '', '非字串的密碼也會被塗掉');
    assert.equal(JSON.parse(text).patients[2], null);
    await t.putDoc('m', doc({}), '0', { 'x-sky-force': '1' });
    assert.equal((await t.post('/api/migrate/finish', {})).data.ok, true);
    const who = async (acct, pwd) => (await browser(mf).login('patient', acct, pwd)).data;
    assert.equal((await who('a1', 'aaa-plain')).pid, 'pabc123');
    assert.equal((await who('b1', 'bbb-plain')).pid, 'L2');
    assert.equal((await who('c1', '12345')).pid, 'L1');
    assert.equal((await who('d1', 'ddd-plain')).pid, 'L4');
    const all = await kvAll(mf);
    assert.ok(!('sky2:a:p:L3' in all), '不是物件的項目不建立帳號');
    assert.ok(!/plain/.test(Object.values(all).join('\n')));
  } finally {
    await mf.dispose();
  }
});

test('舊資料升級：預覽網址不會開始升級，也不會動到資料', async () => {
  const mf = newWorker();
  try {
    await seedLegacy(mf, legacyMain());
    const before = await kvAll(mf);
    for (const origin of ['https://abc12345-sky-platform.me.workers.dev', 'https://claude-zen-lovelace-m0nu0x-sky-platform.me.workers.dev', 'https://other.me.workers.dev']) {
      const b = browser(mf, origin);
      const pub = (await b.get('/api/public')).data;
      assert.deepEqual([pub.mode, pub.preview], ['legacy', true], origin);
      const r = await b.login('therapist', 'skypt', 'therapist-plain-9');
      assert.deepEqual([r.status, r.data.error], [409, 'preview'], origin);
    }
    assert.deepEqual(await kvAll(mf), before);
    // 正式網址（workers.dev 或自訂網域）才會開始
    for (const origin of ['https://sky-platform.me.workers.dev', 'https://pt.example.com']) {
      assert.equal((await browser(mf, origin).get('/api/public')).data.preview, false, origin);
    }
    const b = browser(mf, 'https://sky-platform.me.workers.dev');
    assert.equal((await b.login('therapist', 'skypt', 'therapist-plain-9')).data.mig, 'pending');
    // 已在正式網址開始升級後，其他網址的治療師也能接手完成（資料已經決定要升級）
    const p = browser(mf, 'https://abc12345-sky-platform.me.workers.dev');
    assert.equal((await p.login('therapist', 'skypt', 'therapist-plain-9')).data.mig, 'pending');
  } finally {
    await mf.dispose();
  }
});

test('舊資料升級：可用環境變數強制指定是否為預覽', async () => {
  const mf = newWorker({ bindings: { SKY_PREVIEW: '1' } });
  try {
    await seedLegacy(mf, legacyMain());
    const b = browser(mf, 'https://pt.example.com');
    assert.equal((await b.get('/api/public')).data.preview, true);
    assert.equal((await b.login('therapist', 'skypt', 'therapist-plain-9')).data.error, 'preview');
  } finally {
    await mf.dispose();
  }
});

test('舊資料升級：升級中斷（舊資料已移除但狀態未更新）可以接續完成', async () => {
  const mf = newWorker();
  try {
    await seedLegacy(mf, legacyMain());
    const t = browser(mf);
    await t.login('therapist', 'skypt', 'therapist-plain-9');
    await runMigration(t);
    await t.putDoc('m', doc({}), '0', { 'x-sky-force': '1' });
    const kv = await mf.getKVNamespace('SKY_KV');
    await kv.delete(LEGACY_KEY); // 模擬 finish 做到一半
    const t2 = browser(mf);
    assert.equal((await t2.login('therapist', 'skypt', 'therapist-plain-9')).data.mig, 'pending');
    assert.deepEqual((await t2.post('/api/migrate/accounts', { i: 0 })).data, { i: 0, total: 0, ids: [], gone: true });
    assert.equal((await t2.post('/api/migrate/finish', {})).data.ok, true);
    assert.equal((await browser(mf).login('patient', 'ming', 'ming-plain-1')).status, 200);
  } finally {
    await mf.dispose();
  }
});

test('登入頁的標題與 Logo：公開可讀、只有治療師能改', async () => {
  const mf = newWorker();
  try {
    const t = await ready(mf);
    assert.equal((await browser(mf).get('/api/public')).data.brand, null);
    assert.equal((await browser(mf).put('/api/public', { title: 'x' })).status, 401);
    assert.equal((await t.put('/api/public', { title: '我的診所', sub: '副標', logoSrc: 'data:image/png;base64,AAAA', extra: 'ignored' })).status, 200);
    assert.deepEqual((await browser(mf).get('/api/public')).data.brand, { title: '我的診所', sub: '副標', logoSrc: 'data:image/png;base64,AAAA' });
  } finally {
    await mf.dispose();
  }
});
