// 瀏覽器端對端測試：用真的瀏覽器操作頁面，連到本機的 Worker（wrangler dev）。
// 執行：npm run test:e2e        只跑其中一段：npm run test:e2e -- fresh｜features｜legacy｜sync｜preview
import { readFileSync } from 'node:fs';
import { startServer, openPage, login, appReady, waitToast, synced, pull, check, loadPlaywright } from './e2e-lib.mjs';

const { chromium } = loadPlaywright();
const only = process.argv.slice(2);
const want = (name) => !only.length || only.includes(name);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const ev = (h, fn, arg) => h.page.evaluate(fn, arg);
const confirmOk = (h) => h.page.click('#m-confirm.on #m-confirm-ok');
const noErrors = (...hs) => hs.forEach((h) => check(h.errors.length === 0, `${h.name}：頁面沒有錯誤` + (h.errors.length ? '\n' + h.errors.join('\n') : '')));

async function addPatient(t, name, acct, pwd) {
  await ev(t, () => goT('pt'));
  await t.page.click('text=+ 新增個案');
  await t.page.fill('#m-pt-nm', name);
  await t.page.fill('#m-pt-acct', acct);
  await t.page.fill('#m-pt-pwd', pwd);
  await t.page.fill('#m-pt-note', '私人備註-' + name);
  await t.page.click('#m-pt .mf .btn.pri');
  await t.page.waitForFunction((n) => patients.some((p) => p.name === n) && !document.querySelector('#m-pt.on'), name);
}
const idxOf = (h, name) => ev(h, (n) => patients.findIndex((p) => p.name === n), name);
async function say(h, role, text, ci) {
  if (role === 't') {
    await ev(h, (i) => { goT('ch'); selectContact(i); }, ci);
    await h.page.fill('#ch-inp', text);
    await h.page.press('#ch-inp', 'Enter');
  } else {
    await ev(h, () => goP('pc'));
    await h.page.fill('#p-ch-inp', text);
    await h.page.press('#p-ch-inp', 'Enter');
  }
}
const chat = (h, ci = 0) => ev(h, (i) => getMsgs(i).map((m) => (m.who === 'me' ? 'T:' : 'P:') + (m.type === 'img' ? '[圖]' : m.txt.split('\n')[0])), ci);

