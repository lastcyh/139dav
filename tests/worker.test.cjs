const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// Execute the actual Worker in strict mode. Every test gets isolated globals and KV;
// accidental network requests fail instead of contacting a real account.
const source = '"use strict";' + fs.readFileSync(path.join(__dirname, '..', 'worker', 'cloud139.js'), 'utf8')
  .replace('export default {', 'const worker = {');
const config = { auth: btoa('pc:13800138000:token'), account: '13800138000',
  dav_user: 'admin', dav_pass: 'davpass1', admin_pass: 'managepass' };
const basic = (password, user = 'admin') => 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
function sandbox(mounts = {}, cfg = config) {
  const data = new Map([['catalog', JSON.stringify({ version: 1, mounts })]]);
  if (cfg) data.set('config', JSON.stringify(cfg));
  const box = { console: { log() {} }, Date, TextEncoder, TextDecoder, crypto: webcrypto,
    atob, btoa, Response, Request, URL, setTimeout: fn => { fn(); return 0; },
    fetch: async () => { throw Error('Network forbidden'); } };
  const checkKey = key => assert.ok(Buffer.byteLength(key, 'utf8') <= 512, 'KV key exceeds 512 bytes');
  box.env = { CACHE: { data, get: async key => { checkKey(key); return data.get(key) ?? null; },
    put: async (key, value) => { checkKey(key); data.set(key, value); } } };
  vm.createContext(box);
  vm.runInContext(source, box);
  return box;
}
const run = (box, script) => vm.runInContext(script, box);
const saved = box => JSON.parse(box.env.CACHE.data.get('catalog'));
async function request(box, pathname, method = 'GET', password, body) {
  box.req = new Request('https://example.test' + pathname, {
    method, headers: { ...(password ? { Authorization: basic(password) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return run(box, 'worker.fetch(req, env, {waitUntil(){}})');
}
function mockListing(box) {
  run(box, `call139 = async (env, url, body, budget) => {
    useBudget(budget);
    const id = body.getOutLinkInfoReq.linkID;
    (globalThis.probed ||= []).push(id);
    if (id.startsWith('DEAD')) throw new Err139('200000727', 'dead');
    return {data: {coLst: [{coID: id, coName: id + '.mp4', coSize: 42}], caLst: []}};
  };`);
}

test('fresh browser homepage opens setup; DAV methods still require credentials', async () => {
  const box = sandbox({}, null);
  const root = await request(box, '/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('Location'), '/setup');
  assert.equal((await request(box, '/setup')).status, 200);
  assert.equal((await request(box, '/', 'PROPFIND')).status, 401);
  assert.equal((await request(box, '/', 'HEAD')).status, 401);
});

test('environment emergency password overrides stored admin password', async () => {
  const box = sandbox();
  box.env.ADMIN_PASS = 'emergency';
  assert.equal((await request(box, '/admin', 'GET', 'emergency')).status, 200);
  assert.equal((await request(box, '/admin', 'GET', 'managepass')).status, 401);
  assert.equal((await request(box, '/tree', 'GET', 'davpass1')).status, 200);
});

test('reject ambiguous, unreachable and reserved catalog paths', () => {
  const box = sandbox();
  for (const pathname of ['A//B', '/A', 'A/', 'A/../B', './A', 'A/./B', 'A\\B', 'A\nB',
    'health', 'admin/films', 'setup', 'tree', 'link', 'probe', 'A/ /B']) {
    box.mounts = { [pathname]: { id: 'share123' } };
    assert.ok(run(box, 'catalogError(mounts)'), JSON.stringify(pathname));
  }
  box.mounts = { A: { id: 's1' }, 'A/B': { id: 's2' } };
  assert.ok(run(box, 'catalogError(mounts)'));
  box.mounts = { '电影/100% #片名': { id: 'share123#code' } };
  assert.equal(run(box, 'catalogError(mounts)'), null);
});

test('budget exhaustion never caches a partial merged mount', async () => {
  const box = sandbox();
  mockListing(box);
  box.ids = Array.from({ length: 30 }, (_, i) => 'S' + i).join(',');
  await assert.rejects(run(box, 'listMountRoot(env, parseMembers({id:ids}), null, {fillOnly:true,budget:25})'),
    error => error.rc === 'BUDGET');
  assert.equal(box.probed.length, 25);
  assert.equal([...box.env.CACHE.data.keys()].some(key => key.endsWith(':@root')), false);
  assert.equal(run(box, 'globalThis.__dirs?.size || 0'), 0);
});

test('retry requests obey the remaining API budget', async () => {
  const box = sandbox();
  box.__auth = { v: config.auth, ts: Date.now() };
  let calls = 0;
  box.fetch = async () => { calls++; return new Response('{"resultCode":"9530"}'); };
  await assert.rejects(run(box, 'call139(env, API.LIST, {}, 2)'), error => error.rc === 'BUDGET');
  assert.equal(calls, 2);
});

test('large multi-share checks resume within the mount without skipping members', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => 'S' + i);
  const box = sandbox({ '电影/合集': { id: ids.join(',') } });
  mockListing(box);
  const first = await run(box, 'pruneCatalog(env,"",6)');
  assert.equal(first.done, false);
  assert.equal(box.probed.length, 20);
  box.cursor = first.nextFrom;
  const second = await run(box, 'pruneCatalog(env,cursor,6)');
  assert.equal(second.done, true);
  assert.deepEqual(Array.from(box.probed), ids);
});

test('member cursor survives pruning earlier shares and keeps source metadata', async () => {
  const ids = ['DEAD0', ...Array.from({ length: 25 }, (_, i) => 'S' + i)];
  const box = sandbox({ A: { id: ids.join(',') } });
  const cat = saved(box); cat.source_hash = 'source-A';
  box.env.CACHE.data.set('catalog', JSON.stringify(cat));
  mockListing(box);
  const first = await run(box, 'pruneCatalog(env,"",6)');
  assert.equal(first.done, false);
  assert.equal(saved(box).mounts.A.id.includes('DEAD'), false);
  box.cursor = first.nextFrom;
  assert.equal((await run(box, 'pruneCatalog(env,cursor,6)')).done, true);
  assert.deepEqual(Array.from(box.probed).filter(id => !id.startsWith('DEAD')), ids.slice(1));
  assert.equal(saved(box).source_hash, 'source-A');
});

test('share health checks only read the first page of a large directory', async () => {
  const box = sandbox();
  box.calls = 0;
  run(box, `call139 = async () => { calls++; return {data:{coLst:Array.from({length:200},(_,i)=>({coID:String(i),coName:i+'.mp4'}))}}; };`);
  assert.equal((await run(box, 'probeMember(env,{id:"S",pwd:""},20)')).status, 'ok');
  assert.equal(box.calls, 1);
});

for (const oldId of ['DEAD', 'LIVE,DEAD']) {
  test(`pruning preserves a concurrent replacement of ${oldId}`, async () => {
    const box = sandbox({ A: { id: oldId }, B: { id: 'B' } });
    run(box, `listAll = async (env,m) => {
      if(m.id==='DEAD') {
        const current=JSON.parse(await env.CACHE.get('catalog'));
        current.mounts.A={id:'NEW_LIVE'}; current.mounts.C={id:'NEW_MOUNT'};
        await env.CACHE.put('catalog',JSON.stringify(current));
        throw new Err139('200000727','dead');
      }
      return {folders:[],files:[{id:'f',name:'file.mp4'}]};
    };`);
    const result = await run(box, 'pruneCatalog(env,"",6)');
    assert.equal(saved(box).mounts.A.id, 'NEW_LIVE');
    assert.equal(saved(box).mounts.C.id, 'NEW_MOUNT');
    assert.equal(result.removed.length, 0);
    assert.equal(box.env.CACHE.data.has('check_log'), false);
  });
}

test('KV failure during pruning does not fall back to writing an old snapshot', async () => {
  const box = sandbox({ A: { id: 'DEAD' } });
  run(box, `listAll = async env => { env.CACHE.get=async()=>{throw Error('KV unavailable')}; throw new Err139('200000727','dead'); };`);
  await assert.rejects(run(box, 'pruneCatalog(env,"",6)'), /KV unavailable/);
  assert.equal(saved(box).mounts.A.id, 'DEAD');
});

test('unknown errors are retained; only confirmed dead and empty shares are pruned', async () => {
  const box = sandbox({ A: { id: 'DEAD' }, B: { id: 'EMPTY' }, C: { id: 'UNKNOWN' } });
  run(box, `listAll=async(env,m)=>{
    if(m.id==='EMPTY')return {folders:[],files:[]};
    throw new Err139(m.id==='DEAD'?'200000727':'200000799','test');
  };`);
  const result = await run(box, 'pruneCatalog(env,"",6)');
  assert.deepEqual(Object.keys(saved(box).mounts), ['C']);
  assert.equal(result.flagged.length, 1);
  assert.equal(JSON.parse(box.env.CACHE.data.get('check_log')).length, 2);
});

test('sync fingerprint survives manual edits and is updated by a successful upload', async () => {
  const box = sandbox();
  assert.equal((await request(box, '/admin/catalog', 'POST', 'managepass',
    { mounts: { A: { id: 'share123' } }, source_hash: 'hash-A' })).status, 200);
  assert.equal((await request(box, '/admin/catalog-lines', 'POST', 'managepass', { lines: 'B | share456' })).status, 200);
  assert.equal(saved(box).source_hash, 'hash-A');
  const state = await request(box, '/admin/sync-state', 'GET', 'managepass');
  assert.equal((await state.json()).source_hash, 'hash-A');
  assert.equal((await request(box, '/admin/sync-state', 'GET', 'davpass1')).status, 401);
  await request(box, '/admin/catalog', 'POST', 'managepass', { mounts: { C: { id: 'share789' } }, source_hash: 'hash-B' });
  assert.equal(saved(box).source_hash, 'hash-B');
});

test('catalog write queue preserves metadata across simultaneous local writes', async () => {
  const box = sandbox();
  await run(box, `Promise.all([
    saveCatalog(env,{mounts:{A:{id:'a'}},source_hash:'hash-A'}),
    saveCatalog(env,{mounts:{B:{id:'b'}}})
  ])`);
  assert.equal(saved(box).source_hash, 'hash-A');
  assert.deepEqual(Object.keys(saved(box).mounts), ['B']);
});

test('regression: UTF-8 credentials, DAV collections, renamed file extensions and escaping', async () => {
  const box = sandbox({}, { ...config, dav_user: '用户', dav_pass: '密码:abcdef' });
  box.req = new Request('https://example.test/tree', { headers: { Authorization: basic('密码:abcdef', '用户') } });
  assert.equal((await run(box, 'worker.fetch(req,env,{})')).status, 200);
  assert.match(run(box, 'davResponse("/dir",{kind:"dir",name:"dir"},false)'), /<D:href>\/dir\/<\/D:href>/);
  assert.equal(run(box, 'const f=[{name:"test.mp4"},{name:"test.mp4"}];uniqueNames([],f);f[1].name'), 'test (2).mp4');
  const html = run(box, 'ADMIN_FORM("https://example.test",{mounts:1},"admin","pass","",false,[{path:"<script>alert(1)</script>"}])');
  assert.ok(html.includes('&lt;script&gt;'));
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});

test('regression: deeply nested paths keep the source share', async () => {
  const box = sandbox();
  run(box, `listMountRoot=async()=>({folders:[{kind:'dir',id:'d',name:'sub',memberIdx:1}],files:[]});
    listOne=async(env,m)=>({folders:[],files:[{kind:'file',name:'film.mp4',id:m.id}]});`);
  const result = await run(box, 'resolvePath(env,buildTree({mounts:{A:{id:"shareA,shareB"}}}),["A","sub","film.mp4"],null)');
  assert.equal(result.entry.memberIdx, 1);
  assert.equal(result.entry.id, 'shareB');
});

test('admin UI reports an unfinished check when the round limit is reached', async () => {
  const box = sandbox();
  const html = run(box, 'ADMIN_FORM("https://example.test",{mounts:1},"admin","pass","",false,[])');
  const ui = { b1: {}, b2: {}, b3: {}, msg3: {}, confirm: () => true,
    fetch: async () => new Response(JSON.stringify({ok:true,total:1,remaining:1,nextFrom:'A',done:false})) };
  vm.createContext(ui);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  await ui.b3.onclick();
  assert.equal(ui.msg3.className, 'hint err');
  assert.ok(ui.msg3.textContent.includes('尚未完成'));
  assert.equal(ui.b3.disabled, false);
});

test('invalid nonempty catalog lines reject the entire edit and report the line number', async () => {
  for (const invalid of ['B share5678', 'B | ', ' | share5678', 'B | ,,,', 'B | bad id', 'B//C | share5678']) {
    const box = sandbox({ A: { id: 'share1234' }, B: { id: 'share5678' } });
    const before = box.env.CACHE.data.get('catalog');
    const response = await request(box, '/admin/catalog-lines', 'POST', 'managepass',
      { lines: 'A | share1234\n' + invalid });
    assert.equal(response.status, 400, invalid);
    assert.match((await response.json()).error, /第 2 行/);
    assert.equal(box.env.CACHE.data.get('catalog'), before);
  }
});

test('blank lines and repeated paths remain valid, including dictionary property names', async () => {
  const box = sandbox();
  const response = await request(box, '/admin/catalog-lines', 'POST', 'managepass', {
    lines: '\nA | share1234\n\nA | share1234#8888,share5678\nconstructor | share0000\n__proto__ | share9999\n',
  });
  assert.equal(response.status, 200);
  assert.equal(saved(box).mounts.A.id, 'share1234#8888,share5678');
  assert.equal(saved(box).mounts.constructor.id, 'share0000');
  assert.equal(saved(box).mounts.__proto__.id, 'share9999');
  const tree = await request(box, '/tree', 'GET', 'davpass1');
  const summary = (await tree.json()).top;
  assert.equal(summary.constructor, 1);
  assert.equal(summary.__proto__, 1);
});

test('catalog editor rejects missing or incorrectly typed input without changing saved data', async () => {
  for (const body of [null, {}, { lines: [] }, { lines: 42 }]) {
    const box = sandbox({ A: { id: 'share1234' } });
    const before = box.env.CACHE.data.get('catalog');
    assert.equal((await request(box, '/admin/catalog-lines', 'POST', 'managepass', body)).status, 400);
    assert.equal(box.env.CACHE.data.get('catalog'), before);
  }
});

test('catalog read failures produce a non-editable error page and allow a later retry', async () => {
  const box = sandbox({ A: { id: 'share1234' } });
  const get = box.env.CACHE.get;
  box.env.CACHE.get = async key => {
    if (key === 'catalog') throw Error('KV temporarily unavailable');
    return get(key);
  };
  const response = await request(box, '/admin', 'GET', 'managepass');
  const html = await response.text();
  assert.equal(response.status, 503);
  assert.ok(html.includes('目录读取失败'));
  assert.equal(html.includes('id="cat"'), false);
  assert.equal(html.includes('id="b1"'), false);
  assert.equal(saved(box).mounts.A.id, 'share1234');
  const forcedRecovery = await request(box, '/admin?recover=1', 'GET', 'managepass');
  assert.equal(forcedRecovery.status, 503);
  assert.equal((await forcedRecovery.text()).includes('id="cat"'), false);
  box.env.CACHE.get = get;
  const retry = await request(box, '/admin', 'GET', 'managepass');
  assert.equal(retry.status, 200);
  assert.ok((await retry.text()).includes('A | share1234'));
});

test('a genuinely missing catalog permits initial editing; damaged data never looks like an empty library', async () => {
  const empty = sandbox();
  empty.env.CACHE.data.delete('catalog');
  const initial = await request(empty, '/admin', 'GET', 'managepass');
  assert.equal(initial.status, 200);
  assert.ok((await initial.text()).includes('id="cat"'));
  for (const invalid of ['{broken', 'null', '{"mounts":[]}', '{}']) {
    const box = sandbox();
    box.env.CACHE.data.set('catalog', invalid);
    const response = await request(box, '/admin', 'GET', 'managepass');
    assert.equal(response.status, 503, invalid);
    assert.equal((await response.text()).includes('id="cat"'), false);
  }
});

test('a failed external catalog source cannot be mistaken for an unconfigured catalog', async () => {
  const box = sandbox();
  box.env.CACHE.data.delete('catalog');
  box.env.CATALOG_URL = 'https://catalog.example.test/catalog.json';
  box.fetch = async () => new Response('unavailable', { status: 503 });
  assert.equal((await request(box, '/admin', 'GET', 'managepass')).status, 503);
});

test('malformed successful listing responses are retained during health checks', async () => {
  for (const reply of [{ resultCode: '0' }, { data: null }, { data: {} }, { data: [] },
    { data: { caLst: {}, coLst: [] } }, { data: { caLst: [], coLst: 'bad' } },
    { data: { coLst: [null] } }, { data: { coLst: [{}] } },
    { data: { caLst: [{ caID: 'd' }] } }]) {
    const box = sandbox({ A: { id: 'share1234' } });
    box.reply = reply;
    run(box, 'call139=async()=>reply');
    const before = box.env.CACHE.data.get('catalog');
    const result = await run(box, 'pruneCatalog(env,"",6)');
    assert.equal(result.removed.length, 0, JSON.stringify(reply));
    assert.equal(box.env.CACHE.data.get('catalog'), before);
    assert.ok(result.flagged[0].reason.includes('BAD_RESPONSE'));
    assert.equal(box.env.CACHE.data.has('check_log'), false);
  }
});

test('explicit empty listing arrays remain eligible for empty-share cleanup', async () => {
  const box = sandbox({ A: { id: 'share1234' } });
  run(box, 'call139=async()=>({data:{caLst:[],coLst:[]}})');
  const result = await run(box, 'pruneCatalog(env,"",6)');
  assert.equal(result.removed.length, 1);
  assert.deepEqual(Object.keys(saved(box).mounts), []);
});

test('a temporarily failed share never replaces a complete stale cache with partial data', async () => {
  for (const rc of ['ERR', '9530', 'BAD_RESPONSE', '200000727']) {
    const box = sandbox();
    box.rc = rc;
    run(box, `listMemberRoot=async(env,m)=>{
      if(globalThis.fail && m.id==='B')throw new Err139(rc,'temporary failure');
      return {folders:[],files:[{kind:'file',id:m.id,name:m.id+'.mp4'}]};
    };`);
    const full = await run(box, 'listMountRoot(env,[{id:"A",pwd:""},{id:"B",pwd:""}],null)');
    assert.equal(full.files.length, 2);
    const key = [...box.env.CACHE.data.keys()].find(key => key.endsWith(':@root'));
    const before = box.env.CACHE.data.get(key);
    for (const entry of box.__dirs.values()) entry.ts -= 1801000;
    box.fail = true;
    box.jobs = [];
    const stale = await run(box, 'listMountRoot(env,[{id:"A",pwd:""},{id:"B",pwd:""}],{waitUntil:p=>jobs.push(p)})');
    await Promise.all(box.jobs);
    assert.equal(stale.files.length, 2);
    assert.equal(box.env.CACHE.data.get(key), before);
    assert.equal(box.__dirs.get(key).data.files.length, 2);
  }
});

test('a cold partial result remains usable, is not cached and recovers on the next access', async () => {
  const box = sandbox();
  box.calls = 0;
  box.fail = true;
  run(box, `listMemberRoot=async(env,m)=>{
    calls++;
    if(fail && m.id==='B')throw new Err139('ERR','offline');
    return {folders:[],files:[{kind:'file',id:m.id,name:m.id+'.mp4'}]};
  };`);
  const partial = await run(box, 'listMountRoot(env,[{id:"A",pwd:""},{id:"B",pwd:""}],null)');
  assert.equal(partial.files.length, 1);
  assert.equal([...box.env.CACHE.data.keys()].some(key => key.endsWith(':@root')), false);
  assert.equal(run(box, 'globalThis.__dirs?.size || 0'), 0);
  box.fail = false;
  const full = await run(box, 'listMountRoot(env,[{id:"A",pwd:""},{id:"B",pwd:""}],null)');
  assert.equal(full.files.length, 2);
  assert.equal(box.calls, 4);
  assert.equal([...box.env.CACHE.data.keys()].some(key => key.endsWith(':@root')), true);
});

test('long multi-share mounts fit KV key limits and reuse the cached result', async () => {
  const box = sandbox();
  box.members = Array.from({ length: 40 }, (_, i) => ({ id: 'share' + String(i).padStart(8, '0'), pwd: '提取码'.repeat(8) }));
  mockListing(box);
  const first = await run(box, 'listMountRoot(env,members,null)');
  assert.equal(first.files.length, 40);
  assert.equal((await run(box, 'listMountRoot(env,members,null)')).files.length, 40);
  assert.equal(box.probed.length, 40);
  const key = [...box.env.CACHE.data.keys()].find(key => key.endsWith(':@root'));
  assert.ok(Buffer.byteLength(key) < 100);
  assert.equal(key.includes('提取码'), false);
  // Even unusually long individual identifiers use the same bounded key format.
  box.longMember = { id: 'x'.repeat(600), pwd: 'y'.repeat(600) };
  await run(box, 'listOne(env,longMember,"root",null)');
});

test('listing cache identities distinguish credentials, order and separator characters', async () => {
  const box = sandbox();
  const identities = [ [['A', 'B|C']], [['A|B', 'C']], [['A', 'p'], ['B', 'q']],
    [['B', 'q'], ['A', 'p']], [['A', 'other']] ];
  const keys = [];
  for (const parts of identities) {
    box.parts = parts;
    keys.push(await run(box, 'listingKey(parts)'));
  }
  assert.equal(new Set(keys).size, identities.length);
});

function adminScript() {
  const box = sandbox();
  return run(box, 'ADMIN_FORM("https://example.test",{mounts:1},"admin","pass","",false,[])')
    .match(/<script>([\s\S]*?)<\/script>/)[1];
}

test('admin save and configuration buttons recover after network failure and support retry', async () => {
  const ui = { b1: {}, b2: {}, b3: {}, cat: { value: 'A | share1234' }, msg: {}, msg2: {},
    confirm: () => true, admin_clear: { checked: false }, fetch: async () => { throw Error('offline'); } };
  for (const field of ['auth2', 'account2', 'dav_user2', 'dav_pass2', 'admin_pass2']) ui[field] = { value: '' };
  vm.createContext(ui);
  vm.runInContext(adminScript(), ui);
  for (const [button, message] of [['b1', 'msg'], ['b2', 'msg2']]) {
    await ui[button].onclick();
    assert.equal(ui[button].disabled, false);
    assert.equal(ui[message].className, 'hint err');
    assert.ok(ui[message].textContent.includes('offline'));
  }
  assert.equal(ui.cat.value, 'A | share1234');
  assert.equal(ui.b1.textContent, '保存目录 · 整份覆盖');
  ui.fetch = async () => new Response('{"ok":true,"mounts":1}');
  await ui.b1.onclick();
  await ui.b2.onclick();
  assert.equal(ui.msg.className, 'hint ok');
  assert.equal(ui.msg2.className, 'hint ok');
});

test('setup form restores its save button after network failure and retries with the same input', async () => {
  const box = sandbox();
  const html = run(box, 'SETUP_FORM("",false)');
  const button = {};
  const notices = [];
  const ui = { f: {}, document: { querySelector: () => button }, alert: text => notices.push(text),
    location: {}, fetch: async () => { throw Error('offline'); } };
  for (const [field, value] of Object.entries({ auth: config.auth, account: '', dav_user: 'admin', dav_pass: 'pass123', admin_pass: '' })) ui[field] = { value };
  vm.createContext(ui);
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ui);
  await ui.f.onsubmit({ preventDefault() {} });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '保存并完成部署');
  assert.ok(notices[0].includes('offline'));
  assert.equal(ui.auth.value, config.auth);
  ui.fetch = async () => new Response('{"ok":true}');
  await ui.f.onsubmit({ preventDefault() {} });
  assert.equal(ui.location.href, '/admin');
});

function ioCounts(box) {
  const get = box.env.CACHE.get, put = box.env.CACHE.put;
  const counts = { reads: [], writes: [] };
  box.env.CACHE.get = async key => { counts.reads.push(key); return get(key); };
  box.env.CACHE.put = async (key, ...args) => { counts.writes.push(key); return put(key, ...args); };
  return counts;
}

test('configuration read errors never reopen unauthenticated setup', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  const before = box.env.CACHE.data.get('config');
  const get = box.env.CACHE.get;
  let fail = true;
  box.env.CACHE.get = async key => { if (key === 'config' && fail) { fail = false; throw Error('KV unavailable'); } return get(key); };
  const response = await request(box, '/setup', 'POST', undefined,
    { auth: config.auth, dav_user: 'replacement', dav_pass: 'replacement-pass' });
  assert.equal(response.status, 502);
  assert.equal(box.env.CACHE.data.get('config'), before);
  assert.equal((await request(box, '/setup', 'POST', undefined, { dav_pass: 'replacement-pass' })).status, 401);
  for (const invalid of ['null', '{}', '[]', '{broken']) {
    const damaged = sandbox();
    damaged.env.CACHE.data.set('config', invalid);
    const recovery = await request(damaged, '/setup', 'GET');
    assert.equal(recovery.status, 503);
    assert.equal((await recovery.text()).includes('<form'), false);
  }
});

test('cross-site and simple content-type management writes are blocked before any KV access', async () => {
  for (const pathname of ['/setup', '/admin/catalog', '/admin/catalog-lines', '/admin/check']) {
    for (const headers of [ { Origin: 'https://untrusted.example', 'Content-Type': 'text/plain' },
      { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
      { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, { 'Content-Type': 'text/plain' } ]) {
      const box = sandbox();
      const counts = ioCounts(box);
      box.req = new Request('https://example.test' + pathname, { method: 'POST',
        headers: { ...headers, Authorization: basic('managepass') }, body: '{"dav_pass":"changed-pass"}' });
      const response = await run(box, 'worker.fetch(req,env,{})');
      assert.ok([403, 415].includes(response.status), pathname);
      assert.equal(counts.reads.length, 0);
      assert.equal(counts.writes.length, 0);
    }
  }
  const sameOrigin = sandbox();
  sameOrigin.req = new Request('https://example.test/setup', { method: 'POST',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json; charset=UTF-8', Authorization: basic('managepass') },
    body: '{"dav_pass":"changed-pass"}' });
  assert.equal((await run(sameOrigin, 'worker.fetch(req,env,{})')).status, 200);
});

test('configuration and token changes commit in one KV write and ignore stale legacy token keys', async () => {
  const box = sandbox();
  box.env.CACHE.data.set('auth', config.auth);
  const counts = ioCounts(box);
  const replacement = btoa('pc:13800138000:replacement-token');
  const response = await request(box, '/setup', 'POST', 'managepass', { auth: replacement, dav_pass: 'changed-pass' });
  assert.equal(response.status, 200);
  assert.deepEqual(counts.writes, ['config']);
  const record = JSON.parse(box.env.CACHE.data.get('config'));
  assert.equal(record.schema, 2);
  assert.equal(record.auth, replacement);
  assert.equal(record.dav_pass, 'changed-pass');
  assert.equal(await run(box, 'getAuth(env)'), replacement);
  assert.equal(box.env.CACHE.data.get('auth'), config.auth);
});

test('a failed configuration commit leaves both credentials and token unchanged', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  const before = box.env.CACHE.data.get('config');
  box.env.CACHE.put = async () => { throw Error('KV write failed'); };
  const response = await request(box, '/setup', 'POST', 'managepass',
    { auth: btoa('pc:13800138000:new-token'), dav_pass: 'changed-pass' });
  assert.equal(response.status, 502);
  assert.equal(box.env.CACHE.data.get('config'), before);
  assert.equal(await run(box, 'getAuth(env)'), config.auth);
});

test('two simultaneous initial configurations cannot both replace the service account', async () => {
  const box = sandbox({}, null);
  const counts = ioCounts(box);
  const a = new Request('https://example.test/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth: config.auth, dav_user: 'first', dav_pass: 'first-pass' }) });
  const b = new Request('https://example.test/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth: config.auth, dav_user: 'second', dav_pass: 'second-pass' }) });
  box.requests = [a, b];
  const responses = await run(box, 'Promise.all(requests.map(r=>worker.fetch(r,env,{})))');
  assert.deepEqual(Array.from(responses, r => r.status).sort(), [200, 401]);
  assert.deepEqual(counts.writes, ['config']);
});

test('emergency environment credentials are not silently persisted by an unrelated edit', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  box.env.ADMIN_PASS = 'emergency-pass';
  assert.equal((await request(box, '/setup', 'POST', 'emergency-pass', { dav_pass: 'changed-pass' })).status, 200);
  assert.equal(JSON.parse(box.env.CACHE.data.get('config')).admin_pass, 'managepass');
  delete box.env.ADMIN_PASS;
  box.__cfg = null;
  assert.equal((await request(box, '/admin', 'GET', 'managepass')).status, 200);
});

test('playback logins cannot reset admin lockout, and admin lockout does not prevent playback', async () => {
  const box = sandbox();
  for (let attempt = 0; attempt < 8; attempt++) {
    assert.equal((await request(box, '/admin', 'GET', 'wrong-pass')).status, 401);
    assert.equal((await request(box, '/tree', 'GET', 'davpass1')).status, 200);
  }
  assert.ok(box.__bf.get('admin:unknown').locked > Date.now());
  assert.equal((await request(box, '/admin', 'GET', 'managepass')).status, 401);
  assert.equal((await request(box, '/tree', 'GET', 'davpass1')).status, 200);
});

test('authentication failure tracking has a fixed memory entry limit', async () => {
  const box = sandbox();
  for (let ip = 0; ip < 1050; ip++) {
    box.req = new Request('https://example.test/admin', { headers: { 'CF-Connecting-IP': String(ip) } });
    await run(box, 'checkAdminAuth(req,env)');
  }
  assert.ok(box.__bf.size <= 1024);
});

test('download caching distinguishes the formerly colliding extraction codes', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  box.calls = 0;
  run(box, 'call139=async()=>({data:{downloadURL:"https://cdn.example.test/"+(++calls)}})');
  const a = await run(box, 'getDlUrl(env,[{id:"share1234",pwd:"AaAa"}],{id:"file1"})');
  const b = await run(box, 'getDlUrl(env,[{id:"share1234",pwd:"BBBB"}],{id:"file1"})');
  assert.notEqual(a, b);
  assert.equal(box.calls, 2);
});

test('concurrent and repeated downloads share one config read, one cache read and one link lookup', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  const counts = ioCounts(box);
  box.calls = 0;
  run(box, 'call139=async()=>{calls++;return {data:{downloadURL:"https://cdn.example.test/file"}}}');
  const urls = await run(box, 'Promise.all(Array.from({length:20},()=>getDlUrl(env,[{id:"share1234",pwd:""}],{id:"file1"})))');
  assert.equal(new Set(urls).size, 1);
  assert.equal(box.calls, 1);
  assert.equal(counts.reads.filter(k => k === 'config').length, 1);
  assert.equal(counts.reads.filter(k => k.startsWith('dl:')).length, 1);
  assert.equal(counts.writes.length, 1);
  const reads = counts.reads.length;
  await run(box, 'getDlUrl(env,[{id:"share1234",pwd:""}],{id:"file1"})');
  assert.equal(counts.reads.length, reads);
  assert.equal(counts.writes.length, 1);
});

test('optional cache failures preserve valid links and back off repeated write attempts', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  let writes = 0;
  box.env.CACHE.put = async () => { writes++; throw Error('KV quota exceeded'); };
  run(box, 'call139=async()=>({data:{downloadURL:"https://cdn.example.test/file"}})');
  assert.equal(await run(box, 'getDlUrl(env,[{id:"share1234",pwd:""}],{id:"file1"})'), 'https://cdn.example.test/file');
  assert.equal(await run(box, 'getDlUrl(env,[{id:"share1234",pwd:""}],{id:"file2"})'), 'https://cdn.example.test/file');
  assert.equal(writes, 1);
  const get = box.env.CACHE.get;
  box.env.CACHE.get = async key => { if (key.startsWith('dl:')) throw Error('cache read failed'); return get(key); };
  assert.equal(await run(box, 'getDlUrl(env,[{id:"share1234",pwd:""}],{id:"file3"})'), 'https://cdn.example.test/file');
});

