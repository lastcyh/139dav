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
const CACHE_V = "v2";        // 目录缓存键版本; 列目录结构变更时递增, 让旧缓存立即失效
const REALM = "139dav";      // 读操作(WebDAV / 直链)的 realm; 同一页调到的接口必须同 realm, 否则浏览器按 realm 分开缓存凭据
const REALM_ADMIN = "139dav-admin"; // 管理写操作的 realm; 与读分开, 这样"只给播放权限"不会连管理权一起给出去
const WARM_BATCH = 8;        // 每次定时预热处理的挂载数(只补缺; 免费版单次请求 50 子请求上限, 不宜调大)
const WARM_CALL_BUDGET = 25; // 预热时 139 API 调用预算(免费版单次请求 50 子请求上限)
const WARM_DAILY_CAP = 2000; // 每日预热调用上限(保护账号, 避免触发风控)
const CHECK_BATCH = 6;        // 每次死链体检处理的挂载数(体检由管理页按钮或 GitHub Actions 触发)
const CHECK_CALL_BUDGET = 20; // 每次体检的 139 调用预算(免费版单次请求 50 子请求上限)

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

async function encryptPayload(obj) {
  const plain = new TextEncoder().encode(sortedJson(obj));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", AES_KEY, "AES-CBC", false, ["encrypt"]);
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
  const key = await crypto.subtle.importKey("raw", AES_KEY, "AES-CBC", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  return JSON.parse(new TextDecoder().decode(pt));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 运行配置: KV "config" (由 /setup 向导写入) 优先, env 变量兜底 ----
async function getConfig(env) {
  if (globalThis.__cfg && Date.now() - globalThis.__cfg.ts < 60000) return globalThis.__cfg.v;
  let v = {};
  try {
    const kv = await env.CACHE.get("config");
    if (kv) v = JSON.parse(kv) || {};
  } catch {}
  v.account = v.account || env.ACCOUNT || "";
  // env.AUTH 允许带 "Basic " 前缀(配置向导会自动去掉, 环境变量路径这里统一处理)
  v.auth = String(v.auth || env.AUTH || "").trim().replace(/^Basic\s+/i, "");
  v.dav_user = v.dav_user || env.DAV_USER || "";
  v.dav_pass = v.dav_pass || env.DAV_PASS || "";
  // 管理口令(可选): 设了之后, 改目录/改配置等写操作要用它, 而不是 WebDAV 密码。
  // 留空 = 沿用 WebDAV 密码(向后兼容)。env.ADMIN_PASS 可作为忘记口令时的兜底。
  v.admin_pass = v.admin_pass || env.ADMIN_PASS || "";
  globalThis.__cfg = { v, ts: Date.now() };
  return v;
}
async function isConfigured(env) {
  const c = await getConfig(env);
  return !!(c.auth && c.account && c.dav_user && c.dav_pass);
}

function parseMembers(leaf) {
  return String(leaf.id || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("#");
    return i >= 0 ? { id: s.slice(0, i), pwd: s.slice(i + 1) } : { id: s, pwd: "" };
  });
}

class Err139 extends Error {
  constructor(rc, desc) { super(`139 接口错误 ${rc}: ${desc || ""}`); this.rc = rc; }
}

async function call139(env, url, body) {
  // 9530 = 个别出口 IP 被 139 风控, 换个出口重试即可; 其他错误码直接抛
  let last;
  for (let i = 0; i < 3; i++) {
    // 按"实际发出的网络请求"计数(重试也算), 预热预算才是硬上限
    globalThis.__callCount = (globalThis.__callCount || 0) + 1;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { ...HEADERS, Authorization: "Basic " + (await getAuth(env)) },
        body: await encryptPayload(body),
      });
      const b = await decryptPayload(await r.text());
      const rc = String(b?.resultCode ?? b?.code ?? "");
      if (rc === "0") return b;
      last = { rc, desc: b?.desc || b?.message || "" };
      if (rc !== "9530") break;
    } catch (e) {
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
    console.log("无法解析令牌过期时间, 自动续期已停用(令牌格式可能变了):", tok.slice(0, 24));
  } catch (e) {
    console.log("Authorization 不是合法 base64, 自动续期已停用:", String(e).slice(0, 80));
  }
  return Infinity;
}