// ───────────────────────── 全新安裝：完整操作一輪 ─────────────────────────
async function fresh(browser) {
  console.log('\n■ 全新安裝：首次設定、治療師與兩位個案的完整操作');
  const srv = await startServer({ port: 8801 });
  try {
    const t = await openPage(browser, srv.base, { name: '治療師' });
    check((await t.page.textContent('#l-note')).includes('首次使用'), '登入頁提示首次設定');
    await login(t, 'therapist', 'boss', '123');
    await waitToast(t, /密碼至少 6 個字元/);
    await login(t, 'therapist', 'boss', 'boss-pass-1');
    await appReady(t);
    check((await ev(t, () => patients.length)) === 0, '全新系統沒有預設個案，也沒有預設帳密');

    await addPatient(t, '王小明', 'amy', 'amy-pass-1');
    await addPatient(t, '陳大文', 'bob', 'bob-pass-1');
    // 帳號重複、密碼太短會被擋下
    await ev(t, () => goT('pt'));
    await t.page.click('text=+ 新增個案');
    await t.page.fill('#m-pt-nm', '重複');
    await t.page.fill('#m-pt-acct', 'amy');
    await t.page.fill('#m-pt-pwd', 'x'.repeat(8));
    await t.page.click('#m-pt .mf .btn.pri');
    await waitToast(t, /已被使用/);
    await t.page.fill('#m-pt-acct', 'carl');
    await t.page.fill('#m-pt-pwd', '123');
    await t.page.click('#m-pt .mf .btn.pri');
    await waitToast(t, /密碼至少 6 個字元/);
    await ev(t, () => closeM('m-pt'));
    check((await ev(t, () => patients.length)) === 2, '重複帳號與過短密碼不會建立個案');

    // 衛教內容：影片＋附 PDF 的知識，推播給王小明
    await ev(t, () => openMediaModal('video', -1));
    await t.page.fill('#m-med-title', '膝關節伸展影片');
    await t.page.fill('#m-med-url', 'youtube.com/watch?v=abc');
    await t.page.click('#m-med .mf .btn.pri');
    await ev(t, () => openMediaModal('know', -1));
    await t.page.fill('#m-med-title', '居家運動手冊');
    await t.page.setInputFiles('#m-pdf-inp', { name: 'handbook.pdf', mimeType: 'application/pdf', buffer: PDF });
    await t.page.waitForFunction(() => document.getElementById('m-pdf-name').textContent.includes('handbook.pdf'));
    await t.page.click('#m-med .mf .btn.pri');
    const amyI = await idxOf(t, '王小明');
    const bobI = await idxOf(t, '陳大文');
    for (const [list, type] of [['videos', 'video'], ['knows', 'know']]) {
      await ev(t, ([l, ty]) => openPush(window.eval(l).length - 1, ty), [list, type]);
      await t.page.check(`#push-pt-list input[data-pi="${amyI}"]`);
      await t.page.click('#m-push .mf .btn.pri');
    }
    // 病歷：王小明一筆已傳送、一筆未傳送；陳大文一筆已傳送
    const record = async (ci, s, send) => {
      await ev(t, (i) => { goT('mr'); selMrPt(i); openMrNew(); }, ci);
      await t.page.fill('#m-mr-s', s);
      await t.page.click('#m-mr .mf .btn.pri');
      await t.page.waitForFunction((x) => medRecords.some((r) => r.s === x), s);
      if (send) await ev(t, (x) => sendMr(medRecords.findIndex((r) => r.s === x)), s);
    };
    await record(amyI, '王小明的病歷-已傳送', true);
    await record(amyI, '王小明的病歷-未傳送草稿', false);
    await record(bobI, '陳大文的病歷-已傳送', true);
    // 對話、圖片、公告、治療師自己的相簿與記事
    await say(t, 't', '小明你好，記得每天做伸展', amyI);
    await say(t, 't', '大文你好，這是只給你的訊息', bobI);
    await ev(t, (i) => selectContact(i), amyI);
    await t.page.setInputFiles('#t-img-inp', { name: 'x.png', mimeType: 'image/png', buffer: PNG });
    await t.page.click('#m-img-prev.on .mf .btn.pri');
    await ev(t, () => { ctxIdx = 0; markAnn(); addAlbum('t'); });
    await ev(t, () => addNote('t'));
    await t.page.fill('#m-note-nm', '治療師私人記事');
    await t.page.fill('#m-note-body', '只有治療師看得到');
    await t.page.click('#m-note .mf .btn.pri');
    await synced(t);
    check((await chat(t, amyI)).join('|') === 'T:小明你好，記得每天做伸展|T:[圖]', '治療師端的對話內容正確');

    // ── 個案王小明（手機）──
    const amy = await openPage(browser, srv.base, { mobile: true, name: '王小明' });
    await login(amy, 'patient', 'amy', 'wrong-pass');
    await waitToast(amy, /帳號或密碼錯誤/);
    await login(amy, 'patient', 'amy', 'amy-pass-1');
    await appReady(amy, 'patient');
    check((await amy.page.textContent('#p-greet')).includes('王小明'), '個案登入後看到自己的名字');
    check((await ev(amy, () => patients.length)) === 1, '個案的瀏覽器裡只有自己一位個案');
    check((await chat(amy)).join('|') === 'T:小明你好，記得每天做伸展|T:[圖]', '個案看到治療師的訊息與圖片');
    check((await ev(amy, () => patients[0].ptUnread)) === 2, '個案端未讀數正確');
    await ev(amy, () => goP('pmr'));
    const mrText = await amy.page.textContent('#p-mr-list');
    check(mrText.includes('王小明的病歷-已傳送') && !mrText.includes('未傳送'), '個案只看得到已傳送的病歷');
    await ev(amy, () => goP('lrn'));
    const lrn = await amy.page.textContent('#lrn-grid');
    check(lrn.includes('膝關節伸展影片') && lrn.includes('居家運動手冊'), '個案看到推播的衛教內容');
    // 下載 PDF（個案端的資料裡沒有 PDF 本體，按下去才向伺服器要）
    check(!(await ev(amy, () => JSON.stringify(knows))).includes('base64'), '個案同步的資料裡沒有 PDF 本體');
    await ev(amy, () => openViewModal('pdf', 0));
    const [dl] = await Promise.all([amy.page.waitForEvent('download'), amy.page.click('#dl-btn')]);
    check(readFileSync(await dl.path()).equals(PDF), '個案下載到的 PDF 內容正確');
    check(dl.suggestedFilename() === 'handbook.pdf', 'PDF 檔名正確'); // 無頭瀏覽器對中文檔名一律回報 download，所以測試用英文檔名
    await ev(amy, () => closeM('m-view'));
    // 每日回報
    await ev(amy, () => goP('dr'));
    await amy.page.check('.ex-cb');
    await ev(amy, () => { document.getElementById('vas-inp').value = 4; setVas(4); });
    await amy.page.fill('#rpt-note', '今天膝蓋比較不痛');
    await amy.page.click('#rpt-btns .btn.pri');
    await waitToast(amy, /已提交/);
    // 回覆訊息、自己的相簿與記事、改名字
    await say(amy, 'p', '謝謝治療師，我會照做');
    await ev(amy, () => addNote('p'));
    await amy.page.fill('#m-note-nm', '小明的日記');
    await amy.page.fill('#m-note-body', '小明自己的記事');
    await amy.page.click('#m-note .mf .btn.pri');
    await ev(amy, () => goP('pac'));
    await amy.page.fill('#p-nm', '王小明（膝）');
    await amy.page.click('[data-pv="pac"] .btn.pri');
    await waitToast(amy, /已儲存/);
    await synced(amy);

    // ── 治療師收到個案的回報與訊息 ──
    await pull(t);
    await t.page.waitForFunction((i) => getMsgs(i).length === 4, amyI, { timeout: 30000 });
    check((await chat(t, amyI)).join('|') === 'T:小明你好，記得每天做伸展|T:[圖]|P:📋 每日回報已提交|P:謝謝治療師，我會照做', '治療師看到個案的回報與訊息，順序正確');
    check((await ev(t, (i) => patients[i].name, amyI)) === '王小明（膝）', '個案改的名字同步給治療師');
    await ev(t, (i) => { goT('ov'); selStatPt(i); }, amyI);
    check((await t.page.textContent('#ov-stats')).includes('100%'), '總覽顯示今日執行率');
    check((await ev(t, (i) => ptStats[i].logs.length, amyI)) === 1, '運動追蹤有一筆回報');
    const ntf = await ev(t, () => notifications.map((n) => n.msg));
    check(ntf.some((m) => m.includes('提交每日回報（完成率 100%・VAS 4）')) && ntf.some((m) => m.includes('傳送訊息：謝謝治療師')), '通知列出個案的回報與訊息');
    check((await ev(t, (i) => patients[i].unread, bobI)) === 0, '其他個案的未讀數不受影響');
    await say(t, 't', '很好，繼續保持', amyI);
    await synced(t);
    await pull(amy);
    await amy.page.waitForFunction(() => getMsgs(0).length === 5, null, { timeout: 30000 });
    check((await chat(amy)).pop() === 'T:很好，繼續保持', '個案收到治療師的回覆');

    // ── 治療師開著編輯視窗時，雲端的更新先不套用（操作到一半資料不會被換掉），關閉後才更新 ──
    await ev(t, (i) => { goT('pt'); openPtModal(i); }, amyI);
    await ev(amy, () => { pNotes.unshift({ title: '視窗開著時新增', body: '' }); renderNotes('p'); _touched = true; });
    await synced(amy);
    await pull(t);
    await t.page.waitForTimeout(800);
    check((await ev(t, (i) => (pNotesMap[i] || []).some((n) => n.title === '視窗開著時新增'), amyI)) === false && (await ev(t, () => _fails)) === 0, '視窗開著時不套用雲端更新，也不會被誤判成連線失敗');
    await ev(t, () => closeM('m-pt'));
    await pull(t);
    await t.page.waitForFunction((i) => (pNotesMap[i] || []).some((n) => n.title === '視窗開著時新增'), amyI, { timeout: 30000 });
    check(true, '視窗關閉後更新就進來了');

    // ── 個案刪訊息：自己的真的刪掉；治療師的只在自己這邊隱藏 ──
    await ev(amy, () => goP('pc'));
    await ev(amy, () => { ctxIdx = getMsgs(0).findIndex((m) => m.txt === '小明你好，記得每天做伸展'); deleteMsg(); });
    await confirmOk(amy);
    await ev(amy, () => { ctxIdx = getMsgs(0).findIndex((m) => m.txt === '謝謝治療師，我會照做'); deleteMsg(); });
    await confirmOk(amy);
    await synced(amy);
    await pull(t);
    await t.page.waitForFunction((i) => getMsgs(i).length === 4, amyI, { timeout: 30000 });
    check((await chat(t, amyI)).join('|') === 'T:小明你好，記得每天做伸展|T:[圖]|P:📋 每日回報已提交|T:很好，繼續保持', '個案刪除治療師的訊息不影響治療師的紀錄；刪除自己的訊息兩邊都消失');
    await amy.page.reload();
    await appReady(amy, 'patient');
    check((await chat(amy)).join('|') === 'T:[圖]|P:📋 每日回報已提交|T:很好，繼續保持', '個案重新整理後仍然登入中，被隱藏的訊息不會回來');

    // ── 資料隔離：個案的瀏覽器收到的所有回應裡，沒有別人的資料，也沒有治療師的私人內容 ──
    const got = amy.bodies.map((b) => b.text).join('\n');
    for (const leak of ['陳大文', 'bob', '只給你的訊息', '陳大文的病歷', '私人備註', '未傳送草稿', '治療師私人記事', '只有治療師看得到', '"salt"', '"hash"', 'boss']) {
      check(!got.includes(leak), `個案收到的資料裡沒有「${leak}」`);
    }
    check(amy.bodies.every((b) => !/\/api\/doc\/m/.test(b.url)), '個案從未讀取治療師的主文件');
    const amyId = await ev(amy, () => SESSION.pid);
    const bobId = await ev(t, (i) => patients[i].id, bobI);
    const probe = await ev(amy, async (id) => {
      const out = {};
      for (const p of ['/api/doc/m', '/api/doc/p/' + id, '/api/doc/t/' + id, '/api/legacy']) out[p] = (await fetch(p)).status;
      out.put = (await fetch('/api/doc/p/' + id, { method: 'PUT', headers: { 'X-Sky-Req': '1', 'X-Sky-Base': '0' }, body: '{}' })).status;
      out.acct = (await fetch('/api/account', { method: 'POST', headers: { 'X-Sky-Req': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'set', pid: id, pwd: 'hacked-123' }) })).status;
      return out;
    }, bobId);
    check(Object.values(probe).every((s) => s === 403), '個案直接向伺服器要別人的資料或改別人的密碼，一律被拒絕 ' + JSON.stringify(probe));
    check(amyId !== bobId, '兩位個案的 id 不同');
    // 治療師收到的回應裡也沒有任何密碼或雜湊
    const tGot = t.bodies.map((b) => b.text).join('\n');
    for (const leak of ['"salt"', '"hash"', '"pwd"', 'amy-pass-1', 'bob-pass-1', 'boss-pass-1']) check(!tGot.includes(leak), `治療師收到的資料裡沒有「${leak}」`);
    // KV 裡找不到任何明碼密碼
    const dump = srv.kvKeys().map((k) => srv.kvGet(k)).join('\n');
    for (const pw of ['amy-pass-1', 'bob-pass-1', 'boss-pass-1']) check(!dump.includes(pw), `KV 內找不到明碼密碼 ${pw}`);

    // ── 未登入：直接打 API 拿不到東西 ──
    const anon = await openPage(browser, srv.base, { name: '未登入' });
    const anonProbe = await ev(anon, async (ids) => {
      const out = [];
      for (const p of ['/api/doc/m', '/api/doc/p/' + ids[0], '/api/doc/t/' + ids[0], '/api/versions', '/api/state']) out.push((await fetch(p)).status);
      return out;
    }, [amyId]);
    check(anonProbe.join() === '401,401,401,401,410', '未登入時資料端點回 401（舊端點已停用）');
    check(!(await anon.page.content()).includes('王小明'), '登入頁本身不含任何個案資料');
    await anon.ctx.close();

    // ── 第二台治療師裝置：兩台同時操作，內容互相合併 ──
    const t2 = await openPage(browser, srv.base, { name: '治療師-平板' });
    await login(t2, 'therapist', 'boss', 'boss-pass-1');
    await appReady(t2);
    check((await ev(t2, () => patients.map((p) => p.name).join())) === '王小明（膝）,陳大文', '第二台裝置載入相同的個案名單');
    check((await chat(t2, amyI)).length === 4 && (await ev(t2, () => medRecords.length)) === 3, '第二台裝置載入相同的對話與病歷');
    await ev(t, () => { tags.push({ name: '電腦新增的標籤', clr: 'green' }); renderTagList(); _touched = true; });
    await say(t2, 't', '平板傳的訊息', bobI);
    await Promise.all([synced(t), synced(t2)]);
    await pull(t);
    await pull(t2);
    await t.page.waitForFunction((i) => getMsgs(i).some((m) => m.txt === '平板傳的訊息'), bobI, { timeout: 30000 });
    await t2.page.waitForFunction(() => tags.some((x) => x.name === '電腦新增的標籤'), null, { timeout: 30000 });
    check(true, '兩台治療師裝置的變更互相同步');
    // 同一位個案的對話，兩台同時各傳一則 → 兩則都保留
    await ev(t, (i) => { goT('ch'); selectContact(i); }, bobI);
    await ev(t2, (i) => { goT('ch'); selectContact(i); }, bobI);
    await t.page.fill('#ch-inp', '電腦同時傳');
    await t2.page.fill('#ch-inp', '平板同時傳');
    await Promise.all([t.page.press('#ch-inp', 'Enter'), t2.page.press('#ch-inp', 'Enter')]);
    await Promise.all([synced(t), synced(t2)]);
    await pull(t);
    await pull(t2);
    await Promise.all([synced(t), synced(t2)]);
    await pull(t);
    const both = (await chat(t, bobI)).join('|');
    check(both.includes('電腦同時傳') && both.includes('平板同時傳') && both === (await chat(t2, bobI)).join('|'), '兩台同時傳訊息，兩則都保留且兩邊一致');

    // 下載雲端新版要花時間；這段時間內使用者的操作不能被蓋掉
    await say(t2, 't', '平板在電腦下載期間傳的', bobI);
    await synced(t2);
    await t.page.route('**/api/doc/t/**', async (route) => { if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
    const slowPull = pull(t);                       // 電腦開始下載（被拖慢 2.5 秒）
    await t.page.waitForTimeout(600);
    await t.page.fill('#ch-inp', '電腦在下載途中傳的');
    await t.page.press('#ch-inp', 'Enter');         // 下載還沒回來，使用者先傳了一則
    await slowPull;
    await t.page.unroute('**/api/doc/t/**');
    await synced(t);
    const mid = (await chat(t, bobI)).join('|');
    check(mid.includes('電腦在下載途中傳的') && mid.includes('平板在電腦下載期間傳的'), '下載雲端新版的等待期間所做的操作不會被蓋掉');
    await pull(t2);
    await t2.page.waitForFunction((i) => getMsgs(i).some((m) => m.txt === '電腦在下載途中傳的'), bobI, { timeout: 30000 });

    // ── 改密碼 ──
    const bob = await openPage(browser, srv.base, { mobile: true, name: '陳大文' });
    await login(bob, 'patient', 'bob', 'bob-pass-1');
    await appReady(bob, 'patient');
    check((await chat(bob)).join('|').includes('只給你的訊息') && !(await chat(bob)).join('|').includes('小明'), '陳大文只看到自己的對話');
    // 個案自己改密碼：要輸入目前密碼
    await ev(bob, () => goP('pac'));
    await bob.page.fill('#p-pwd-new', 'bob-new-pass');
    await bob.page.click('[data-pv="pac"] .btn.pri');
    await waitToast(bob, /請先輸入目前密碼/);
    await bob.page.fill('#p-pwd-new', 'bob-new-pass');
    await bob.page.fill('#p-pwd-cur', 'wrong-current');
    await bob.page.click('[data-pv="pac"] .btn.pri');
    await waitToast(bob, /目前密碼不正確/);
    await bob.page.fill('#p-pwd-new', 'bob-new-pass');
    await bob.page.fill('#p-acct', 'bobby');
    await bob.page.fill('#p-pwd-cur', 'bob-pass-1');
    await bob.page.click('[data-pv="pac"] .btn.pri');
    await waitToast(bob, /已儲存/);
    await synced(bob);
    await pull(t);
    await t.page.waitForFunction((i) => patients[i].acct === 'bobby', bobI, { timeout: 30000 });
    check(true, '個案改了帳號，治療師的個案清單跟著更新');
    // 治療師重設個案密碼 → 個案被登出，舊密碼失效
    await ev(t, (i) => { goT('pt'); openPtModal(i); }, bobI);
    await t.page.fill('#m-pt-pwd', 'reset-pass-9');
    await t.page.click('#m-pt .mf .btn.pri');
    await waitToast(t, /已更新個案/);
    await pull(bob).catch(() => {});
    await bob.page.waitForSelector('#login.on', { timeout: 30000 });
    await waitToast(bob, /登入已失效/);
    check((await ev(bob, () => patients.length)) === 0 && !(await bob.page.content()).includes('只給你的訊息'), '被登出後，個案裝置上的資料已清空');
    await login(bob, 'patient', 'bobby', 'bob-new-pass');
    await waitToast(bob, /帳號或密碼錯誤/);
    await login(bob, 'patient', 'bobby', 'reset-pass-9');
    await appReady(bob, 'patient');
    check(true, '治療師重設密碼後，個案要用新密碼登入');
    // 治療師改自己的密碼 → 另一台治療師裝置被登出
    await ev(t, () => goT('st'));
    await t.page.fill('#st-pwd-new', 'boss-pass-2');
    await t.page.fill('#st-pwd-cur', 'boss-pass-1');
    await t.page.click('[data-tv="st"] .card:nth-child(1) .btn.pri');
    await waitToast(t, /已儲存/);
    await pull(t2).catch(() => {});
    await t2.page.waitForSelector('#login.on', { timeout: 30000 });
    check(true, '治療師改密碼後，其他裝置上的登入失效');
    await t2.ctx.close();

    // ── 備份匯出再匯入：資料都在，個案沿用原本的密碼 ──
    const [bk] = await Promise.all([t.page.waitForEvent('download'), ev(t, () => exportBackup())]);
    const backup = readFileSync(await bk.path(), 'utf8');
    check(!/pwd|salt|"hash"|pass-/.test(backup), '備份檔不含密碼');
    check(backup.includes('王小明的病歷-未傳送草稿') && backup.includes('小明的日記') && backup.includes('只給你的訊息'), '備份檔包含全部資料');
    await t.page.setInputFiles('#import-file-inp', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await confirmOk(t);
    await waitToast(t, /備份匯入成功/, 60000);
    await synced(t, 90000);
    check((await ev(t, () => patients.map((p) => p.name + '/' + p.acct).join())) === '王小明（膝）/amy,陳大文/bobby', '匯入後個案與帳號都在');
    check((await ev(t, (id) => patients.every((p) => p.id !== id), amyId)), '匯入的個案換了新的 id');
    await amy.page.waitForSelector('#login.on', { timeout: 40000 }).catch(() => pull(amy).catch(() => {}));
    await amy.page.waitForSelector('#login.on', { timeout: 40000 });
    await login(amy, 'patient', 'amy', 'amy-pass-1');
    await appReady(amy, 'patient');
    const afterImport = (await chat(amy)).join('|');
    check(afterImport === 'T:[圖]|P:📋 每日回報已提交|T:很好，繼續保持', '匯入後個案用原本的密碼登入，對話都在（先前自己隱藏的那一則仍然隱藏）：' + afterImport);
    check((await ev(amy, () => pNotes.map((n) => n.title).join())) === '視窗開著時新增,小明的日記', '個案自己的記事也還原了');
    await ev(amy, () => goP('lrn'));
    check((await amy.page.textContent('#lrn-grid')).includes('居家運動手冊'), '推播的衛教內容也還原了');

    // ── 刪除個案 ──
    const bobI2 = await idxOf(t, '陳大文');
    const bobNew = await ev(t, (i) => patients[i].id, bobI2);
    await ev(t, (i) => { goT('pt'); deletePt(i); }, bobI2);
    await confirmOk(t);
    await waitToast(t, /已刪除個案/);
    await synced(t);
    check((await ev(t, async (id) => (await fetch('/api/doc/p/' + id)).status, bobNew)) === 404, '刪除個案後，伺服器上該個案的資料已移除');
    await login(await (async () => { await bob.page.reload(); await bob.page.waitForSelector('#login.on'); await bob.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入'); return bob; })(), 'patient', 'bobby', 'reset-pass-9');
    await waitToast(bob, /帳號或密碼錯誤/);
    check(true, '被刪除的個案無法再登入');
    check(srv.kvKeys().filter((k) => k.includes(bobNew) || k.includes(bobId)).length === 0, 'KV 內沒有殘留被刪除個案的資料');

    // ── 同一個瀏覽器的另一個分頁改用別的帳號登入 → 原本的分頁立刻鎖定 ──
    const tab2 = await t.ctx.newPage();
    await tab2.goto(srv.base);
    await tab2.waitForSelector('#t-app.on');        // 同一個瀏覽器共用通行證，直接進入
    const sw = await tab2.evaluate(async () => (await fetch('/api/login', { method: 'POST', headers: { 'X-Sky-Req': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'patient', acct: 'amy', pwd: 'amy-pass-1' }) })).status);
    check(sw === 200, '另一個分頁改用個案帳號登入');
    await pull(t).catch(() => {});
    // 原本的分頁會重新載入：治療師的資料從記憶體與畫面清空，之後顯示的是「現在登入的那個帳號」的畫面
    await t.page.waitForSelector('#p-app.on', { timeout: 30000 });
    const html = await t.page.content();
    check((await ev(t, () => ROLE + patients.length + medRecords.filter((r) => !r.sent).length)) === 'patient10' && !html.includes('未傳送草稿') && !html.includes('治療師私人記事') && !html.includes('私人備註'),
      '原本治療師的分頁立刻清空，不再留有治療師的資料');
    await tab2.close();
    await ev(t, () => logout());
    await t.page.waitForSelector('#login.on');
    await t.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入');
    await login(t, 'therapist', 'boss', 'boss-pass-2');
    await appReady(t);

    // ── 登入頁的標題是公開資訊：治療師改了之後，沒登入的人打開登入頁就看得到 ──
    await ev(t, () => goT('st'));
    await t.page.fill('#st-f-title', '天空物理治療所');
    await t.page.click('[data-tv="st"] .card:nth-child(2) .btn.pri');
    await synced(t);
    const visitor = await openPage(browser, srv.base, { name: '訪客' });
    check((await visitor.page.textContent('#front-title')) === '天空物理治療所' && (await visitor.page.title()) === '天空物理治療所', '登入頁顯示治療師設定的標題');
    await visitor.ctx.close();

    // ── 登出：資料從這台裝置清空 ──
    await ev(t, () => logout());
    await t.page.waitForSelector('#login.on');
    await t.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入');
    check((await ev(t, () => patients.length + medRecords.length)) === 0 && !(await t.page.content()).includes('王小明'), '登出後頁面上沒有任何個案資料');
    check((await ev(t, async () => (await fetch('/api/doc/m')).status)) === 401, '登出後通行證失效');
    // ── 忘記治療師密碼：帳號擁有者在 Cloudflare 後台放入重設碼後，在登入頁重設 ──
    check(!(await t.page.isVisible('#l-code-row')), '平常登入頁沒有重設碼欄位');
    srv.kvPut('sky2:reset', 'my-reset-code-77');
    await t.page.reload();
    await t.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入' && MODE === 'reset');
    check((await t.page.isVisible('#l-code-row')) && (await t.page.textContent('#l-note')).includes('重設治療師帳密'), '放入重設碼後，治療師分頁出現重設說明與重設碼欄位');
    await t.page.click('.l-tab:nth-child(2)');
    check(!(await t.page.isVisible('#l-code-row')), '個案分頁不顯示重設碼欄位');
    await t.page.click('.l-tab:nth-child(1)');
    await t.page.fill('#l-acct', 'newboss');
    await t.page.fill('#l-pwd', 'brand-new-pass');
    await t.page.fill('#l-code', 'wrong-code-0000');
    await t.page.click('.l-submit');
    await waitToast(t, /重設碼不正確/);
    await t.page.fill('#l-pwd', 'brand-new-pass');
    await t.page.fill('#l-code', 'my-reset-code-77');
    await t.page.click('.l-submit');
    await appReady(t);
    check((await ev(t, () => patients.map((p) => p.name).join())) === '王小明（膝）' && (await ev(t, () => therapistState.acct)) === 'newboss', '重設後以新帳密登入，資料都在');
    check(srv.kvGet('sky2:reset') === null, '重設碼用過即刪');
    noErrors(t, amy, bob);
  } finally {
    await srv.stop();
  }
}

// ───────────────────────── 逐一操作各項功能 ─────────────────────────
// 治療師與個案把每個功能都用過一輪：不能有執行期錯誤，而且結果都同步得出去、兩邊看到的一致
async function features(browser) {
  console.log('\n■ 逐一操作治療師與個案的各項功能');
  const srv = await startServer({ port: 8805 });
  try {
  const t=await openPage(browser,srv.base,{name:'T'});
  await login(t,'therapist','boss','boss-pass-1'); await appReady(t);
  for(const [n,a] of [['甲','pa'],['乙','pb'],['丙','pc']]){
    await ev(t,()=>goT('pt')); await t.page.click('text=+ 新增個案'); await t.page.fill('#m-pt-nm',n); await t.page.fill('#m-pt-acct',a); await t.page.fill('#m-pt-pwd','pass-'+a+'-1'); await t.page.click('#m-pt .mf .btn.pri');
    await t.page.waitForFunction((x)=>patients.some(p=>p.name===x)&&!document.querySelector('#m-pt.on'),n);
  }
  // 標籤：新增、套用到個案、編輯、刪除
  await ev(t,()=>{goT('tg');openTagModal(-1);}); await t.page.fill('#m-tag-nm','新標籤'); await t.page.click('#m-tag .mf .btn.pri');
  await ev(t,()=>{openTagModal(0);}); await t.page.fill('#m-tag-nm','改名標籤'); await ev(t,()=>onCustomClr('#ff8800')); await t.page.click('#m-tag .mf .btn.pri');
  await ev(t,()=>{goT('pt');openPtModal(0);togglePtTag(0);togglePtTag(5);}); await t.page.click('#m-pt .mf .btn.pri'); await waitToast(t,/已更新個案/);
  await ev(t,()=>delTag(1)); await confirmOk(t);
  // 分類：新增、改名（影片跟著改）、次主題、刪除
  await ev(t,()=>{openCatModal(-1);}); await t.page.fill('#m-cat-nm','新分類'); await t.page.fill('#m-cat-subs','子一\n子二'); await t.page.click('#m-cat .mf .btn.pri');
  await ev(t,()=>{openCatModal(0);}); await t.page.fill('#m-cat-nm','肩部復健改名'); await t.page.click('#m-cat .mf .btn.pri');
  await ev(t,()=>addSub(0)); await t.page.fill('#m-prompt-inp','新次主題'); await t.page.press('#m-prompt-inp','Enter');
  await ev(t,()=>delSub(0,0)); await confirmOk(t);
  await ev(t,()=>delCat(2)); await confirmOk(t);
  // 影片／知識：編輯、封面、推播、收回、刪除（推播序號要跟著調整）
  await ev(t,()=>{goT('vd');openMediaModal('video',0);}); await t.page.fill('#m-med-desc','改過說明'); await t.page.setInputFiles('#m-cov-inp',{name:'c.png',mimeType:'image/png',buffer:PNG}); await t.page.waitForFunction(()=>document.getElementById('m-cov-prev').style.display==='block'); await t.page.click('#m-med .mf .btn.pri');
  for(const i of [0,1,2]){await ev(t,(k)=>openPush(k,'video'),i); await t.page.check('#push-pt-list input[data-pi="0"]'); if(i===1)await t.page.check('#push-pt-list input[data-pi="1"]'); await t.page.click('#m-push .mf .btn.pri');}
  await ev(t,()=>openPush(2,'video')); await t.page.uncheck('#push-pt-list input[data-pi="0"]'); await t.page.click('#m-push .mf .btn.pri');
  await ev(t,()=>delVideo(0)); await confirmOk(t);
  await ev(t,()=>{goT('kn');openPush(0,'know');}); await t.page.check('#push-pt-list input[data-pi="0"]'); await t.page.click('#m-push .mf .btn.pri');
  await ev(t,()=>delKnow(1)); await confirmOk(t);
  // 病歷：新增（附圖）、編輯、傳送、刪除
  await ev(t,()=>{goT('mr');openMrNew();}); await t.page.fill('#m-mr-s','S1'); await t.page.setInputFiles('#m-mr-img-inp',{name:'r.png',mimeType:'image/png',buffer:PNG}); await t.page.waitForFunction(()=>pendingMrImgs.length===1); await t.page.click('#m-mr .mf .btn.pri');
  await ev(t,()=>openMrNew()); await t.page.fill('#m-mr-s','S2'); await t.page.click('#m-mr .mf .btn.pri');
  await ev(t,()=>openMrModal(0)); await t.page.fill('#m-mr-o','O1'); await t.page.click('#m-mr .mf .btn.pri');
  await ev(t,()=>sendMr(0)); await ev(t,()=>delMr(1,false)); await confirmOk(t);
  // 對話：文字、圖片、公告、刪訊息、搜尋、相簿（含照片與改名）、記事、清除
  await ev(t,()=>{goT('ch');selectContact(0);});
  for(const m of ['一','二','三']){await t.page.fill('#ch-inp',m); await t.page.press('#ch-inp','Enter');}
  await t.page.setInputFiles('#t-img-inp',{name:'x.png',mimeType:'image/png',buffer:PNG}); await t.page.click('#m-img-prev.on .mf .btn.pri');
  await ev(t,()=>{ctxIdx=0;markAnn();ctxIdx=2;markAnn();});
  await ev(t,()=>{ctxIdx=1;deleteMsg();}); await confirmOk(t);
  await ev(t,()=>{openMsgSearch();searchMsgs('三');closeM('m-msearch');});
  await ev(t,()=>{addAlbum('t');openAlbum(0,'t');}); await t.page.setInputFiles('#m-alb-file-inp',{name:'a.png',mimeType:'image/png',buffer:PNG}); await t.page.waitForFunction(()=>albPhotos.length===1); await ev(t,()=>{albEdit();document.getElementById('m-alb-inp-ttl').value='相簿改名';}); await t.page.click('#m-alb .mf .btn.pri');
  await ev(t,()=>addNote('t')); await t.page.fill('#m-note-nm','記事'); await t.page.fill('#m-note-body','內容'); await t.page.click('#m-note .mf .btn.pri');
  await ev(t,()=>{selectContact(1);}); await t.page.fill('#ch-inp','給乙'); await t.page.press('#ch-inp','Enter'); await ev(t,()=>clearChat()); await confirmOk(t);
  // 排序、設定（名稱、頭像、Logo、標題）
  await ev(t,()=>{goT('pt');movePt(0,1);movePt(2,-1);});
  await ev(t,()=>goT('st')); await t.page.fill('#st-nm','天空治療師'); await t.page.setInputFiles('#st-av-inp',{name:'av.png',mimeType:'image/png',buffer:PNG}); await t.page.waitForFunction(()=>therapistImg.startsWith('data:')); await t.page.click('[data-tv="st"] .card:nth-child(1) .btn.pri');
  await t.page.setInputFiles('#st-logo-inp',{name:'lg.png',mimeType:'image/png',buffer:PNG}); await t.page.waitForFunction(()=>pendingLogoSrc); await t.page.click('[data-tv="st"] .card:nth-child(2) .btn.pri');
  for(const v of ['ov','ex','tg','vd','kn','mr','ch','pt','st'])await ev(t,(x)=>goT(x),v);
  await ev(t,()=>{selStatPt(1);exportPdf();toggleNotif();toggleTagFilter();});
  await synced(t,60000);
  const snap=()=>ev(t,()=>JSON.stringify(canonState(liveState())));
    // 個案甲（現在排第 2）登入：看到的內容與治療師端一致
  const p=await openPage(browser,srv.base,{mobile:true,name:'P'});
  await login(p,'patient','pa','pass-pa-1'); await appReady(p,'patient');
  const seenByPt=await ev(p,()=>[getMsgs(0).map(m=>m.txt||'[圖]').join('|'),getAnns(0).map(a=>a.text+'@'+a.msgIdx).join(),videos.map(v=>v.title).join(),knows.map(k=>k.title).join(),medRecords.map(r=>r.s+r.o+(r.imgs||[]).length).join(),therapistState.name+(therapistState.img?'(有頭像)':'')].join(' / '));
  check(seenByPt==='一|三|[圖] / 一@0,三@1 / 麥肯基伸展訓練 / 肩部手術術後照護手冊 / S1O11 / 天空治療師(有頭像)','個案看到的對話、公告、推播內容、病歷與治療師資料都正確：'+seenByPt);
  // 個案端各項功能
  for(const v of ['ph','dr','lrn','pmr','pc','pac'])await ev(p,(x)=>goP(x),v);
  await ev(p,()=>goP('dr')); await p.page.check('.ex-cb >> nth=0'); await ev(p,()=>saveDraft()); await ev(p,()=>{document.getElementById('vas-inp').value=7;setVas(7);}); await p.page.click('#rpt-btns .btn.pri'); await waitToast(p,/已提交/);
  await ev(p,()=>resetRpt()); await p.page.check('.ex-cb >> nth=0'); await p.page.click('#rpt-btns .btn.pri'); await waitToast(p,/已提交/);
  await ev(p,()=>goP('pc')); await p.page.setInputFiles('#p-img-inp',{name:'x.png',mimeType:'image/png',buffer:PNG}); await p.page.click('#m-img-prev.on .mf .btn.pri');
  await ev(p,()=>{addAlbum('p');openAlbum(0,'p');}); await p.page.setInputFiles('#m-alb-file-inp',{name:'a.png',mimeType:'image/png',buffer:PNG}); await p.page.waitForFunction(()=>albPhotos.length===1); await p.page.click('#m-alb .mf .btn.pri');
  await ev(p,()=>addNote('p')); await p.page.fill('#m-note-nm','個案記事'); await p.page.click('#m-note .mf .btn.pri');
  await ev(p,()=>{openNote(0,'p');}); await p.page.fill('#m-note-body','改內容'); await p.page.click('#m-note .mf .btn.pri');
  await ev(p,()=>goP('pac')); await p.page.setInputFiles('#p-av-inp',{name:'av.png',mimeType:'image/png',buffer:PNG}); await p.page.waitForFunction(()=>pendingPtAvImg); await p.page.click('[data-pv="pac"] .btn.pri'); await waitToast(p,/已儲存/);
  await ev(p,()=>{openMsgSearch();searchMsgs('一');closeM('m-msearch');openChatOv('palb');openChatOv('pnt');closeChatOv('p');openViewModal('vid',0);closeM('m-view');});
  await synced(p,60000);
  await pull(t); await t.page.waitForFunction(()=>ptStats.some(s=>s.logs.length===1),null,{timeout:30000}); await synced(t,60000);
  const i=await ev(t,()=>patients.findIndex(x=>x.name==='甲'));
  const seenByT=await ev(t,(k)=>JSON.stringify({msgs:getMsgs(k).map(m=>(m.who==='me'?'T:':'P:')+(m.txt?m.txt.split('\n')[0]:'[圖]')),log:ptStats[k].logs.map(l=>[l.pct,l.done,l.total,l.vas]),unread:patients[k].unread,av:!!patients[k].imgSrc,pAlb:(pAlbumsMap[k]||[]).map(a=>a.photos.length),pNt:(pNotesMap[k]||[]).map(n=>n.title+'/'+n.body),rpt:rptDraftMap[k]&&rptDraftMap[k].submitted}),i);
  check(seenByT==='{"msgs":["T:一","T:三","T:[圖]","P:📋 每日回報已提交","P:📋 每日回報已提交","P:[圖]"],"log":[[100,1,1,0]],"unread":3,"av":true,"pAlb":[1],"pNt":["個案記事/改內容"],"rpt":true}','治療師看到個案的回報、圖片、頭像、相簿與記事：'+seenByT);
  // 重新載入後，治療師端的資料與雲端一致（拆開存放再組回來，內容不變）
  const mid=await snap();
  await t.page.reload(); await appReady(t); await t.page.waitForTimeout(1500);
  const after=await snap();
  const strip=(j)=>JSON.stringify(JSON.parse(j,(k,v)=>k==='ptUnread'?undefined:v));
  check(strip(mid)===strip(after),'治療師重新載入後，資料與重新載入前完全一致');
  await t.page.waitForTimeout(6000);
  check((await ev(t,()=>pendingDocs().length))===0,'重新載入後沒有多餘的寫入');
    noErrors(t, p);
  } finally {
    await srv.stop();
  }
}

// ───────────────────────── 舊資料升級（正式站目前的格式）─────────────────────────
const IMG = 'data:image/png;base64,' + PNG.toString('base64');
function legacyMain() {
  return {
    patients: [
      { name: '林小美', sex: '女', acct: 'mei', pwd: 'mei-plain', av: '林', imgSrc: IMG, tags: [0], note: '舊備註-小美', unread: 1, assignedVids: [0], assignedKnows: [0] },
      { name: '張大偉', sex: '男', acct: 'wei', pwd: '', av: '張', imgSrc: '', tags: [], note: '舊備註-大偉', unread: 0, assignedVids: [], assignedKnows: [] },
    ],
    tags: [{ name: '術後恢復', clr: 'blue' }],
    cats: [{ name: '肩部復健', clr: 'blue', subs: [] }],
    mediaSubs: ['入門'],
    videos: [{ title: '舊影片', cat: '肩部復健', sub: '入門', desc: '', cv: '', url: 'https://example.com/v', coverSrc: '' }],
    knows: [{ title: '舊手冊', cat: '肩部復健', sub: '入門', desc: '', cv: '', coverSrc: '', pdfSrc: 'data:application/pdf;base64,' + PDF.toString('base64'), pdfName: 'old.pdf' }],
    medRecords: [{ ptIdx: 0, date: '2026-10-01', s: '小美舊病歷', o: '', a: '', p: '', imgs: [IMG], sent: true }, { ptIdx: 1, date: '2026-10-02', s: '大偉舊病歷', o: '', a: '', p: '', imgs: [], sent: false }],
    notifications: [{ msg: '舊通知', icon: '💬', t: '09:00', read: false, ci: 0 }],
    msgMap: { 0: [{ who: 'me', t: '09:00', txt: '舊訊息一' }, { who: 'them', t: '09:01', txt: '舊訊息二' }, { who: 'me', t: '09:02', type: 'img', src: IMG }, { who: 'them', t: '09:03', txt: '舊訊息四' }], 1: [{ who: 'me', t: '08:00', txt: '給大偉的舊訊息' }] },
    annMap: { 0: [{ text: '舊訊息一', imgSrc: '', msgIdx: 0 }] },
    tAlbumsMap: { 0: [{ title: '治療師舊相簿', photos: [IMG] }] },
    tNotesMap: {},
    pAlbumsMap: {},
    pNotesMap: { 0: [{ title: '小美舊記事', body: '內容' }] },
    ptStats: [{ weekRate: 0, trend: '+0%', rates: [0, 0, 0, 0, 0, 0, 0], vas: [0, 0, 0, 0, 0, 0, 0], logs: [{ date: '2026-10-01', pct: 50, done: 1, total: 2, vas: 5, note: '舊回報' }], lastVas: 5 }, { logs: [] }],
    rptDraftMap: {},
    frontState: { title: '天空物理治療所', sub: 'Sky PT Clinic', logoSrc: 'logo.png' },
    therapistState: { name: 'Sky', title: '物理治療師', initials: 'S', img: '', acct: 'skypt', pwd: 'sky-plain-pw' },
    patientSelf: { name: '測試', initials: '測', img: '' },
  };
}

async function upgradeAndCheck(browser, srv, label) {
  // 升級前：登入頁沿用原本的標題；個案登入會被請稍候；沒登入拿不到任何資料
  const mei = await openPage(browser, srv.base, { mobile: true, name: '林小美' });
  check((await mei.page.textContent('#front-title')) === '天空物理治療所', '升級前的登入頁沿用原本的標題');
  check((await mei.page.textContent('#l-note')).includes('請治療師先登入完成升級'), '登入頁提示需要升級');
  await login(mei, 'patient', 'mei', 'mei-plain');
  await waitToast(mei, /系統升級中/);
  check((await ev(mei, async () => (await fetch('/api/state')).status)) === 410, '舊的公開端點已停用');
  // 治療師以原本的帳密登入 → 出現升級視窗
  const t = await openPage(browser, srv.base, { name: '治療師' });
  await login(t, 'therapist', 'skypt', 'wrong');
  await waitToast(t, /帳號或密碼錯誤/);
  await login(t, 'therapist', 'skypt', 'sky-plain-pw');
  await t.page.waitForSelector('#m-upg.on');
  check((await t.page.textContent('#m-upg-msg')).includes('127.0.0.1'), '升級前先說明並顯示目前網址');
  // 先按「稍後再說」：回到登入頁，資料原封不動
  await t.page.click('#m-upg-no');
  await t.page.waitForSelector('#login.on');
  await t.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入');
  check(srv.kvGet('sky_state_v1').includes('sky-plain-pw'), '取消升級時舊資料沒有被更動');
  await login(t, 'therapist', 'skypt', 'sky-plain-pw');
  await t.page.waitForSelector('#m-upg.on');
  await t.page.click('#m-upg-go');
  await appReady(t);
  await waitToast(t, /雲端資料載入完成|資料升級完成/);
  check(true, `${label}：升級完成並進入畫面`);
  return { t, mei };
}

async function legacy(browser) {
  console.log('\n■ 舊資料升級：正式站目前的格式（帳密明碼、沒有個案 id）');
  const srv = await startServer({ port: 8802, legacy: legacyMain() });
  try {
    const { t, mei } = await upgradeAndCheck(browser, srv, '舊格式');
    check((await ev(t, () => patients.map((p) => [p.id, p.name, p.acct, p.sex, p.note, p.unread].join('/')).join())) === 'L0/林小美/mei/女/舊備註-小美/1,L1/張大偉/wei/男/舊備註-大偉/0', '個案資料、備註與未讀數都保留');
    check((await chat(t, 0)).join('|') === 'T:舊訊息一|P:舊訊息二|T:[圖]|P:舊訊息四', '對話內容與順序不變');
    check((await ev(t, () => JSON.stringify(annMap[0]))) === '[{"text":"舊訊息一","imgSrc":"","msgIdx":0}]', '公告保留');
    check((await ev(t, () => medRecords.map((r) => r.ptIdx + r.s + r.sent).join())) === '0小美舊病歷true,1大偉舊病歷false', '病歷保留');
    check((await ev(t, () => [tAlbumsMap[0][0].title, pNotesMap[0][0].title, ptStats[0].logs[0].note, videos[0].title, knows[0].pdfName, tags[0].name, therapistState.name, frontState.title].join())) === '治療師舊相簿,小美舊記事,舊回報,舊影片,old.pdf,術後恢復,Sky,天空物理治療所', '相簿、記事、回報紀錄、衛教內容、標籤、設定都保留');
    check((await ev(t, () => therapistState.acct)) === 'skypt', '設定頁顯示治療師帳號');
    await synced(t);
    // 伺服器端：舊的那一包不見了、任何地方都找不到明碼
    const keys = srv.kvKeys();
    check(!keys.includes('sky_state_v1'), '舊資料已從舊版程式讀得到的位置移除');
    check(keys.includes('sky2:legacy'), '保留一份備份');
    const dump = keys.map((k) => srv.kvGet(k)).join('\n');
    for (const pw of ['mei-plain', 'sky-plain-pw']) check(!dump.includes(pw), `KV 內找不到明碼密碼 ${pw}`);
    check(!/"pwd":"[^"]/.test(dump), 'KV 內沒有任何非空的密碼欄位');
    // 重新整理後不會再出現升級視窗
    await t.page.reload();
    await appReady(t);
    check(!(await t.page.$('#m-upg.on')), '升級只會進行一次');
    // 個案用原本的密碼登入，只看到自己的資料
    await mei.page.reload();
    await mei.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入');
    check((await mei.page.textContent('#l-note')) === '', '升級完成後登入頁不再提示');
    await login(mei, 'patient', 'mei', 'mei-plain');
    await appReady(mei, 'patient');
    check((await chat(mei)).join('|') === 'T:舊訊息一|P:舊訊息二|T:[圖]|P:舊訊息四', '個案看到原本的對話');
    check((await ev(mei, () => [medRecords.length, medRecords[0].s, pNotes[0].title, ptStats[0].logs[0].note, videos[0].title].join())) === '1,小美舊病歷,小美舊記事,舊回報,舊影片', '個案看到自己的病歷、記事、回報與推播內容');
    await ev(mei, () => openViewModal('pdf', 0));
    const [dl] = await Promise.all([mei.page.waitForEvent('download'), mei.page.click('#dl-btn')]);
    check(readFileSync(await dl.path()).equals(PDF), '個案可以下載原本推播的 PDF');
    const got = mei.bodies.map((b) => b.text).join('\n');
    for (const leak of ['張大偉', '大偉舊病歷', '給大偉的舊訊息', '舊備註', '治療師舊相簿', 'mei-plain', 'sky-plain-pw', 'skypt']) check(!got.includes(leak), `個案收到的資料裡沒有「${leak}」`);
    // 沒設密碼的舊帳號：密碼與帳號相同（與舊版行為一致）
    const wei = await openPage(browser, srv.base, { mobile: true, name: '張大偉' });
    await login(wei, 'patient', 'wei', 'wei');
    await appReady(wei, 'patient');
    check((await chat(wei)).join('|') === 'T:給大偉的舊訊息' && (await ev(wei, () => medRecords.length)) === 0, '另一位個案也只看到自己的資料（未傳送的病歷看不到）');
    // 升級後照常運作
    await say(mei, 'p', '升級後的新訊息');
    await synced(mei);
    await pull(t);
    await t.page.waitForFunction(() => getMsgs(0).length === 5, null, { timeout: 30000 });
    check((await chat(t, 0)).pop() === 'P:升級後的新訊息' && (await ev(t, () => patients[0].unread)) === 2, '升級後訊息照常往來，未讀數累加');
    noErrors(t, mei, wei);
  } finally {
    await srv.stop();
  }
}

// 同步層分支的格式（有個案 id、訊息有 id／ts、帶 _sync）
async function syncFormat(browser) {
  console.log('\n■ 舊資料升級：同步層格式（已有個案 id 與訊息時間戳）');
  const d = legacyMain();
  d.patients[0].id = 'pabc1';
  d.patients[1].id = 'pabc2';
  d.patients[0].ptUnread = 1;
  let ts = 1700000000000;
  Object.values(d.msgMap).forEach((list) => list.forEach((m, i) => { m.id = 'm' + i + Math.random().toString(36).slice(2, 6); m.ts = ts += 1000; }));
  delete d.patientSelf;
  delete d.notifications;
  d._sync = { hist: ['abc', 'def'] };
  const srv = await startServer({ port: 8803, legacy: d });
  try {
    const { t, mei } = await upgradeAndCheck(browser, srv, '同步層格式');
    check((await ev(t, () => patients.map((p) => p.id).join())) === 'pabc1,pabc2', '原本的個案 id 保留');
    check((await chat(t, 0)).join('|') === 'T:舊訊息一|P:舊訊息二|T:[圖]|P:舊訊息四', '對話內容與順序不變');
    check((await ev(t, () => getMsgs(0)[0].ts)) === 1700000001000, '原本的時間戳保留');
    await mei.page.reload();
    await mei.page.waitForFunction(() => document.querySelector('.l-submit').textContent === '登入');
    await login(mei, 'patient', 'mei', 'mei-plain');
    await appReady(mei, 'patient');
    check((await ev(mei, () => patients[0].ptUnread)) === 1, '個案端的未讀數保留');
    noErrors(t, mei);
  } finally {
    await srv.stop();
  }
}

// 預覽網址：不升級、不動資料
async function preview(browser) {
  console.log('\n■ 預覽網址：只顯示說明，不會動到資料');
  const srv = await startServer({ port: 8804, legacy: legacyMain(), vars: { SKY_PREVIEW: '1' } });
  try {
    const before = srv.kvGet('sky_state_v1');
    const t = await openPage(browser, srv.base, { name: '預覽' });
    check((await t.page.textContent('#l-note')).includes('這是預覽網址'), '登入頁說明這是預覽網址');
    await login(t, 'therapist', 'skypt', 'sky-plain-pw');
    await waitToast(t, /預覽網址/);
    check(!(await t.page.$('#m-upg.on')) && (await t.page.$('#login.on')), '不會出現升級視窗');
    check(srv.kvKeys().join() === 'sky_state_v1' && srv.kvGet('sky_state_v1') === before, 'KV 完全沒有被更動');
    noErrors(t);
  } finally {
    await srv.stop();
  }
}

const browser = await chromium.launch();
let failed = false;
try {
  if (want('fresh')) await fresh(browser);
  if (want('features')) await features(browser);
  if (want('legacy')) await legacy(browser);
  if (want('sync')) await syncFormat(browser);
  if (want('preview')) await preview(browser);
  console.log('\n全部通過');
} catch (e) {
  failed = true;
  console.error('\n✖ ' + (e.stack || e));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
