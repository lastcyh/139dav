// cloud139 — 移动云盘分享 → WebDAV + 直链 (Cloudflare Worker)
//
// 目录树由 catalog.json 驱动（clean_links.py 或 /admin 网页生成, 经 /admin/catalog 写入 KV）:
//   { "generated": "...", "mounts": { "分类/标题": { "id": "id1#pwd1,id2" } } }
//
// 路由:
//   PROPFIND/GET/HEAD/OPTIONS /**   WebDAV 只读（WebDAV 账号密码）
//   GET /link?path=/电视剧/.../x.mp4  302 直链（支持 &format=json）
//   GET /health                     状态
//   GET /tree                       目录树摘要（WebDAV 账号密码）
//   POST /admin/catalog             上传 catalog（管理口令）
//   POST /admin/check               死链体检, 清理失效/空白分享（管理口令）
//   GET /probe?link=id#pwd          分享探测（WebDAV 账号密码）
//
// 读(WebDAV/直链/探测)用 DAV_USER/DAV_PASS; 写(管理页/改配置/导入目录)用 ADMIN_PASS,
// 未设 ADMIN_PASS 时写操作退回用 WebDAV 密码（向后兼容）。
// 环境: AUTH(139 Authorization) ACCOUNT DAV_USER DAV_PASS [ADMIN_PASS] [CATALOG_URL] CACHE(KV)

const AES_KEY = new TextEncoder().encode("PVGDwmcvfs1uV3d1");
const API = {
  LIST: "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6",
  DL: "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3",
  REFRESH: "https://aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do",
};
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=UTF-8",
  "X-Deviceinfo": "||9|12.27.0|firefox|140.0|||linux unknown|1920X526|zh-CN|||",
  "hcy-cool-flag": "1",
  "CMS-DEVICE": "default",
  "x-m4c-caller": "PC",
  "X-Yun-Api-Version": "v1",
  "Origin": "https://yun.139.com",
  "Referer": "https://yun.139.com/",
};
const DIR_FRESH = 1800;      // 目录新鲜期 30 分钟【秒】—— 比较时 *1000 转毫秒
const DIR_STORE = 7 * 86400; // 目录缓存保留 7 天【秒】(KV TTL 也是秒)
const DL_TTL = 600;          // 直链缓存 10 分钟【秒】（S3 预签名 15 分钟有效）
const BF_MAX = 5;            // 连续失败 N 次锁定
const BF_WINDOW = 600e3;     // 失败计数窗口 10 分钟【毫秒】
const BF_LOCK_TTL = 900e3;   // 锁定 15 分钟【毫秒】(内存级, 个人使用的轻量防护)
const CAT_TTL = 60;          // catalog 内存缓存 60 秒【秒】—— 比较时 *1000 转毫秒
const LIST_PAGE = 200;       // 139 分享列表单页条数(接口默认只给 100, 必须显式翻页)
const LIST_MAX_PAGES = 100;  // 翻页安全上限: 100 页 × 200 = 20000 项
const CACHE_V = "v4";        // v4 校验上游数据, 并停止缓存成员请求失败时的残缺目录
const REALM = "139dav";      // 读操作(WebDAV / 直链)的 realm; 同一页调到的接口必须同 realm, 否则浏览器按 realm 分开缓存凭据
const REALM_ADMIN = "139dav-admin"; // 管理写操作的 realm; 与读分开, 这样"只给播放权限"不会连管理权一起给出去
const WARM_BATCH = 8;        // 每次定时预热处理的挂载数(只补缺; 免费版单次请求 50 子请求上限, 不宜调大)
const WARM_CALL_BUDGET = 25; // 预热时 139 API 调用预算(免费版单次请求 50 子请求上限)
const WARM_DAILY_CAP = 2000; // 每日预热调用上限(保护账号, 避免触发风控)
const CHECK_BATCH = 6;        // 每次死链体检处理的挂载数(体检由管理页按钮或 GitHub Actions 触发)
const CHECK_CALL_BUDGET = 20; // 每次体检的 139 调用预算(免费版单次请求 50 子请求上限)
const REQUEST_CALL_BUDGET = 40; // 给免费版 50 次外部请求限制留出余量
const BF_MAX_ENTRIES = 1024;
const DIR_MEMO_BYTES = 8 * 1024 * 1024; // 目录内存估算预算, 避免只按条数保留大目录
const DL_MEMO_MAX = 64;
const CATALOG_BODY_MAX = 1024 * 1024;
const CONFIG_BODY_MAX = 32 * 1024;

const MIME = {
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", ts: "video/mp2t",
  mov: "video/quicktime", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  iso: "application/octet-stream", mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav",
  pdf: "application/pdf", epub: "application/epub+zip", zip: "application/zip",
  rar: "application/vnd.rar", tar: "application/x-tar", gz: "application/gzip",
  srt: "text/plain", ass: "text/plain", ssa: "text/plain", txt: "text/plain", nfo: "text/plain",
};

// ================= 139 协议 =================

function sortedJson(o) {
  if (Array.isArray(o)) return "[" + o.map(sortedJson).join(",") + "]";
  if (o !== null && typeof o === "object") {
    return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + sortedJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(o);
}

function aesKey() {
  return (globalThis.__aesKey ||= crypto.subtle.importKey("raw", AES_KEY, "AES-CBC", false, ["encrypt", "decrypt"]));
}

async function encryptPayload(obj) {
  const plain = new TextEncoder().encode(sortedJson(obj));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await aesKey();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plain));
  const out = new Uint8Array(16 + ct.length);
  out.set(iv); out.set(ct, 16);
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function decryptPayload(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const raw = Uint8Array.from(atob(t), c => c.charCodeAt(0));
  const key = await aesKey();
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  return JSON.parse(new TextDecoder().decode(pt));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 运行配置: KV "config" (由 /setup 向导写入) 优先, env 变量兜底 ----
class ConfigUnavailable extends Error {}

async function getConfig(env, fresh = false) {
  if (!fresh && globalThis.__cfg && Date.now() - globalThis.__cfg.ts < 60000) return globalThis.__cfg.v;
  if (fresh) return loadConfig(env);
  if (globalThis.__cfgPending) return globalThis.__cfgPending;
  const pending = loadConfig(env);
  globalThis.__cfgPending = pending;
  try { return await pending; }
  finally { if (globalThis.__cfgPending === pending) globalThis.__cfgPending = null; }
}

async function loadConfig(env) {
  const revision = globalThis.__configRevision || 0;
  let v = {};
  let kv;
  try { kv = await env.CACHE.get("config"); }
  catch { throw new ConfigUnavailable("配置读取失败，请稍后重试"); }
  if (kv !== null) {
    try { v = JSON.parse(kv); }
    catch { throw new ConfigUnavailable("配置数据损坏，已停止初始化"); }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ConfigUnavailable("配置数据不合法，已停止初始化");
  }
  v.account = v.account || env.ACCOUNT || "";
  // env.AUTH 允许带 "Basic " 前缀(配置向导会自动去掉, 环境变量路径这里统一处理)
  v.auth = String(v.auth || env.AUTH || "").trim().replace(/^Basic\s+/i, "");
  // 仅旧配置读取独立令牌键。新配置把账号/口令/令牌一次写入同一键, 消除半更新。
  if (v.schema !== 2 && v.auth) {
    let legacy;
    try { legacy = await env.CACHE.get("auth"); }
    catch { throw new ConfigUnavailable("旧版令牌读取失败，请稍后重试"); }
    if (legacy) {
      try { if (atob(legacy).split(":")[1] === String(v.account)) v.auth = legacy; } catch {}
    }
  }
  v.dav_user = v.dav_user || env.DAV_USER || "";
  v.dav_pass = v.dav_pass || env.DAV_PASS || "";
  // 管理口令(可选): 设了之后, 改目录/改配置等写操作要用它, 而不是 WebDAV 密码。
  // 留空 = 沿用 WebDAV 密码(向后兼容)。env.ADMIN_PASS 可作为忘记口令时的兜底。
  v.stored_admin_pass = v.admin_pass || "";
  v.admin_pass = env.ADMIN_PASS || v.stored_admin_pass;
  if (kv !== null && (!v.auth || !v.account || typeof v.dav_user !== "string" || !v.dav_user ||
      typeof v.dav_pass !== "string" || !v.dav_pass)) throw new ConfigUnavailable("已有配置不完整，已停止初始化");
  if (revision !== (globalThis.__configRevision || 0)) return getConfig(env);
  globalThis.__cfg = { v, ts: Date.now() };
  return v;
}
async function isConfigured(env) {
  const c = await getConfig(env);
  return !!(c.auth && c.account && c.dav_user && c.dav_pass);
}

async function withConfigWrite(update) {
  const pending = (globalThis.__configWrite || Promise.resolve()).catch(() => {}).then(update);
  globalThis.__configWrite = pending;
  try { return await pending; }
  finally { if (globalThis.__configWrite === pending) globalThis.__configWrite = null; }
}

async function saveConfig(env, c) {
  const record = { schema: 2, auth: c.auth, account: c.account, dav_user: c.dav_user,
    dav_pass: c.dav_pass, admin_pass: c.stored_admin_pass ?? c.admin_pass ?? "" };
  await env.CACHE.put("config", JSON.stringify(record));
  globalThis.__configRevision = (globalThis.__configRevision || 0) + 1;
  globalThis.__cfg = { ts: Date.now(), v: { ...record, stored_admin_pass: record.admin_pass,
    admin_pass: env.ADMIN_PASS || record.admin_pass } };
}

function parseMembers(leaf) {
  return String(leaf?.id || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("#");
    return i >= 0 ? { id: s.slice(0, i), pwd: s.slice(i + 1) } : { id: s, pwd: "" };
  });
}

class Err139 extends Error {
  constructor(rc, desc) { super(`139 接口错误 ${rc}: ${desc || ""}`); this.rc = rc; }
}

const newBudget = limit => ({ remaining: limit, used: 0 });
const budgetExhausted = budget => typeof budget === "number"
  ? (globalThis.__callCount || 0) >= budget : budget && budget.remaining <= 0;
function useBudget(budget) {
  if (budgetExhausted(budget)) throw new Err139("BUDGET", "本轮调用预算已用完");
  if (budget && typeof budget === "object") { budget.remaining--; budget.used++; }
  globalThis.__callCount = (globalThis.__callCount || 0) + 1;
}