test('directory cache write failures return fresh content without repeated upstream calls', async () => {
  const box = sandbox();
  box.count = 0;
  box.env.CACHE.put = async () => { throw Error('KV quota exceeded'); };
  await run(box, 'cachedListing(env,"listing",async()=>{count++;return {folders:[],files:[{id:"f",name:"file.mp4"}]}},null)');
  assert.equal((await run(box, 'cachedListing(env,"listing",async()=>{throw Error("must use memo")},null)')).files.length, 1);
  assert.equal(box.count, 1);
});

test('legacy refreshed tokens are preserved without a migration write', async () => {
  const box = sandbox();
  const legacy = btoa('pc:13800138000:legacy-renewed-token');
  box.env.CACHE.data.set('auth', legacy);
  const counts = ioCounts(box);
  assert.equal(await run(box, 'getAuth(env)'), legacy);
  assert.equal(counts.writes.length, 0);
  assert.equal(counts.reads.includes('auth_check'), false);
});

function expiringConfig() {
  return { ...config, schema: 2, auth: btoa('pc:13800138000:a|b|c|' + (Date.now() + 86400000)) };
}

test('token renewal is coalesced and persists the current credentials in a single config write', async () => {
  const box = sandbox({}, expiringConfig());
  const counts = ioCounts(box);
  let fetches = 0;
  const token = 'new|b|c|' + (Date.now() + 30 * 86400000);
  box.fetch = async () => { fetches++; return new Response('<root><return>0</return><token>' + token + '</token></root>'); };
  const values = await run(box, 'Promise.all([getAuth(env),getAuth(env),getAuth(env)])');
  assert.equal(new Set(values).size, 1);
  assert.equal(fetches, 1);
  assert.deepEqual(counts.writes, ['config']);
  assert.equal(JSON.parse(box.env.CACHE.data.get('config')).dav_pass, config.dav_pass);
  await run(box, 'getAuth(env)');
  assert.equal(fetches, 1);
  assert.equal(counts.writes.length, 1);
});

