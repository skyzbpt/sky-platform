// 瀏覽器端對端測試的共用工具：啟動本機 Worker（wrangler dev）、塞入舊資料、開瀏覽器。
// 需要 Playwright（npm i -D playwright 或使用環境內建的版本）；這不是專案的必要相依套件。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.mjs';

const require = createRequire(import.meta.url);
export function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    console.error('找不到 playwright，請先安裝：npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');

// 啟動一個獨立的本機環境（自己的 KV 資料夾與連接埠）。legacy＝先放進 KV 的舊資料（物件或字串）
export async function startServer({ port, legacy, vars = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sky-e2e-'));
  const state = join(dir, 'state');
  if (legacy !== undefined) {
    const file = join(dir, 'legacy.json');
    writeFileSync(file, typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
    execFileSync(WRANGLER, ['kv', 'key', 'put', 'sky_state_v1', '--binding', 'SKY_KV', '--path', file, '--local', '--persist-to', state], { cwd: ROOT, stdio: 'pipe' });
  }
  const args = ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const child = spawn(WRANGLER, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(base + '/api/public');
      if (r.ok) break;
    } catch (e) {}
    if (i > 120) throw new Error('wrangler dev 沒有啟動：\n' + log);
    await new Promise((r) => setTimeout(r, 250));
  }
  const kv = (args2) => execFileSync(WRANGLER, ['kv', ...args2, '--binding', 'SKY_KV', '--local', '--persist-to', state], { cwd: ROOT, stdio: 'pipe', maxBuffer: 1 << 28 }).toString();
  return {
    base,
    log: () => log,
    // 直接讀本機 KV（檢查伺服器端實際存了什麼）
    kvKeys: () => JSON.parse(kv(['key', 'list'])).map((k) => k.name),
    kvPut: (key, value) => kv(['key', 'put', key, value]),
    kvGet: (key) => {
      try {
        const out = kv(['key', 'get', key]);
        return out.trim() === 'Value not found' ? null : out; // wrangler 對不存在的 key 印出這行字
      } catch (e) {
        return null;
      }
    },
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 開一個瀏覽器分頁，並記錄頁面錯誤與所有 /api 回應內容（用來檢查個案拿到了哪些資料）
export async function openPage(browser, base, { mobile = false, name = '' } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 800 } : { width: 1280, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  const bodies = [];
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    // 404／409 這類回應瀏覽器會自動印一行「Failed to load resource」，屬於預期中的情況
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return;
    try {
      bodies.push({ url: r.url().replace(base, ''), status: r.status(), text: r.status() === 204 ? '' : await r.text() });
    } catch (e) {}
  });
  await page.goto(base);
  await page.waitForFunction(() => /登入|建立治療師帳號/.test(document.querySelector('.l-submit').textContent) || document.querySelector('#t-app.on,#p-app.on'));
  return { page, ctx, errors, bodies, name };
}
export async function login(h, role, acct, pwd) {
  const { page } = h;
  await page.click(role === 'patient' ? '.l-tab:nth-child(2)' : '.l-tab:nth-child(1)');
  await page.fill('#l-acct', acct);
  await page.fill('#l-pwd', pwd);
  await page.click('.l-submit');
}
export const appReady = (h, role) => h.page.waitForSelector(role === 'patient' ? '#p-app.on' : '#t-app.on', { timeout: 30000 });
export const toastText = (h) => h.page.evaluate(() => (document.getElementById('toast').classList.contains('show') ? document.getElementById('toast').textContent : ''));
export async function waitToast(h, re, timeout = 15000) {
  await h.page.waitForFunction((src) => { const t = document.getElementById('toast'); return t.classList.contains('show') && new RegExp(src).test(t.textContent); }, re.source, { timeout });
}
// 等到所有變更都已上傳
export const synced = (h, timeout = 40000) => h.page.waitForFunction(() => {
  if (_syncP || _paused) return false; // 還在同步中
  if (pendingDocs().length || Object.values(chans).some((c) => c.dirty)) { syncNow(false, true); return false; }
  return true;
}, null, { timeout, polling: 300 });
// 立刻向雲端確認有沒有新資料（測試不想等輪詢間隔）
export const pull = (h) => h.page.evaluate(async () => { _wantFull = true; await syncNow(true); await syncNow(true); });

export function check(cond, msg) {
  if (!cond) throw new Error('檢查失敗：' + msg);
  console.log('  ✓ ' + msg);
}