async function call139(env, url, body, budget) {
  // 对风控与网络故障做有限重试; 出口由 Cloudflare 决定, 不保证更换。
  let last;
  for (let i = 0; i < 3; i++) {
    if (budgetExhausted(budget)) throw new Err139("BUDGET", "本轮调用预算已用完");
    try {
      const auth = await getAuth(env, budget);
      useBudget(budget);
      const r = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { ...HEADERS, Authorization: "Basic " + auth },
        body: await encryptPayload(body),
      });
      const b = await decryptPayload(await r.text());
      const rc = String(b?.resultCode ?? b?.code ?? "");
      if (rc === "0") return b;
      last = { rc, desc: b?.desc || b?.message || "" };
      if (rc !== "9530") break;
    } catch (e) {
      if (e.rc === "BUDGET") throw e;
      last = { rc: "ERR", desc: String(e).slice(0, 200) };
    }
    await sleep(400 * (i + 1));
  }
  throw new Err139(last?.rc ?? "?", last?.desc);
}

// ---------- token 自动续期 ----------

function authRemainMs(auth) {
  try {
    const dec = atob(auth);
    const tok = dec.split(":")[2] || "";
    const exp = Number(tok.split("|")[3]);
    if (Number.isFinite(exp)) return exp - Date.now();
    // 解析不出过期时间就别装死: 至少告警, 否则令牌格式一变就是"突然全站 401 且原因不明"
    console.log("无法解析令牌过期时间，自动续期已停用(令牌格式可能变了)");
  } catch (e) {
    console.log("Authorization 不是合法 base64, 自动续期已停用:", String(e).slice(0, 80));
  }
  return Infinity;
}

async function getAuth(env, budget) {
  const c = await getConfig(env);
  const revision = globalThis.__configRevision || 0;
  const auth = c.auth;
  const now = Date.now();
  const check = globalThis.__authCheck;
  if (globalThis.__authRefresh?.auth === auth) return globalThis.__authRefresh.promise;
  if (check?.auth === auth && now - check.ts < 3600e3) return auth;
  globalThis.__authCheck = { auth, ts: now };
  const remain = authRemainMs(auth);
  if (remain > 15 * 86400e3 || remain <= 0) return auth;
  const promise = (async () => {
    try {
      const parts = atob(auth).split(":");
      const account = parts[1] || "";
      const tok = parts.slice(2).join(":");
      useBudget(budget);
      const r = await fetch(API.REFRESH, {
        method: "POST", redirect: "manual", headers: { "Content-Type": "application/xml" },
        body: `<root><token>${xmlEsc(tok)}</token><account>${xmlEsc(account)}</account><clienttype>656</clienttype></root>`,
      });
      const xml = await r.text();
      const ret = (xml.match(/<return>([^<]*)<\/return>/i) || [])[1];
      const newTok = (xml.match(/<token>([^<]*)<\/token>/i) || [])[1];
      if (ret === "0" && newTok) {
        return await withConfigWrite(async () => {
          // 本 isolate 已手动保存过配置时, 不用可能滞后的 KV 回读覆盖已确认的新值。
          const current = await getConfig(env, revision === (globalThis.__configRevision || 0));
          if (current.auth !== auth || current.account !== c.account) return current.auth;
          const updated = btoa(`pc:${account}:${newTok}`);
          await saveConfig(env, { ...current, auth: updated });
          console.log("139 token 已自动续期");
          return updated;
        });
      }
    } catch (e) {
      if (e.rc === "BUDGET") throw e;
      console.log("token 刷新失败，继续使用当前令牌");
    }
    // 续期期间可能发生手动更新, 不把旧令牌再交给随后发出的请求。
    return (await getConfig(env)).auth;
  })();
  globalThis.__authRefresh = { auth, promise };
  try { return await promise; }
  finally { if (globalThis.__authRefresh?.promise === promise) globalThis.__authRefresh = null; }
}

// ================= catalog 与目录树 =================

class CatalogMissing extends Error {}
class CatalogCorrupt extends Error {}

function validateStoredCatalog(data) {
  if (!data || !data.mounts || typeof data.mounts !== "object" || Array.isArray(data.mounts)) {
    throw new CatalogCorrupt("目录数据损坏，无法读取原有挂载");
  }
  return data;
}

function parseStoredCatalog(raw) {
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new CatalogCorrupt("目录数据损坏，无法读取原有挂载"); }
  return validateStoredCatalog(data);
}

async function getCatalog(env) {
  const now = Date.now();
  if (globalThis.__cat && now - globalThis.__cat.ts < CAT_TTL * 1000) return globalThis.__cat.data;
  if (globalThis.__catPending) return globalThis.__catPending;
  const pending = loadCatalog(env);
  globalThis.__catPending = pending;
  try { return await pending; }
  finally { if (globalThis.__catPending === pending) globalThis.__catPending = null; }
}

async function loadCatalog(env) {
  const previous = globalThis.__cat;
  let data = null;
  const kv = await env.CACHE.get("catalog");
  // 读取期间可能刚完成保存/清理, 旧读取不能覆盖已确认的新目录。
  if (globalThis.__cat && globalThis.__cat !== previous) return globalThis.__cat.data;
  if (kv !== null) {
    data = parseStoredCatalog(kv);
  } else if (env.CATALOG_URL) {
    const r = await fetch(env.CATALOG_URL, { redirect: "manual", cf: { cacheTtl: 60 } });
    if (!r.ok) throw new Error(`目录源读取失败: HTTP ${r.status}`);
    try { data = await readJson(r); }
    catch (e) { if (e instanceof SyntaxError) throw new CatalogCorrupt("目录源数据损坏"); throw e; }
  } else {
    throw new CatalogMissing("尚未导入目录");
  }
  if (globalThis.__cat && globalThis.__cat !== previous) return globalThis.__cat.data;
  validateStoredCatalog(data);
  globalThis.__cat = { data, ts: Date.now() };
  return data;
}

function buildTree(catalog) {
  const root = { children: new Map() };
  for (const [path, leaf] of Object.entries(catalog.mounts)) {
    const segs = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i];
      if (!node.children.has(name)) node.children.set(name, { children: new Map(), name });
      node = node.children.get(name);
      if (i === segs.length - 1) node.leaf = leaf;
    }
  }
  return root;
}

function catalogTree(catalog) {
  if (globalThis.__tree?.catalog === catalog) return globalThis.__tree.tree;
  const tree = buildTree(catalog);
  globalThis.__tree = { catalog, tree };
  return tree;
}

// 校验目录结构。返回错误说明, 没问题返回 null。
// 关键点: 路径不能互为前缀 —— catalog 里同时有 A 和 A/B 时, 走到 A 就被当成分享根,
// A/B 永远访问不到(而且不报错, 很难查)。宁可导入时直接拒绝。
function catalogError(mounts) {
  if (!mounts || typeof mounts !== "object" || Array.isArray(mounts)) return "catalog.mounts 必须是对象";
  const paths = Object.keys(mounts);
  if (!paths.length) return "catalog.mounts 不能为空";
  for (const p of paths) {
    const segs = p.split("/");
    if (segs.some(s => !s.trim() || s === "." || s === ".." || /[\\\u0000-\u001f\u007f]/.test(s))) return `路径格式不对: ${p}`;
    if (new Set(["setup", "admin", "health", "tree", "link", "probe"]).has(segs[0])) return `路径占用了接口名称: ${p}`;
    const leaf = mounts[p];
    if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) return `挂载内容必须是对象: ${p}`;
    const ids = String(leaf.id || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean);
    if (!ids.length) return `挂载缺少 id: ${p}`;
    for (const one of ids) {
      const sid = one.split("#")[0].trim();
      if (!sid || /[\/\s]/.test(sid)) return `分享 ID 不合法: ${p} -> ${one}`;
    }
  }
  const set = new Set(paths);
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join("/");
      if (set.has(parent)) return `路径冲突: "${parent}" 和 "${p}" 不能同时作为挂载(前者会遮住后者)`;
    }
  }
  return null;
}

// ================= 列目录（带缓存） =================

function parseMtime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s || "");
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]); // 北京时间
}

// catalog.generated 的解析。带时区偏移/ Z 的按原样解析; 老版不带时区的裸本地时间
// 若直接 Date.parse 会被当成 UTC → 目录 mtime 差 8 小时(北京时区下显示成未来时间)。
// 所以裸时间一律按 +08:00(本库固定北京时区)解释。
function parseCatalogTime(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(t)) return Date.parse(t) || 0;
  return Date.parse(t.replace(" ", "T") + "+08:00") || 0;
}

const MEMO_MAX = 300;        // 内存目录缓存条数上限(超过按 LRU 淘汰, 防止 isolate 无限膨胀)

function memoSet(key, data, ts, serialized) {
  const m = (globalThis.__dirs ||= new Map());
  let bytes = globalThis.__dirBytes || 0;
  bytes -= m.get(key)?.weight || 0;
  m.delete(key);                                   // 重新插入到末尾, 顺带实现 LRU
  // ts 用数据的原始时间(KV 里存的那个), 不能一律用"现在",
  // 否则从 KV 捞出来的旧数据会被当成刚更新过, 新鲜期与保留期都算错
  const items = (data.folders?.length || 0) + (data.files?.length || 0);
  const weight = (serialized || JSON.stringify(data)).length * 2 + items * 256;
  if (weight <= DIR_MEMO_BYTES) { m.set(key, { data, ts: ts || Date.now(), weight }); bytes += weight; }
  while (m.size > MEMO_MAX || bytes > DIR_MEMO_BYTES) {
    const oldest = m.keys().next().value;
    bytes -= m.get(oldest).weight;
    m.delete(oldest);
  }
  globalThis.__dirBytes = bytes;
}

// 可选缓存故障短暂退避, 避免额度耗尽后每次播放都继续尝试读写。
async function cacheGet(env, key) {
  if (Date.now() < (globalThis.__cacheReadRetry || 0)) return null;
  try { return await env.CACHE.get(key); }
  catch { globalThis.__cacheReadRetry = Date.now() + 60000; return null; }
}
async function cachePut(env, key, value, expirationTtl) {
  if (Date.now() < (globalThis.__cacheWriteRetry || 0)) return;
  try { await env.CACHE.put(key, value, { expirationTtl }); }
  catch { globalThis.__cacheWriteRetry = Date.now() + 60000; }
}