test('late renewal cannot overwrite a manual token or credential change', async () => {
  const box = sandbox({}, expiringConfig());
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  box.fetch = async () => { started(); await gate; return new Response('<root><return>0</return><token>late-token</token></root>'); };
  const renewal = run(box, 'getAuth(env)');
  await began;
  const manual = btoa('pc:13800138000:manual-token');
  assert.equal((await request(box, '/setup', 'POST', 'managepass', { auth: manual, dav_pass: 'manual-pass' })).status, 200);
  release();
  assert.equal(await renewal, manual);
  const record = JSON.parse(box.env.CACHE.data.get('config'));
  assert.equal(record.auth, manual);
  assert.equal(record.dav_pass, 'manual-pass');
});

test('public enumeration stops below the free-plan external request limit', async () => {
  const box = sandbox();
  box.calls = 0;
  run(box, `call139=async(env,url,body,budget)=>{
    useBudget(budget); calls++;
    return {data:{coLst:Array.from({length:200},(_,i)=>({coID:String(body.getOutLinkInfoReq.bNum+i),coName:i+'.mp4'}))}};
  };`);
  const response = await request(box, '/probe?link=share1234', 'GET', 'davpass1');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).rc, 'BUDGET');
  assert.equal(box.calls, 40);
});

test('per-invocation budgets are unaffected by other requests in the same isolate', async () => {
  const box = sandbox({ A: { id: 'S1' } });
  box.__callCount = 999999;
  mockListing(box);
  assert.equal((await run(box, 'pruneCatalog(env,"",6)')).done, true);
  assert.deepEqual(Array.from(box.probed), ['S1']);
});

