# 开发说明

部署、账号配置和播放器连接请先阅读 [README](../README.md)。这里记录接口、资源控制和验证方法，供维护代码或接入脚本时参考。

## 接口与认证

WebDAV 使用站点根路径，仅支持读取。读取接口使用 WebDAV 用户名和密码；管理接口使用同一用户名和独立管理口令，未设置管理口令时使用 WebDAV 密码。认证方式为 HTTP Basic。

| 接口 | 认证 | 用途 |
|---|---|---|
| `GET /health` | 无 | 查询服务是否已配置；配置不可读时返回 HTTP 503、`ok: false`、`configured: null` |
| `GET /tree` | WebDAV | 查看目录更新时间、顶层分类与挂载数量摘要 |
| `GET /link?path=<路径>` | WebDAV | 302 跳转到下载直链，追加 `format=json` 返回 JSON |
| `GET /probe?link=<分享ID或链接>` | WebDAV | 探测单个分享 |
| `GET /setup`、`POST /setup` | 首次配置无需认证；已配置后需管理认证 | 配置页面与配置更新 |
| `GET /admin` | 管理 | 网页管理端 |
| `POST /admin/catalog-lines` | 管理 | 提交 `{ "lines": "路径 \| 分享链接" }`，全量替换目录 |
| `POST /admin/catalog` | 管理 | 上传目录 JSON，全量替换目录 |
| `GET /admin/sync-state` | 管理 | 获取最近成功上传的 `source_hash` |
| `POST /admin/check` | 管理 | 分批检查、清理失效分享 |

`path` 和 `link` 参数需要 URL 编码。例如通过 curl 获取带特殊字符的文件路径：

```bash
curl --user "WebDAV用户名" --get "https://你的Worker地址/link" --data-urlencode "path=电影/某电影/某电影.mp4" --data-urlencode "format=json"
```

管理写接口要求 `Content-Type: application/json`，浏览器请求必须同源。配置和检查请求正文最多 32 KiB，目录 JSON 和按行编辑正文最多 1 MiB，超出返回 413。

检查接口以 `from` 接收续查游标。客户端应按返回的 `nextFrom` 继续，直到 `done` 明确为真；游标应视为不透明值，不自行递增。无法确认的分享会保留，客户端需区分已确认、异常和未验证的结果；响应缺少完成状态或续查游标时应报错。

`BAD_RESPONSE` 单列为需人工核对的结构异常，返回在 `flagged` 中，标记 `kind: "structure"`，不计入 `unverified`。管理页和检查脚本直接显示条目与原因，不依赖 Cloudflare 日志查询。

目录清理已提交但清理记录读写失败时，接口仍返回成功与本批 `removed`，并带上 `logWarning: true`。客户端应提示记录未保存，继续处理续查游标，并保留本次返回的原始分享 ID。

## 目录同步

`clean_links.py` 从 `data/` 生成 `catalog.json`，`upload_catalog.py` 负责上传。两种目录写入接口都是全量替换。

自动同步通过 `--source-hash` 提交源文档指纹，Worker 仅在成功保存目录时更新记录。`--if-changed` 会先读取 `/admin/sync-state`，与最近成功版本一致时跳过上传；回退到更早的源文件也会同步。手动编辑和体检保留这份指纹，不影响下一次源文件变化的判断。

旧 Worker 缺少同步状态接口，或状态读取失败时，条件上传会停止，不会退回全量覆盖。不带 `--if-changed` 的手动全量上传仍可使用。

旧 Worker 的同步状态请求也可能返回 401，不能单凭这个状态区分服务版本和凭据错误。脚本会同时提示检查管理口令与升级 Worker，且不会上传目录。

工作流指纹同时包含 `data/**` 与 `clean_links.py`。清洗规则变化后，即使源文档未变，也会重新生成并同步目录。

已认证的完整目录提交允许替换确定损坏的旧目录，此时无法保留旧指纹；KV 读取故障仍会中止写入。`/admin` 默认显示损坏提示，通过明确的重建入口才打开空白编辑框。配置读取故障时，`/setup` 只展示恢复说明，不开放初始化或接受配置写入。

配置故障时，浏览器的 `GET /` 和 `GET /admin` 以 302 转到 `/setup`；API、WebDAV 和写入请求仍返回相应故障状态，不做页面跳转。

KV 为最终一致存储，不提供跨节点事务。同一实例内的写入排序和保存前复核不能保证跨节点并发安全，管理操作仍应避免并行执行。

## Cloudflare 资源控制

默认只使用一个 Worker 和一个 KV，不运行定时预热。`wrangler.toml` 中的 `crons = []` 会在部署时移除旧触发器；改为 `["0 * * * *"]` 可启用每小时预热，传播可能需要最多 15 分钟，见 [Cron 配置说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/#remove-a-cron-trigger)。GitHub Actions 的每日检查与 Cron 分开控制。

- 普通请求的 139 调用预算为 40 次，检查每批 20 次，预热每轮 25 次；重试和实际执行的令牌续期也计入预算。预热每日上限为 2,000 次 139 调用，这不是全站 KV 配额控制。
- 上游请求不自动跟随重定向。兼容旧部署的 `CATALOG_URL` 需直接返回不超过 1 MiB 的目录 JSON。
- 配置缓存 60 秒，同一实例合并并发读取。令牌检查在内存中按小时限频，仅成功续期后持久化配置；新版配置写入同一 KV 记录，并兼容读取旧版已续期令牌。
- 挂载配置表（`catalog`）的内存缓存为 60 秒，与分享内部的目录列表缓存分开；同一实例合并并发读取，保存或清理完成后，尚未结束的旧读取不能替换新的配置表。
- 直链内存缓存最多 64 条，每条 URL 最多 16 KiB，缓存期最多 600 秒；内存和 KV 缓存共享原始过期时间，合并同一实例的并发请求。
- 目录内存缓存最多 300 条，并限制约 8 MiB 的估算容量。目录缓存新鲜期为 30 分钟，KV 保留期为 7 天；过期后按访问触发后台刷新。部分结果不替换完整缓存。
- 浏览时跳过缺少名称或 ID 等畸形条目，并将整个结果标记为不完整，不写入目录缓存；该标记也会传递到合并挂载和自动展开的父目录。检查分享健康状态时仍严格拒绝畸形响应，缺少列表的 `data: {}` 不作为空分享处理。
- 可选缓存读写失败后短暂退避，已有有效结果仍可返回；目录后台刷新失败后，同一实例 60 秒内不重复刷新旧缓存。必要的配置与目录保存失败会向调用方报错。
- 预热只补缺少缓存的挂载根目录。预算不足时不保存残缺目录，游标和每日用量共用一个小记录，无进度变化且无上游调用时不写入。
- 目录树、自然排序比较器和加密密钥会复用，避免重复构建。

内存缓存及登录失败计数不跨实例共享，不能将其视为全局限流。免费版仍受 CPU、实例内存、子请求和每日 KV 额度限制，上述措施不保证任意规模都能使用免费层。限制以 [Workers 文档](https://developers.cloudflare.com/workers/platform/limits/)和 [KV 文档](https://developers.cloudflare.com/kv/platform/limits/)为准。

## 本地验证

使用 Node.js 22 和 Python 3.12，在项目根目录执行：

```bash
node --test tests/worker.test.cjs
python -m unittest discover -s tests -p "test_*.py"
```

测试使用模拟 KV 和接口响应，不访问真实账号。提交和 Pull Request 会自动运行同一套测试；它们不替代 Cloudflare 与 139 真实环境的兼容性验证。
