# mcloud-dav

把移动云盘的分享链接整理成只读 WebDAV 媒体库，在 Infuse、nPlayer、Kodi、rclone 等客户端中浏览和播放。

部署在 Cloudflare Workers，使用一个 KV 存储，无需自备服务器。播放和下载通过 302 跳转到移动云节点，媒体流量不经过 Worker。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastcyh/mcloud-dav)

项目按个人自建服务场景设计，请保管好服务地址、账号密码和 139 Authorization。访问者会消耗你的移动云盘账号额度和 Cloudflare 配额。

## 开始使用

准备一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)和一个可登录 [移动云盘网页版](https://yun.139.com)的账号。使用部署按钮或自动同步时，还需要 GitHub 账号。

### 1. 部署服务

点击上方 **Deploy to Cloudflare Workers**，按页面提示完成部署，Cloudflare 会创建 Worker 和所需的 KV 存储。

上方按钮指向本仓库。要从自己的 Fork 部署，请将按钮链接中的 `https://github.com/lastcyh/mcloud-dav` 替换为自己的仓库地址。

部署完成后，在 Cloudflare 面板中找到 Worker 地址，例如：

```text
https://mcloud-dav.你的子域.workers.dev
```

也可以使用[命令行部署](#命令行部署)。

### 2. 设置账号

首次访问 Worker 地址会进入配置页。先取得 **139 Authorization**：

1. 在浏览器中登录 [yun.139.com](https://yun.139.com)。
2. 按 `F12` 打开开发者工具，切换到「网络 / Network」。
3. 刷新页面，搜索 `hcy/file/list`，打开一条对应请求。
4. 在「请求标头 / Request Headers」中复制 `Authorization` 的完整值。

将它粘贴到配置页，确认自动识别的手机号，再设置 WebDAV 用户名和密码。密码至少 6 位，建议使用更长的独立密码。

可以另外设置「管理口令」，用于登录管理页、修改配置和目录；播放器仍使用 WebDAV 密码。未设置管理口令时，两者使用同一密码。

配置完成后，通过 **Worker 地址后加 `/admin`** 进入管理页。

### 3. 添加分享

在管理页的分享列表中，每行填写「目录路径、分隔符 `|`、分享链接」。以下都是格式示例，请替换为真实链接：

```text
电影/某电影 | https://yun.139.com/shareweb/#/w/i/ExampleID001
剧集/某剧 第一季 | https://caiyun.139.com/m/i?ExampleID002
纪录片/某系列 | ExampleID003#提取码
合集/多个分享 | ExampleID004,ExampleID005#提取码
```

- `/` 表示目录层级；标题和分类可以自行命名。
- 可以粘贴完整链接，也可以填写分享 ID；有提取码时写成 `分享ID#提取码`。
- 同一路径填写多行，或在一行用英文逗号分隔多个分享，可以将它们放在同一个目录下。
- 路径不能包含 `|`、反斜杠、空路径段、`.` 或 `..`；顶层名称不能使用 `setup`、`admin`、`health`、`tree`、`link`、`probe`。提取码不能包含逗号或分号。

**保存会替换整份目录。** 编辑框会填入现有内容，请保留仍需使用的条目。格式错误时会提示行号并拒绝本次保存；读取失败时会停止编辑，请刷新重试。

链接较多时，可以改用[批量导入](#批量导入可选)。

### 4. 连接播放器

在客户端中添加 WebDAV 连接：

| 设置 | 填写内容 |
|---|---|
| 地址 | 你的 Worker 地址，或绑定的自定义域名 |
| 协议 | HTTPS / WebDAV HTTPS |
| 端口 | 443（客户端要求时填写） |
| 路径 | `/` |
| 用户名、密码 | 第 2 步设置的 WebDAV 账号，使用独立管理口令时也不要填管理口令 |

如果客户端把服务器和路径分开填写，服务器栏只填域名。账号密码也可以在 `/admin` 中查看。

使用 rclone 时，运行 `rclone config`，新建名为 `mcloud` 的连接，类型选择 `webdav`，厂商选择 `other`，填入地址和账号密码。然后运行：

```bash
rclone ls mcloud:
```

文件按自然顺序排列，例如「第2集」排在「第10集」之前。分享根目录仅含一个文件夹时会自动展开，最多展开三层。

## 批量导入（可选）

适合已经有链接文档、需要一次添加大量分享的情况。支持 Markdown、TXT 和 DOCX，格式见 [data/示例合集.md](data/示例合集.md)。Markdown 标题用于生成目录层级，正文中的链接按条目整理，同一行的多个链接会放入同一个目录。

将完整的链接文档放入项目的 `data/` 目录，安装 Python（建议 3.12），在项目根目录执行：

```bash
python -m pip install -r requirements.txt
python clean_links.py
python upload_catalog.py --url "https://你的Worker地址" --user "WebDAV用户名" --pass "WebDAV密码"
```

如果设置过独立管理口令，最后一条命令还需添加 `--admin-token "管理口令"`。脚本会提取链接、整理标题、去重，生成 `catalog.json` 后上传。

**上传同样会替换整份线上目录**，请确认文档包含全部要保留的分享。本地运行脚本不会自动提交文件到 GitHub；但如果将 `data/` 提交到公开仓库，其中的分享链接也会公开。私密链接请仅在本地处理、使用私有仓库，或通过管理页添加。

## 自动同步与检查（可选）

默认可以只用管理页，按需编辑和检查。希望从仓库中的 `data/` 自动维护目录时，再启用 GitHub Actions。

### 开启方法

1. Fork 仓库，将完整的链接文档放入 `data/` 并提交。注意公开仓库中的链接对所有人可见。
2. 在自己仓库的 **Settings → Secrets and variables → Actions** 中添加以下 Repository secrets：

   | 名称 | 内容 |
   |---|---|
   | `WORKER_URL` | Worker 的完整地址 |
   | `DAV_USER` | WebDAV 用户名 |
   | `DAV_PASS` | WebDAV 密码 |
   | `ADMIN_TOKEN` | 独立管理口令，仅设置过时填写 |

3. 打开 **Actions**，允许工作流运行，再找到 **clean-and-upload** 并启用它。Fork 不会复制原仓库的 Secrets，需要自己填写。

计划任务每天北京时间 **10:20** 触发，实际开始时间可能延迟。它会在源文档或清洗脚本变化时同步目录，随后检查失效分享；两者未变时也会执行检查。

### 使用前须知

- **先更新 Worker，再启用新版自动同步。** 旧版服务不支持同步状态时，任务会停止并提示升级。
- 首次同步会上传完整目录。以后源文档、清洗脚本变化，或在 Actions 手动点击 **Run workflow**，都会重新用文档生成的目录覆盖线上内容。
- 源文档和清洗脚本均未变时，日常定时同步会保留管理页的修改；之后任一变化，这些手动修改仍可能被覆盖。建议选定一种主要的目录维护方式。
- 没有有效分享链接时会跳过上传，保留线上目录。

主要通过管理页维护目录时，请在 Actions 中选择 **clean-and-upload → Disable workflow**。停用工作流不会删除线上目录，也不影响播放。

## 日常管理

访问 `/admin` 可以修改目录、更新 Authorization、修改密码，或点击「检查链接」。

检查会清理确定不存在、被取消或明确为空的分享。网络故障、风控导致暂时无法确认的分享会保留，可稍后重试。响应结构异常的分享会单独标为「需人工核对」，具体条目和原因会直接显示在管理页或检查脚本的输出中。一个目录绑定多条分享时，只移除确认失效的成员。

建议保留原始链接文档，以便需要时重新添加。检查期间尽量不要同时编辑目录或在另一台设备发起检查。

Authorization 通常有效约 30 天，服务会在被访问时尝试续期。如果已经过期或续期失败，请重新登录移动云盘，按首次配置的方法获取新的值，再到管理页更新。

## 常见问题

### 浏览器打开首页显示 405？

配置完成后，根地址用于 WebDAV 连接，不提供网页文件列表。网页管理请访问 `/admin`。

### workers.dev 地址无法访问？

可以为 Worker 绑定自定义域名，或调整客户端的网络连接方式。先确认浏览器能够打开 `/admin`，再检查播放器设置。

### 首次打开目录慢，或新增文件还没出现？

首次访问需要从移动云盘读取目录，分享多、分页多时会更慢。目录会缓存约 30 分钟；超过这个时间后，再次浏览会触发后台刷新，该次访问仍可能显示旧内容。刷新成功后重新打开目录，才能看到变化；网络故障和风控可能延长等待时间。

部分分享暂时读取失败时，会尽量保留已有的完整目录。没有完整缓存时，可能先显示仍能读取的部分内容，请稍后重试。

### 遇到 9530 或令牌错误？

9530 可能是移动云盘风控，持续重试不一定有用。请稍后再试，并检查移动云盘账号是否正常；令牌过期时，到管理页更新 Authorization。

### 提示目录损坏或配置暂不可用？

目录数据损坏时，管理页会提供「进入目录重建」。先备份 Cloudflare KV 中的 `catalog` 记录，再在重建页粘贴**完整分享列表**并保存；也可以用本地完整文档重新导入。重建会替换原目录，无法恢复旧的自动同步状态，请先核对或停用 Actions，避免之后同步覆盖手动重建的内容。

配置损坏或暂时读取失败时，浏览器访问首页或 `/admin` 会转到 `/setup` 的只读恢复说明。先检查 KV 绑定、额度和服务状态；确认记录损坏后，再由账号所有者在 Cloudflare 面板备份并修复 `config`。故障期间不会重新开放初始化，健康检查会返回 `ok: false`。

### 忘记管理口令？

在 Cloudflare 中为这个 Worker 添加名为 `ADMIN_PASS` 的 Secret，值设为临时口令，并重新部署使其生效。等待约一分钟后，用**原 WebDAV 用户名和临时口令**登录 `/admin`。

在管理页设置新的管理口令，然后移除 `ADMIN_PASS` Secret 并再次部署。应急 Secret 存在时会始终优先使用它。

### 密码正确却仍然无法登录？

先确认使用的是对应的密码：播放用 WebDAV 密码，管理用管理口令。连续多次认证失败会暂时锁定对应的登录，请等待 15 分钟后重试。

### 免费额度够用吗？需要开启预热吗？

默认只使用 Worker 和一个 KV，按访问加载目录，**不开启定时预热**。播放流量直接到移动云盘，但目录浏览、登录和链接检查仍会消耗 Cloudflare 资源。大量分享、频繁检查和多人使用可能超过免费限制，请在 Cloudflare 面板关注用量，额度以 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)和 [KV 限制](https://developers.cloudflare.com/kv/platform/limits/)为准。

建议先保持默认设置。确有需要时，可将 `wrangler.toml` 中的 `crons = []` 改为 `crons = ["0 * * * *"]` 后部署，启用每小时预热。它只补充缺少的根目录缓存，会增加请求和存储操作，**不会让已有目录中的新增文件立即出现**。GitHub Actions 的每日检查需单独开启或关闭。

### 还有哪些使用限制？

- 只读，不支持上传、删除或转存到自己的移动云盘。
- 一次请求最多调用 139 接口 40 次，每页最多读取 200 项。无重试和额外路径查询时，单个分享约在 8,000 项前后触及限制；续期、自动展开文件夹、获取直链和多分享合并也共用预算，实际可能更早受限。建议拆分大目录，减少一个目录绑定的分享数量。
- 同名内容可能只显示先加入分享中的一份；文件与文件夹重名时，文件会改名。
- 不支持一次获取整棵目录树的 `Depth: infinity`，客户端应使用 `Depth: 1`。
- 浏览器类 WebDAV 客户端可能受跨域限制，建议使用独立客户端。
- 链接检查针对整个分享，不能检查出分享内每个文件的删除情况。
- 批量目录上传的请求正文上限为 1 MiB；遇到 413 时请缩减目录数据。

## 更新服务

更新前可查看 [更新日志](CHANGELOG.md)。保留原有的 KV 绑定，已有目录和账号配置就可以继续使用。

通过 Fork 部署时，先在 GitHub 中 **Sync fork**，再通过原来的 Cloudflare 构建连接重新部署同一个 Worker。命令行部署时，在原项目目录中执行：

```bash
git pull
npx wrangler deploy
```

本仓库默认的 `crons = []` 会在部署时移除旧版本的定时预热任务。需要保留预热时，请按上文修改配置；定时任务变更可能需要最多 15 分钟生效。

## 命令行部署

需要 Git、Node.js 和 npm。在终端中执行：

```bash
git clone https://github.com/lastcyh/mcloud-dav
cd mcloud-dav
npx wrangler kv namespace create CACHE
```

按提示登录 Cloudflare，将返回的 namespace ID 填入 `wrangler.toml` 的 `REPLACE_WITH_KV_NAMESPACE_ID`，然后部署：

```bash
npx wrangler deploy
```

## 项目说明

本项目主要由 AI 辅助开发，仍需更多真实环境验证。移动云盘接口来自社区逆向，后续可能发生不兼容变化。

欢迎提交 Issue，说明使用的客户端、复现步骤和错误信息；请隐藏密码、Authorization 和私密分享链接。接口、资源控制和测试方法见 [开发说明](docs/development.md)。

代码基于 [MIT 许可证](LICENSE) 开源。代码许可不包含第三方内容的使用或传播授权，详见 [免责声明](DISCLAIMER.md)。139 分享协议参考了 [OpenList](https://github.com/OpenListTeam/OpenList) 的 `139Yun` 驱动，感谢社区的工作。