test('fully cached prewarming does not write progress for an unchanged cursor', async () => {
  const box = sandbox({ A: { id: 'S1' } });
  mockListing(box);
  await run(box, 'listMountRoot(env,[{id:"S1",pwd:""}],null)');
  const counts = ioCounts(box);
  await run(box, 'warmMounts(env,{})');
  assert.equal(box.probed.length, 1);
  assert.equal(counts.writes.length, 0);
});

test('prewarming respects the remaining daily allowance and stores only one bookkeeping key', async () => {
  const box = sandbox({ A: { id: 'S1,S2' } });
  box.env.CACHE.data.set('warm_state', JSON.stringify({ day: new Date().toISOString().slice(0,10), used: 1999, idx: 0 }));
  mockListing(box);
  const counts = ioCounts(box);
  await run(box, 'warmMounts(env,{})');
  assert.equal(box.probed.length, 1);
  assert.deepEqual(counts.writes, ['warm_state']);
  assert.equal(JSON.parse(box.env.CACHE.data.get('warm_state')).used, 2000);
  await run(box, 'warmMounts(env,{})');
  assert.equal(box.probed.length, 1);
  assert.equal(counts.writes.length, 1);
});

test('large directories are bounded by retained weight as well as entry count', () => {
  const box = sandbox();
  box.large = { files: Array.from({length:1000}, (_,i)=>({id:String(i),name:'x'.repeat(6000)+i})), folders: [] };
  run(box, 'memoSet("oversized",large,Date.now())');
  assert.equal(box.__dirs.has('oversized'), false);
  box.small = { files: Array.from({length:300}, (_,i)=>({id:String(i),name:'x'.repeat(2000)+i})), folders: [] };
  for (let i = 0; i < 12; i++) { box.key = String(i); run(box, 'memoSet(key,small,Date.now())'); }
  assert.ok(box.__dirBytes <= 8 * 1024 * 1024);
  assert.ok(box.__dirs.size < 12);
});

