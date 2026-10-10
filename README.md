# mcloud-dav

> 🤖 **本项目是 vibe coding 的产物。** 代码主要由 AI 生成，功能可用，但未经严格审查与充分测试，请自行评估风险后使用。

把移动云盘的分享链接整理成只读 WebDAV 媒体库，部署在 Cloudflare Workers 免费层，无需自备服务器。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastcyh/mcloud-dav)

> ⚠️ **仅限个人使用。** 地址与账号密码请勿公开分享，所有访客都会消耗你的 139 账号额度与 Cloudflare 免费配额。

## 功能特性

- **清洗**：把含 139 分享链接的 Markdown/文本放入 `data/`，脚本自动提取链接、去重，并按标题层级生成目录树
- **服务**：Worker 实现 139 分享协议，对外提供只读 WebDAV 与 302 直链接口。播放时直连移动云节点，流量不经过 Worker
- **零维护**：令牌自动续期、目录缓存与定时预热、风控自动重试、失效链接自动清理

支持 Infuse、nPlayer、Kodi、rclone 等标准 WebDAV 客户端。

## 快速开始

### 环境要求

- 一个 GitHub 账号，建议先 Fork 本仓库
- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)
- 一个可登录 [yun.139.com](https://yun.139.com) 的移动云盘账号

### 1. 部署

点击上方 **Deploy to Cloudflare** 按钮，登录并确认，Cloudflare 会自动创建 KV 存储与 Worker。已 Fork 的话，进入自己 fork 仓库的 README 点击按钮，或把按钮链接中的仓库地址替换为你的 fork。

完成后在 Cloudflare 面板中查看 Worker 地址，形如 `https://mcloud-dav.你的子域.workers.dev`。

不使用按钮时，手动部署只需三条命令：

```bash
git clone https://github.com/lastcyh/mcloud-dav && cd mcloud-dav
npx wrangler kv namespace create CACHE   # 把返回的 id 填入 wrangler.toml
npx wrangler deploy
```

### 2. 配置

访问 Worker 地址即可进入配置页，需要填写 **139 Authorization**，获取方式：

1. 浏览器登录 [yun.139.com](https://yun.139.com)
2. 按 `F12` 打开开发者工具，切换到 **网络** 标签
3. 刷新页面，在过滤框输入 `hcy/file/list`，任选一条请求
4. 在请求标头中找到 `Authorization`，复制其值，是一长串 base64 编码的令牌
5. 粘贴到配置页，手机号会自动识别，再设置 WebDAV 用户名与密码

令牌有效期约 30 天，Worker 会自动续期，无需手动处理。

配置页还有一个可选的 **管理口令**：设置后，修改目录与配置需要使用它，WebDAV 密码仅用于播放。留空则两者相同。如忘记口令，可在 Cloudflare 中添加 `ADMIN_PASS` 环境变量应急。

### 3. 添加分享

支持两种方式，二选一。

**方式 A：管理页粘贴，适合少量**

访问 `/admin` 登录后，每行填写一条：

```
分类/标题 | 分享链接
```

路径与名称可自行指定，例如：

```
电影/某电影 | https://yun.139.com/shareweb/#/w/i/xxxxxxxx
剧集/某剧 第一季 | https://caiyun.139.com/m/i?yyyyyyyy
纪录片/某系列 | id1,id2#提取码,id3
```

第三行为一个目录绑定多条分享的写法。分享 ID 是链接中 `/w/i/` 或 `/share/` 后面那一段，带提取码时写作 `ID#提取码`。

> 路径不能包含 `|`，提取码不能包含逗号与分号，它们都是解析分隔符。管理页打开时会回填现有目录，保存为**全量覆盖**，未贴回的条目将被删除。旁边的 **检查链接** 按钮会逐个探测所有分享，自动删除失效或空白的条目。

**方式 B：批量清洗，适合大量**

把含分享链接的 Markdown/文本放入 `data/`，格式参考 [示例合集](data/示例合集.md)，然后在本地执行：

```bash
python clean_links.py
python upload_catalog.py --url <Worker地址> --user <账号> --pass <密码>
```

也可交由 GitHub Actions 自动执行，见[自动清洗与体检](#自动清洗与体检)。

> ⚠️ **方式 B 会把 `data/` 中的分享链接提交进 git 仓库。** 公开仓库等于公开分享链接，任何人都能直连 139 获取内容。请使用私有仓库，或改用方式 A。

脚本会提取全部链接、去除画质与集数等噪音、按分享 ID 去重，并按文档标题层级生成目录树。文档中也可以只写裸 ID：`标题：分享ID` 或 `标题：分享ID#提取码`。

### 4. 挂载播放

**rclone：**

```
rclone config
# 类型: webdav | url: https://mcloud-dav.你的子域.workers.dev | 厂商: other | 账号密码: 第 2 步设置的
rclone ls :webdav:
```

**Infuse / nPlayer / Kodi：** 添加共享 → WebDAV → 填入地址与账号密码。账号密码可在 `/admin` 首屏查看。

**直链接口：** 供下载工具或脚本调用，302 跳转到移动云直链，加 `&format=json` 返回 JSON：

```
GET https://mcloud-dav.你的子域.workers.dev/link?path=电影/某电影/某电影.mp4
```

## 目录规则

```
/<标题层级>/
└── <标题>/
    └── 第01集.mp4 …
```

文档中的标题行即目录层级，同一行写多个链接即可把多条分享绑定到同一个挂载。列表按自然排序，`第2集` 排在 `第10集` 之前。分享根目录的套壳文件夹会自动穿透，最多三层，更深的层级需要手动进入。

## 接口

| 路由 | 说明 |
|---|---|
| `GET /health` | 状态，是否已配置 |
| `GET /link?path=<路径>&format=json` | 302 直链，`format=json` 返回 JSON |
| `GET /probe?link=<分享ID>` | 单个分享连通性探测 |
| `POST /setup` | 初始配置或修改配置 |
| `GET /admin` | 网页管理端 |
| `POST /admin/catalog-lines` | 按行覆盖目录树 |
| `POST /admin/catalog` | 直接上传 catalog.json |
| `POST /admin/check` | 死链体检，逐批探测并清理失效或空白的分享 |

WebDAV 即站点根路径，只读。**读**接口使用 WebDAV 账号密码，**写**接口使用管理口令，未设置管理口令时两者相同。

## 自动清洗与体检

可选用 GitHub Actions 自动执行。**与方式 A 二选一**：两者都是整份覆盖目录，同时使用会互相覆盖。

在 fork 仓库中把链接文档放入 `data/` 并 commit，然后到 **Settings → Secrets and variables → Actions** 添加：

| Secret | 值 |
|---|---|
| `WORKER_URL` | Worker 地址 |
| `DAV_USER` / `DAV_PASS` | WebDAV 账号密码 |
| `ADMIN_TOKEN` | 管理口令，仅在设置过管理口令时需要 |

Actions 每天执行一次：`data/` 有改动时才清洗并推送目录树，未变化则跳过；之后无论 `data/` 是否变化，都会执行一次死链体检。如需强制同步，手动触发该 workflow 即可。

## 常见问题

**workers.dev 无法访问？** 境内对 `*.workers.dev` 存在干扰。可给 Worker 绑定自定义域，或让客户端走代理。

**打开目录需要等待 1 到 3 秒？** 首次访问需要实时调用 139 接口，之后 7 天内秒开，过期也会先返回旧数据再后台刷新。定时预热只覆盖各挂载的根目录，更深的子目录首次仍需实时拉取。目录内文件特别多时首次会更久，每 200 项需要多调用一次接口。

**新增的文件多久出现？** 最长 30 分钟，受缓存影响。

**会超出 KV 免费额度吗？** 不会。写入仅发生在首次访问与浏览触发的刷新时，预热只补缺，另有每日调用上限保护账号。

**9530 错误？** 139 对部分数据中心 IP 的风控，Worker 会自动更换出口重试，无需处理。

**直链多久过期？** 15 分钟，移动云 EOS 的 S3 预签名，不绑定 IP。

**有防爆破吗？** 有。同一 IP 连续 5 次认证失败将锁定 15 分钟，属内存级轻量防护，跨节点不共享，请配合强密码使用。

**管理口令是做什么的？** 见[快速开始](#快速开始)第 2 步。

**有哪些限制？**

- 只读，不支持上传、删除或转存。
- 单个目录最多显示 **2 万** 项。免费版有请求次数上限，目录内文件接近上万，或一个挂载绑定了很多条分享且路径较深时，可能直接报错。
- 不支持 `Depth: infinity` 的 PROPFIND，会返回 403，客户端请使用 `Depth: 1`。
- 同一目录内文件与文件夹重名时，文件会被自动改名，与网盘上显示的名称不一致。
- 浏览器类 WebDAV 客户端无法连接，跨域响应头未完全开放。rclone、Infuse、nPlayer、Kodi 不受影响。
- 体检只能发现整个分享失效或空白，无法发现分享内单个文件被删除。

## 更新

更新只替换 Worker 代码，不影响已有配置：令牌与账号密码保存在 KV 中，与代码相互独立。

```bash
cd mcloud-dav
git pull
npx wrangler deploy
```

使用 Deploy 按钮部署的：先在 fork 仓库执行 **Sync fork**，再到 Cloudflare 面板 **Workers & Pages** → 选择对应 Worker → **重新部署**。

更新后无需手动清理缓存，旧缓存会自动失效。

## 贡献

欢迎提交 Issue 与 Pull Request。提交问题前请先确认可复现，并说明复现步骤与预期行为。

## 许可

本项目基于 [MIT 许可证](LICENSE) 开源，不存储任何音视频文件，仅整理用户自己的分享链接并做直链跳转。请遵守当地法律法规，勿用于商业用途，详见 [DISCLAIMER.md](DISCLAIMER.md)。

## 致谢

139 分享协议整理自 [OpenList](https://github.com/OpenListTeam/OpenList) 的 `139Yun` 驱动，感谢社区的逆向工作。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。
