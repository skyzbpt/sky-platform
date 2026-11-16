// 前端資料層（純函式）測試：文件 ⇄ 畫面資料的拆與組、三方合併、消毒、舊資料轉換。
// 這些函式寫在 public/index.html 裡（「資料格式與合併」區塊），這裡把那一段取出來單獨執行。
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ROOT } from './helpers.mjs';

const html = readFileSync(ROOT + 'public/index.html', 'utf8');
const a = html.indexOf('// ── 資料格式與合併');
const b = html.indexOf('// ── 資料合併結束 ──');
assert.ok(a > 0 && b > a, '找不到資料層區塊');
const NAMES = ['newStat', 'isObj', 'stable', 'eq', 'prepState', 'canonState', 'keepRpt', 'toNorm', 'fromNorm', 'merge3', 'mergeArr', 'mergePer', 'safeImg', 'sanMark', 'seenMark', 'countAfter',
  'mergeByTs', 'canonP', 'canonT', 'canonM', 'splitState', 'joinState', 'joinPatient', 'splitPatient', 'mergeM', 'mergeT', 'mergeP', 'deriveNotifs', 'normLegacy'];
const ctx = vm.createContext({});
vm.runInContext(html.slice(a, b) + `\n;globalThis.__x={${NAMES.join(',')}};`, ctx);
const X = ctx.__x;
const J = (x) => JSON.stringify(x);
const clone = (x) => JSON.parse(JSON.stringify(x));
// vm 內建立的物件與這裡的原型不同，比較前先轉成純 JSON
const same = (got, want, msg) => assert.deepEqual(clone(got), clone(want), msg);

const IMG = 'data:image/jpeg;base64,QUJDREVGRw==';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// 一份內容豐富的資料（已是新格式：訊息有 id／ts）
function sample() {
  return {
    patients: [
      { id: 'pA', name: '王小明', sex: '男', acct: 'ming', av: '王', imgSrc: IMG, tags: [0, 1], note: '私人備註A', unread: 1, ptUnread: 1, assignedVids: [1, 0], assignedKnows: [0] },
      { id: 'pB', name: '陳美麗', sex: '女', acct: 'mei', av: '陳', imgSrc: '', tags: [], note: '私人備註B', unread: 0, ptUnread: 0, assignedVids: [], assignedKnows: [] },
      { id: 'pC', name: '林空白', sex: '其他', acct: 'lin', av: '林', imgSrc: '', tags: [1], note: '', unread: 0, assignedVids: [5], assignedKnows: [] },
    ],
    tags: [{ name: '術後恢復', clr: 'blue' }, { name: '慢性疼痛', clr: 'pink' }],
    cats: [{ name: '肩部復健', clr: 'blue', subs: ['旋轉肌訓練'] }],
    mediaSubs: ['入門', '進階'],
    videos: [{ title: '影片零', cat: '肩部復健', sub: '入門', desc: 'd0', cv: '', url: 'https://example.com/0', coverSrc: IMG }, { title: '影片一', cat: '', sub: '', desc: 'd1', cv: 'c2', url: '', coverSrc: '' }],
    knows: [{ title: '知識零', cat: '肩部復健', sub: '入門', desc: 'k0', cv: '', coverSrc: '', pdfSrc: 'data:application/pdf;base64,JVBERi0=', pdfName: 'a.pdf', pdfHash: 'ab'.repeat(32), url: '' }],
    medRecords: [
      { ptIdx: 0, date: '2026-01-02', s: 'A已傳送', o: '', a: '', p: '', imgs: [IMG], sent: true },
      { ptIdx: 1, date: '2026-01-03', s: 'B已傳送', o: 'o', a: 'a', p: 'p', imgs: [], sent: true },
      { ptIdx: 0, date: '2026-01-04', s: 'A未傳送草稿', o: '', a: '', p: '', imgs: [], sent: false },
    ],
    notifications: [],
    msgMap: {
      0: [
        { id: 'a1', ts: 100, who: 'me', t: '10:00', txt: '治療師給A-1' },
        { id: 'a2', ts: 110, who: 'them', t: '10:01', txt: 'A回覆-1' },
        { id: 'a3', ts: 120, who: 'me', t: '10:02', type: 'img', src: IMG },
        { id: 'a4', ts: 130, who: 'them', t: '10:03', type: 'img', src: PNG },
        { id: 'a5', ts: 140, who: 'me', t: '10:04', txt: '治療師給A-2' },
        { id: 'a6', ts: 150, who: 'them', t: '10:05', txt: '📋 每日回報已提交\n完成率：50%（1/2 項）\nVAS 疼痛：4 分', auto: true },
      ],
      1: [{ id: 'b1', ts: 200, who: 'me', t: '11:00', txt: '治療師給B' }, { id: 'b2', ts: 210, who: 'them', t: '11:01', txt: 'B的秘密訊息' }],
    },
    annMap: { 0: [{ text: '治療師給A-1', imgSrc: '', msgIdx: 0 }, { text: 'A回覆-1', imgSrc: '', msgIdx: 1 }] },
    tAlbumsMap: { 0: [{ title: '治療師相簿A', photos: [IMG] }] },
    tNotesMap: { 1: [{ title: '治療師記事B', body: '私人記事B' }] },
    pAlbumsMap: { 0: [{ title: 'A的相簿', photos: [PNG, IMG] }] },
    pNotesMap: { 0: [{ title: 'A的記事', body: 'A寫的內容' }], 1: [{ title: 'B的記事', body: 'B寫的內容' }] },
    ptStats: [
      { weekRate: 0, trend: '+0%', rates: [0, 0, 0, 0, 0, 0, 0], vas: [0, 0, 0, 0, 0, 0, 0], logs: [{ date: '2026-01-01', pct: 50, done: 1, total: 2, vas: 4, note: 'A的回報' }], lastVas: 4 },
      X.newStat(),
      X.newStat(),
    ],
    rptDraftMap: { 0: { date: '2026-01-02', exercises: { 0: true }, vas: 3, note: '草稿', submitted: false, saved: true } },
    frontState: { title: '天空物理治療', sub: 'Sky PT', logoSrc: 'logo.png' },
    therapistState: { name: 'Sky', title: '物理治療師', initials: 'S', img: IMG, acct: 'skypt' },
    ntf: { clr: 0, read: 0 },
  };
}
const roundTrip = (F) => X.prepState(X.joinState(clone(X.splitState(F)), F.therapistState.acct));