test('chunked management bodies exceeding the application limit are rejected without mutation', async () => {
  const box = sandbox();
  const before = box.env.CACHE.data.get('catalog');
  box.req = new Request('https://example.test/admin/catalog-lines', { method: 'POST',
    headers: { Authorization: basic('managepass'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: 'x'.repeat(1024 * 1024) }), duplex: 'half' });
  const response = await run(box, 'worker.fetch(req,env,{})');
  assert.equal(response.status, 413);
  assert.equal(box.env.CACHE.data.get('catalog'), before);
});

test('cached catalog trees retain natural numeric order and are replaced after an edit', () => {
  const box = sandbox();
  const tree = run(box, 'const first={mounts:{A:{id:"s"}}};catalogTree(first)');
  assert.equal(run(box, 'catalogTree(first)'), tree);
  assert.notEqual(run(box, 'catalogTree({mounts:{B:{id:"t"}}})'), tree);
  assert.ok(run(box, 'naturalCmp({name:"第2集"},{name:"第10集"})') < 0);
});

test('late renewal keeps locally saved credentials even if KV temporarily returns an older record', async () => {
  const original = expiringConfig();
  const box = sandbox({}, original);
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  box.fetch = async () => { started(); await gate; return new Response('<root><return>0</return><token>late-token</token></root>'); };
  const renewal = run(box, 'getAuth(env)');
  await began;
  const manual = btoa('pc:13800138000:manual-token');
  await request(box, '/setup', 'POST', 'managepass', { auth: manual, dav_pass: 'manual-pass' });
  const get = box.env.CACHE.get;
  box.env.CACHE.get = async key => key === 'config' ? JSON.stringify(original) : get(key);
  release();
  assert.equal(await renewal, manual);
  assert.equal(JSON.parse(box.env.CACHE.data.get('config')).dav_pass, 'manual-pass');
});