async function getAuth(env) {
  // 内存缓存 60 秒: 否则每次调 139 都要读 2 次 KV(auth + auth_check),
  // 分页后一次列目录会放大成十几次无谓的 KV 读
  if (globalThis.__auth && Date.now() - globalThis.__auth.ts < 60000) return globalThis.__auth.v;
  const kvAuth = await env.CACHE.get("auth");
  let auth = kvAuth || (await getConfig(env)).auth;
  const now = Date.now();
  const memo = () => { globalThis.__auth = { v: auth, ts: Date.now() }; return auth; };
  const lastCheck = Number((await env.CACHE.get("auth_check")) || 0);
  if (now - lastCheck < 3600e3) return memo();          // 每小时检查一次
  await env.CACHE.put("auth_check", String(now));
  const remain = authRemainMs(auth);
  if (remain > 15 * 86400e3 || remain <= 0) return memo(); // 剩余>15天才续, 过期了续不了
  try {
    const dec = atob(auth);
    const account = dec.split(":")[1];
    const tok = dec.split(":")[2];
    const r = await fetch(API.REFRESH, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: `<root><token>${tok}</token><account>${account}</account><clienttype>656</clienttype></root>`,
    });
    const xml = await r.text();
    const ret = (xml.match(/<return>([^<]*)<\/return>/i) || [])[1];
    const newTok = (xml.match(/<token>([^<]*)<\/token>/i) || [])[1];
    if (ret === "0" && newTok) {
      auth = btoa(`pc:${account}:${newTok}`);
      await env.CACHE.put("auth", auth);
      console.log("139 token 已自动续期");
    }
  } catch (e) {
    console.log("token 刷新失败(继续用旧token):", String(e).slice(0, 100));
  }
  return memo();
}

// ================= catalog 与目录树 =================

async function getCatalog(env) {
  const now = Date.now();
  if (globalThis.__cat && now - globalThis.__cat.ts < CAT_TTL * 1000) return globalThis.__cat.data;
  let data = null;
  try {
    const kv = await env.CACHE.get("catalog");
    if (kv) data = JSON.parse(kv);
  } catch {}
  if (!data && env.CATALOG_URL) {
    const r = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 60 } });
    if (r.ok) data = await r.json();
  }
  if (!data || !data.mounts) throw new Error("catalog 不可用: 请先 POST /admin/catalog 或配置 CATALOG_URL");
  globalThis.__cat = { data, ts: now };
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