test('拆成文件再組回來：內容與順序完全一樣', () => {
  // normLegacy：把範例裡的未讀「數量」換成記號（實際資料在升級時做過一次）
  const F = X.normLegacy(sample());
  F.patients[2].ptUnread = 0;
  const D = X.splitState(F);
  const F2 = roundTrip(F);
  same(X.canonState(F2), X.canonState(F));
  same(F2.medRecords, F.medRecords);
  same(F2.annMap, F.annMap);
  // 再拆一次要得到一模一樣的文件（否則會被誤判成有變更而不斷上傳）
  assert.equal(J(X.splitState(F2)), J(D));
  assert.deepEqual(Object.keys(D.t), ['pA', 'pB', 'pC']);
  assert.deepEqual(clone(D.m.order), ['pA', 'pB', 'pC']);
});

test('文件內容的歸屬：個案的文件裡沒有別人的資料，也沒有治療師的私人內容', () => {
  const D = X.splitState(X.prepState(sample()));
  const forA = J(D.t.pA) + J(D.p.pA);
  const forB = J(D.t.pB) + J(D.p.pB);
  for (const leak of ['B的秘密訊息', '治療師給B', 'B已傳送', 'B的記事', '陳美麗', 'mei', '私人備註', '私人記事', '治療師相簿', 'A未傳送草稿', '術後恢復', 'skypt', '影片零" 以外']) {
    assert.ok(!forA.includes(leak), 'A 的文件不該出現：' + leak);
  }
  for (const leak of ['A回覆', '治療師給A', 'A已傳送', 'A的相簿', 'A的記事', 'A的回報', '王小明', 'ming', '私人備註', '私人記事']) {
    assert.ok(!forB.includes(leak), 'B 的文件不該出現：' + leak);
  }
  // 個案該看到的都在
  for (const need of ['治療師給A-1', 'A回覆-1', 'A已傳送', '影片一', '影片零', '知識零', 'A的相簿', 'Sky', '草稿']) assert.ok(forA.includes(need), need);
  // 推播的內容依推播順序；PDF 只放雜湊、不放檔案本體
  same(D.t.pA.pub.vids.map((v) => v.title), ['影片一', '影片零']);
  same(D.t.pA.pub.knows[0], { title: '知識零', cat: '肩部復健', sub: '入門', desc: 'k0', cv: '', coverSrc: '', pdfName: 'a.pdf', pdfRef: 'ab'.repeat(32) });
  assert.ok(!forA.includes('JVBERi0'));
  same(D.t.pC.pub.vids, [], '指向不存在的影片不會出錯');
  // 文件裡完全沒有密碼欄位
  assert.ok(!/pwd|password/i.test(J(D)));
  // 治療師的訊息在 T、個案的訊息在 P
  same(D.t.pA.chat.msgs.map((m) => m.id), ['a1', 'a3', 'a5']);
  same(D.p.pA.msgs.map((m) => m.id), ['a2', 'a4', 'a6']);
  // 主文件不含對話內容
  assert.ok(!J(D.m).includes('治療師給A') && !J(D.m).includes('A回覆'));
});