test('failed renewal persistence leaves a complete old configuration instead of a half-updated token', async () => {
  const original = expiringConfig();
  const box = sandbox({}, original);
  box.fetch = async () => new Response('<root><return>0</return><token>new-token</token></root>');
  box.env.CACHE.put = async () => { throw Error('KV unavailable'); };
  assert.equal(await run(box, 'getAuth(env)'), original.auth);
  assert.deepEqual(JSON.parse(box.env.CACHE.data.get('config')), original);
});

test('renewal consumes the same external request budget as the following API call', async () => {
  const box = sandbox({}, expiringConfig());
  let fetches = 0;
  box.fetch = async () => { fetches++; return new Response('<root><return>0</return><token>new-token</token></root>'); };
  await assert.rejects(run(box, 'call139(env,API.LIST,{},newBudget(1))'), error => error.rc === 'BUDGET');
  assert.equal(fetches, 1);
});

test('KV hydration cannot extend the original download expiry', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  box.calls = 0;
  run(box, 'call139=async()=>{calls++;return {data:{downloadURL:"https://cdn.example.test/new"}}}');
  const key = 'dl:v2:' + await run(box, 'keyDigest(["13800138000","S","","f"])');
  box.env.CACHE.data.set(key, JSON.stringify({url:'https://cdn.example.test/old',t:Date.now()-601000}));
  assert.equal(await run(box, 'getDlUrl(env,[{id:"S",pwd:""}],{id:"f"})'), 'https://cdn.example.test/new');
  assert.equal(box.calls, 1);
});

test('download memo capacity is bounded and malformed URLs are not retained', async () => {
  const box = sandbox({}, { ...config, schema: 2 });
  run(box, 'call139=async()=>({data:{downloadURL:"https://cdn.example.test/file"}})');
  for (let i=0;i<70;i++) { box.fileId=String(i); await run(box, 'getDlUrl(env,[{id:"S",pwd:""}],{id:fileId})'); }
  assert.equal(box.__downloads.size, 64);
  run(box, 'call139=async()=>({data:{downloadURL:"https://cdn.example.test/"+"x".repeat(20000)}})');
  await assert.rejects(run(box, 'getDlUrl(env,[{id:"S",pwd:""}],{id:"oversized"})'), error=>error.rc==='NOLINK');
  assert.equal(box.__downloads.size, 64);
});

test('file paths with extra segments return not found without another upstream call', async () => {
  const box = sandbox();
  run(box, `listMountRoot=async()=>({folders:[],files:[{kind:'file',name:'film.mp4',id:'f'}]});
    listOne=async()=>{throw Error('file must not be listed as a directory')};`);
  assert.equal(await run(box, 'resolvePath(env,buildTree({mounts:{A:{id:"S"}}}),["A","film.mp4","extra"],null)'), null);
});

test('unverified health checks are counted without extra bookkeeping writes', async () => {
  const box = sandbox({ A: { id: 'S' } });
  const counts = ioCounts(box);
  run(box, 'listAll=async()=>{throw new Err139("9530","blocked")}');
  const response = await request(box, '/admin/check', 'POST', 'managepass', {});
  const result = await response.json();
  assert.equal(result.unverified, 1);
  assert.equal(result.removed.length, 0);
  assert.equal(counts.writes.length, 0);
});

test('admin UI rejects incomplete health responses before entering a retry loop', async () => {
  let calls = 0;
  const ui = { b1:{}, b2:{}, b3:{}, msg3:{}, confirm:()=>true,
    fetch:async()=>{calls++;return new Response('{"ok":true}') } };
  vm.createContext(ui);
  vm.runInContext(adminScript(),ui);
  await ui.b3.onclick();
  assert.equal(calls,1);
  assert.equal(ui.msg3.className,'hint err');
  assert.equal(ui.b3.disabled,false);
});

