# 部署说明与参数详解

适用对象：`src/b2-worker.js`（单文件 Worker，连接 Backblaze B2 私有/公有桶 + 文件管理）。

---

## 目录

1. [部署前的准备（B2 侧）](#1-部署前的准备b2-侧)
2. [部署方式](#2-部署方式)
3. [环境变量参数总表](#3-环境变量参数总表)
4. [路由与路径规则](#4-路由与路径规则)
5. [API 参考](#5-api-参考)
6. [网页文件管理器](#6-网页文件管理器)
7. [CORS 配置（直传必须）](#7-cors-配置直传必须)
8. [配额与限制](#8-配额与限制)
9. [安全建议](#9-安全建议)
10. [故障排查](#10-故障排查)

---

## 1. 部署前的准备（B2 侧）

### 1.1 创建 Application Key

Backblaze 控制台 → **Account → Application Keys → Add a New Application Key**

| 字段 | 建议值 |
| --- | --- |
| Name | `cf-b2-worker` |
| Allow access to Bucket(s) | 只勾选目标桶（最小权限） |
| Type | Read and Write（只需只读就选 Read Only） |
| Capabilities | `listFiles` `readFiles` `writeFiles` `deleteFiles`；`$path`/`$host` 模式再加 `listBuckets` |

创建后**立刻记录**：

- `keyID`（形如 `0056xxxxxxxxxxxxxxxxxxxxx`）→ 对应变量 `B2_KEY_ID`
- `applicationKey`（形如 `Kxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）→ 对应变量 `B2_APPLICATION_KEY`，**只显示一次**

> 若之前用过 rclone/aws-cli，注意区分：这里是 **Application Key**（S3 兼容），不是 master application key。

### 1.2 获取 S3 兼容 Endpoint

B2 控制台 → **Buckets → 点击目标桶 → Bucket Settings**，在 "Bucket Info" / "Endpoint" 处可见：

```
s3.us-west-001.backblazeb2.com
```

填 `B2_ENDPOINT` 时要带协议：`https://s3.us-west-001.backblazeb2.com`。

Region 会自动从主机名推导（`s3.<region>.backblazeb2.com` → `<region>`），也可显式设置 `B2_REGION`。
**Region 与 Endpoint 必须同区**，否则签名会返回 `AuthorizationHeaderMalformed`。

### 1.3 桶的可见性

桶要保持 **Private** 也没问题 —— Worker 会用密钥实时签名，客户端无需任何凭据。
只有当你要让 S3 原生直链（`f00x.backblazeb2.com`）也能直接访问时，才需要设 Public。

---

## 2. 部署方式

### 方式 A：Wrangler CLI（推荐，便于版本管理）

```bash
# 1. 准备目录
cp .dev.vars.example .dev.vars      # 本地调试用

# 2. 登录
npx wrangler login

# 3. 写入密钥（不会进 wrangler.toml，也不会进 Git）
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put ADMIN_PASS
npx wrangler secret put ADMIN_TOKEN   # 可选，与 Basic 二选一

# 4. 修改 wrangler.toml 里的 [vars]

# 5. 本地预览
npx wrangler dev --remote          # 用真实 B2 联调；不带 --remote 时签名仍会发出去

# 6. 部署
npx wrangler deploy

# 7. 看日志
npx wrangler tail
```

> 本地 `wrangler dev` 建议加 `--remote`，因为 Miniflare 本地模式对 `caches.default` 与流式 Range 的表现与线上不完全一致。

### 方式 B：Cloudflare 控制台（无需本地环境）

1. **Workers & Pages → Create → Create Worker → 起个名字 → Deploy**
2. **Edit Code**：把 `src/b2-worker.js` 的内容整段粘贴覆盖，再 **Deploy**
3. **Settings → Variables and Secrets**：
   - **Secrets（加密）**：`B2_KEY_ID`、`B2_APPLICATION_KEY`、`ADMIN_PASS`
   - **Variables（明文）**：见第 3 节表格
4. **Settings → Domains & Routes** → Add → Custom domain（推荐绑定到 DNS 由 Cloudflare 托管的域名，会自动建 DNS 记录并让 CDN 缓存生效）

### 方式 C：最小 package.json（可选）

本 Worker **零依赖**，不需要 `npm install`。若希望固化 wrangler 版本：

```json
{
  "name": "cf-b2-worker",
  "private": true,
  "type": "module",
  "scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy", "tail": "wrangler tail" },
  "devDependencies": { "wrangler": "^3.80.0" }
}
```

---

## 3. 环境变量参数总表

> 布尔值接受：`true/false`、`1/0`、`yes/no`、`on/off`（大小写不敏感）。未设置时使用下表默认值。

### 3.1 连接（必需）

| 变量 | 推荐位置 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `B2_KEY_ID` | Secret | — | Application Key ID。为兼容 CF-Proxy-B2 也接受 `B2_APPLICATION_KEY_ID` |
| `B2_APPLICATION_KEY` | Secret | — | Application Key 本体。别名 `B2_SECRET_ACCESS_KEY` |
| `B2_ENDPOINT` | vars | `https://s3.us-west-001.backblazeb2.com` | S3 兼容端点，必须 `https://` 开头，末尾不要带 `/` |
| `BUCKET_NAME` | vars | — | 固定桶名，或 `$path`（URL 首段做桶名）、`$host`（主机名首段做桶名） |
| `B2_REGION` | vars | 由 `B2_ENDPOINT` 推导 | 显式指定区域，例如 `us-west-001`、`eu-central-003` |
| `URL_STYLE` | vars | `path` | `path`：`s3.xxx.backblazeb2.com/<bucket>/<key>`（兼容带点桶名）；`virtual`：`<bucket>.s3.xxx.backblazeb2.com/<key>` |

### 3.2 访问控制

| 变量 | 推荐位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_USER` | vars | 空 | Basic 用户名 |
| `ADMIN_PASS` | **Secret** | 空 | Basic 密码。比较采用恒定时间算法 |
| `ADMIN_TOKEN` | **Secret** | 空 | Bearer 令牌。存在时优先级高于 Basic |
| `PUBLIC_READ` | vars | `true` | 是否允许匿名读取对象；`false` 时 GET/HEAD 也需要鉴权 |
| `PUBLIC_WRITE` | vars | `false` | 是否允许匿名写入；谨慎开启，等于开放网盘 |
| `PUBLIC_PREFIX` | vars | `share` | **匿名只读前缀**。非空时匿名只能下载该前缀下的对象，其余一律 403；访问根路径自动 302 到 `/<前缀>/`。留空＝整桶匿名可读（旧行为） |
| `PUBLIC_LIST` | vars | `true` | 是否允许匿名列举 `PUBLIC_PREFIX` 目录（做公开目录索引） |
| `ALLOW_LIST_BUCKET` | vars | `false` | 是否允许匿名列举**任意**目录。管理员始终可列举全桶 |
| `ENABLE_WRITE` | vars | `true` | 总写开关，关闭后所有 PUT/POST 变 403/405 |
| `ENABLE_DELETE` | vars | `true` | 总删开关 |
| `ENABLE_MANAGE` | vars | `true` | 是否开放 `/__manage` 网页管理器 |
| `ROOT_ACTION` | vars | `deny` | 匿名访问目录时的响应：`deny` 返回 403 JSON、`welcome` 渲染引导页（推荐）、`redirect` 302 跳到 `/__manage` |
| `ALLOWED_ORIGINS` | vars | `*` | CORS 白名单，逗号分隔完整 Origin，例如 `https://a.com,https://b.com` |

**鉴权判定的优先级：**

```
PUBLIC_WRITE=true            → 直接放行所有写删（强烈不建议）
Bearer ADMIN_TOKEN 匹配      → 管理员
Basic ADMIN_USER/ADMIN_PASS  → 管理员
两者都未配置                 → 写删默认拒绝（fail-closed）
```

### 3.2.1 匿名 vs 管理员

| 操作 | 匿名 | 管理员（登录） |
| --- | --- | --- |
| 读取 `/<PUBLIC_PREFIX>/**` | ✅ | ✅ |
| 读取其它 key | ❌ 403 | ✅ |
| 列举 `/<PUBLIC_PREFIX>/` | ✅（`PUBLIC_LIST=true` 时） | ✅ |
| 列举其它目录 | ❌ 403 | ✅ |
| 访问根路径 `/` | 302 → `/<PUBLIC_PREFIX>/` | 正常列出全桶 |
| 上传 / 删除 / 重命名 / 建目录 / API | ❌ 401 | ✅ |

> 前缀匹配是**目录级**的：`share` 与 `share/a/b.jpg` 命中，`sharex.txt` 不命中。
> 把 `PUBLIC_PREFIX` 设为空字符串即可恢复"整桶匿名可读"的旧行为。

### 3.3 性能与缓存

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CACHE_MAX_AGE` | `86400` | 响应 `Cache-Control: public, max-age=N`；`0` 表示不改 `Cache-Control` |
| `ENABLE_CACHE` | `true` | 是否使用 Cloudflare Cache API 缓存响应；命中时响应头带 `X-B2-Cache: HIT` |
| `ALLOW_REDIRECT` | `false` | 允许 `/<key>?redirect=1` 返回 302 到预签名 URL，把大文件流量完全交给 B2（会绕过 CF 缓存） |
| `UPLOAD_CACHE_CONTROL` | 空 | 上传时写入对象的 Cache-Control，例如 `public, max-age=31536000, immutable` |

缓存生效范围：**仅 GET、且无 Range、且无 Authorization 头、且状态码 200**。
带 Range 的请求不写缓存（避免半段内容污染 Cache API）。

### 3.4 上传

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `104857600`（100MB） | 经 Worker 代理上传的体积上限（Workers 硬上限就是 100MB） |
| `PRESIGN_EXPIRES` | `3600` | 预签名 URL 有效期（秒） |
| `MULTIPART_THRESHOLD` | `104857600` | 超过该体积自动走 S3 分片上传 |
| `MULTIPART_PART_SIZE` | `26214400`（25MB） | 分片大小；B2 要求最后一片外其他片 ≥5MB。**Worker 代理模式下必须小于 `MAX_UPLOAD_BYTES`**（前端会自动取两者较小值并留出 1MB 余量） |
| `RCLONE_DOWNLOAD` | `false` | 兼容 `rclone --b2-download-url`：剥掉 URL 中 `file/<bucket>/` 前缀 |

### 3.5 隐私收敛（防信息泄露）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIDE_BUCKET_INFO` | `true` | 匿名视图隐藏桶名/区域；`/__api/health` 对匿名只返回 `{ok,service,authenticated,publicRead}`；匿名遇到上游错误只回状态码、不回 XML 正文（错误详情写 `wrangler tail` 日志） |
| `STRIP_UPSTREAM_META` | `true` | 删除 `x-bz-*`、`x-amz-request-id`、`x-amz-id-2`、`x-amz-version-id`、`x-amz-server-side-encryption*` 等内部头；`ETag`/`Content-Range`/`Last-Modified` 保留以保证断点续传 |

### 3.6 调试

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEBUG` | `false` | 保留项；异常时会在日志输出堆栈（`wrangler tail` 可见），响应体始终只返回简短错误信息 |

### 3.7 匿名可见信息清单（默认配置下）

| 信息 | 匿名能否看到 |
| --- | --- |
| 桶名 | ❌（列表页标题显示为「公开目录」） |
| 区域 / S3 端点 | ❌（`health` 匿名不返回 region） |
| Application Key / keyID | ❌（仅在**预签名 URL** 里出现，而预签名接口需管理员鉴权） |
| 对象内容 `/share/**` | ✅（这是公开目录的用途） |
| 对象内部 ID（`x-bz-file-id` 等） | ❌（已剥离） |
| 上游错误 XML（含桶名） | ❌（匿名只看到 `Not Found` / `Forbidden`） |
| 管理器入口 `/__manage` | ❌（匿名视图不给出链接） |

即使知道端点和桶名也无法直连：桶为 Private，S3 请求必须带有效 SigV4 签名，`f00x.backblazeb2.com` 友好 URL 同样需要授权令牌——密钥只存在于 Worker 的 Secret 里。

---

## 4. 路由与路径规则

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/<key>` | GET / HEAD | 下载对象（支持 Range、条件请求） |
| `/<key>` | PUT | 经 Worker 上传（需鉴权，`ENABLE_WRITE`） |
| `/<key>` | DELETE | 删除对象（需鉴权，`ENABLE_DELETE`） |
| `/` | GET | 匿名 → 302 到 `/<PUBLIC_PREFIX>/`（默认 `/share/`）；管理员 → 列出全桶 |
| `/share/<key>` | GET | 匿名可直接下载的公开对象；`/share/` 可作为公开目录索引 |
| `/<prefix>/` | GET | 目录列表（HTML；`?format=json` 返回 JSON；`?cursor=` 翻页；`?limit=` 每页条数） |
| `/__manage` | GET | 网页文件管理器（需鉴权） |
| `/<bucket>/__manage` | GET | `$path` 模式下的管理器，自动把 API 前缀带上桶名 |
| `/__api/*` | 见下节 | 管理 API（需鉴权，`/health` 除外） |
| `/<bucket>/__api/*` | 同上 | `$path` 模式下显式指定桶；也可用 `/__api/*?bucket=<桶名>` |
| 任意 | OPTIONS | CORS 预检，返回 204 |

> **判断规则**：路径以 `/` 结尾视为"目录"→ 返回列表；否则视为"对象"→ 走下载/上传/删除。
> 含 `__api/` 的路径总是优先当 API 处理。

**桶名解析（`BUCKET_NAME`）**

| 取值 | 示例 URL | 桶 | 对象 key |
| --- | --- | --- | --- |
| `my-bucket` | `/a/b.jpg` | `my-bucket` | `a/b.jpg` |
| `$path` | `/my-bucket/a/b.jpg` | `my-bucket` | `a/b.jpg` |
| `$host` | `https://my-bucket.dl.example.com/a/b.jpg` | `my-bucket` | `a/b.jpg` |

> 安全：`key` 会做归一化，`..` 会被消解（`../../etc/passwd` → `etc/passwd`），无法跳出桶外。

---

## 5. API 参考

所有 `/__api/*` 端点除 `/health` 外均需鉴权，统一返回 JSON，失败时 `ok:false` 且带 `error`。

### `GET /__api/health`

```json
{ "ok": true, "service": "cf-b2-worker", "bucketMode": "fixed", "region": "us-west-001",
  "publicRead": true, "authenticated": true }
```

### `GET /__api/list`

| 参数 | 说明 |
| --- | --- |
| `prefix` | 前缀，例如 `photos/` |
| `cursor` | 上一页返回的 `nextToken` |
| `limit` | 每页条数，默认 1000 |
| `recursive=1` | 不使用 `/` 分隔符，递归列出全部对象 |
| `bucket` | 仅 `$path`/`$host` 模式需要 |

```json
{ "ok": true, "bucket": "my-bucket",
  "files": [{ "key":"a.txt","name":"a.txt","size":12,"lastModified":"2026-09-27T10:00:00.000Z","etag":"..." }],
  "folders": ["photos/"], "truncated": false, "nextToken": "" }
```

> ⚠️ **下载必须经 Worker**：`type=get` 的预签名（即"B2 直链"）**已被强制禁用**，调用返回 403。
> 下载请直接用 `GET /<key>`，需要另存为时加 `?dl=1`（Worker 会下发 `Content-Disposition: attachment`）。
> 预签名仅保留给**上传直传**使用，这样端点/桶名/keyID 不再出现在任何下载链接里。

### `GET /__api/presign`（仅上传）

| 参数 | 说明 |
| --- | --- |
| `key` | 对象 key（必需） |
| `type` | **只能 `put`**（`get` 已禁用 → 403） |
| `expires` | 有效期秒数，默认 `PRESIGN_EXPIRES` |
| `ct` | `type=put` 时的 Content-Type，客户端 PUT 时必须使用同一个值 |

返回：

```json
{ "ok": true, "url": "https://s3.us-west-001.backblazeb2.com/my-bucket/a.txt?X-Amz-...", "expires": 3600 }
```

> **PUT 预签名 URL 必须同时发送头 `x-amz-content-sha256: UNSIGNED-PAYLOAD`**（本项目管理器的 `<span>` 已自动带上；你自己写客户端时务必加上）。

### `PUT|GET|HEAD|DELETE /__api/object?key=<key>`

- `PUT`：请求体即文件内容，走 Worker 中转，受 `MAX_UPLOAD_BYTES` 限制
- `DELETE`：删除对象
- `GET/HEAD`：等价下载地址 `/<key>`

### `POST /__api/copy`

```json
{ "from": "old.txt", "to": "new.txt", "move": true }
```

`move:true` 时复制完成后删除源对象（用服务端 `x-amz-copy-source` 复制，数据不经过 Worker）。
`$path`/`$host` 模式再加 `?bucket=xxx`。

### `POST /__api/mkdir`

```json
{ "prefix": "photos/2026" }
```

实际写入 `photos/2026/.keep`（0 字节占位对象），使 `ListObjectsV2` 能把该目录作为 `CommonPrefixes` 返回。

### 分片上传

| 端点 | 参数 / body | 说明 |
| --- | --- | --- |
| `POST /__api/multipart/create?key=` | `{ "contentType": "video/mp4" }` | 返回 `{ uploadId }` |
| `GET /__api/multipart/part?key=&uploadId=&partNumber=` | — | 返回该分片的预签名 PUT URL（**直传**路径） |
| `PUT /__api/multipart/part?key=&uploadId=&partNumber=` | 请求体＝分片内容 | 由 Worker 中继该分片到 B2（**代理**路径，无需 CORS，单片必须 < `MAX_UPLOAD_BYTES`） |
| `POST /__api/multipart/complete?key=` | `{ "uploadId": "..." }` | 服务端自动 ListParts 取 ETag 后合并 |
| `POST /__api/multipart/abort?key=` | `{ "uploadId": "..." }` | 取消并清理碎片 |

`complete` 不需要客户端回传 ETag（避免依赖跨域暴露的 ETag 响应头），服务端会分页拉取全部已上传分片并排序后合并。

**curl 示例（直传）**

```bash
# 1. 取上传直链
UP=$(curl -s -u admin:pass "https://<host>/__api/presign?key=demo.bin&type=put" | jq -r .url)

# 2. 直传到 B2（不受 Workers 100MB 限制）
curl -X PUT -T ./demo.bin \
  -H "Content-Type: application/octet-stream" \
  -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
  "$UP"
```

---

## 6. 网页文件管理器

访问 `https://<你的域名>/__manage`（需 Basic/Bearer 鉴权）。

- 目录浏览、面包屑导航、翻页
- 拖拽上传、进度条；超过 `MULTIPART_THRESHOLD` 自动切换分片上传
- **主题切换**（按钮在右上角）：暖色（默认）/ 深色，选择记在 localStorage
- 下载（走 Worker：`/<key>?dl=1`，由 Worker 下发 `Content-Disposition: attachment`；**不再提供 B2 直链**）
- 重命名（服务端复制 + 删除）
- 新建目录、删除文件/目录
- 右上角输入 Basic 用户名/密码或 Bearer 令牌后点"鉴权"；若浏览器已完成 Basic 弹窗登录，通常无需再填
- 亮色主题下**目录行**为暖色底 + 琥珀色文字，文件行为浅色卡片；深色模式维持单色不变

### 6.1 两种上传方式怎么选

| | 直传（默认，推荐） | Worker 代理 |
| --- | --- | --- |
| 数据路径 | 浏览器 → 预签名 URL → B2 | 浏览器 → Worker → B2 |
| 是否需要桶配 CORS | **需要** | 不需要 |
| 单请求体积上限 | 无（旁路 Worker） | **100MB**（Workers 请求体硬限） |
| 大文件（>100MB） | 分片直传，速度最快 | 分片经 Worker 中继，稳定但慢（两跳） |
| 适用 | 生产环境、大文件 | 临时救急、或不方便配 CORS 时 |

切到任一种模式，**超过阈值都会自动走 S3 分片上传**，只是分片的落地点不同：

| 场景 | 行为 |
| --- | --- |
| 直传 + 小文件（`≤MULTIPART_THRESHOLD`） | 签一张预签名 PUT URL，浏览器一次 PUT 到 B2 |
| 直传 + 大文件 | 分片：`create` → 逐片取预签名 URL → `complete` |
| Worker 代理 + 小文件（`≤MAX_UPLOAD_BYTES`） | 一次 PUT 到 `/__api/object` |
| Worker 代理 + 大文件 | 分片：`create` → 逐片 PUT 到 `/__api/multipart/part`（Worker 中继）→ `complete` |

> **>100MB 的文件能否经 Worker 上传？** 能，但只能走「Worker 代理 + 分片」：每片 ≤ `multipartPartSize` 且 <100MB，逐片转发。代价是两份带宽套娃、占 CPU/内存、速度慢。
> 想快的话，请在 B2 桶配好 CORS 后用「直传」，配好后错误信息也就不出现了。

---

## 7. CORS：到底是谁在限制，怎么解除

### 7.1 谁限制？

**两边都参与了，但角色不同：**

| 角色 | 做了什么 |
| --- | --- |
| **浏览器**（强制方） | 同源策略：页面在 `https://xxx.workers.dev`，却要把数据 PUT 到 `https://s3.us-east-005.backblazeb2.com`，属于跨源。带自定义头（`x-amz-content-sha256`）的 PUT 必须先发 `OPTIONS` 预检。浏览器拿不到合法的 CORS 响应头，就直接掐掉请求，只抛一个笼统的 network error（真实原因在 DevTools → Console/Network 里写着 "blocked by CORS policy"） |
| **Backblaze B2**（授权方） | 官方原话："By default, the Backblaze B2 servers will **deny** preflight requests." 桶上没配 CORS 规则时，B2 就不返回 `Access-Control-Allow-*` 头 → 浏览器拒绝。**配了规则才是解封** |

推论：

- **非浏览器客户端**（curl / rclone / aws-cli / 服务端代码）**完全不受影响**——我一直用它测试就是证据。
- 所以这不是"能用某种 Hidden 开关绕开"，而是**必须在桶上加 CORS 规则**。

### 7.2 为什么在 Backblaze 网页控制台里找不到？

因为 **Web 控制台没有 CORS 设置界面**。官方只允许三种途径：`b2_create_bucket` / `b2_update_bucket` **API**、**B2 CLI**、或 S3 兼容 API 的 **PutBucketCors**。别再在 B2 网页里翻了。

### 7.3 方案 A：B2 CLI（推荐）

```bash
# 1. 安装（需要 Python）
pip install b2

# 2. 登录：用你的 Application Key ID + Application Key
b2 account authorize

# 3. 看当前规则（默认为空）
b2 get-bucket <你的桶名>
```

写一条规则。**`allowedOperations` 必须用小写下划线写法**（`s3_put` / `s3_get` / `s3_head` / `s3_delete`）：

```bash
b2 update-bucket \
  --corsRules '[
    {
      "corsRuleName": "allow-worker-b2-upload",
      "allowedOrigins": ["https://b2.mose19960101.workers.dev"],
      "allowedOperations": ["s3_put", "s3_get", "s3_head"],
      "allowedHeaders": ["content-type", "x-amz-content-sha256"],
      "exposeHeaders": ["ETag"],
      "maxAgeSeconds": 3600
    }
  ]' \
  <你的桶名> allPrivate
```

> ⚠️ **实测更正**：官方 CORS 文档把 S3 操作写成 `S3 Put Object` / `S3 Get Object` 这类带空格的形式，
> 但 **API 实际会返回 `400 bad_request unknown allowedOperation value: S3 Put Object`**。
> 真实可用值只有四个：`s3_put`、`s3_get`、`s3_head`、`s3_delete`（另有原生侧的
> `b2_upload_file`、`b2_upload_part`、`b2_download_file_by_name`、`b2_download_file_by_id`）。
> 可用 `tools/setup-b2-cors.mjs`（见 7.7）一键配置 + 自检。

Windows PowerShell（建议写文件避免引号地狱）：

```powershell
# cors.json
# [ { "corsRuleName": "allow-worker-upload",
#     "allowedOrigins": ["https://b2.mose19960101.workers.dev"],
#     "allowedOperations": ["S3 Put Object","S3 Get Object","S3 Head Object"],
#     "allowedHeaders": ["content-type","x-amz-content-sha256"],
#     "exposeHeaders": ["ETag"], "maxAgeSeconds": 3600 } ]
b2 update-bucket --corsRules (Get-Content .\cors.json -Raw) <你的桶名> allPrivate
b2 get-bucket <你的桶名>          # 确认 corsRules 已写入
```

### 7.4 方案 B：S3 API（aws-cli，最贴近我们用的端点）

我们用的是 S3 端点，所以直接用 `PutBucketCors` 更保险（**注意：S3 设置的规则和 Native API 设置的是两套独立命名空间**，别混用查看）：

```json
/* s3cors.json —— AWS 风格 */
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://b2.mose19960101.workers.dev"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["content-type", "x-amz-content-sha256"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

```bash
aws configure set aws_access_key_id <keyID>
aws configure set aws_secret_access_key <applicationKey>
aws s3api put-bucket-cors \
  --bucket <你的桶名> \
  --cors-configuration file://s3cors.json \
  --endpoint-url https://s3.us-east-005.backblazeb2.com
aws s3api get-bucket-cors --bucket <你的桶名> --endpoint-url https://s3.us-east-005.backblazeb2.com
```

### 7.5 规则字段速查（官方限制）

| 字段 | 取值 / 限制 |
| --- | --- |
| `corsRuleName` | 必填，6–63 位，仅字母数字和连字符，桶内唯一，不能以 `b2-` 开头 |
| `allowedOrigins` | 必填。`https://域名`、可带端口、`https://*.example.com` 通配、`https`（任意 https 源）、`*`（任意源；**有 `*` 时必须唯一**） |
| `allowedOperations` | 必填，至少一项。S3 侧实际可用值：**`s3_put` / `s3_get` / `s3_head` / `s3_delete`**；原生侧：`b2_download_file_by_name` / `b2_download_file_by_id` / `b2_upload_file` / `b2_upload_part` |
| `allowedHeaders` | 可选。`content-type`、`x-amz-content-sha256`，支持后缀通配 `x-bz-info-*`，或单个 `*` |
| `exposeHeaders` | 可选，必须是完整头名（如 `ETag`） |
| `maxAgeSeconds` | **必填**，0–86400 |
| 数量/大小 | 每桶最多 100 条，每条 <1000 字节；**命中第一条匹配规则即止** |

### 7.6 配完怎么验证

1. 管理器里把上传方式保持为「直传」，重传一个小文件。
2. F12 → Network：应当看到先 `OPTIONS`（返回 200/204 且带 `Access-Control-Allow-Origin`、`Access-Control-Allow-Headers`），随后 `PUT` 返回 200。
3. 仍失败的话，看 Console 里的具体原因多半是：
   - `Request header field x-amz-content-sha256 is not allowed` → `allowedHeaders` 少了它（或直接用 `"allowedHeaders": ["*"]` 排错）
   - `Method PUT is not allowed` → `allowedOperations` 少了 `s3_put`
   - `400 unknown allowedOperation value: S3 Put Object` → 用了文档里的空格写法，改成 `s3_put`
   - `The bucket contains B2 Native CORS rules. Please use B2 Native API instead.` → 该桶已用原生规则，S3 的 `PutBucketCors` 不可用，改用 `b2_update_bucket`
   - `No 'Access-Control-Allow-Origin' header` → `allowedOrigins` 没命中（记得带 `https://`，workers.dev 子域也要写全）

> 只做**读取 / CDN 代理**时（请求都经 Worker 转发），浏览器不跨源，**不需要任何 B2 CORS 配置**。
> 也可以不配 CORS：把界面上传方式切到「Worker 代理」，代价是 100MB/请求上限且大文件更慢。

### 7.7 一键脚本（推荐，幂等可重复执行）

```bash
# 凭据只在环境变量里，不写进文件、不进 Git
B2_KEY_ID=<keyID> B2_APP_KEY=<applicationKey> node tools/setup-b2-cors.mjs
# 可选：B2_BUCKET=其他桶  B2_ORIGIN=https://你的自定义域  B2_DRY_RUN=1（只看不改）
```

脚本依次做：登录 → 找桶 → `b2_update_bucket` 写 `corsRules` → 尝试 S3 `PutBucketCors`（桶已有原生规则时会被拒，属正常）→ `GetBucketCors` 回读 → **模拟浏览器 `OPTIONS` 预检**，打印 `Access-Control-Allow-*`，最后给出 ✅/❌ 结论。

对 `axyz-bucket` 的实际执行结果：

```
[6] 模拟浏览器 OPTIONS 预检
    HTTP 200
    access-control-allow-origin : https://b2.mose19960101.workers.dev
    access-control-allow-methods: PUT
    access-control-allow-headers: content-type,x-amz-content-sha256
    access-control-max-age      : 3600
✅ CORS 已放行该来源，管理器切回「直传」即可上传
```

当前桶上两条规则：

1. `restore-download-any-https`：`https` 任意来源、`s3_get`/`s3_head`、`authorization`/`range`（桶上原有规则，已写回）
2. `allow-worker-b2-upload`：仅 `https://b2.mose19960101.workers.dev`、`s3_put`/`s3_get`/`s3_head`、`content-type`/`x-amz-content-sha256`

---

## 8. 配额与限制

| 项目 | 限制 | 应对 |
| --- | --- | --- |
| Workers 请求体（代理上传） | 100MB（免费/付费同上限） | 走预签名直传或分片上传 |
| 子请求数 | 免费套餐每次请求 50 个 | 正常读写为 1 个子请求；`multipart/complete` 会分页 ListParts，极多分片时略增 |
| CPU 时间 | 免费套餐 10ms/请求 | SigV4 仅 4 次 HMAC + 若干 SHA-256，开销极小 |
| Cache API 单对象 | 约 512MB | 更大的对象自动跳过缓存（不报错） |
| 流式响应 | 下载统一经 Worker 流式回源；大文件建议配合 CDN 缓存与 Range | 见 `CACHE_MAX_AGE` |
| SigV4 有效期 | 签名 15 分钟内有效（由 `x-amz-date` 决定） | 无需处理，签名即时生成 |
| B2 分片规则 | 除最后一片外每片 ≥5MB，最多 10000 片 | 调大 `MULTIPART_PART_SIZE` |

---

## 9. 安全建议：信息泄露与防滥用

### 9.1 防刷流量 / 防滥用（重要）

单个匿名请求 = 一次回源到 B2 的请求（若 CDN 未命中）。虽然 CF↔B2 免流量费，但 Worker 请求数与 Backblaze `Class C/D` 事务数是计费的。建议叠加四层：

1. **让缓存挡在最前面**：`CACHE_MAX_AGE=86400`（或更长）、`ENABLE_CACHE=true`，并给 `/share/*` 的对象设置 `UPLOAD_CACHE_CONTROL = "public, max-age=31536000, immutable"`，让基本边缘命中。
2. **WAF 速率限制**：Security → WAF → Rate limiting rules，例（按 10 秒/IP 阈值，匹配 `hostname = b2.example.com and not starts_with(http.request.uri.path, "/share/")`，动作 Block 或 Managed Challenge）。
3. **Bot Fight Mode / Under Attack**：控制台 → Bots，打开 Bot Fight Mode；遭遇刷量时临时开 "I'm under attack"。
4. **Cache Rules**：给 `/share/*` 建一条 Cache Rule（Eligible for cache + Edge TTL），让静态文件在 CDN 边缘直接命中，连 Worker 都不触发。

补充：匿名只能访问 `/share/**`（`PUBLIC_PREFIX`），**本身已经把放大面收敛到一个目录**——这是最重要的一层。

### 9.2 通用加固清单

1. **密钥只放 Secret**：`B2_APPLICATION_KEY`、`ADMIN_PASS`、`ADMIN_TOKEN` 一律用 `wrangler secret put`，绝不写进 `wrangler.toml`/Git。
2. **最小权限 Key**：Application Key 只授权目标桶和必要的 capabilities；只读场景就别给 `writeFiles`/`deleteFiles`。
3. **不要开启 `PUBLIC_WRITE`**：除非你确实想做一个公开网盘。
4. **`ALLOW_LIST_BUCKET` 保持 `false`**：开放后任何人都能枚举桶内容。
5. **管理入口单独保护**：可以再加一层 Cloudflare Access（Zero Trust），或在自定义域名上只给 `/__manage` 设置访问策略。
6. **防盗链/限速**：将 `PUBLIC_READ` 设为 `false`，或在 Cloudflare WAF 里对 Referer / 速率做限制，避免被刷量虽然流量免费但请求数计费。
7. **定期轮换**：Application Key、Basic 口令建议定期更换；更换 Secret 后 `wrangler deploy` 使其生效。
8. **不要用 `$path`/`$host` 模式对外提供匿名服务**：这两种模式等于把该密钥可见的所有桶都暴露出来。

---

## 10. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 访问根域名显示 `目录列举未开放（ALLOW_LIST_BUCKET=false）` | **预期行为**，不是故障：根路径＝目录列举，默认不允许匿名枚举。三种选择：① 直接访问具体对象 `/<key>`（公开读已生效）；② 先访问 `/__manage` 用 Basic 登录，浏览器缓存凭据后根路径即可列出；③ 设置 `ROOT_ACTION=welcome` 渲染引导页，或 `ROOT_ACTION=redirect` 直接跳转管理器；确实要公开枚举才设 `ALLOW_LIST_BUCKET=true` |
| 全部请求返回 `SignatureDoesNotMatch` | `B2_ENDPOINT` 与 `B2_REGION` 不对应；或 keyID/applicationKey 复制错误/带了空格；确认 Key 有该桶权限 |
| `AuthorizationQueryParametersError` / presign 403 | 预签名 URL 过期（`PRESIGN_EXPIRES`）；或客户端改了 URL 参数 |
| `AuthorizationHeaderMalformed` | 端点前缀多写了 `/`、或 region 推导错误 → 显式设置 `B2_REGION` |
| PUT 预签名上传 400/403 | 缺少 `x-amz-content-sha256: UNSIGNED-PAYLOAD` 头，或 Content-Type 与预签名时的 `ct` 不一致 |
| 浏览器上传报"网络错误" | 直传模式下 B2 桶 CORS 未允许你的 Origin / `s3_put` / `x-amz-content-sha256`。**应急办法**：把界面上的上传方式切到「Worker 代理」；**根治办法**：按第 7 节给桶配 CORS |
| 删除后再列举仍可见 | B2 可能存在延迟；另外带斜杠的"目录"是 `.keep` 占位对象，需一并删除 |
| 下载大文件慢或超时 | 开 `ALLOW_REDIRECT=true`，用 `/<key>?redirect=1` 走 302 直连 B2 |
| 视频无法拖动进度 | 源响应缺 `Accept-Ranges` 时已自动补；确认客户端带了 Range 且 Worker 未被中间件剥离 |
| 命中不了缓存 | Range / Authorization 请求不缓存；URL 上的查询串会成为缓存键；`CACHE_MAX_AGE=0` 时不写缓存 |
| 目录列表 403 | `ALLOW_LIST_BUCKET=false` 且未带鉴权；加 Basic/Bearer 即可 |
| `$path` 模式全部 400 | URL 第一段缺失，访问 `https://host/<bucket>/<key>` 或带 `?bucket=` 走 API |
| TS/构建报错 `.html` | 与本项目无关：那是 CF-Proxy-B2 的问题（详见 README 分析章节） |

排错利器：

```bash
npx wrangler tail                         # 实时日志
curl -u admin:pass https://<host>/__api/health
curl -I https://<host>/some/key.jpg       # 看 X-B2-Cache / Accept-Ranges / Cache-Control
```