// 目录列表缓存: 新鲜期内直接返回; 过了新鲜期先返回旧数据 + 后台静默刷新 (SWR);
// 最长保留 7 天, 超龄才同步重新拉取
async function cachedListing(env, key, recompute, ctx, opts = {}) {
  const now = Date.now();
  // 同一目录的并发拉取合并成一次(冷加载和后台刷新共用), 避免重复打 139。
  // 写回时内存 memo 和 KV 都要更新: 只写 memo 的话 KV 里的 t 永远不变,
  // 冷启动会一直读到旧数据, 而且每个请求都会再触发一次全量重拉。
  const inflight = (globalThis.__inflight ||= new Map());
  const pauseRefresh = () => {
    const old = globalThis.__dirs?.get(key);
    if (old) old.retryAfter = Date.now() + 60000;
  };
  const store = () => {
    if (inflight.has(key)) return inflight.get(key);
    const p = recompute().then(async d => {
      // 可返回尚可访问的成员, 但请求失败后的部分结果不覆盖完整缓存。
      if (d.incomplete) { pauseRefresh(); return d; }
      const t = Date.now();
      const serialized = JSON.stringify({ d, t });
      memoSet(key, d, t, serialized);
      await cachePut(env, key, serialized, DIR_STORE);
      return d;
    }).catch(e => { pauseRefresh(); throw e; }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const refresh = () => store().catch(() => {});
  const memo = globalThis.__dirs?.get(key);
  if (memo && now - memo.ts < DIR_STORE * 1000) {
    if (!opts.fillOnly && now - memo.ts > DIR_FRESH * 1000 && now >= (memo.retryAfter || 0) && ctx?.waitUntil) ctx.waitUntil(refresh());
    return memo.data;
  }
  const kv = await cacheGet(env, key);
  if (kv) {
    try {
      const j = JSON.parse(kv);
      if (j && j.d && now - (j.t || 0) < DIR_STORE * 1000) {
        memoSet(key, j.d, j.t, kv);   // 保留原始时间, 别让旧数据"变新鲜"
        if (!opts.fillOnly && now - (j.t || 0) > DIR_FRESH * 1000 && ctx?.waitUntil) ctx.waitUntil(refresh());
        return j.d;
      }
    } catch {}
  }
  return store();
}

// 同一目录里文件夹与文件重名时, 给文件加后缀 —— 否则 PROPFIND 会输出两个相同 href,
// 而 resolvePath 按名字查找只认文件夹, 同名文件永远访问不到。
function uniqueNames(folders, files) {
  const used = new Set();
  for (const arr of [folders, files]) {
    const isFile = (arr === files);
    for (const e of arr) {
      let name = e.name, n = 2;
      if (used.has(name)) {
        if (isFile) {
          const idx = e.name.lastIndexOf(".");
          const base = (idx > 0) ? e.name.slice(0, idx) : e.name;
          const ext = (idx > 0) ? e.name.slice(idx) : "";
          while (used.has(name)) name = `${base} (${n++})${ext}`;
        } else {
          while (used.has(name)) name = `${e.name} (${n++})`;
        }
      }
      used.add(name);
      e.name = name;
    }
  }
}

// 列一个分享目录的全部内容。
// 139 getOutLinkInfoV6 不传分页参数时只返回前 100 项(按最近添加排序),
// 因此必须用 bNum/eNum 逐页拉取(单页上限 200), 并用 caSrt/coSrt/srtDr 固定排序保证翻页稳定。
// budget: 本次请求的调用预算; 用满就抛错(不把残缺结果当完整目录缓存)
async function listAll(env, member, pcaid, budget, probeOnly = false) {
  const account = (await getConfig(env)).account;
  const folders = [];
  const files = [];
  const seen = new Set();
  let incomplete = false;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    if (budgetExhausted(budget)) {
      throw new Err139("BUDGET", "本次请求调用预算已用完，请减少分享数量或目录深度");
    }
    const bNum = page * LIST_PAGE + 1;
    const body = await call139(env, API.LIST, {
      getOutLinkInfoReq: {
        account, linkID: member.id, passwd: member.pwd, pCaID: pcaid,
        caSrt: 1, coSrt: 1, srtDr: 0,          // 固定排序, 避免翻页时顺序漂移导致漏项/重复
        bNum, eNum: bNum + LIST_PAGE - 1,      // 页码区间, 闭区间 1-based
      },
    }, budget);
    const d = body?.data;
    // 缺少数据/列表或畸形条目不是空分享, 否则体检会把异常响应当成删除依据。
    if (!d || typeof d !== "object" || Array.isArray(d) ||
        (!Array.isArray(d.caLst) && !Array.isArray(d.coLst)) ||
        (d.caLst != null && !Array.isArray(d.caLst)) ||
        (d.coLst != null && !Array.isArray(d.coLst))) {
      throw new Err139("BAD_RESPONSE", "分享列表响应结构不合法");
    }
    const ca = d.caLst || [];
    const co = d.coLst || [];
    const validFolder = f => !!f?.caID && typeof f.caName === "string" && !!f.caName;
    const validFile = f => !!f?.coID && typeof f.coName === "string" && !!f.coName;
    const malformed = ca.some(f => !validFolder(f)) || co.some(f => !validFile(f));
    if (malformed && probeOnly) {
      throw new Err139("BAD_RESPONSE", "分享列表包含不合法的文件或目录");
    }
    if (malformed) incomplete = true;
    let fresh = 0;
    for (const f of ca) {
      if (!validFolder(f) || seen.has(f.caID)) continue;
      seen.add(f.caID); fresh++;
      folders.push({ kind: "dir", id: f.caID, name: f.caName, mtime: parseMtime(f.udTime) });
    }
    for (const f of co) {
      if (!validFile(f) || seen.has(f.coID)) continue;
      seen.add(f.coID); fresh++;
      files.push({ kind: "file", id: f.coID, name: f.coName, size: Number(f.coSize || 0), mtime: parseMtime(f.udTime) });
    }
    // 本页不足一页(或没有新条目) => 已到最后一页
    if (probeOnly || ca.length + co.length < LIST_PAGE || fresh === 0) break;
  }
  uniqueNames(folders, files);
  return { folders, files, ...(incomplete ? { incomplete: true } : {}) };
}

async function keyDigest(parts) {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
async function listingKey(parts) {
  return `lst:${CACHE_V}:` + await keyDigest(parts);
}

async function listOne(env, member, pcaid, ctx, opts = {}) {
  opts = { ...opts, budget: opts.budget ?? ctx?.budget };
  const key = await listingKey([member.id, member.pwd, pcaid]);
  return cachedListing(env, key,
    async () => listAll(env, member, pcaid, opts.budget), ctx, opts);
}

// 列单个成员的"有效根": 若根目录只有一个文件夹(分享者套壳)则自动下沉, 最多 3 层。
// 注意: 这里现拉根目录(不经 cachedListing)。因为外层 listMountRoot 已经缓存了"下沉后的结果",
// 再单独缓存一份原始根目录是多余的(单成员挂载会存成两个键), 而且外层刷新时可能读到
// 内层还没刷新的旧值, 让内容更新要等两个刷新周期才可见。下沉用到的子目录仍走 listOne 缓存。
async function listMemberRoot(env, member, ctx, opts = {}) {
  opts = { ...opts, budget: opts.budget ?? ctx?.budget };
  let cur = await listAll(env, member, "root", opts.budget);
  for (let depth = 0; !cur.incomplete && cur.folders.length === 1 && cur.files.length === 0 && depth < 3; depth++) {
    const inner = await listOne(env, member, cur.folders[0].id, ctx, opts);
    // 子目录不完整时保留可进入的外层文件夹, 不把不确定的穿透结果存为完整根目录。
    if (inner.incomplete) { cur.incomplete = true; break; }
    if (inner.folders.length === 0 && inner.files.length === 0) break; // 空壳不穿
    cur = inner;
  }
  return cur;
}

async function listMountRoot(env, members, ctx, opts = {}) {
  opts = { ...opts, budget: opts.budget ?? ctx?.budget };
  const key = (await listingKey(members.map(m => [m.id, m.pwd]))) + ":@root";
  return cachedListing(env, key, async () => {
    const merged = { folders: [], files: [] };
    const seen = new Set();
    let okCount = 0, firstErr = null;
    for (let mi = 0; mi < members.length; mi++) {
      let one;
      try {
        one = await listMemberRoot(env, members[mi], ctx, opts);
      } catch (e) {
        // 预算耗尽表示目录尚未读完, 不能把前几个成员缓存为完整目录。
        if (e.rc === "BUDGET") throw e;
        // 单条分享失效(过期/缺提取码)不该拖垮整个目录, 跳过它继续
        if (!firstErr) firstErr = e;
        console.log("挂载成员拉取失败, 已跳过:", String(e).slice(0, 120));
        continue;
      }
      okCount++;
      if (one.incomplete) merged.incomplete = true;
      for (const arr of [one.folders, one.files]) {
        for (const e of arr) {
          const k = e.kind + ":" + e.name;   // 按 类型+名字 去重, 避免同名文件与文件夹互相顶掉
          if (seen.has(k)) continue;         // 同名先到先得
          seen.add(k);
          merged[e.kind === "dir" ? "folders" : "files"].push({ ...e, memberIdx: mi });
        }
      }
    }
    if (!okCount && firstErr) throw firstErr;   // 全都失败才整体报错, 免得掩盖问题
    if (firstErr) merged.incomplete = true;
    uniqueNames(merged.folders, merged.files);  // 多分享合并后也保证名字唯一
    return merged;
  }, ctx, opts);
}

async function getDlUrl(env, members, entry, ctx) {
  const member = (members && (members[entry.memberIdx || 0] || members[0])) || { id: "", pwd: "" };
  const account = (await getConfig(env)).account;
  const key = "dl:v2:" + await keyDigest([account, member.id, member.pwd || "", entry.id]);
  const memo = (globalThis.__downloads ||= new Map());
  const remember = data => {
    memo.delete(key); memo.set(key, data);
    while (memo.size > DL_MEMO_MAX) memo.delete(memo.keys().next().value);
    return data.url;
  };
  const hot = memo.get(key);
  if (hot && Date.now() - hot.t < DL_TTL * 1000) return remember(hot);
  memo.delete(key);
  const inflight = (globalThis.__dlInflight ||= new Map());
  if (inflight.has(key)) return inflight.get(key);
  const pending = (async () => {
    const kv = await cacheGet(env, key);
    if (kv) {
      try {
        const j = JSON.parse(kv);
        if (typeof j.url === "string" && j.url.length <= 16384 && /^https?:\/\//i.test(j.url) &&
            j.t > 0 && Date.now() - j.t >= 0 && Date.now() - j.t < DL_TTL * 1000) return remember(j);
      } catch {}
    }
    const body = await call139(env, API.DL, {
      dlFromOutLinkReqV3: { account, linkID: member.id, passwd: member.pwd, coIDLst: { item: [entry.id] } },
    }, ctx?.budget);
    const d = body?.data || {};
    const url = d.extInfo?.cdnDownloadURL || d.redrUrl || d.redrURL || d.downloadUrl || d.downloadURL;
    if (typeof url !== "string" || url.length > 16384 || !/^https?:\/\//i.test(url)) throw new Err139("NOLINK", "未返回合法的下载直链");
    const data = { url, t: Date.now() };
    remember(data);
    await cachePut(env, key, JSON.stringify(data), DL_TTL);
    return url;
  })().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

// ================= 路径解析 =================

// 返回 {kind:"catdir",node} | {kind:"mountdir",members} |
//       {kind:"shareDir",entry,members} | {kind:"file",entry,members} | null
async function resolvePath(env, tree, segs, ctx) {
  // 边走边记住"最近一个有挂载的祖先"。
  // catalogError 已在导入时拒绝"A 与 A/B 共存"的目录, 这里是兜底防御:
  // 万一 KV 里残留旧版脏数据, 请求 A/B 会先匹配到子节点 B(用 B 的挂载),
  // 而不是走到 A 就把剩下的 B 当成分享内部路径。
  let node = tree;
  let i = 0;
  let best = null, bestAt = 0;
  while (i < segs.length) {
    if (node.leaf) { best = node; bestAt = i; }
    const next = node.children.get(segs[i]);
    if (!next) break;
    node = next;
    i++;
  }
  let leaf, rest;
  if (i === segs.length && node.leaf) { leaf = node; rest = []; }
  else if (best) { leaf = best; rest = segs.slice(bestAt); }
  else if (i === segs.length) return { kind: "catdir", node };
  else return null;
  const members = parseMembers(leaf.leaf);
  if (!members.length) return null;
  if (rest.length === 0) return { kind: "mountdir", members };
  let entries = await listMountRoot(env, members, ctx);
  // 多分享挂载时, 要一路记住当前条目来自哪条分享:
  // 只有挂载根那一层带 memberIdx, 往下 listOne 出来的条目没有,
  // 所以必须把上一层的来源带下去, 否则深一层就会错用 members[0]。
  let mi = 0;
  for (let j = 0; j < rest.length; j++) {
    const e = entries.folders.concat(entries.files).find(x => x.name === rest[j]);
    if (!e) return null;
    if (e.memberIdx != null) mi = e.memberIdx;
    if (j === rest.length - 1) {
      const entry = { ...e, memberIdx: mi };
      return e.kind === "dir" ? { kind: "shareDir", entry, members } : { kind: "file", entry, members };
    }
    if (e.kind !== "dir") return null; // 文件不能继续向下遍历, 避免把文件 ID 当目录再请求上游
    entries = await listOne(env, members[mi], e.id, ctx);
  }
  return null;
}

async function dirEntries(env, resolved, ctx, cat) {
  if (resolved.kind === "catdir") {
    const mt = parseCatalogTime(cat?.generated) || Date.now();
    return [...resolved.node.children.values()].map(n => ({
      kind: "dir", name: n.name, size: 0, mtime: mt, virtual: true,
    }));
  }
  const lst = resolved.kind === "mountdir"
    ? await listMountRoot(env, resolved.members, ctx)
    : await listOne(env, (resolved.members && (resolved.members[resolved.entry.memberIdx || 0] || resolved.members[0])) || { id: "", pwd: "" }, resolved.entry.id, ctx);
  return lst.folders.concat(lst.files);
}

// ================= WebDAV =================

const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hrefOf = segs => "/" + segs.map(s => encodeURIComponent(s)).join("/");

function davResponse(href, e, isRoot) {
  const isDir = e.kind === "dir" || isRoot;
  const finalHref = (isDir && !href.endsWith("/")) ? href + "/" : href;
  const mtime = e.mtime ? new Date(e.mtime) : new Date(0);
  const mime = isDir ? "httpd/unix-directory" : (MIME[e.name.split(".").pop().toLowerCase()] || "application/octet-stream");
  return `<D:response>
<D:href>${xmlEsc(finalHref)}</D:href>
<D:propstat><D:prop>
<D:displayname>${xmlEsc(e.name || "")}</D:displayname>
<D:resourcetype>${isDir ? "<D:collection/>" : ""}</D:resourcetype>
${isDir ? "" : `<D:getcontentlength>${e.size || 0}</D:getcontentlength>`}
<D:getcontenttype>${mime}</D:getcontenttype>
<D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified>
<D:creationdate>${new Date(e.mtime || 0).toISOString().replace(/\.\d+Z$/, "Z")}</D:creationdate>
<D:supportedlock></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}

// 自然排序: "第2集" 排在 "第10集" 前, 数字段按数值比较
const nameCollator = new Intl.Collator("zh", { numeric: true, sensitivity: "base" });
const naturalCmp = (a, b) => nameCollator.compare(a.name, b.name);

async function handleDav(request, env, url, ctx) {
  // OPTIONS 放在认证之前: 浏览器类 WebDAV 客户端的 CORS 预检不带凭据, 先认证会 401
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: {
      DAV: "1", Allow: "OPTIONS, GET, HEAD, PROPFIND",
      "MS-Author-Via": "DAV", "Content-Length": "0",
      // 跨域的浏览器客户端过预检还要这些头, 光不 401 不够
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS, GET, HEAD, PROPFIND",
      "Access-Control-Allow-Headers": "Authorization, Depth, Content-Type",
    } });
  }
  if (!(await checkAuth(request, env))) return unauthorized(REALM);
  const segs = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).filter(Boolean);

  if (request.method === "PROPFIND") {
    const depth = (request.headers.get("Depth") || "1").trim();
    // Depth: infinity 表示"递归整棵树"。本库做不到(要递归打几百次 139 接口, 会撞免费版
    // 50 子请求上限), 以前是当 Depth:1 处理 —— 客户端以为拿全了其实只有一层, 更坑。
    // RFC 4918 允许用 403 明确拒绝, 这里就明确拒绝。
    if (/^infinity$/i.test(depth)) {
      return text("403 Forbidden: 不支持 Depth: infinity, 目录树太大, 请改用 Depth: 1", 403);
    }
    const cat = await getCatalog(env);
    let resolved;
    try { resolved = await resolvePath(env, catalogTree(cat), segs, ctx); }
    catch (e) { return text(e.message, 502); }
    if (!resolved) return text("404 Not Found", 404);

    // 目录 mtime = catalog 重建时间 与 内容最新修改时间 的较大者
    let selfMtime = parseCatalogTime(cat.generated) || Date.now();
    let entries = [];
    // 文件没有子项, 直接返回自身(省掉一次拿文件 ID 当目录去列的 139 调用)
    // Depth:0 只要资源自身属性, 别为它去把整个目录拉一遍(白耗 139 配额)
    if (resolved.kind !== "file" && depth !== "0") {
      entries = await dirEntries(env, resolved, ctx, cat);
    }
    if (entries.length) {
      selfMtime = Math.max(selfMtime, ...entries.map(e => e.mtime || 0));
    }
    const self = resolved.kind === "file"
      ? { kind: "file", name: segs[segs.length - 1] || "", size: resolved.entry.size || 0, mtime: resolved.entry.mtime || 0 }
      : { kind: "dir", name: segs[segs.length - 1] || "", size: 0, mtime: selfMtime };
    const out = [davResponse(hrefOf(segs), self, segs.length === 0)];
    if (depth !== "0") {
      entries.sort((a, b) => (a.kind === b.kind ? naturalCmp(a, b) : a.kind === "dir" ? -1 : 1));
      for (const e of entries) out.push(davResponse(hrefOf([...segs, e.name]), e, false));
    }
    return new Response(multistatus(out), { status: 207, headers: { "Content-Type": 'application/xml; charset="utf-8"' } });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    let resolved;
    try { resolved = await resolvePath(env, catalogTree(await getCatalog(env)), segs, ctx); }
    catch (e) { return text(e.message, 502); }
    if (!resolved) return text("404 Not Found", 404);
    if (resolved.kind !== "file") return text("405 Method Not Allowed (directory)", 405);
    const e = resolved.entry;
    const mime = MIME[e.name.split(".").pop().toLowerCase()] || "application/octet-stream";
    const base = {
      "Content-Type": mime,
      "Content-Length": String(e.size || 0),
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(e.mtime || 0).toUTCString(),
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: base });
    const target = await getDlUrl(env, resolved.members, e, ctx);
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  }

  if (request.method === "PROPPATCH" || request.method === "LOCK" || request.method === "UNLOCK") {
    // 只读库: 这三个方法一律不支持。以前返回空 200 假装成功, 客户端会以为
    // 属性写成功 / 拿到锁, 行为不可预期; 现在按 OPTIONS 里 Allow 的实际能力回 405。
    return text("405 Method Not Allowed: 只读库, 不支持改属性/加锁", 405);
  }
  return text("405 Method Not Allowed", 405);
}

// ================= API 路由 =================

const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function readJson(request, limit = CATALOG_BODY_MAX) {
  const tooLarge = () => Object.assign(new Error("请求内容过大，请减少条目后重试"), { status: 413 });
  if (Number(request.headers.get("Content-Length")) > limit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("empty JSON");
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally { reader.releaseLock(); }
}

// 认证 + 防爆破: 同一 IP 连续失败 N 次锁定 15 分钟(内存级, 跨 isolate 不共享), 失败加随机延迟。
// mode="read"  用 WebDAV 账号密码(播放器/直链等只读场景)
// mode="admin" 用管理口令 admin_pass; 没设就退回 WebDAV 密码(向后兼容)
async function authCheck(request, env, mode) {
  const ip = mode + ":" + (request.headers.get("CF-Connecting-IP") || "unknown");
  const bf = (globalThis.__bf ||= new Map());
  const now = Date.now();
  // 清理过期条目: 每分钟最多扫一次, 避免每个请求都 O(n) 遍历整张表
  if (bf.size > 64 && now - (globalThis.__bfClean || 0) > 60e3) {
    globalThis.__bfClean = now;
    for (const [k, v] of bf) {
      // 锁定中的条目按锁定时长保留, 纯计数条目按失败窗口保留。
      // 统一按 BF_WINDOW 会把"锁定中但 10 分钟没动静"的条目提前删掉,
      // 15 分钟的锁实际只锁 10 分钟就被人绕过
      const ttl = v.locked ? BF_LOCK_TTL : BF_WINDOW;
      if (now - (v.t || 0) > ttl) bf.delete(k);
    }
  }
  let e = bf.get(ip);
  if (!e) {
    if (bf.size >= BF_MAX_ENTRIES) bf.delete(bf.keys().next().value);
    e = { n: 0, t: now }; bf.set(ip, e);
  }
  if (e.locked && now < e.locked) return false;                    // 锁定中, 直接拒
  if (e.locked) { e.locked = 0; e.n = 0; e.t = now; }              // 锁已过期, 重置计数
  if (now - (e.t || 0) > BF_WINDOW) { e.n = 0; e.t = now; }        // 计数窗口过期
  const c = await getConfig(env);
  const wantUser = c.dav_user;
  const wantPass = mode === "admin" ? (c.admin_pass || c.dav_pass) : c.dav_pass;
  if (!wantUser || !wantPass) return false;
  const h = request.headers.get("Authorization") || "";
  let ok = false;
  const basicMatch = h.match(/^Basic\s+(.+)$/i);
  if (basicMatch) {
    let bin = null;
    try { bin = atob(basicMatch[1].trim()); } catch {}
    if (bin !== null) {
      // 客户端发的可能是 UTF-8 字节, atob 出来是 latin1 字符串, 中文账号密码会比对失败;
      // 两种解释都试一下(纯 ASCII 时两者相同)
      const cands = [bin];
      try { cands.push(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))); } catch {}
      for (const raw of cands) {
        const i = raw.indexOf(":");   // 按第一个冒号切分, 密码里含冒号也能正确比对
        if (i >= 0 && raw.slice(0, i) === wantUser && raw.slice(i + 1) === wantPass) { ok = true; break; }
      }
    }
  }
  if (ok) { bf.delete(ip); return true; }
  e.t = now;
  e.n = (e.n || 0) + 1;
  await sleep(400 + Math.floor(Math.random() * 600));
  if (e.n >= BF_MAX) {
    e.locked = now + BF_LOCK_TTL;   // BF_LOCK_TTL 本身就是毫秒
  }
  return false;
}
const checkAuth = (request, env) => authCheck(request, env, "read");
const checkAdminAuth = (request, env) => authCheck(request, env, "admin");
const unauthorized = realm => new Response("401 Unauthorized", {
  status: 401, headers: { "WWW-Authenticate": `Basic realm="${realm}"`, "Content-Type": "text/plain" },
});

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;

  if (path === "/health") {
    // 只回状态, 不泄露挂载数/目录时间(要看这些走需认证的 /tree)
    try { return json({ ok: true, configured: await isConfigured(env), colo: request.cf?.colo }); }
    catch (e) {
      if (!(e instanceof ConfigUnavailable)) throw e;
      return json({ ok: false, configured: null, error: "配置暂不可用，请访问 /setup 查看恢复说明" }, 503);
    }
  }

  // 写操作(导入/覆盖目录)走管理口令; 只读接口(直链/树/探测)走 WebDAV 口令。
  // 只读场景用 WebDAV 密码, 写操作要用管理口令, 两者分开。
  const isWrite = path === "/admin/catalog" || path === "/admin/catalog-lines" || path === "/admin/check" || path === "/admin/sync-state";
  const authed = isWrite ? await checkAdminAuth(request, env) : await checkAuth(request, env);
  if (!authed) return unauthorized(isWrite ? REALM_ADMIN : REALM);

  if (path === "/link") {
    const p = url.searchParams.get("path") || "";
    // searchParams 已经把 %XX 解过一次了, 这里别再 decodeURIComponent 一次,
    // 否则文件名里含字面 "%" (如 "100%.mp4") 会被二次解码解错
    const segs = p.split("/").filter(Boolean);
    const resolved = await resolvePath(env, catalogTree(await getCatalog(env)), segs, ctx);
    if (!resolved) return text("404 Not Found: " + p, 404);
    if (resolved.kind !== "file") return text("不是文件: " + p, 400);
    const target = await getDlUrl(env, resolved.members, resolved.entry, ctx);
    if (url.searchParams.get("format") === "json") return json({ path: p, url: target });
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  }

  if (path === "/admin/catalog-lines") {
    return handleCatalogLines(request, env);
  }

  if (path === "/admin/sync-state" && request.method === "GET") {
    const cat = await readCatalogFresh(env);
    return json({ source_hash: cat?.source_hash || "" });
  }

  if (path === "/tree") {
    const cat = await getCatalog(env);
    const summary = Object.create(null);
    for (const p of Object.keys(cat.mounts)) {
      const c = p.split("/")[0];
      summary[c] = (summary[c] || 0) + 1;
    }
    return json({ generated: cat.generated, top: summary, total: Object.keys(cat.mounts).length });
  }

  if (path === "/admin/catalog" && request.method === "POST") {
    let data;
    try { data = await readJson(request); } catch (e) { if (e.status) throw e; return text("bad json", 400); }
    const err = catalogError(data && data.mounts);
    if (err) return text(err, 400);
    await saveCatalog(env, data);
    return json({ ok: true, mounts: Object.keys(data.mounts).length, generated: data.generated || null });
  }

  if (path === "/admin/check" && request.method === "POST") {
    // 死链体检: 前端拿着 nextFrom 反复调用, 直到 done 为止
    let b = {};
    try { b = await readJson(request, CONFIG_BODY_MAX); } catch (e) { if (e.status) throw e; return json({ error: "bad json" }, 400); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "需要 JSON 对象" }, 400);
    const from = (b && typeof b.from === "string") ? b.from : "";
    const r = await pruneCatalog(env, from, CHECK_BATCH);
    return json({ ok: true, total: r.total, remaining: r.remaining, checked: r.checked, nextFrom: r.nextFrom, done: r.done, removed: r.removed, flagged: r.flagged, unverified: r.unverified, logWarning: r.logWarning || undefined });
  }

  if (path === "/probe") {
    const parsed = parseLinkEntriesInWorker(url.searchParams.get("link") || "")[0] || "";
    let lid = parsed, pwd = "";
    if (lid.includes("#")) [lid, pwd] = lid.split("#", 2);
    if (!lid) return json({ error: "缺少分享链接" }, 400);
    const t0 = Date.now();
    const d = await listAll(env, { id: lid, pwd }, "root", ctx?.budget);
    return json({ share: lid, pw: pwd ? "有" : "无", ms: Date.now() - t0, folders: d.folders.map(f => f.name), files: d.files.map(f => f.name) });
  }

  return text("404 Not Found. /health /link /tree /admin/catalog /probe", 404);
}

// ================= 配置向导与管理页 =================

const PAGE_CSS = `<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 16px}
.card{max-width:680px;margin:0 auto;background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#8b93a1;margin:0 0 20px;font-size:13px}
label{display:block;font-size:13px;color:#aab2c0;margin:14px 0 6px}
input,textarea{width:100%;background:#0f1115;border:1px solid #2c3442;border-radius:8px;color:#e6e6e6;padding:10px 12px;font-size:13px;font-family:inherit}
textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
button{margin-top:18px;width:100%;background:#4f7cff;border:none;color:#fff;padding:11px;border-radius:8px;font-size:14px;cursor:pointer}
button:hover{background:#3d6af0}
.hint{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6}
.ok{color:#4ade80}.err{color:#f87171}
a{color:#4f7cff}
details{margin-top:22px;border-top:1px solid #262b36;padding-top:14px}
summary{cursor:pointer;color:#8b93a1;font-size:13px}
.status{background:#0f1115;border:1px solid #2c3442;border-radius:8px;padding:12px;font-size:13px;line-height:1.8;margin-bottom:18px}
</style>`;

function page(title, body) {
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + title + ` - 139dav</title>` + PAGE_CSS + `</head><body><div class="card">` + body + `</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" } });
}

const SETUP_FORM = (notice, adminSet) => `
<h1>139dav 初始配置</h1>
<p class="sub">粘贴移动云盘网页版的 Authorization, 设好 WebDAV 账号密码, 即可完成部署</p>
` + (notice || "") + `
<form id="f">
<label>139 Authorization</label>
<p class="hint">yun.139.com 网页端 F12 → 网络 → hcy/file/list → 请求标头 Authorization，可带或不带 Basic 前缀</p>
<textarea id="auth" placeholder="粘贴 Basic 后面的整串 base64" required></textarea>
<label>139 账号，手机号。一般会自动识别，识别不出再手动填</label>
<input id="account" placeholder="自动识别" inputmode="numeric">
<label>WebDAV 用户名</label>
<input id="dav_user" value="admin" required>
<label>WebDAV 密码，至少 6 位</label>
<input id="dav_pass" type="password" required>
<label>管理口令，可选，至少 6 位。填了之后改目录、改配置要用它；留空就直接用 WebDAV 密码管理${adminSet ? "。当前已设置，留空则不修改" : ""}</label>
<input id="admin_pass" type="password" autocomplete="new-password">
<button>保存并完成部署</button>
<p class="hint">保存后访问 <a href="/admin">/admin</a> 添加分享, 或用仓库里的 clean_links.py 批量导入。WebDAV 地址即本站根路径。</p>
</form>
<script>
f.onsubmit = async (e) => {
  e.preventDefault();
  const b = document.querySelector("button"); b.disabled = true; b.textContent = "保存中...";
  let saved = false;
  try {
    const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: auth.value.trim(), account: account.value.trim(), dav_user: dav_user.value.trim(), dav_pass: dav_pass.value, admin_pass: admin_pass.value }) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) { saved = true; b.textContent = "完成!"; location.href = "/admin"; }
    else alert(j.error || ("保存失败: HTTP " + r.status));
  } catch (e) {
    alert("保存失败，请检查网络后重试: " + e);
  } finally {
    if (!saved) { b.disabled = false; b.textContent = "保存并完成部署"; }
  }
};
</` + `script>`;

const ADMIN_FORM = (origin, info, dav_user, dav_pass, lines, adminSet, checkLog) => `
<h1>139dav 管理页</h1>
<p class="sub">分享列表管理 · WebDAV 与直链接口同源</p>
<div class="status">
WebDAV 地址: <b>` + xmlEsc(origin) + `/</b>，播放器/rclone 直接挂<br>
WebDAV 账号: <b>` + xmlEsc(dav_user) + `</b>  密码: <b>` + xmlEsc(dav_pass) + `</b>，忘了就回这里看<br>
直链接口: <b>` + xmlEsc(origin) + `/link?path=/分类/标题/文件.mp4</b><br>
管理口令: <b>` + (adminSet ? "已启用，改目录、改配置要用它" : "未启用，当前用 WebDAV 密码管理") + `</b><br>
当前目录: <b>` + (info.damaged ? "无法读取（重建模式）" : xmlEsc(String(info.mounts)) + " 个挂载") + `</b>，generated ` + xmlEsc(info.generated || "未导入") + `<br>
最近清理: <b>` + (checkLog && checkLog.length ? checkLog.slice(0, 5).map(x => xmlEsc(x.path)).join("、") + (checkLog.length > 5 ? " 等 " + checkLog.length + " 项" : "") : "无") + `</b>
</div>
<label>分享列表。每行一条：<code>分类/标题 | 分享链接或ID#提取码</code>，链接可多个用逗号分隔。保存是整份覆盖，已自动回填现有目录。路径不能含 <code>|</code>，提取码不能含逗号/分号。</label>
<textarea id="cat" placeholder="分类/标题 | https://yun.139.com/shareweb/#/w/i/xxxxxx&#10;电影/某电影 | yyyyyyyy,zzzzzzzz#8888">` + xmlEsc(lines || "") + `</textarea>
<button id="b1">保存目录 · 整份覆盖</button>
<p class="hint" id="msg"></p>
<button id="b3">检查链接 · 清理失效和空白分享</button>
<p class="hint" id="msg3" style="white-space:pre-line"></p>
<p class="hint">大批量导入请用仓库里的 <b>clean_links.py</b>，把包含 139 分享链接的 Markdown 放进 data/ 自动清洗，再跑 <b>upload_catalog.py</b> 上传。</p>
<details><summary>修改初始配置：Authorization / WebDAV 账号密码 / 管理口令</summary>
<label>139 Authorization</label><textarea id="auth2"></textarea>
<label>139 账号</label><input id="account2">
<label>WebDAV 用户名</label><input id="dav_user2">
<label>WebDAV 密码，留空则不修改</label><input id="dav_pass2" type="password">
<label>管理口令，留空则不修改${adminSet ? "" : "。当前未启用"}</label><input id="admin_pass2" type="password" autocomplete="new-password">
<label style="font-weight:normal"><input type="checkbox" id="admin_clear" style="width:auto"> 清除管理口令，改回用 WebDAV 密码管理</label>
<button id="b2">更新配置</button><p class="hint" id="msg2"></p>
</details>
<script>
b1.onclick = async () => {
  // 全量覆盖不可逆: 编辑框只改了一部分就保存, 其余挂载会被静默清空, 必须确认
  if (!confirm(${JSON.stringify(info.damaged ? "确认用完整分享列表重建损坏的目录？原目录将被覆盖，请先备份 KV 中的 catalog。" : `保存将「全量覆盖」现有 ${info.mounts} 个挂载, 没贴回来的条目会被删除。确认继续?`)})) return;
  b1.disabled = true; b1.textContent = "保存中...";
  try {
    const r = await fetch("/admin/catalog-lines", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: cat.value }) });
    const j = await r.json().catch(() => ({}));
    msg.textContent = j.ok
      ? ("已保存 " + j.mounts + " 个挂载" + (j.merged ? "；有 " + j.merged.length + " 个重复路径已自动合并：" + j.merged.join("、") : ""))
      : ("失败: " + (j.error || r.status));
    msg.className = j.ok ? "hint ok" : "hint err";
  } catch (e) {
    msg.textContent = "保存失败，请检查网络后重试: " + e;
    msg.className = "hint err";
  } finally { b1.disabled = false; b1.textContent = "保存目录 · 整份覆盖"; }
};
b3.onclick = async () => {
  if (!confirm("会逐个探测所有分享，把失效和空白的链接从目录里删掉。挂载多时要等一会儿，继续？")) return;
  b3.disabled = true;
  let from = "", removed = [], flagged = [], total = 0, guard = 0, done = false, unverified = 0, logWarning = false;
  try {
    while (!done) {
      if (++guard > 1000) throw new Error("体检超过轮次上限，尚未完成，请稍后重试");
      const r = await fetch("/admin/check", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { msg3.textContent = "失败: " + (j.error || r.status); msg3.className = "hint err"; return; }
      if (typeof j.done !== "boolean" || (!j.done && (typeof j.nextFrom !== "string" || !j.nextFrom))) {
        throw new Error("体检响应缺少完成状态或续查信息，尚未完成");
      }
      from = j.nextFrom; total = j.total; done = j.done;
      if (j.removed && j.removed.length) removed = removed.concat(j.removed);
      if (j.flagged && j.flagged.length) flagged = flagged.concat(j.flagged);
      unverified += j.unverified || 0;
      logWarning = logWarning || j.logWarning === true;
      msg3.textContent = "体检中… 还剩 " + j.remaining + " 个，已清理 " + removed.length + " 项";
      msg3.className = "hint";
      // 清理会写同一个 catalog 键, 避免下一批紧接着再次写入而触发 KV 限速。
      if (!done && j.removed?.length) await new Promise(resolve => setTimeout(resolve, 1100));
    }
    const needsReview = flagged.length || unverified || logWarning;
    const autoReload = removed.length && !needsReview;
    msg3.textContent = "体检完成：共 " + total + " 个挂载，清理 " + removed.length + " 项"
      + (logWarning ? "；部分清理记录未保存，目录清理已生效，请保留原始链接文档" : "")
      + (unverified ? "；有 " + unverified + " 条分享本轮未能确认，已保留，请稍后重试" : "")
      + (flagged.length ? "；另有 " + flagged.length + " 条分享需人工核对，已保留\\n" + flagged.map(x => x.path + "：" + (x.reason || "原因未提供")).join("\\n") : "")
      + (autoReload ? "，稍后自动刷新" : removed.length ? "；目录已清理，请刷新页面后再编辑目录" : "");
    msg3.className = "hint ok";
    // 有待核对结果时保留报告, 同时避免使用清理前的编辑框再次覆盖目录。
    if (removed.length && needsReview) b1.disabled = true;
    if (autoReload) setTimeout(() => location.reload(), 2000);
  } catch (e) {
    msg3.textContent = "失败: " + e;
    msg3.className = "hint err";
  } finally { b3.disabled = false; }
};
b2.onclick = async () => {
  b2.disabled = true;
  try {
    const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: auth2.value.trim(), account: account2.value.trim(), dav_user: dav_user2.value.trim(), dav_pass: dav_pass2.value, admin_pass: admin_pass2.value, admin_clear: admin_clear.checked }) });
    const j = await r.json().catch(() => ({}));
    msg2.textContent = j.ok ? "已更新。管理口令变更后，刷新页面会要求重新登录" : ("失败: " + (j.error || r.status));
    msg2.className = j.ok ? "hint ok" : "hint err";
  } catch (e) {
    msg2.textContent = "更新失败，请检查网络后重试: " + e;
    msg2.className = "hint err";
  } finally { b2.disabled = false; }
};
</` + `script>`;

function parseLinkEntriesInWorker(raw) {
  return String(raw || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/(?:shareweb|w)\/#\/(?:w\/i|share)\/([0-9A-Za-z]+)/) || s.match(/caiyun\.139\.com\/[wm]\/i[/?]([0-9A-Za-z]+)/);
    let id, pwd = "";
    if (m) {
      id = m[1];
      // 提取码必须紧跟在 ID 后面(允许前置空格)。不能在整个剩余串里找 "#":
      // 139 链接本身就含 "#"(shareweb/#/w/i/...), markdown 的 [链接](链接) 后半段也是 URL
      const rest = s.slice(m.index + m[0].length).replace(/^\s+/, "");
      if (rest.startsWith("#")) {
        const cand = rest.slice(1).split(/[,，;；\s)\]]/)[0].trim();
        if (cand && cand.length <= 32 && !/[/:?]/.test(cand)) pwd = cand;
      }
    } else if (!/^https?:/i.test(s) && s.includes("#")) {
      const p = s.split("#");      // 裸 ID#提取码(不是完整链接才走这里)
      id = p[0].trim(); pwd = (p[1] || "").trim();
    } else {
      id = s;
    }
    return pwd ? id + "#" + pwd : id;
  }).filter(Boolean);
}

async function handleSetup(request, env, url) {
  if (request.method === "GET") {
    let configured;
    try { configured = await isConfigured(env); }
    catch (e) {
      if (!(e instanceof ConfigUnavailable)) throw e;
      const response = page("配置恢复说明", '<h1>配置暂不可用</h1><p>为保护已有服务，已停止初始化和配置修改。</p><h2>恢复方法</h2><p>先在 Cloudflare 面板检查 CACHE 绑定、KV 用量和服务状态。临时故障恢复后再刷新。</p><p>如果确认 config 记录已损坏或字段不完整，请先备份该记录，再从可信备份恢复。没有备份时，可由账号所有者在 Cloudflare 面板删除 config 后立即重新配置；这会重置网页保存的账号、密码和令牌，catalog 目录无需删除。</p><p>恢复前请暂时关闭公开访问，恢复后确认账号密码已重新设置。此页只提供说明，不接受配置提交。</p>');
      return new Response(response.body, { status: 503, headers: response.headers });
    }
    // 已配置后, 打开/提交配置页属于"管理写操作", 用管理口令
    if (configured && !(await checkAdminAuth(request, env))) {
      return new Response("401 Unauthorized: 已配置, 修改请用管理口令登录", {
        status: 401, headers: { "WWW-Authenticate": `Basic realm="${REALM_ADMIN}"`, "Content-Type": "text/plain" } });
    }
    const c = configured ? await getConfig(env) : {};
    return page("初始配置", SETUP_FORM(configured ? '<p class="hint ok">已配置过, 再次提交将覆盖现有配置。</p>' : "", !!c.admin_pass));
  }
  if (request.method === "POST") {
    return withConfigWrite(async () => {
      const old = await getConfig(env, true);
      const configured = !!(old.auth && old.account && old.dav_user && old.dav_pass);
      if (configured && !(await checkAdminAuth(request, env))) {
        return json({ error: "已配置, 修改需管理口令认证" }, 401);
      }
      let b;
      try { b = await readJson(request, CONFIG_BODY_MAX); } catch (e) { if (e.status) throw e; return json({ error: "bad json" }, 400); }
      if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "需要 JSON 对象" }, 400);
      let auth = String(b.auth || "").trim().replace(/^Basic\s+/i, "");
      if (!auth) {
        if (!configured) return json({ error: "Authorization 不能为空" }, 400);
        // getConfig 已兼容旧版独立 auth 键; 新版直接沿用当前配置中的有效令牌。
        auth = old.auth || "";
        if (!auth) return json({ error: "Authorization 不能为空" }, 400);
      }
      let account = String(b.account || "").trim();
      let dec = "";
      try { dec = atob(auth); } catch { return json({ error: "Authorization 不是合法 base64" }, 400); }
      const parts = dec.split(":");
      if (parts.length < 3) return json({ error: "Authorization 格式不对, 应为 pc:手机号:令牌" }, 400);
      if (!account) account = parts[1] || old.account || "";
      if (!/^\d{5,15}$/.test(account)) return json({ error: "账号识别失败, 请手动填写手机号" }, 400);
      // 留空 = 不修改(管理页就是这么标注的); 首次配置必须填。
      // 长度只校验"新填的"密码 —— 沿用的旧密码可能是环境变量配的短密码, 不该拦
      let dav_pass = String(b.dav_pass || "");
      if (dav_pass) {
        if (dav_pass.length < 6) return json({ error: "WebDAV 密码至少 6 位" }, 400);
      } else {
        if (!configured || !old.dav_pass) return json({ error: "WebDAV 密码至少 6 位" }, 400);
        dav_pass = old.dav_pass;
      }
      const dav_user = String(b.dav_user || old.dav_user || "admin").trim() || "admin";
      if (dav_user.includes(":")) return json({ error: "WebDAV 用户名不能包含冒号" }, 400);
      // 管理口令: 留空 = 不修改(沿用旧值); admin_clear=true = 清除(退回用 WebDAV 密码管理)
      let admin_pass = old.stored_admin_pass || "";
      if (b.admin_clear === true) admin_pass = "";
      else {
        const raw = String(b.admin_pass || "");
        if (raw) {
          if (raw.length < 6) return json({ error: "管理口令至少 6 位" }, 400);
          if (raw === dav_pass) return json({ error: "管理口令不能和 WebDAV 密码相同(那样等于没分开)" }, 400);
          admin_pass = raw;
        }
      }
      await saveConfig(env, { auth, account, dav_user, dav_pass, admin_pass });
      globalThis.__authCheck = null;
      return json({ ok: true });
    });
  }
  return text("405", 405);
}

async function handleAdminUi(request, env, url) {
  if (request.method !== "GET") return text("405", 405);
  // 管理页会显示 WebDAV 密码、且能改目录, 所以走管理口令, 不是 WebDAV 密码
  if (!(await checkAdminAuth(request, env))) return unauthorized(REALM_ADMIN);
  let info = { mounts: 0, generated: null };
  let lines = "";
  try {
    const c = await getCatalog(env);
    info = { mounts: Object.keys(c.mounts || {}).length, generated: c.generated };
    // 回填现有目录: 不然用户想改一条就得手贴全量, 只贴一部分保存还会静默清空其余挂载
    lines = Object.entries(c.mounts || {}).map(([p, l]) => `${p} | ${(l && l.id) || ""}`).join("\n");
  } catch (e) {
    if (e instanceof CatalogCorrupt) {
      if (url.searchParams.get("recover") !== "1") {
        const response = page("目录数据损坏", '<h1>目录数据损坏</h1><p>已停止普通编辑，避免误覆盖。请先备份 Cloudflare KV 中的 catalog，再使用完整分享列表重建目录。</p><p><a href="/admin?recover=1">进入目录重建</a>。重建会替换原目录，请准备完整备份；自动同步启用时，也请核对仓库中的完整链接文档。</p>');
        return new Response(response.body, { status: 503, headers: response.headers });
      }
      info.damaged = true;
    } else if (!(e instanceof CatalogMissing)) {
      console.log("管理页读取目录失败");
      const response = page("目录读取失败", '<h1>目录读取失败</h1><p>现有目录暂时无法读取，已停止编辑以保护原有内容。请稍后<a href="/admin">刷新重试</a>。</p>');
      return new Response(response.body, { status: 503, headers: response.headers });
    }
  }
  const cfg = await getConfig(env);
  const adminSet = !!cfg.admin_pass;
  let checkLog = [];
  try { checkLog = JSON.parse(await env.CACHE.get("check_log")) || []; } catch {}
  const notice = info.damaged ? '<p class="hint err">正在重建损坏的目录：下方为空白重建框，请粘贴完整备份后保存，不要只填写部分条目。</p>' : "";
  return page("管理页", notice + ADMIN_FORM(url.origin, info, cfg.dav_user || "-", cfg.dav_pass || "-", lines, adminSet, checkLog));
}

async function handleCatalogLines(request, env) {
  if (request.method !== "POST") return text("405", 405);
  // 认证已由 handleApi 按"写操作"用管理口令完成, 这里不再重复认证
  // (重复认证会让一次失败被防爆破计两次)
  let b;
  try { b = await readJson(request); } catch (e) { if (e.status) throw e; return json({ error: "bad json" }, 400); }
  if (!b || typeof b.lines !== "string") return json({ error: "lines 必须是文本" }, 400);
  const mounts = Object.create(null);
  const merged = [];
  for (const [index, line] of b.lines.split("\n").entries()) {
    if (!line.trim()) continue;
    const invalid = reason => json({ error: `第 ${index + 1} 行: ${reason}，未保存目录` }, 400);
    const segs = line.split("|");
    if (segs.length < 2) return invalid("缺少分隔符 |，格式为 路径 | 分享链接或ID");
    const path = segs[0].trim().replace(/^\/+|\/+$/g, "");
    const link = segs.slice(1).join("|").trim();
    if (!path || !link) return invalid("路径和分享链接不能为空");
    const ids = parseLinkEntriesInWorker(link);
    if (!ids.length) return invalid("没有有效的分享链接");
    const lineError = catalogError({ [path]: { id: ids.join(",") } });
    if (lineError) return invalid(lineError);
    if (mounts[path]) {
      // 同一路径写了两行: 合并 id, 并允许后一行更新提取码
      const currentList = mounts[path].id.split(",").filter(Boolean);
      const idMap = new Map();
      for (const item of currentList) {
        const [sid] = item.split("#");
        idMap.set(sid, item);
      }
      for (const item of ids) {
        const [sid, pwd] = item.split("#");
        if (!idMap.has(sid) || pwd) {
          idMap.set(sid, item);
        }
      }
      mounts[path].id = Array.from(idMap.values()).join(",");
      merged.push(path);
      continue;
    }
    mounts[path] = { id: ids.join(",") };
  }
  if (!Object.keys(mounts).length) return json({ error: "没有解析到有效条目, 格式: 路径 | 链接" }, 400);
  const err = catalogError(mounts);
  if (err) return json({ error: err }, 400);
  // 与 clean_links.py 对齐: 带 +08:00 偏移, 别用 toISOString().slice(0,19)(那会丢掉 Z 变裸时间)
  const generated = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, "+08:00");
  const catalog = { version: 1, generated: generated, mounts: mounts };
  await saveCatalog(env, catalog);
  const uniqMerged = [...new Set(merged)];
  return json({ ok: true, mounts: Object.keys(mounts).length, merged: uniqMerged.length ? uniqMerged : undefined });
}

// 定时预热: 每次处理一批挂载根目录, 让"点进文件夹"永远是热路径
async function warmMounts(env, ctx) {
  const cat = await getCatalog(env);
  const keys = Object.keys(cat.mounts || {});
  if (!keys.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const stored = await env.CACHE.get("warm_state");
  const state = stored ? JSON.parse(stored) : {};
  const dailyUsed = state.day === day ? Number(state.used || 0) : 0;
  if (dailyUsed >= WARM_DAILY_CAP) return;
  let idx = Number(state.idx || 0);
  if (!Number.isFinite(idx) || idx < 0 || idx >= keys.length) idx = 0;
  const budget = newBudget(Math.min(WARM_CALL_BUDGET, WARM_DAILY_CAP - dailyUsed));
  let n = 0;
  for (; idx < keys.length && n < WARM_BATCH; idx++) {
    const members = parseMembers(cat.mounts[keys[idx]]);
    if (!members.length) continue;   // 无效挂载不占批次名额, 留给下一个
    n++;
    // 预算透传给 listAll, 翻页过程中就会停(不会先打完 100 次再检查)
    try { await listMountRoot(env, members, ctx, { fillOnly: true, budget }); } catch {}
    if (budgetExhausted(budget)) { idx++; break; }
  }
  const nextIdx = idx >= keys.length ? 0 : idx;
  // 游标与每日用量合成一个小键; 缓存全命中且游标不变时不写入。
  if (budget.used || nextIdx !== Number(state.idx || 0)) {
    await env.CACHE.put("warm_state", JSON.stringify({ day, idx: nextIdx, used: dailyUsed + budget.used }));
  }
}

// ================= 死链体检 =================

// 探测一个挂载成员(现拉根目录, 不走缓存)。六种结果:
//   ok      能列出且有内容
//   empty   能列出但里面什么都没有
//   dead    139 明确报"分享不存在/被取消"。要连错两次才算, 免得偶发错误误删
//   structure 响应结构异常, 保留并提示人工核对, 不计入临时未确认数
//   unknown 风控 / 网络 / 其他业务错误, 一律保留不删并计入未确认数
//   deferred 预算用尽, 从本成员续查
//
// 只认 DEAD_RC 这一个码当死链, 是照兄弟项目拿 1552 个真实分享验证过的结论:
// 只有它确定代表"外链不存在/被分享者取消"。其他非零码可能只是临时故障或需要人工判断,
// 误删的代价远大于漏删, 所以一律保留, 只在 flagged 里列出来给人看。
const DEAD_RC = "200000727";
async function probeMember(env, member, budget) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 判断分享是否存在/为空只需要第一页, 大目录也能在一轮预算内完成探测。
      const r = await listAll(env, member, "root", budget, true);
      return (!r.folders.length && !r.files.length) ? { status: "empty" } : { status: "ok" };
    } catch (e) {
      const rc = String(e?.rc ?? "ERR");
      const msg = String(e?.message || e).slice(0, 120);
      if (rc === "BUDGET") return { status: "deferred", rc, msg };
      if (rc === "BAD_RESPONSE") return { status: "structure", rc, msg };
      if (rc !== DEAD_RC) return { status: "unknown", rc, msg };
      last = { rc, msg };
    }
  }
  return { status: "dead", rc: last?.rc || "?", msg: last?.msg || "" };
}

// 绕过 60 秒内存缓存, 读取 KV 当前可见的目录版本; KV 跨节点仍为最终一致。
async function readCatalogFresh(env) {
  const kv = await env.CACHE.get("catalog");
  if (kv) {
    return parseStoredCatalog(kv);
  }
  return null;
}

// 串行化当前 isolate 内的目录写入。KV 跨节点仍是最终一致, 不提供全局事务。
async function withCatalogWrite(update) {
  const pending = (globalThis.__catalogWrite || Promise.resolve()).catch(() => {}).then(update);
  globalThis.__catalogWrite = pending;
  try { return await pending; }
  finally { if (globalThis.__catalogWrite === pending) globalThis.__catalogWrite = null; }
}

async function saveCatalog(env, catalog) {
  return withCatalogWrite(async () => {
    // 网页手动编辑保留最近成功同步的源指纹, 避免下一次 Actions 覆盖手工修改。
    if (catalog.source_hash === undefined) {
      try {
        const current = await readCatalogFresh(env);
        if (current?.source_hash) catalog = { ...catalog, source_hash: current.source_hash };
      } catch (e) {
        if (!(e instanceof CatalogCorrupt)) throw e;
        console.log("原目录数据损坏，使用管理员提交的完整目录重建");
      }
    }
    await env.CACHE.put("catalog", JSON.stringify(catalog));
    globalThis.__cat = { data: catalog, ts: Date.now() };
  });
}

// 体检并清理: 从 from 指定的那个挂载开始, 处理最多 batch 个, 失效/空白的成员直接从 catalog 移除。
// 一个挂载绑多条分享时只移除挂掉的那几条, 全挂才移除整个挂载。
// 游标包含路径和下一个成员, 预算耗尽也不会漏掉同一挂载后面的分享。
async function pruneCatalog(env, from, batch) {
  const cat = await getCatalog(env);
  const mounts = cat.mounts || {};
  const keys = Object.keys(mounts);
  if (!keys.length) return { total: 0, remaining: 0, checked: 0, nextFrom: "", done: true, removed: [], flagged: [], unverified: 0 };
  let i = 0;
  let memberStart = 0;
  if (from) {
    let path = from, member = null;
    if (!keys.includes(from) && from.startsWith("@check:")) {
      try { [path, member] = JSON.parse(from.slice(7)); } catch {}
    }
    const at = keys.indexOf(path);
    if (at >= 0) {
      i = at;
      if (member) memberStart = Math.max(0, parseMembers(mounts[path]).findIndex(m => m.id === member.id && m.pwd === member.pwd));
    }
  }
  const budget = newBudget(CHECK_CALL_BUDGET);
  const next = { ...mounts };
  let removed = [];
  let logWarning = false;
  const flagged = [];
  let unverified = 0;
  let n = 0;
  let resume = "";
  while (i < keys.length && n < batch) {
    if (budgetExhausted(budget)) break;   // 预算用尽, 剩下的下一轮再查
    const path = keys[i];
    const members = parseMembers(mounts[path]);
    if (!members.length) { delete next[path]; removed.push({ path, reason: "挂载为空" }); n++; i++; continue; }
    const dropped = new Set(), why = [];
    for (let mi = memberStart; mi < members.length; mi++) {
      const m = members[mi];
      const r = await probeMember(env, m, budget);
      if (r.status === "deferred") {
        resume = "@check:" + JSON.stringify([path, m]);
        break;
      }
      if (r.status === "structure") {
        flagged.push({ path, kind: "structure", reason: m.id + ": BAD_RESPONSE（响应结构异常，需人工核对）" });
      } else if (r.status === "unknown") {
        unverified++;
        // 风控/网络/预算属于常态, 不进报告; 其他业务码列出来让人自己判断
        if (r.rc && r.rc !== "9530" && r.rc !== "ERR" && r.rc !== "BUDGET") flagged.push({ path, reason: m.id + ": " + r.rc });
      } else if (r.status !== "ok") {
        dropped.add(mi);
        why.push(m.id + ": " + (r.status === "empty" ? "空分享" : (r.rc || "失效")));
      }
    }
    const kept = members.filter((_, mi) => !dropped.has(mi));
    // 记下删除前的原始 id, 万一是误删还能照着加回来
    if (!kept.length) { delete next[path]; removed.push({ path, reason: why.join("; ") || "全部失效", id: mounts[path].id }); }
    else if (kept.length < members.length) {
      next[path] = { ...mounts[path], id: kept.map(m => (m.pwd ? m.id + "#" + m.pwd : m.id)).join(",") };
      removed.push({ path, reason: "部分成员失效: " + why.join("; "), id: mounts[path].id });
    }
    if (resume) break;
    memberStart = 0;
    n++; i++;
  }
  const done = i >= keys.length;
  if (removed.length) {
    removed = await withCatalogWrite(async () => {
      const latestCat = (await readCatalogFresh(env)) || cat;
      const latestMounts = { ...(latestCat.mounts || {}) };
      const applied = [];
      for (const r of removed) {
        // 同一路径已被管理员替换/编辑/删除时, 本轮探测不再适用。
        if (JSON.stringify(latestMounts[r.path]) !== JSON.stringify(mounts[r.path])) continue;
        if (next[r.path]) latestMounts[r.path] = next[r.path];
        else delete latestMounts[r.path];
        applied.push(r);
      }
      if (!applied.length) return [];
      const generated = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, "+08:00");
      const updated = { ...latestCat, generated, mounts: latestMounts };
      await env.CACHE.put("catalog", JSON.stringify(updated));
      globalThis.__cat = { data: updated, ts: Date.now() };
      // 目录已提交, 附属记录失败不能把成功清理报成失败。读不到旧记录时也不覆盖它。
      try {
        let log = JSON.parse(await env.CACHE.get("check_log")) || [];
        if (!Array.isArray(log)) throw new Error("清理记录格式不合法");
        log = applied.map(r => ({ path: r.path, reason: r.reason, id: r.id || "", t: Date.now() })).concat(log).slice(0, 30);
        await env.CACHE.put("check_log", JSON.stringify(log), { expirationTtl: 30 * 86400 });
      } catch {
        logWarning = true;
        console.log("目录清理已完成，但清理记录未保存");
      }
      return applied;
    });
  }
  // 下一轮从 keys[i] 接着查。keys[i] 这一项一定还在(只删过 i 之前的), 所以游标不会丢。
  return { total: keys.length, remaining: keys.length - i, checked: n, nextFrom: done ? "" : (resume || keys[i]), done, removed, flagged, unverified, logWarning };
}

// 入口
// 注: /admin 与 /setup 在 fetch 里已提前分流, 不放进这个集合
const API_PATHS = new Set(["/health", "/tree", "/admin/catalog", "/admin/catalog-lines", "/admin/check", "/admin/sync-state", "/probe"]);

function writeRequestError(request, url) {
  if (request.method !== "POST" || !(url.pathname === "/setup" || url.pathname.startsWith("/admin/"))) return null;
  const origin = request.headers.get("Origin");
  if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return json({ error: "不接受跨站管理请求" }, 403);
  }
  const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return json({ error: "管理请求需要 application/json" }, 415);
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      const invalidWrite = writeRequestError(request, url);
      if (invalidWrite) return invalidWrite;
      ctx = { budget: newBudget(REQUEST_CALL_BUDGET), waitUntil: ctx?.waitUntil?.bind(ctx) };
      if (url.pathname === "/" && request.method === "GET" && !(await isConfigured(env))) {
        return new Response(null, { status: 302, headers: { Location: "/setup", "Cache-Control": "no-store" } });
      }
      // 必须 await: 不 await 的话处理器异步抛错会变成 rejected Promise,
      // 这个 try/catch 根本接不住, 客户端拿到的是 500 而不是下面的 JSON
      if (url.pathname === "/setup") return await handleSetup(request, env, url);
      if (url.pathname === "/admin") return await handleAdminUi(request, env, url);
      if (API_PATHS.has(url.pathname) || url.pathname === "/link") {
        return await handleApi(request, env, url, ctx);
      }
      return await handleDav(request, env, url, ctx);
    } catch (e) {
      if (e instanceof ConfigUnavailable && request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
        return new Response(null, { status: 302, headers: { Location: "/setup", "Cache-Control": "no-store" } });
      }
      if (e.status === 413) return json({ error: e.message }, 413);
      return json({ error: String(e).slice(0, 300), rc: e.rc || null }, 502);
    }
  },
  async scheduled(event, env, ctx) {
    // 定时任务只负责预热缓存。死链体检不在这里做:
    // 用 GitHub Actions 的由 workflow 每天调 /admin/check; 只用管理页的手动点按钮。
    try { await warmMounts(env, ctx); } catch (e) { console.log("warm 失败:", String(e).slice(0, 150)); }
  },
};