test('failed background refreshes preserve old data and avoid retrying on every access', async () => {
  const box = sandbox();
  box.count = 0;
  box.jobs = [];
  await run(box, 'cachedListing(env,"listing",async()=>({files:[{id:"f",name:"old.mp4"}],folders:[]}),null)');
  box.__dirs.get('listing').ts -= 1801000;
  const call = 'cachedListing(env,"listing",async()=>{count++;throw Error("offline")},{waitUntil:p=>jobs.push(p)})';
  assert.equal((await run(box, call)).files[0].name, 'old.mp4');
  await Promise.all(box.jobs);
  assert.equal((await run(box, call)).files[0].name, 'old.mp4');
  await Promise.all(box.jobs);
  assert.equal(box.count, 1);
});

test('unauthenticated configuration errors never include stored secrets or backend error details', async () => {
  const box = sandbox();
  box.env.CACHE.data.set('config', 'private-password-secret');
  const response = await request(box, '/health');
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('private-password-secret'), false);
  const other = sandbox();
  other.env.CACHE.get = async () => { throw Error('backend private-password-secret'); };
  const failed = await request(other, '/setup');
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes('private-password-secret'), false);
});

test('simultaneous cold catalog reads share a single KV lookup', async () => {
  const box = sandbox({ A: { id: 'old-share' } });
  const counts = ioCounts(box);
  const catalogs = await run(box, 'Promise.all(Array.from({length:12},()=>getCatalog(env)))');
  assert.equal(counts.reads.filter(key => key === 'catalog').length, 1);
  assert.equal(new Set(catalogs).size, 1);
});

test('a late catalog read cannot replace a catalog saved while it was pending', async () => {
  const box = sandbox({ A: { id: 'old-share' } });
  const get = box.env.CACHE.get;
  let release, started, first = true;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  box.env.CACHE.get = async key => {
    const value = await get(key);
    if (key === 'catalog' && first) { first = false; started(); await gate; }
    return value;
  };
  const reading = run(box, 'getCatalog(env)');
  await began;
  await run(box, 'saveCatalog(env,{mounts:{B:{id:"new-share"}}})');
  release();
  assert.deepEqual(Object.keys((await reading).mounts), ['B']);
  assert.deepEqual(Object.keys((await run(box, 'getCatalog(env)')).mounts), ['B']);
  assert.deepEqual(Object.keys(saved(box).mounts), ['B']);
});

test('concurrent failed catalog reads are released so a later read can recover', async () => {
  const box = sandbox({ A: { id: 'share' } });
  const get = box.env.CACHE.get;
  let reads = 0;
  box.env.CACHE.get = async () => { reads++; throw Error('temporary failure'); };
  const results = await run(box, 'Promise.allSettled([getCatalog(env),getCatalog(env)])');
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(reads, 1);
  box.env.CACHE.get = get;
  assert.equal((await run(box, 'getCatalog(env)')).mounts.A.id, 'share');
});

for (const failure of ['get', 'put']) {
  test(`a check_log ${failure} failure reports completed cleanup without hiding removed links`, async () => {
    const box = sandbox({ A: { id: 'DEAD' }, B: { id: 'LIVE' } });
    mockListing(box);
    const previousLog = JSON.stringify([{ path: 'older', id: 'original-share' }]);
    box.env.CACHE.data.set('check_log', previousLog);
    const operation = box.env.CACHE[failure];
    box.env.CACHE[failure] = async (key, ...args) => {
      if (key === 'check_log') throw Error('log unavailable');
      return operation(key, ...args);
    };
    const response = await request(box, '/admin/check', 'POST', 'managepass', {});
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.done, true);
    assert.equal(result.logWarning, true);
    assert.equal(result.removed[0].id, 'DEAD');
    assert.deepEqual(Object.keys(saved(box).mounts), ['B']);
    assert.equal(box.env.CACHE.data.get('check_log'), previousLog);
  });
}

test('admin UI distinguishes successful cleanup from a failed cleanup history save', async () => {
  const ui = { b1:{}, b2:{}, b3:{}, msg3:{}, confirm:()=>true,
    setTimeout(){}, fetch:async()=>new Response(JSON.stringify({
      ok:true, done:true, total:1, remaining:0,
      removed:[{path:'A',id:'DEAD'}], logWarning:true,
    })) };
  vm.createContext(ui);
  vm.runInContext(adminScript(),ui);
  await ui.b3.onclick();
  assert.ok(ui.msg3.textContent.includes('体检完成'));
  assert.ok(ui.msg3.textContent.includes('清理记录未保存'));
  assert.equal(ui.b3.disabled,false);
});

test('an explicit full replacement repairs corrupt catalog data without requiring a source hash', async () => {
  for (const invalid of ['{private-corrupt-data', 'null', '{"mounts":[]}', '{}']) {
    const box = sandbox();
    box.env.CACHE.data.set('catalog', invalid);
    const result = await request(box, '/admin/catalog-lines', 'POST', 'managepass', {lines:'Recovered | share1234'});
    assert.equal(result.status, 200, invalid);
    assert.equal(saved(box).mounts.Recovered.id, 'share1234');
    assert.equal(saved(box).source_hash, undefined);
  }
});

test('a catalog read outage still stops full replacement rather than losing existing sync metadata', async () => {
  const box = sandbox({ A: {id:'keep'} });
  const before = box.env.CACHE.data.get('catalog');
  box.env.CACHE.get = async () => {throw Error('temporary KV outage')};
  await assert.rejects(run(box, 'saveCatalog(env,{mounts:{B:{id:"replacement"}}})'), /KV outage/);
  assert.equal(box.env.CACHE.data.get('catalog'), before);
});

test('corrupt catalogs offer an authenticated, explicit rebuild mode instead of an empty ordinary editor', async () => {
  const box = sandbox();
  box.env.CACHE.data.set('catalog','{private-corrupt-data');
  const page = await request(box, '/admin', 'GET', 'managepass');
  const html = await page.text();
  assert.equal(page.status,503);
  assert.ok(html.includes('/admin?recover=1'));
  assert.equal(html.includes('id="cat"'),false);
  assert.equal(html.includes('private-corrupt-data'),false);
  assert.equal((await request(box,'/admin?recover=1')).status,401);
  const rebuild = await request(box, '/admin?recover=1', 'GET', 'managepass');
  const form = await rebuild.text();
  assert.equal(rebuild.status,200);
  assert.ok(form.includes('id="cat"'));
  assert.ok(form.includes('完整备份'));
  assert.ok(form.includes('重建损坏的目录'));
});

test('browse skips malformed entries without caching partial content while health checks stay strict', async () => {
  const box = sandbox({ A: {id:'share'} });
  run(box, `call139=async()=>({data:{caLst:[{caID:'bad',caName:''}],coLst:[{coID:'good',coName:'valid.mp4',coSize:42},null]}})`);
  const response = await request(box, '/A', 'PROPFIND', 'davpass1');
  const xml = await response.text();
  assert.equal(response.status,207);
  assert.ok(xml.includes('valid.mp4'));
  assert.equal([...box.env.CACHE.data.keys()].some(key=>key.startsWith('lst:')),false);
  const checked=await run(box,'pruneCatalog(env,"",6)');
  assert.equal(checked.removed.length,0);
  assert.equal(checked.unverified,0);
  assert.ok(checked.flagged[0].reason.includes('BAD_RESPONSE'));
});