// 校验目录结构。返回错误说明, 没问题返回 null。
// 关键点: 路径不能互为前缀 —— catalog 里同时有 A 和 A/B 时, 走到 A 就被当成分享根,
// A/B 永远访问不到(而且不报错, 很难查)。宁可导入时直接拒绝。
function catalogError(mounts) {
  if (!mounts || typeof mounts !== "object" || Array.isArray(mounts)) return "catalog.mounts 必须是对象";
  const paths = Object.keys(mounts);
  if (!paths.length) return "catalog.mounts 不能为空";
  for (const p of paths) {
    if (!p.trim() || p.startsWith("/") || p.endsWith("/")) return `路径格式不对: ${p}`;
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

function memoSet(key, data, ts) {
  const m = (globalThis.__dirs ||= new Map());
  m.delete(key);                                   // 重新插入到末尾, 顺带实现 LRU
  // ts 用数据的原始时间(KV 里存的那个), 不能一律用"现在",
  // 否则从 KV 捞出来的旧数据会被当成刚更新过, 新鲜期与保留期都算错
  m.set(key, { data, ts: ts || Date.now() });
  while (m.size > MEMO_MAX) m.delete(m.keys().next().value);
}

// 目录列表缓存: 新鲜期内直接返回; 过了新鲜期先返回旧数据 + 后台静默刷新 (SWR);
// 最长保留 7 天, 超龄才同步重新拉取
async function cachedListing(env, key, recompute, ctx, opts = {}) {
  const now = Date.now();
  // 同一目录的并发拉取合并成一次(冷加载和后台刷新共用), 避免重复打 139。
  // 写回时内存 memo 和 KV 都要更新: 只写 memo 的话 KV 里的 t 永远不变,
  // 冷启动会一直读到旧数据, 而且每个请求都会再触发一次全量重拉。
  const inflight = (globalThis.__inflight ||= new Map());
  const store = () => {
    if (inflight.has(key)) return inflight.get(key);
    const p = recompute().then(async d => {
      const t = Date.now();
      memoSet(key, d, t);
      await env.CACHE.put(key, JSON.stringify({ d, t }), { expirationTtl: DIR_STORE });
      return d;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  const refresh = () => store().catch(() => {});
  const memo = globalThis.__dirs?.get(key);
  if (memo && now - memo.ts < DIR_STORE * 1000) {
    if (!opts.fillOnly && now - memo.ts > DIR_FRESH * 1000 && ctx?.waitUntil) ctx.waitUntil(refresh());
    return memo.data;
  }
  const kv = await env.CACHE.get(key);
  if (kv) {
    try {
      const j = JSON.parse(kv);
      if (j && j.d && now - (j.t || 0) < DIR_STORE * 1000) {
        memoSet(key, j.d, j.t);   // 保留原始时间, 别让旧数据"变新鲜"
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
  for (const arr of [folders, files]) for (const e of arr) {
    let name = e.name, n = 2;
    while (used.has(name)) name = `${e.name} (${n++})`;
    used.add(name);
    e.name = name;
  }
}

// 列一个分享目录的全部内容。
// 139 getOutLinkInfoV6 不传分页参数时只返回前 100 项(按最近添加排序),
// 因此必须用 bNum/eNum 逐页拉取(单页上限 200), 并用 caSrt/coSrt/srtDr 固定排序保证翻页稳定。
// budget: 预热时的调用预算; 用满就抛错(不把残缺结果当完整目录缓存)
async function listAll(env, member, pcaid, budget) {
  const account = (await getConfig(env)).account;
  const folders = [];
  const files = [];
  const seen = new Set();
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    if (budget && (globalThis.__callCount || 0) >= budget) {
      throw new Err139("BUDGET", "预热调用预算已用完, 本轮跳过该挂载");
    }
    const bNum = page * LIST_PAGE + 1;
    const body = await call139(env, API.LIST, {
      getOutLinkInfoReq: {
        account, linkID: member.id, passwd: member.pwd, pCaID: pcaid,
        caSrt: 1, coSrt: 1, srtDr: 0,          // 固定排序, 避免翻页时顺序漂移导致漏项/重复
        bNum, eNum: bNum + LIST_PAGE - 1,      // 页码区间, 闭区间 1-based
      },
    });
    const d = body?.data || {};
    const ca = d.caLst || [];
    const co = d.coLst || [];
    let fresh = 0;
    for (const f of ca) {
      if (!f.caID || seen.has(f.caID)) continue;
      seen.add(f.caID); fresh++;
      folders.push({ kind: "dir", id: f.caID, name: f.caName, mtime: parseMtime(f.udTime) });
    }
    for (const f of co) {
      if (!f.coID || seen.has(f.coID)) continue;
      seen.add(f.coID); fresh++;
      files.push({ kind: "file", id: f.coID, name: f.coName, size: Number(f.coSize || 0), mtime: parseMtime(f.udTime) });
    }
    // 本页不足一页(或没有新条目) => 已到最后一页
    if (ca.length + co.length < LIST_PAGE || fresh === 0) break;
  }
  uniqueNames(folders, files);
  return { folders, files };
}

async function listOne(env, member, pcaid, ctx, opts = {}) {
  return cachedListing(env, `lst:${CACHE_V}:${member.id}:${member.pwd}:${pcaid}`,
    async () => listAll(env, member, pcaid, opts.budget), ctx, opts);
}

// 列单个成员的"有效根": 若根目录只有一个文件夹(分享者套壳)则自动下沉, 最多 3 层。
// 注意: 这里现拉根目录(不经 cachedListing)。因为外层 listMountRoot 已经缓存了"下沉后的结果",
// 再单独缓存一份原始根目录是多余的(单成员挂载会存成两个键), 而且外层刷新时可能读到
// 内层还没刷新的旧值, 让内容更新要等两个刷新周期才可见。下沉用到的子目录仍走 listOne 缓存。
async function listMemberRoot(env, member, ctx, opts = {}) {
  let cur = await listAll(env, member, "root", opts.budget);
  for (let depth = 0; cur.folders.length === 1 && cur.files.length === 0 && depth < 3; depth++) {
    const inner = await listOne(env, member, cur.folders[0].id, ctx, opts);
    if (inner.folders.length === 0 && inner.files.length === 0) break; // 空壳不穿
    cur = inner;
  }
  return cur;
}

async function listMountRoot(env, members, ctx, opts = {}) {
  const key = `lst:${CACHE_V}:${members.map(m => `${m.id}|${m.pwd}`).join(",")}:@root`;
  return cachedListing(env, key, async () => {
    const merged = { folders: [], files: [] };
    const seen = new Set();
    let okCount = 0, firstErr = null;
    for (let mi = 0; mi < members.length; mi++) {
      let one;
      try {
        one = await listMemberRoot(env, members[mi], ctx, opts);
      } catch (e) {
        // 单条分享失效(过期/缺提取码)不该拖垮整个目录, 跳过它继续
        if (!firstErr) firstErr = e;
        console.log("挂载成员拉取失败, 已跳过:", String(e).slice(0, 120));
        continue;
      }
      okCount++;
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
    uniqueNames(merged.folders, merged.files);  // 多分享合并后也保证名字唯一
    return merged;
  }, ctx, opts);
}

async function getDlUrl(env, members, entry) {
  const member = members[entry.memberIdx || 0];
  const account = (await getConfig(env)).account;
  // 缓存键带上账号和提取码指纹: 否则换 139 账号、或同一分享改了提取码后,
  // 10 分钟内还会复用旧直链
  const pw = member.pwd || "";
  let pwTag = 0;
  for (let i = 0; i < pw.length; i++) pwTag = (pwTag * 31 + pw.charCodeAt(i)) | 0;
  const key = `dl:${account}:${member.id}:${pwTag}:${entry.id}`;
  const kv = await env.CACHE.get(key);
  if (kv) { try { const j = JSON.parse(kv); if (j.url) return j.url; } catch {} }
  const body = await call139(env, API.DL, {
    dlFromOutLinkReqV3: {
      account, linkID: member.id, passwd: member.pwd,
      coIDLst: { item: [entry.id] },
    },
  });
  const d = body?.data || {};
  const url = d.extInfo?.cdnDownloadURL || d.redrUrl || d.redrURL || d.downloadUrl || d.downloadURL;
  if (!url) throw new Err139("NOLINK", "未返回下载直链");
  await env.CACHE.put(key, JSON.stringify({ url }), { expirationTtl: DL_TTL });
  return url;
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
    : await listOne(env, resolved.members[resolved.entry.memberIdx || 0], resolved.entry.id, ctx);
  return lst.folders.concat(lst.files);
}

// ================= WebDAV =================

const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hrefOf = segs => "/" + segs.map(s => encodeURIComponent(s)).join("/");

function davResponse(href, e, isRoot) {
  const isDir = e.kind === "dir" || isRoot;
  const mtime = e.mtime ? new Date(e.mtime) : new Date(0);
  const mime = isDir ? "httpd/unix-directory" : (MIME[e.name.split(".").pop().toLowerCase()] || "application/octet-stream");
  return `<D:response>
<D:href>${xmlEsc(href)}</D:href>
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
const naturalCmp = (a, b) => a.name.localeCompare(b.name, "zh", { numeric: true, sensitivity: "base" });

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
    try { resolved = await resolvePath(env, buildTree(cat), segs, ctx); }
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
    try { resolved = await resolvePath(env, buildTree(await getCatalog(env)), segs, ctx); }
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
    const target = await getDlUrl(env, resolved.members, e);
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

// 认证 + 防爆破: 同一 IP 连续失败 N 次锁定 15 分钟(内存级, 跨 isolate 不共享), 失败加随机延迟。
// mode="read"  用 WebDAV 账号密码(播放器/直链等只读场景)
// mode="admin" 用管理口令 admin_pass; 没设就退回 WebDAV 密码(向后兼容)
async function authCheck(request, env, mode) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
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
  if (!e) { e = { n: 0, t: now }; bf.set(ip, e); }
  if (e.locked && now < e.locked) return false;                    // 锁定中, 直接拒
  if (e.locked) { e.locked = 0; e.n = 0; e.t = now; }              // 锁已过期, 重置计数
  if (now - (e.t || 0) > BF_WINDOW) { e.n = 0; e.t = now; }        // 计数窗口过期
  const c = await getConfig(env);
  const wantUser = c.dav_user;
  const wantPass = mode === "admin" ? (c.admin_pass || c.dav_pass) : c.dav_pass;
  if (!wantUser || !wantPass) return false;
  const h = request.headers.get("Authorization") || "";
  let ok = false;
  if (h.startsWith("Basic ")) {
    let bin = null;
    try { bin = atob(h.slice(5)); } catch {}
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
    return json({ ok: true, configured: await isConfigured(env), colo: request.cf?.colo });
  }

  // 写操作(导入/覆盖目录)走管理口令; 只读接口(直链/树/探测)走 WebDAV 口令。
  // 只读场景用 WebDAV 密码, 写操作要用管理口令, 两者分开。
  const isWrite = path === "/admin/catalog" || path === "/admin/catalog-lines" || path === "/admin/check";
  const authed = isWrite ? await checkAdminAuth(request, env) : await checkAuth(request, env);
  if (!authed) return unauthorized(isWrite ? REALM_ADMIN : REALM);

  if (path === "/link") {
    const p = url.searchParams.get("path") || "";
    // searchParams 已经把 %XX 解过一次了, 这里别再 decodeURIComponent 一次,
    // 否则文件名里含字面 "%" (如 "100%.mp4") 会被二次解码解错
    const segs = p.split("/").filter(Boolean);
    const resolved = await resolvePath(env, buildTree(await getCatalog(env)), segs, ctx);
    if (!resolved) return text("404 Not Found: " + p, 404);
    if (resolved.kind !== "file") return text("不是文件: " + p, 400);
    const target = await getDlUrl(env, resolved.members, resolved.entry);
    if (url.searchParams.get("format") === "json") return json({ path: p, url: target });
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  }

  if (path === "/admin/catalog-lines") {
    return handleCatalogLines(request, env);
  }

  if (path === "/tree") {
    const cat = await getCatalog(env);
    const summary = {};
    for (const p of Object.keys(cat.mounts)) {
      const c = p.split("/")[0];
      summary[c] = (summary[c] || 0) + 1;
    }
    return json({ generated: cat.generated, top: summary, total: Object.keys(cat.mounts).length });
  }

  if (path === "/admin/catalog" && request.method === "POST") {
    let data;
    try { data = await request.json(); } catch { return text("bad json", 400); }
    const err = catalogError(data && data.mounts);
    if (err) return text(err, 400);
    await env.CACHE.put("catalog", JSON.stringify(data));
    globalThis.__cat = null;
    return json({ ok: true, mounts: Object.keys(data.mounts).length, generated: data.generated || null });
  }

  if (path === "/admin/check" && request.method === "POST") {
    // 死链体检: 前端拿着 nextFrom 反复调用, 直到 done 为止
    let b = {};
    try { b = await request.json(); } catch {}
    const from = (b && typeof b.from === "string") ? b.from : "";
    const r = await pruneCatalog(env, from, CHECK_BATCH);
    return json({ ok: true, total: r.total, remaining: r.remaining, checked: r.checked, nextFrom: r.nextFrom, done: r.done, removed: r.removed });
  }

  if (path === "/probe") {
    const parsed = parseLinkEntriesInWorker(url.searchParams.get("link") || "")[0] || "";
    let lid = parsed, pwd = "";
    if (lid.includes("#")) [lid, pwd] = lid.split("#", 2);
    if (!lid) return json({ error: "缺少分享链接" }, 400);
    const t0 = Date.now();
    const d = await listAll(env, { id: lid, pwd }, "root");
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
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
  const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: auth.value.trim(), account: account.value.trim(), dav_user: dav_user.value.trim(), dav_pass: dav_pass.value, admin_pass: admin_pass.value }) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { b.textContent = "完成!"; location.href = "/admin"; }
  else { b.disabled = false; b.textContent = "保存并完成部署"; alert(j.error || ("失败: HTTP " + r.status)); }
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
当前目录: <b>` + xmlEsc(String(info.mounts)) + `</b> 个挂载，generated ` + xmlEsc(info.generated || "未导入") + `<br>
最近清理: <b>` + (checkLog && checkLog.length ? checkLog.slice(0, 5).map(x => x.path).join("、") + (checkLog.length > 5 ? " 等 " + checkLog.length + " 项" : "") : "无") + `</b>
</div>
<label>分享列表。每行一条：<code>分类/标题 | 分享链接或ID#提取码</code>，链接可多个用逗号分隔。保存是整份覆盖，已自动回填现有目录。路径不能含 <code>|</code>，提取码不能含逗号/分号。</label>
<textarea id="cat" placeholder="分类/标题 | https://yun.139.com/shareweb/#/w/i/xxxxxx&#10;电影/某电影 | yyyyyyyy,zzzzzzzz#8888">` + xmlEsc(lines || "") + `</textarea>
<button id="b1">保存目录 · 整份覆盖</button>
<p class="hint" id="msg"></p>
<button id="b3">检查链接 · 清理失效和空白分享</button>
<p class="hint" id="msg3"></p>
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
  if (!confirm("保存将「全量覆盖」现有 ${info.mounts} 个挂载, 没贴回来的条目会被删除。确认继续?")) return;
  b1.disabled = true; b1.textContent = "保存中...";
  const r = await fetch("/admin/catalog-lines", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: cat.value }) });
  const j = await r.json().catch(() => ({}));
  b1.disabled = false; b1.textContent = "保存目录 · 整份覆盖";
  msg.textContent = j.ok
    ? ("已保存 " + j.mounts + " 个挂载" + (j.merged ? "；有 " + j.merged.length + " 个重复路径已自动合并：" + j.merged.join("、") : ""))
    : ("失败: " + (j.error || r.status));
  msg.className = j.ok ? "hint ok" : "hint err";
};
b3.onclick = async () => {
  if (!confirm("会逐个探测所有分享，把失效和空白的链接从目录里删掉。挂载多时要等一会儿，继续？")) return;
  b3.disabled = true;
  let from = "", removed = [], total = 0, guard = 0, done = false;
  try {
    while (!done) {
      if (++guard > 1000) break;
      const r = await fetch("/admin/check", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from }) });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { msg3.textContent = "失败: " + (j.error || r.status); msg3.className = "hint err"; return; }
      from = j.nextFrom; total = j.total; done = j.done;
      if (j.removed && j.removed.length) removed = removed.concat(j.removed);
      msg3.textContent = "体检中… 还剩 " + j.remaining + " 个，已清理 " + removed.length + " 项";
      msg3.className = "hint";
    }
    msg3.textContent = removed.length
      ? ("体检完成：共 " + total + " 个挂载，清理了 " + removed.length + " 项，稍后自动刷新")
      : ("体检完成：共 " + total + " 个挂载，没有失效或空链接");
    msg3.className = "hint ok";
    if (removed.length) setTimeout(() => location.reload(), 2000);
  } catch (e) {
    msg3.textContent = "失败: " + e;
    msg3.className = "hint err";
  } finally { b3.disabled = false; }
};
b2.onclick = async () => {
  b2.disabled = true;
  const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: auth2.value.trim(), account: account2.value.trim(), dav_user: dav_user2.value.trim(), dav_pass: dav_pass2.value, admin_pass: admin_pass2.value, admin_clear: admin_clear.checked }) });
  const j = await r.json().catch(() => ({}));
  b2.disabled = false;
  msg2.textContent = j.ok ? "已更新。管理口令变更后，刷新页面会要求重新登录" : ("失败: " + (j.error || r.status));
  msg2.className = j.ok ? "hint ok" : "hint err";
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
  const configured = await isConfigured(env);
  if (request.method === "GET") {
    // 已配置后, 打开/提交配置页属于"管理写操作", 用管理口令
    if (configured && !(await checkAdminAuth(request, env))) {
      return new Response("401 Unauthorized: 已配置, 修改请用管理口令登录", {
        status: 401, headers: { "WWW-Authenticate": `Basic realm="${REALM_ADMIN}"`, "Content-Type": "text/plain" } });
    }
    const c = configured ? await getConfig(env) : {};
    return page("初始配置", SETUP_FORM(configured ? '<p class="hint ok">已配置过, 再次提交将覆盖现有配置。</p>' : "", !!c.admin_pass));
  }
  if (request.method === "POST") {
    if (configured && !(await checkAdminAuth(request, env))) {
      return json({ error: "已配置, 修改需管理口令认证" }, 401);
    }
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let auth = String(b.auth || "").trim().replace(/^Basic\s+/i, "");
    if (!auth) return json({ error: "Authorization 不能为空" }, 400);
    let account = String(b.account || "").trim();
    let dec = "";
    try { dec = atob(auth); } catch { return json({ error: "Authorization 不是合法 base64" }, 400); }
    const parts = dec.split(":");
    if (parts.length < 3) return json({ error: "Authorization 格式不对, 应为 pc:手机号:令牌" }, 400);
    if (!account) account = parts[1] || "";
    if (!/^\d{5,15}$/.test(account)) return json({ error: "账号识别失败, 请手动填写手机号" }, 400);
    const old = await getConfig(env);
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
    let admin_pass = old.admin_pass || "";
    if (b.admin_clear === true) admin_pass = "";
    else {
      const raw = String(b.admin_pass || "");
      if (raw) {
        if (raw.length < 6) return json({ error: "管理口令至少 6 位" }, 400);
        if (raw === dav_pass) return json({ error: "管理口令不能和 WebDAV 密码相同(那样等于没分开)" }, 400);
        admin_pass = raw;
      }
    }
    await env.CACHE.put("config", JSON.stringify({ auth: auth, account: account, dav_user: dav_user, dav_pass: dav_pass, admin_pass: admin_pass }));
    // KV 里的 auth 优先级高于 config, 不覆盖的话粘贴新令牌后仍在用旧令牌
    await env.CACHE.put("auth", auth);
    await env.CACHE.put("auth_check", "0");   // 重置检查时间, 让续期逻辑重新评估新令牌
    globalThis.__cfg = null;
    globalThis.__auth = null;   // 令牌可能变了, 让 getAuth 重新读
    return json({ ok: true });
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
  } catch {}
  const cfg = await getConfig(env);
  const adminSet = !!cfg.admin_pass;
  let checkLog = [];
  try { checkLog = JSON.parse(await env.CACHE.get("check_log")) || []; } catch {}
  return page("管理页", ADMIN_FORM(url.origin, info, cfg.dav_user || "-", cfg.dav_pass || "-", lines, adminSet, checkLog));
}

async function handleCatalogLines(request, env) {
  if (request.method !== "POST") return text("405", 405);
  // 认证已由 handleApi 按"写操作"用管理口令完成, 这里不再重复认证
  // (重复认证会让一次失败被防爆破计两次)
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const mounts = {};
  const merged = [];
  for (const line of String(b.lines || "").split("\n")) {
    const segs = line.split("|");
    if (segs.length < 2) continue;
    const path = segs[0].trim().replace(/^\/+|\/+$/g, "");
    const link = segs.slice(1).join("|").trim();
    if (!path || !link) continue;
    const ids = parseLinkEntriesInWorker(link);
    if (!ids.length) continue;
    if (mounts[path]) {
      // 同一路径写了两行: 合并 id, 而不是让后一行静默覆盖前一行(前者会被无声丢掉)
      const have = new Set(mounts[path].id.split(",").map(s => s.split("#")[0]));
      const add = ids.filter(i => !have.has(i.split("#")[0]));
      if (add.length) mounts[path].id = [mounts[path].id].concat(add).join(",");
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
  await env.CACHE.put("catalog", JSON.stringify(catalog));
  globalThis.__cat = null;
  const uniqMerged = [...new Set(merged)];
  return json({ ok: true, mounts: Object.keys(mounts).length, merged: uniqMerged.length ? uniqMerged : undefined });
}

// 定时预热: 每次处理一批挂载根目录, 让"点进文件夹"永远是热路径
async function warmMounts(env, ctx) {
  const cat = await getCatalog(env);
  const keys = Object.keys(cat.mounts || {});
  if (!keys.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `warm_day:${day}`;
  if (Number(await env.CACHE.get(dayKey) || 0) >= WARM_DAILY_CAP) return; // 当日配额用尽
  let idx = Number(await env.CACHE.get("warm_idx") || 0);
  if (!Number.isFinite(idx) || idx < 0 || idx >= keys.length) idx = 0;
  // 用"增量"而不是把全局计数清零: 清零会抹掉并发用户请求的计数,
  // 预算改成 base + 上限, 判定与每日配额都用增量
  const base = globalThis.__callCount || 0;
  const budget = base + WARM_CALL_BUDGET;
  let n = 0;
  for (; idx < keys.length && n < WARM_BATCH; idx++) {
    const members = parseMembers(cat.mounts[keys[idx]]);
    if (!members.length) continue;   // 无效挂载不占批次名额, 留给下一个
    n++;
    // 预算透传给 listAll, 翻页过程中就会停(不会先打完 100 次再检查)
    try { await listMountRoot(env, members, ctx, { fillOnly: true, budget }); } catch {}
    if ((globalThis.__callCount || 0) >= budget) { idx++; break; }
  }
  await env.CACHE.put("warm_idx", String(idx >= keys.length ? 0 : idx));
  const used = (globalThis.__callCount || 0) - base;
  if (used > 0) {
    const cur = Number(await env.CACHE.get(dayKey) || 0);
    await env.CACHE.put(dayKey, String(cur + used), { expirationTtl: 172800 });
  }
}

// ================= 死链体检 =================

// 探测一个挂载成员(现拉根目录, 不走缓存)。四种结果:
//   ok      能列出且有内容
//   empty   能列出但里面什么都没有
//   dead    139 明确报错(分享被取消 / 提取码错)。要连错两次才算, 免得偶发业务错误误删
//   unknown 风控 9530 / 网络错误 / 预算用尽这类临时问题, 一律保留, 绝不当死链删
async function probeMember(env, member, budget) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await listAll(env, member, "root", budget);
      return (!r.folders.length && !r.files.length) ? { status: "empty" } : { status: "ok" };
    } catch (e) {
      const rc = String(e?.rc ?? "ERR");
      const msg = String(e?.message || e).slice(0, 120);
      if (rc === "9530" || rc === "ERR" || rc === "BUDGET") return { status: "unknown", rc, msg };
      last = { rc, msg };
    }
  }
  return { status: "dead", rc: last?.rc || "?", msg: last?.msg || "" };
}

// 体检并清理: 从 from 指定的那个挂载开始, 处理最多 batch 个, 失效/空白的成员直接从 catalog 移除。
// 一个挂载绑多条分享时只移除挂掉的那几条, 全挂才移除整个挂载。
// 游标用"路径"而不是下标 —— 清理会把后面的挂载往前挪, 用下标会跳着漏查。
async function pruneCatalog(env, from, batch) {
  const cat = await getCatalog(env);
  const mounts = cat.mounts || {};
  const keys = Object.keys(mounts);
  if (!keys.length) return { total: 0, remaining: 0, checked: 0, nextFrom: "", done: true, removed: [] };
  let i = 0;
  if (from) { const at = keys.indexOf(from); i = at >= 0 ? at : 0; }
  const budget = (globalThis.__callCount || 0) + CHECK_CALL_BUDGET;
  const next = { ...mounts };
  const removed = [];
  let n = 0;
  while (i < keys.length && n < batch) {
    if ((globalThis.__callCount || 0) >= budget) break;   // 预算用尽, 剩下的下一轮再查
    const path = keys[i];
    const members = parseMembers(mounts[path]);
    n++; i++;
    if (!members.length) { delete next[path]; removed.push({ path, reason: "挂载为空" }); continue; }
    const kept = [], why = [];
    for (const m of members) {
      const r = await probeMember(env, m, budget);
      if (r.status === "ok" || r.status === "unknown") kept.push(m);
      else why.push(m.id + ": " + (r.status === "empty" ? "空分享" : (r.rc || "失效")));
    }
    if (!kept.length) { delete next[path]; removed.push({ path, reason: why.join("; ") || "全部失效" }); }
    else if (kept.length < members.length) {
      next[path] = { id: kept.map(m => (m.pwd ? m.id + "#" + m.pwd : m.id)).join(",") };
      removed.push({ path, reason: "部分成员失效: " + why.join("; ") });
    }
  }
  const done = i >= keys.length;
  if (removed.length) {
    // generated 也跟着更新, 让客户端知道目录变过
    const generated = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/\.\d+Z$/, "+08:00");
    await env.CACHE.put("catalog", JSON.stringify({ ...cat, generated, mounts: next }));
    globalThis.__cat = null;
    let log = [];
    try { log = JSON.parse(await env.CACHE.get("check_log")) || []; } catch {}
    log = removed.map(r => ({ path: r.path, reason: r.reason, t: Date.now() })).concat(log).slice(0, 30);
    await env.CACHE.put("check_log", JSON.stringify(log), { expirationTtl: 30 * 86400 });
  }
  // 下一轮从 keys[i] 接着查。keys[i] 这一项一定还在(只删过 i 之前的), 所以游标不会丢。
  return { total: keys.length, remaining: keys.length - i, checked: n, nextFrom: done ? "" : keys[i], done, removed };
}

// 入口
// 注: /admin 与 /setup 在 fetch 里已提前分流, 不放进这个集合
const API_PATHS = new Set(["/health", "/tree", "/admin/catalog", "/admin/catalog-lines", "/admin/check", "/probe"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // 必须 await: 不 await 的话处理器异步抛错会变成 rejected Promise,
      // 这个 try/catch 根本接不住, 客户端拿到的是 500 而不是下面的 JSON
      if (url.pathname === "/setup") return await handleSetup(request, env, url);
      if (url.pathname === "/admin") return await handleAdminUi(request, env, url);
      if (API_PATHS.has(url.pathname) || url.pathname === "/link") {
        return await handleApi(request, env, url, ctx);
      }
      return await handleDav(request, env, url, ctx);
    } catch (e) {
      return json({ error: String(e).slice(0, 300), rc: e.rc || null }, 502);
    }
  },
  async scheduled(event, env, ctx) {
    // 定时任务只负责预热缓存。死链体检不在这里做:
    // 用 GitHub Actions 的由 workflow 每天调 /admin/check; 只用管理页的手动点按钮。
    try { await warmMounts(env, ctx); } catch (e) { console.log("warm 失败:", String(e).slice(0, 150)); }
  },
};