test('個案端：只組出自己一位個案的畫面資料；拆回去等於原本的文件', () => {
  const D = X.splitState(X.prepState(sample()));
  const brand = { title: '天空物理治療', sub: 'Sky PT', logoSrc: 'logo.png' };
  const Fp = X.prepState(X.joinPatient(clone(D.t.pA), clone(D.p.pA), 'pA', brand));
  assert.equal(Fp.patients.length, 1);
  same(Fp.msgMap[0].map((m) => m.id), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  same(Fp.patients[0].assignedVids, [0, 1]);
  same(Fp.videos.map((v) => v.title), ['影片一', '影片零']);
  same(Fp.medRecords.map((r) => [r.ptIdx, r.s, r.sent]), [[0, 'A已傳送', true]]);
  same(Fp.annMap[0].map((x) => x.msgIdx), [0, 1]);
  same(Fp.therapistState.name, 'Sky');
  same(Fp.frontState.title, '天空物理治療');
  assert.equal(Fp.patients[0].note, '');
  assert.equal(J(X.splitPatient(Fp, clone(D.t.pA))), J(D.p.pA));
});

test('個案端的操作：傳訊息、刪自己的訊息、刪治療師的訊息（只在自己這邊隱藏）、清除對話', () => {
  const F = X.prepState(sample());
  const D = clone(X.splitState(F));
  const Fp = X.prepState(X.joinPatient(D.t.pA, D.p.pA, 'pA', {}));
  Fp.msgMap[0].push({ id: 'new1', ts: 999, who: 'them', t: '12:00', txt: '個案新訊息' });
  Fp.msgMap[0] = Fp.msgMap[0].filter((m) => m.id !== 'a2' && m.id !== 'a3'); // 刪掉自己的一則、治療師的一則
  let P = clone(X.splitPatient(Fp, D.t.pA));
  same(P.msgs.map((m) => m.id), ['a4', 'a6', 'new1']);
  same(P.hid, ['a3']);
  // 個案重新載入：被隱藏的訊息不會回來
  const again = X.prepState(X.joinPatient(D.t.pA, P, 'pA', {}));
  same(again.msgMap[0].map((m) => m.id), ['a1', 'a4', 'a5', 'a6', 'new1']);
  assert.equal(J(X.splitPatient(again, D.t.pA)), J(P));
  // 治療師那邊：自己的訊息都還在，看得到個案的新訊息，也看得到個案刪了自己那一則
  const Ft = X.prepState(X.joinState({ m: D.m, t: D.t, p: { ...D.p, pA: P } }, 'skypt'));
  same(Ft.msgMap[0].map((m) => m.id), ['a1', 'a3', 'a4', 'a5', 'a6', 'new1']);
  // 治療師刪除訊息後，個案的隱藏清單會跟著清掉已不存在的項目
  const T2 = clone(D.t.pA);
  T2.chat.msgs = T2.chat.msgs.filter((m) => m.id !== 'a3');
  const again2 = X.prepState(X.joinPatient(T2, P, 'pA', {}));
  same(X.splitPatient(again2, T2).hid, []);
  // 清除對話：自己的訊息全刪、治療師的全部隱藏
  again.msgMap[0] = [];
  P = clone(X.splitPatient(again, D.t.pA));
  same(P.msgs, []);
  same(P.hid, ['a1', 'a3', 'a5']);
  const cleared = X.prepState(X.joinPatient(D.t.pA, P, 'pA', {}));
  assert.equal(cleared.msgMap[0], undefined);
  assert.equal(cleared.annMap[0], undefined, '指向已隱藏訊息的公告不顯示');
});

test('未讀數由「看到哪一則」推算：歸零後新訊息才會再計數', () => {
  const F = X.prepState(X.normLegacy(sample()));
  let D = clone(X.splitState(F));
  let Ft = X.prepState(X.joinState(D, 'x'));
  assert.equal(Ft.patients[0].unread, 1, '治療師端：A 有 1 則未讀');
  assert.equal(Ft.patients[0].ptUnread, 1);
  // 治療師看過 → 記號移到個案的最後一則
  Ft.patients[0].unread = 0;
  D = clone(X.splitState(Ft));
  same(D.t.pA.chat.seen, { id: 'a6', ts: 150 });
  Ft = X.prepState(X.joinState(D, 'x'));
  assert.equal(Ft.patients[0].unread, 0);
  // 個案再傳兩則
  D.p.pA.msgs.push({ id: 'n1', ts: 500, who: 'them', t: '09:00', txt: '一' }, { id: 'n2', ts: 501, who: 'them', t: '09:00', txt: '二' });
  Ft = X.prepState(X.joinState(D, 'x'));
  assert.equal(Ft.patients[0].unread, 2);
  same(X.splitState(Ft).t.pA.chat.seen, { id: 'a6', ts: 150 }, '還沒看就不動記號');
  // 記號指的訊息被刪掉時改用時間判斷
  D.p.pA.msgs = D.p.pA.msgs.filter((m) => m.id !== 'a6');
  assert.equal(X.joinState(D, 'x').patients[0].unread, 2);
  // 個案端：看過治療師的訊息
  let Fp = X.prepState(X.joinPatient(D.t.pA, D.p.pA, 'pA', {}));
  assert.equal(Fp.patients[0].ptUnread, 1);
  Fp.patients[0].ptUnread = 0;
  const P = clone(X.splitPatient(Fp, D.t.pA));
  same(P.seen, { id: 'a5', ts: 140 });
  D.t.pA.chat.msgs.push({ id: 't9', ts: 600, who: 'me', t: '09:30', txt: '新的' });
  Fp = X.prepState(X.joinPatient(D.t.pA, P, 'pA', {}));
  assert.equal(Fp.patients[0].ptUnread, 1);
});

test('個案寫的內容會先消毒：型別、長度、格式不對的一律丟掉', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const P = clone(X.canonP({
    prof: { name: evil.repeat(10), imgSrc: 'javascript:alert(1)', acct: 12345 },
    msgs: [
      { id: 'ok1', ts: 5, who: 'me', t: evil, txt: evil },                    // 冒充治療師 → 一律視為個案
      { id: '../x', ts: 'NaN', who: 'them', t: '9:05', txt: 123 },
      { id: 'img1', ts: 7, who: 'them', t: '10:00', type: 'img', src: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { id: 'img2', ts: 8, who: 'them', t: '10:00', type: 'img', src: IMG, extra: evil },
      { id: 'ok1', ts: 9, who: 'them', t: '10:00', txt: '重複的 id' },
      'not an object', null,
    ],
    hid: ['a1', evil, 5, 'a1'],
    seen: { id: evil, ts: 1 },
    pAlb: [{ title: 5, photos: [IMG, evil, 'data:text/html;base64,AAAA'] }, 'x'],
    pNt: [{ title: evil, body: 'b' }, null],
    rpt: { date: evil, exercises: { 0: true, 1: false, evil: true, 9999: true }, vas: 99, note: 5, submitted: 'yes', pct: evil, done: -3, total: 1e9 },
    st: { logs: [{ date: '2026-01-01', pct: evil, done: '2', total: 3.7, vas: 11, note: evil }, { date: 'bad' }, { date: '2026-01-01', pct: 1 }], lastVas: evil, rates: [evil] },
    extra: evil,
  }));
  assert.equal(P.prof.name.length, 60);
  assert.equal(P.prof.imgSrc, '');
  assert.equal(P.prof.acct, '');
  same(P.msgs.map((m) => [m.id, m.who, m.t]), [['ok1', 'them', ''], ['x1', 'them', '9:05'], ['img2', 'them', '10:00']]);
  assert.equal(P.msgs[1].txt, '');
  assert.equal(P.msgs[1].ts, 0);
  same(Object.keys(P.msgs[2]), ['id', 'ts', 'who', 't', 'type', 'src']);
  same(P.hid, ['a1']);
  assert.equal(P.seen, null);
  same(P.pAlb, [{ title: '', photos: [IMG] }]);
  same(P.pNt, [{ title: evil, body: 'b' }], '文字原樣保留（顯示時會跳脫）');
  same(P.rpt, { date: '', exercises: { 0: true }, vas: 10, note: '', submitted: true, saved: false, pct: 0, done: 0, total: 999 });
  same(P.st, { logs: [{ date: '2026-01-01', pct: 0, done: 2, total: 4, vas: 10, note: evil }], lastVas: 0 });
  assert.equal(P.extra, undefined);
  // 完全不是物件也不會出錯
  for (const junk of [null, undefined, 'x', 5, [], { msgs: 'x', st: [], prof: 5, pAlb: {}, rpt: [] }]) {
    same(X.canonP(junk), { v: 2, prof: { name: '', imgSrc: '', acct: '' }, msgs: [], hid: [], seen: null, pAlb: [], pNt: [], rpt: null, st: { logs: [], lastVas: 0 } });
  }
  // 正常內容原樣通過（消毒不會改動合法資料）
  const good = X.splitState(X.prepState(sample())).p.pA;
  assert.equal(J(X.canonP(clone(good))), J(good));
  // 空白草稿不存
  assert.equal(X.canonP({ rpt: { date: '2026-01-01', exercises: { 0: false }, vas: 0, note: '', submitted: false } }).rpt, null);
});

test('合併個案文件：雙方新增都保留、被刪除的不復活、各改各的欄位都生效', () => {
  const base = X.splitState(X.prepState(sample())).p.pA;
  const mine = clone(base);
  const theirs = clone(base);
  mine.msgs.push({ id: 'L1', ts: 300, who: 'them', t: '13:00', txt: '手機傳的' });
  mine.prof.name = '王大明';
  mine.pNt.unshift({ title: '新記事', body: 'x' });
  mine.seen = { id: 'a3', ts: 120 };
  theirs.msgs = theirs.msgs.filter((m) => m.id !== 'a2');             // 治療師刪了一則
  theirs.msgs.push({ id: 'R1', ts: 310, who: 'them', t: '13:01', txt: '平板傳的' });
  theirs.prof.imgSrc = PNG;
  theirs.st.logs.push({ date: '2026-01-05', pct: 100, done: 2, total: 2, vas: 1, note: '' });
  theirs.seen = { id: 'a5', ts: 140 };
  const out = clone(X.mergeP(clone(base), mine, theirs));
  same(out.msgs.map((m) => m.id), ['a4', 'a6', 'R1', 'L1']);
  assert.equal(out.prof.name, '王大明');
  assert.equal(out.prof.imgSrc, PNG);
  same(out.pNt.map((n) => n.title), ['新記事', 'A的記事']);
  same(out.st.logs.map((l) => l.date), ['2026-01-01', '2026-01-05']);
  same(out.seen, { id: 'a5', ts: 140 }, '已讀位置取較新的');
  // 沒有共同基準（來歷不明）時：只接收對方新增的，不採信它的刪除
  const add = clone(X.mergeP(null, mine, theirs, true));
  assert.ok(add.msgs.some((m) => m.id === 'a2') && add.msgs.some((m) => m.id === 'R1'));
  // 兩邊相同或只有一邊有變更
  assert.equal(J(X.mergeP(clone(base), clone(base), theirs)), J(X.canonP(theirs)));
  assert.equal(J(X.mergeP(clone(base), mine, clone(base))), J(X.canonP(mine)));
});

test('合併治療師給個案的文件：訊息與公告合併，推播內容以本機為準', () => {
  const base = X.splitState(X.prepState(sample())).t.pA;
  const mine = clone(base);
  const theirs = clone(base);
  mine.chat.msgs.push({ id: 'L1', ts: 300, who: 'me', t: '13:00', txt: '電腦傳的' });
  mine.pub.vids = [];
  theirs.chat.msgs.push({ id: 'R1', ts: 290, who: 'me', t: '12:59', txt: '手機傳的' });
  theirs.chat.anns = theirs.chat.anns.slice(1);
  theirs.pub.mr = [];
  const out = clone(X.mergeT(clone(base), mine, theirs));
  same(out.chat.msgs.map((m) => m.id), ['a1', 'a3', 'a5', 'R1', 'L1']);
  same(out.chat.anns.length, 1);
  same(out.pub, mine.pub);
});

test('合併主文件：兩台裝置各自新增個案都保留；一邊刪除的個案不會復活，病歷一併移除', () => {
  const base = X.splitState(X.prepState(sample())).m;
  const mine = clone(base);
  const theirs = clone(base);
  mine.order.push('pL');
  mine.per.pL = { sex: '女', tags: [], note: '本機新增', vids: [], knows: [], tAlb: [], tNt: [] };
  mine.per.pA.note = '本機改備註';
  mine.tags.push({ name: '本機標籤', clr: 'green' });
  theirs.order = ['pC', 'pA', 'pR'];                                  // 刪除 pB、調整順序、新增 pR
  delete theirs.per.pB;
  theirs.per.pR = { sex: '男', tags: [], note: '雲端新增', vids: [], knows: [], tAlb: [], tNt: [] };
  theirs.mr = theirs.mr.filter((r) => r._pid !== 'pB');
  theirs.per.pA.tags = [1];
  theirs.ntf = { clr: 50, read: 80 };
  const out = clone(X.mergeM(clone(base), mine, theirs));
  same(Object.keys(out.per).sort(), ['pA', 'pC', 'pL', 'pR']);
  same(out.order.slice().sort(), ['pA', 'pC', 'pL', 'pR']);
  assert.equal(out.per.pA.note, '本機改備註');
  same(out.per.pA.tags, [1]);
  assert.ok(out.mr.every((r) => r._pid !== 'pB') && out.mr.length === 2);
  same(out.tags.map((t) => t.name), ['術後恢復', '慢性疼痛', '本機標籤']);
  same(out.ntf, { clr: 50, read: 80 });
  // 本機刪除的個案，雲端沒動 → 維持刪除
  const del = clone(base);
  del.order = ['pA', 'pC'];
  delete del.per.pB;
  same(Object.keys(X.mergeM(clone(base), del, clone(base)).per), ['pA', 'pC']);
  // 本機沒改排序時採用雲端的排序
  const reordered = clone(base);
  reordered.order = ['pC', 'pB', 'pA'];
  same(X.mergeM(clone(base), clone(base), reordered).order, ['pC', 'pB', 'pA']);
});

test('舊資料轉換：補上訊息 id 與遞增時間戳、未讀數量換成記號、去掉密碼，順序不變', () => {
  const legacy = {
    patients: [
      { name: '王小明', sex: '男', acct: 'ming', pwd: 'plain-1', av: '王', imgSrc: IMG, tags: [0], note: 'n', unread: 2, ptUnread: 1, assignedVids: [0], assignedKnows: [] },
      { name: '陳美麗', acct: 'mei', pwd: 'plain-2', unread: 9 },
      'junk',
    ],
    msgMap: {
      0: [
        { who: 'me', t: '10:00', txt: '一' }, { who: 'them', t: '10:01', txt: '二' }, { who: 'me', t: '10:02', txt: '三' },
        { id: 'keep', ts: 5000, who: 'them', t: '10:03', txt: '四' }, { id: 'keep', ts: 4000, who: 'them', t: '10:04', txt: '五（id 重複、時間倒退）' }, { who: 'me', t: '10:05', txt: '六' },
      ],
      1: [{ who: 'them', t: '1:00', txt: 'x' }],
    },
    annMap: { 0: [{ text: '三', imgSrc: '', msgIdx: 2 }] },
    medRecords: [{ ptIdx: 0, date: '2026-01-02', s: 's', o: '', a: '', p: '', imgs: [], sent: true }],
    therapistState: { name: 'Sky', title: 'PT', initials: 'S', img: '', acct: 'skypt', pwd: 'plain-3' },
    rptDraft: { date: '2026-01-01', exercises: {}, vas: 2, note: '', submitted: false },
    patientSelf: { name: 'x' },
  };
  const F = X.normLegacy(clone(legacy));
  assert.ok(!J(F).includes('plain-'));
  same(F.patients.map((p) => p.id), ['L0', 'L1', 'L2']);
  const msgs = F.msgMap[0];
  same(msgs.map((m) => m.id), ['L0', 'L1', 'L2', 'keep', 'L4', 'L5']);
  assert.ok(msgs.every((m, i) => i === 0 || m.ts > msgs[i - 1].ts), '時間戳遞增');
  same(clone(F.patients[0]._seen).id, 'L1', '未讀 2 則 → 看到倒數第 3 則個案訊息');
  same(clone(F.patients[0]._pseen).id, 'L2', '個案未讀 1 則 → 看到倒數第 2 則治療師訊息');
  assert.equal(F.patients[1]._seen, null, '未讀數比訊息還多 → 全部未讀');
  same(F.rptDraftMap[0].vas, 2);
  // 拆開再組回來：順序、公告位置、未讀數都與原本相同
  const F2 = roundTrip(F);
  same(F2.msgMap[0].map((m) => m.txt), legacy.msgMap[0].map((m) => m.txt));
  same(F2.annMap[0], [{ text: '三', imgSrc: '', msgIdx: 2 }]);
  assert.equal(F2.patients[0].unread, 2);
  assert.equal(F2.patients[0].ptUnread, 1);
  assert.equal(F2.patients[1].unread, 1);
  assert.equal(J(X.splitState(F2)), J(X.splitState(F)));
  // 轉換兩次結果相同
  assert.equal(J(X.normLegacy(clone(F))), J(F));
});

test('通知由個案訊息推算：新的在前、看過或「全部已讀」算已讀、「清除」之前的不列出', () => {
  const F = X.prepState(sample());
  let n = clone(X.deriveNotifs(F));
  same(n.map((x) => [x.msg, x.icon, x.read, x.ci]), [
    ['陳美麗 傳送訊息：B的秘密訊息', '💬', true, 1],
    ['王小明 提交每日回報（完成率 50%・VAS 4）', '📋', false, 0],
    ['王小明 傳送了一張圖片', '💬', true, 0],
    ['王小明 傳送訊息：A回覆-1', '💬', true, 0],
  ]);
  F.ntf = { clr: 0, read: 150 };
  assert.ok(X.deriveNotifs(F).every((x) => x.read));
  F.ntf = { clr: 150, read: 0 };
  same(clone(X.deriveNotifs(F)).map((x) => x.ci), [1]);
  F.msgMap[0].push(...Array.from({ length: 40 }, (_, i) => ({ id: 'z' + i, ts: 1000 + i, who: 'them', t: '1:00', txt: 't' + i + 'x'.repeat(40) })));
  n = X.deriveNotifs(F);
  assert.equal(n.length, 30);
  assert.ok(n[0].msg.endsWith('…') && n[0].msg.includes('t39'));
});

// 以亂數產生各種形狀的資料，確認「拆開 → 組回 → 再拆」永遠穩定
test('亂數測試：任意資料拆開再組回來都穩定', () => {
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const pick = (a) => a[rnd(a.length)];
  for (let round = 0; round < 300; round++) {
    const n = rnd(5);
    const F = { patients: [], msgMap: {}, annMap: {}, tAlbumsMap: {}, tNotesMap: {}, pAlbumsMap: {}, pNotesMap: {}, ptStats: [], rptDraftMap: {}, medRecords: [],
      tags: Array.from({ length: rnd(3) }, (_, i) => ({ name: 'tag' + i, clr: 'blue' })), cats: rnd(2) ? [{ name: 'c', clr: 'pink', subs: ['s'] }] : [],
      mediaSubs: ['入門'], videos: Array.from({ length: rnd(3) }, (_, i) => ({ title: 'v' + i, cat: 'c', sub: '', desc: '', cv: '', url: '', coverSrc: rnd(2) ? IMG : '' })),
      knows: Array.from({ length: rnd(3) }, (_, i) => ({ title: 'k' + i, cat: '', sub: '', desc: '', cv: '', coverSrc: '', ...(rnd(2) ? { pdfSrc: 'data:application/pdf;base64,AA==', pdfName: 'f.pdf', pdfHash: 'cd'.repeat(32) } : {}) })),
      frontState: { title: 't', sub: 's', logoSrc: 'logo.png' }, therapistState: { name: 'n', title: 't', initials: 'n', img: '', acct: 'a' }, ntf: { clr: rnd(3), read: rnd(3) } };
    for (let i = 0; i < n; i++) {
      F.patients.push({ id: 'p' + i, name: pick(['', '王', 'Amy Lin']), sex: pick(['男', '女']), acct: 'acct' + i, imgSrc: rnd(2) ? IMG : '', tags: rnd(2) ? [0] : [], note: pick(['', 'note']),
        unread: 0, ptUnread: 0, assignedVids: Array.from({ length: rnd(3) }, () => rnd(4)), assignedKnows: Array.from({ length: rnd(2) }, () => rnd(4)) });
      const msgs = [];
      let ts = 1000 * i;
      for (let k = rnd(8); k > 0; k--) {
        ts += rnd(3); // 允許相同的時間戳
        const who = pick(['me', 'them']);
        msgs.push(rnd(4) ? { id: 'm' + i + '_' + k, ts, who, t: '10:0' + rnd(10), txt: 'txt' + k } : { id: 'm' + i + '_' + k, ts, who, t: '10:00', type: 'img', src: IMG });
      }
      if (msgs.length) {
        F.msgMap[i] = msgs;
        if (rnd(2)) F.annMap[i] = [{ text: 'ann', imgSrc: '', msgIdx: rnd(msgs.length) }];
        const theirs = msgs.filter((m) => m.who === 'them').length;
        F.patients[i].unread = theirs ? rnd(theirs + 1) : 0;
        const mine = msgs.filter((m) => m.who === 'me').length;
        F.patients[i].ptUnread = mine ? rnd(mine + 1) : 0;
      }
      if (rnd(2)) F.tAlbumsMap[i] = [{ title: 'ta', photos: [IMG] }];
      if (rnd(2)) F.tNotesMap[i] = [{ title: 'tn', body: 'b' }];
      if (rnd(2)) F.pAlbumsMap[i] = [{ title: 'pa', photos: rnd(2) ? [IMG] : [] }];
      if (rnd(2)) F.pNotesMap[i] = [{ title: 'pn', body: 'b' }];
      F.ptStats.push(rnd(2) ? { ...X.newStat(), logs: [{ date: '2026-01-0' + (1 + rnd(9)), pct: rnd(101), done: 1, total: 2, vas: rnd(11), note: '' }], lastVas: rnd(11) } : X.newStat());
      if (rnd(2)) F.rptDraftMap[i] = rnd(2) ? { date: '2026-01-01', exercises: { 0: true }, vas: rnd(11), note: 'n', submitted: false, saved: true } : { date: '2026-01-01', exercises: { 1: true }, vas: 2, note: '', submitted: true, saved: false, pct: 50, done: 1, total: 2 };
      for (let k = rnd(3); k > 0; k--) F.medRecords.push({ ptIdx: i, date: '2026-02-0' + k, s: 's' + k, o: '', a: '', p: '', imgs: [], sent: !!rnd(2) });
    }
    const P = X.normLegacy(clone(F));
    // 亂數產生的訊息時間戳可能相同或倒退；整理後雙方交錯的順序就固定了
    const D = X.splitState(P);
    const F2 = roundTrip(P);
    const D2 = X.splitState(F2);
    assert.equal(J(D2), J(D), 'round ' + round);
    same(X.canonState(F2), X.canonState(P), 'round ' + round);
    same(F2.medRecords, P.medRecords);
    // 個案端也一樣穩定
    for (const p of P.patients) {
      const Fp = X.prepState(X.joinPatient(clone(D.t[p.id]), clone(D.p[p.id]), p.id, {}));
      assert.equal(J(X.splitPatient(Fp, clone(D.t[p.id]))), J(D.p[p.id]), 'patient round ' + round);
      assert.equal(Fp.patients[0].ptUnread, p.ptUnread);
    }
    // 合併：三份相同 → 不變
    assert.equal(J(X.mergeM(clone(D.m), clone(D.m), clone(D.m))), J(D.m));
    for (const id of Object.keys(D.t)) {
      assert.equal(J(X.mergeT(clone(D.t[id]), clone(D.t[id]), clone(D.t[id]))), J(D.t[id]));
      assert.equal(J(X.mergeP(clone(D.p[id]), clone(D.p[id]), clone(D.p[id]))), J(D.p[id]));
    }
  }
});

test('空資料與缺欄位都不會出錯', () => {
  const F = X.prepState({});
  const D = X.splitState(F);
  same(D, { m: { v: 2, order: [], per: {}, mr: [], tags: [], cats: [], mediaSubs: ['入門', '進階', '一般'], videos: [], knows: [], frontState: { title: 'sky 衛教平台', sub: 'Physiotherapy Platform', logoSrc: 'logo.png' },
    therapistState: { name: '測試', title: '物理治療師', initials: '測', img: '' }, ntf: { clr: 0, read: 0 } }, t: {}, p: {} });
  const back = X.prepState(X.joinState({ m: null, t: null, p: undefined }, ''));
  assert.equal(back.patients.length, 0);
  // 主文件有個案、但該個案的文件還沒下載到（剛由別台裝置建立）
  const F2 = X.prepState(X.joinState({ m: { order: ['p1'], per: { p1: {} } }, t: {}, p: {} }, 'me'));
  same(F2.patients.map((p) => [p.id, p.name, p.unread]), [['p1', '', 0]]);
  const Fp = X.prepState(X.joinPatient(null, null, 'p1', null));
  same(Fp.patients.map((p) => p.id), ['p1']);
  same(X.splitPatient(Fp, null), X.canonP(null));
  assert.equal(X.countAfter([], null), 0);
  same(X.mergeByTs([{ id: 1, ts: 5 }], [{ id: 2, ts: 5 }, { id: 3 }]).map((m) => m.id), [1, 2, 3]);
});