test('an incomplete unwrapped child cannot be cached as a complete mount', async () => {
  const box=sandbox({ A:{id:'share'} });
  run(box, `call139=async(env,url,body)=>({data:body.getOutLinkInfoReq.pCaID==='root'
    ?{caLst:[{caID:'wrapper',caName:'Folder'}],coLst:[]}
    :{caLst:[],coLst:[{coID:'good',coName:'valid.mp4'},null]}})`);
  const listing=await run(box,'listMountRoot(env,[{id:"share",pwd:""}],null)');
  assert.equal(listing.incomplete,true);
  assert.equal([...box.env.CACHE.data.keys()].some(key=>key.startsWith('lst:')),false);
});

test('a missing listing is still an error during browsing, never a confirmed empty directory', async () => {
  const box=sandbox();
  run(box,'call139=async()=>({data:{}})');
  await assert.rejects(run(box,'listAll(env,{id:"share",pwd:""},"root",newBudget(40))'),error=>error.rc==='BAD_RESPONSE');
});

test('unreadable configuration has a read-only recovery page and an explicit unhealthy response', async () => {
  for(const invalid of ['{private-config',JSON.stringify({auth:config.auth,account:config.account})]) {
    const box=sandbox();
    box.env.CACHE.data.set('config',invalid);
    const setup=await request(box,'/setup');
    const html=await setup.text();
    assert.equal(setup.status,503);
    assert.ok(html.includes('恢复'));
    assert.equal(html.includes('<form'),false);
    assert.equal(html.includes('private-config'),false);
    const health=await request(box,'/health');
    assert.equal(health.status,503);
    const state=await health.json();
    assert.equal(state.ok,false);
    assert.equal(state.configured,null);
    assert.equal((await request(box,'/setup','POST',undefined,{auth:config.auth,dav_pass:'hijack123'})).status,502);
    assert.equal(box.env.CACHE.data.get('config'),invalid);
  }
});

test('skipping a malformed entry does not change the upstream pagination offset', async () => {
  const box=sandbox();
  box.offsets=[];
  run(box, `call139=async(env,url,body,budget)=>{
    useBudget(budget);
    const offset=body.getOutLinkInfoReq.bNum;offsets.push(offset);
    return {data:{caLst:[],coLst:offset===1
      ?Array.from({length:200},(_,i)=>i===0?null:{coID:'f'+i,coName:i+'.mp4'})
      :[{coID:'last',coName:'last.mp4'}]}};
  }`);
  const result=await run(box,'listAll(env,{id:"share",pwd:""},"root",newBudget(40))');
  assert.deepEqual(Array.from(box.offsets),[1,201]);
  assert.equal(result.files.length,200);
  assert.equal(result.incomplete,true);
});

test('malformed-entry background refresh preserves a complete cached directory', async () => {
  const box=sandbox();
  run(box,`call139=async()=>({data:{caLst:[],coLst:[{coID:'f',coName:'valid.mp4'},...(globalThis.bad?[null]:[])]}})`);
  await run(box,'listMountRoot(env,[{id:"share",pwd:""}],null)');
  const key=[...box.env.CACHE.data.keys()].find(key=>key.endsWith(':@root'));
  const before=box.env.CACHE.data.get(key);
  box.__dirs.get(key).ts-=1801000;
  box.bad=true;
  box.jobs=[];
  const result=await run(box,'listMountRoot(env,[{id:"share",pwd:""}],{waitUntil:p=>jobs.push(p)})');
  await Promise.all(box.jobs);
  assert.equal(result.files[0].name,'valid.mp4');
  assert.equal(box.env.CACHE.data.get(key),before);
  assert.equal(box.__dirs.get(key).data.incomplete,undefined);
});

test('structural share errors need manual review, never retry counts or cleanup writes', async () => {
  const box=sandbox({ A:{id:'structural-share'}, B:{id:'temporary-share'} });
  const counts=ioCounts(box);
  run(box,`listAll=async(env,m)=>{throw new Err139(m.id==='structural-share'?'BAD_RESPONSE':'9530','test')}`);
  const response=await request(box,'/admin/check','POST','managepass',{});
  const report=await response.json();
  assert.equal(response.status,200);
  assert.equal(report.unverified,1);
  assert.equal(report.flagged.length,1);
  assert.equal(report.flagged[0].kind,'structure');
  assert.ok(report.flagged[0].reason.includes('需人工核对'));
  assert.equal(report.removed.length,0);
  assert.equal(counts.writes.length,0);
  assert.equal(Object.keys(saved(box).mounts).length,2);
});

test('admin displays structural error details without a retry instruction or a missing-log reference', async () => {
  const ui={b1:{},b2:{},b3:{},msg3:{},confirm:()=>true,
    fetch:async()=>new Response(JSON.stringify({ok:true,done:true,total:1,remaining:0,unverified:0,
      flagged:[{path:'Library/Share',kind:'structure',reason:'BAD_RESPONSE：响应结构异常，需人工核对'}]}))};
  vm.createContext(ui);
  vm.runInContext(adminScript(),ui);
  await ui.b3.onclick();
  assert.ok(ui.msg3.textContent.includes('Library/Share'));
  assert.ok(ui.msg3.textContent.includes('结构异常'));
  assert.equal(ui.msg3.textContent.includes('稍后重试'),false);
  assert.equal(ui.msg3.textContent.includes('Cloudflare 日志'),false);
  assert.equal(ui.msg3.textContent.includes('未知错误码'),false);
});

test('configuration failures send browser entry points to recovery without redirecting API or DAV requests', async () => {
  for(const broken of ['{damaged-config',JSON.stringify({auth:config.auth})]) {
    const box=sandbox();
    box.env.CACHE.data.set('config',broken);
    for(const pathname of ['/','/admin']) {
      const response=await request(box,pathname);
      assert.equal(response.status,302);
      assert.equal(response.headers.get('Location'),'/setup');
      assert.equal(response.headers.get('Cache-Control'),'no-store');
    }
    const setup=await request(box,'/setup');
    assert.equal(setup.status,503);
    assert.equal((await setup.text()).includes('<form'),false);
    assert.equal((await request(box,'/','PROPFIND','davpass1')).status,502);
    assert.equal((await request(box,'/','HEAD','davpass1')).status,502);
    const health=await request(box,'/health');
    assert.equal(health.status,503);
    assert.equal((await health.json()).ok,false);
    const update=await request(box,'/admin/catalog','POST','managepass',{mounts:{A:{id:'new-share'}}});
    assert.equal(update.status,502);
    assert.equal(update.headers.has('Location'),false);
    assert.equal(box.env.CACHE.data.get('config'),broken);
  }
});

test('cleanup does not erase a manual-review report with an automatic reload or leave a stale editor writable', async () => {
  let scheduled=0;
  const ui={b1:{},b2:{},b3:{},msg3:{},confirm:()=>true,setTimeout(){scheduled++},
    fetch:async()=>new Response(JSON.stringify({ok:true,done:true,total:2,remaining:0,unverified:0,
      removed:[{path:'Dead',id:'dead-share'}],
      flagged:[{path:'Review',kind:'structure',reason:'响应结构异常，需人工核对'}]}))};
  vm.createContext(ui);
  vm.runInContext(adminScript(),ui);
  await ui.b3.onclick();
  assert.equal(scheduled,0);
  assert.ok(ui.msg3.textContent.includes('Review'));
  assert.ok(ui.msg3.textContent.includes('刷新页面后再编辑'));
  assert.equal(ui.b1.disabled,true);
  assert.equal(ui.b3.disabled,false);
});
