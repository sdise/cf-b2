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

# 3. 写入密钥（不会进 wrangler.toml，也不会进 Git；部署永不删除 Secrets）
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put ADMIN_PASS
npx wrangler secret put ADMIN_TOKEN   # 可选，与 Basic 二选一

# 4. 变量：本仓库的 wrangler.toml 已设为「对控制台友好」——
#    keep_vars = true + [vars] 整段注释 ⇒ 部署不会覆盖/删除控制台上的任何变量，
#    所有值都以控制台（Settings → Variables and Secrets）为准。
#    若你更想用配置文件当唯一事实来源：取消 [vars] 注释并填真实值。

# 5. 本地预览（本地变量读 .dev.vars）
npx wrangler dev --remote          # 用真实 B2 联调；不带 --remote 时签名仍会发出去

# 6. 部署（⚠️ --name 决定更新哪个 Worker；写错会新建一个 Worker）
npx wrangler deploy --name <你的 Worker 名>     # 例如 --name b2

# 7. 看日志
npx wrangler tail
```

> 本地 `wrangler dev` 建议加 `--remote`，因为 Miniflare 本地模式对 `caches.default` 与流式 Range 的表现与线上不完全一致。

> ⚠️ **部署会怎样对待你控制台上的变量？**（Cloudflare 官方语义）
>
> | 类型 | 部署行为 |
> | --- | --- |
> | **明文变量**（控制台里标 `Text`） | 默认 wrangler 会**先清空该 Worker 上所有明文变量，再写入配置文件里的** ⇒ 控制台独有的会被删、同名的会被覆盖 |
> | **密钥**（标 `Secret`，或 `wrangler secret put` 建的） | **永不删除、永不覆盖**（官方原文：*"Secrets are never deleted by a deployment whether this flag is true or false."*） |
> | `keep_vars = true` | 保留「配置文件里没有的」变量（同名项仍以配置文件为准） |
> | Cron Triggers | 配置里**没有** `crons`（本仓库已注释）⇒ 不接管，控制台配的 cron 保留；配置里**写了** ⇒ 以配置为准；显式 `crons = []` 才清空 |
> | 路由 | 配置里未声明 `route`/`routes`（本仓库已注释）⇒ 不会覆盖控制台路由 |
>
> 因此本仓库的默认形态是**最安全的**：不碰你的控制台配置。反过来，如果你以后想「以配置文件为准」，取消 `[vars]` 注释即可，但记得先把控制台的真实值（尤其 `B2_ENDPOINT`、`BUCKET_NAME`）抄进文件，否则会被占位值覆盖。

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

> **这些值放在哪？** 本仓库的 `wrangler.toml` 默认是「对控制台友好」形态（`keep_vars = true` + `[vars]` 整段注释），
> 因此**所有变量都以控制台为准**（Settings → Variables and Secrets），部署不会覆盖或删除它们。
> 表中 `vars` 列 = 明文变量，`Secret` 列 = 加密密钥（部署永不改动）。所有项在代码里都有默认值，漏配只是走默认值。

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

### 3.2.1 登录状态是怎么检查与保持的？

**Worker 侧完全无状态**——没有 Cookie、没有 Session、没有 KV/存储。每个请求独立判定一次：

```
请求 → 取 Authorization 头
      ├─ Bearer <token>   → 与 ADMIN_TOKEN 恒定时间比较（先 SHA-256 再逐位异或）
      ├─ Basic base64(u:p)→ atob 后与 ADMIN_USER / ADMIN_PASS 分别恒定时间比较
      └─ 无 / 不匹配      → 写操作 401；未配置任何凭据时写操作一律拒绝（fail-closed）
```

判定发生在 `checkAuth()`，一次请求 1 次比较，JIT 无任何缓存态。

**"保持登录"是谁的功劳？** 是**浏览器**：

1. 首次访问 `/__manage`，Worker 返回 `401 + WWW-Authenticate: Basic realm="B2 Manager"`；
2. 浏览器弹出原生登录框，输入后**按 origin + realm 缓存凭据**；
3. 之后同源请求（含 XHR/fetch，默认 `credentials: same-origin`）**浏览器自动带上 `Authorization: Basic ...`**，所以你感觉"一直登录着"。

推论与注意：

- Worker 无法在服务端"踢人"——Basic 凭据是静态环境变量，改 `ADMIN_PASS` 并重新部署才会让旧凭据失效。
- 管理器在 Bearer 模式下把令牌存在 `sessionStorage`（关标签即失效），Basic 模式下只存在页面内存与浏览器凭据缓存里。
- `PUBLIC_WRITE=true` 会跳过一切校验（等于公开网盘），不要开。
- 想让"退出"立刻生效，建议用 **Bearer 令牌模式**（`ADMIN_TOKEN`），退出即清除本地令牌；Basic 模式受浏览器缓存限制（见下）。

### 3.2.2 退出登录

管理器右上角新增 **「退出」** 按钮，点击后：

1. 清空页面内的用户名/密码/令牌与 `sessionStorage` 里的令牌；
2. 调 `POST /__api/logout`（服务端返回 `401 + WWW-Authenticate`，诱导浏览器丢弃缓存的 Basic 凭据）；
3. 再发一次带错误凭据（`logout:logout`）的请求，触发浏览器凭据缓存失效；
4. 0.9 秒后刷新页面 → 若凭据确已清除，会重新弹出登录框。

> 已知限制：**Basic 认证的凭据缓存由浏览器管理**，部分浏览器/版本不会因子资源 401 而清除，退出后可能仍自动登录。
> 此时可选：① 关闭标签页或浏览器；② 用 Bearer 令牌模式（退出即时生效）；③ Chrome：`chrome://settings/clearBrowserData` 勾选"密码及其他登录数据"，或地址栏左侧锁图标 → 清除站点数据。

### 3.2.3 匿名 vs 管理员

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
| `MAX_UPLOAD_BYTES` | `96000000`（96MB） | **「Worker 代理」**单请求上限。Workers 请求体硬上限是十进制 100MB，这里留 4MB 余量；超过该值自动改为**并发分片**经 Worker 转发 |
| `MULTIPART_THRESHOLD` | `100000000` | **「直传」**超过该体积自动改为并发分片。**实测 B2 单次 PUT 上限 = 100 MiB（104857600 字节）**，达到即被上游中断（`500 InternalError`，浏览器显示 CORS Failed），故代码强制钳制该值 `< 104857600` |
| `UPLOAD_CONCURRENCY` | `3` | 分片并发数的**默认值**（1–10），直传与 Worker 代理通用。可在管理器页面临时改（仅当前浏览器生效） |
| `PRESIGN_EXPIRES` | `3600` | 预签名 URL 有效期（秒） |
| `MULTIPART_PART_SIZE` | `26214400`（25MB） | 分片大小的**默认值**，可在管理器页面临时改。直传上限 95 MiB、Worker 代理上限为 `MAX_UPLOAD_BYTES-1MB`，前端自动钳制；B2 要求除最后一片外每片 ≥5MB |
| `RCLONE_DOWNLOAD` | `false` | 兼容 `rclone --b2-download-url`：剥掉 URL 中 `file/<bucket>/` 前缀 |
| `HIDE_KEEP_FILES` | `true` | 目录页与管理器列表隐藏目录占位对象（`<prefix>/.keep`），并同步修正"几个文件"的计数。设为 `false` 可让占位对象重新可见 |

> **两条上传通道都会按需分片**：直传超过 `MULTIPART_THRESHOLD`（默认 100MB）分片；Worker 代理超过 `MAX_UPLOAD_BYTES`（默认 96MB）分片。
> 原因是 **B2 单次 PUT 上限 100 MiB**（详见 4.1 的实测数据）——单次 PUT 超过该值必被上游中断，所以超过 100MB 的文件**必须**分片。

#### 3.4.1 在页面上临时调整分片大小 / 并发数

管理器页头有两个输入框，**框内默认值即服务端配置**（`MULTIPART_PART_SIZE`、`UPLOAD_CONCURRENCY`）：

```
分片 [ 25 ] MiB   并发 [ 3 ]     ← 页面头部，改完立即生效（当前浏览器）
```

| 输入框 | 范围 | 说明 |
| --- | --- | --- |
| 分片 | 直传 `5–95` MiB；Worker 代理 `5–(MAX_UPLOAD_BYTES-1MB)` | 切换上传方式时自动收紧上限；超出/非法/留空则回落到服务端默认值 |
| 并发 | `1–10` | 越大越快，但更吃带宽、更易触发上游限流；默认 3 是稳的 |

- 改动**只影响当前浏览器**（存 `localStorage`，与「上传方式」选择一起记忆），不改服务端、不影响其他用户。
- 需要改全局默认值 → 改 Workers 变量 `MULTIPART_PART_SIZE` / `UPLOAD_CONCURRENCY` 后重新部署。
- Worker 代理模式下每片都要过 Worker，建议分片不要太大（25MiB 左右较稳）；直传模式下可酌情调大以减少请求数。

#### 3.4.2 「配置CORS」按钮

管理页头部有 **「配置CORS」** 按钮（在「刷新」旁，桌面常显、移动端收进「更多」折叠区）。点击后输入来源（**默认为当前访问的域名**，可自定义），Worker 会通过 **B2 原生 API**（`b2_authorize_account` → `b2_get_bucket` → `b2_update_bucket`）把该来源写入当前桶的 CORS 规则：

- **按规则名去重**（`cfb2-<域名>`）：重复提交不会叠加；桶里已有的其它规则原样保留
- 放行的操作：`b2_upload_file` / `b2_upload_part` / `s3_get` / `s3_put` / `s3_head` / `s3_post` / `s3_delete` 等（浏览器直传与跨域下载都需要）
- B2 原生 API 属于**控制面调用，免费**，不计入 Class A/B/C/D 用量
- 需要 `ENABLE_WRITE=true`（写入桶配置属于写操作）；密钥必须是该桶（所在账号）的有效应用密钥
- 注意：CORS 是**桶级**配置 —— 多桶模式下要给每个桶分别配（切到对应桶的管理器再点）

### 3.5 多桶挂载（BUCKET_1..N）

自 2026-10 起改为**多桶挂载**：每个 B2 桶一个环境变量 BUCKET_N（N 为序号），值为 JSON：

\json
{ "BUCKET_NAME": "b1", "KEY_ID": "005..", "APPLICATION_KEY": "K005..", "ENDPOINT": "https://s3.us-west-004.backblazeb2.com" }
\\n
- 桶可分属**不同 B2 账号**（各自密钥/区域）；桶名不得为保留字 share/__api/__manage\n- URL 映射：/b1/… → 桶 b1；/share/b1/… → 桶 b1 的 share/ 前缀（匿名唯一入口）
- 匿名只有 /share/** 的 GET，其余路径 308 重定向；虚拟根（/ 与 /share/）纯配置推导，0 次 Class C
- 部署后首个请求自动为每个桶补建 share/.keep（幂等盲写，Class A 免费）
- 跨桶改名/移动 = Worker 中转流式复制（源 GET + 目标 PUT + 源 DELETE）
- 每个桶都要单独配 **CORS**（桶级），否则直传失败
- /__manage 为全局入口（头部可切换桶），/b1/__manage 为该桶深链

### 3.6 B2 用量面板

管理页的用量卡片**只展示这 6 项，其余一概不显示**：桶名、已用空间（百分比为主值、数值行为第二行）、对象数、Class B、Class C、计数后端。

```
桶 ayxz-bucket
已用空间: 32.1%
3.2 GB / 10.0 GB
对象数 1,284
Class B: 128 / 2500
Class C: 12 / 2500
计数后端：Durable Object
```

**位置**：**桌面端固定在最左侧一栏**（250px 窄栏），右侧是文件列表与浏览；**移动端（≤860px）整卡隐藏**。

卡片上**没有「重新统计」按钮，也没有对应功能** —— 空间快照只由 Cron（`scheduled()`）刷新，唯一例外是从未有过快照时的首次引导扫描。

#### 这些数字是怎么来的（重要）

Backblaze **没有公开的用量 / 事务次数查询 API**：官方只在 Web 控制台提供 **Caps & Alerts**（可对 Storage / Class A / B / C 设每日上限，Class D 不可设；到达上限 75% 与 100% 发告警），且**用量计数器每天 `00:00 GMT` 重置**。社区里想要这些数字的工具，要么遍历列举自己算（`b2-stats`、`backblaze-b2-exporter`），要么用 Selenium 抓控制台页面（`b2-transaction-tracker`）——因为没有 API 可用。

因此本项目的口径是：

| 指标 | 来源 | 说明 |
| --- | --- | --- |
| 已用空间 | **遍历 `ListObjectsV2` 累加 `Size`** | 只统计 **current 版本**；B2 计费还包含 non-current / hidden 版本，所以这个数**比账单口径略小** |
| 对象数 | 同上 | 含 `.keep` 占位对象（0 字节） |
| Class B / C / A / D | **本 Worker 自己计数** | 在唯一的出网点上按请求分类累计；**只含本 Worker**，控制台、rclone、其他客户端不计入 |
| 总空间 | `STORAGE_QUOTA_BYTES` | 默认按免费额度 10 GB（十进制）展示；设 0 则不显示比例 |

#### 计数存在哪里：Durable Object（推荐）或 Cache API（自动降级）

| 后端 | 触发条件 | 特性 |
| --- | --- | --- |
| **Durable Object `USAGE_DO`** | `wrangler.toml` 里绑定了 `USAGE_DO` | 同一个桶共用一个 DO 实例 → **所有数据中心看到同一份数字**；DO 对同一实例的请求串行处理，**累加与跨日归零是原子的、不丢计数**；面板上会标注"计数后端：Durable Object" |
| **Cache API** | 未绑定 `USAGE_DO`，或 DO 调用失败时自动降级 | 零依赖，但**按数据中心独立**（Cloudflare 文档：*缓存内容不会复制到发起数据中心之外*），数字会按 colo 分裂、并发下会丢极少量计数 |

DO 侧的键：`usage`（`state.storage`，SQLite），内容 `{day, A, B, C, D, at, storage, windowDay, lastAttempt}`；跨日时 `day` 一变即归零。

#### Class B/C 计数：存在哪 / 多久统计一次 / 何时清除

| 问题 | Durable Object 后端（推荐） | Cache API 后端（降级） |
| --- | --- | --- |
| **存在哪里** | DO 实例的 `state.storage`，键 `usage`（SQLite 后端）；一个桶一个实例 `idFromName('usage:<bucket>')` | `caches.default`，键 `https://usage.internal/counters/<bucket>/<UTC 日期>` |
| **多久统计一次** | **每个发往 B2 的请求结束时累加一次**（`ctx.waitUntil` 异步执行，不阻塞响应、不额外请求 B2）；不是定时统计 | 同左 |
| **聚合粒度** | 按 B2 事务类别 A/B/C/D 累计"当日次数"，并记录 `at` 最后更新时间 | 同左 |
| **何时清除（归零）** | **只有 `scheduled()`（Cron）调用 `reset` 时才清零**；请求路径不会自动归零 | 同左：Cron 的 `reset` 把固定键重写成 0 |
| **占用** | 一条几十字节的 JSON；DO 免费额度含 5 GB 存储，无压力 | 单条 JSON，随 TTL（2 天）自动清理 |
| **重置基准** | 由 `USAGE_RESET_HOURS` 指定的 UTC 小时（默认 `23`，与空间统计同一条 cron；若要贴齐 B2 官方 00:00 GMT 就改成 `0`） | 同左 |

> 注意：**计数本身不消耗 B2 事务**（不加任何 B2 请求），消耗的是 DO 请求/行写入（免费额度 10 万/天）或 Cache 读写。页面上的"剩余次数"= `CLASS_B_DAILY_QUOTA / CLASS_C_DAILY_QUOTA` 减去当日累计，纯粹是给你对照 B2 控制台用的提醒值。

**重置（归零）的触发条件 —— 完全由 `scheduled()`（Cron）驱动：**

- **空间统计与计数归零共用同一个 `scheduled()` 事件**，按触发时刻的 UTC 小时分派，默认两者都在 **23 点** → **一条 cron 就够**：

  ```toml
  [triggers]
  crons = ["0 23 * * *"]     # 同一次触发里：① 刷新空间快照 ② 归零 Class A/B/C/D
  ```

  | 配置 | 默认 | 含义 |
  | --- | --- | --- |
  | `USAGE_SCAN_HOURS` | `23` | 命中该小时 → 先刷新空间快照 |
  | `USAGE_RESET_HOURS` | `23` | 命中该小时 → 再把 Class A/B/C/D 清零 |

  取值规则：小时列表（`"23"` / `"11,23"`）、`*` = 每次触发都做、`-` = 从不。
- **计数区间 = 昨天 23:00 → 今天 23:00（UTC）**。与 B2 官方的 00:00 GMT 归零相比有 **1 小时偏移**：面板上的"当日用量"里，官方的 00:00–23:00 部分算在"今天"，23:00–24:00 的部分算到"明天"。1 小时的误差对提醒用途足够，若想贴齐官方口径就把 `USAGE_RESET_HOURS` 改回 `"0"` 并加一条 `"0 0 * * *"`。
- **同一次触发里的顺序是先扫描、再归零**：先给当前用量留一份快照，再做归零结算；本次扫描自己消耗的 Class C 也记在**旧周期**里，随归零一并清掉，所以新周期（23:00 起算）从 **0** 开始。
- **不再有"惰性归零"**：请求路径（`add`/`sync`）不会因为"日期变了"而清零；**也不再用日期分键**，Cache 后端的计数器是固定键 `counters/<bucket>`。
- 含义与代价：**如果 Cron 没配、没跑或被删掉，计数会一直累加不清零**。归零时机完全由你掌控，所以请确认 `[triggers]` 里至少有一条覆盖 `USAGE_RESET_HOURS` 的 cron。
- 归零动作在 DO 内是原子且串行的；DO 侧会记录 `resetAt`（上次归零时刻），管理页显示"计数重置：23:00 UTC（由 Cron scheduled 触发），上次 …"。

> 想验证：`npx wrangler tail` 分别能看到 `定时统计完成 … via do` 与 `当日计数已归零 … via do`；
> 本地则看 `npm test` 里的 "scheduled 按 UTC 小时分派：扫描与重置各管一段"、
> "DO：只有 reset（scheduled 调用）才会把计数清零"、"Cache 降级后端：固定键累加，只有 scheduled 的重置才会清零"。

> **免费计划的 DO 额度**（官方口径，超额即报错，每日 00:00 UTC 重置）：**10 万请求/天**、13,000 GB-s/天、500 万行读/天、**10 万行写/天**、5 GB 存储；免费计划只能用 SQLite 后端，所以绑定用 `new_sqlite_classes`。每个"有 B2 调用的 Worker 请求"会带来 1 次 DO 请求 + 1 次行写入；量很大时可用 `USAGE_DO_WRITE_EVERY` 合并落盘来省写入额度。

**怎么启用 DO**：

```bash
# wrangler.toml 里已经写好了绑定与迁移，直接部署即可（首次会创建 DO 类）
npx wrangler deploy
```

- 必须用 **wrangler** 部署：DO 的类与迁移（`[[migrations]]`）无法在 Cloudflare 控制台的在线编辑器里配置。
- 如果你只能用控制台部署：把 `wrangler.toml` 里的 `[[durable_objects.bindings]]` 与 `[[migrations]]` 删掉即可——代码会自动**降级到 Cache API**（面板上会显示"计数后端：Cache API"），功能不缺失，只是数字按数据中心分裂。
- 部署后打开管理页，卡片底部会显示当前后端：`计数后端：Durable Object（全局一致、原子）` 即表示绑定生效。

#### 查询频率与成本控制

| 动作 | 触发 | 频率 / 成本 |
| --- | --- | --- |
| 事务计数（写入） | **每个发往 B2 的请求结束时**（`ctx.waitUntil`，异步） | 1 次 DO 调用（或 1 次 Cache 读+写），**不额外请求 B2**；`USAGE_DO_WRITE_EVERY>1` 时按批合并落盘 |
| 面板数字（读取） | **打开/刷新管理页时读一次** | 页面没有轮询/定时器，数字不会自己变（刷新页面即可，数字取自快照） |
| 打开管理页 | 页面加载 | 只读已有快照；**只有 DO/缓存判定需要时才扫描** |
| 空间扫描 | **Cron Triggers → `scheduled()`** | 由你在 Worker 上配置的 Cron 决定（推荐每天 23:00 UTC 一次）；**不依赖有人访问页面** |
| 首次引导 | 第一次打开用量面板且从无快照 | 只扫一次，之后一律只读快照 |
| 计数归零 | 与统计同一条 cron（默认 UTC 23:00） | 由 `USAGE_RESET_HOURS` 决定；DO 全局一次、Cache 后端按 colo 各自执行 |

**空间统计由 Cron 驱动（不是惰性统计）**：`USAGE_AUTO_SCAN` 默认 `false`，意味着**快照过期也不会自动重扫**——只有两种情况下会扫描：① Cron 触发 `scheduled()`；② 从未有快照时的首次引导。

> **已移除「手动重新统计」**：`/__api/usage?refresh=1` 参数已被忽略，任何请求路径都不再强制重扫；`USAGE_MIN_INTERVAL` 与响应里的 `throttled`/`minInterval` 字段一并删除。想立刻要新数字只能等下一次 Cron（或临时把 `USAGE_AUTO_SCAN` 设为 `true`）。

```toml
# wrangler.toml
[triggers]
crons = ["0 23 * * *"]     # 每天 23:00 UTC：同一次触发里「先刷新空间快照、再归零计数」
```

- 选 23:00 UTC 的原因：B2 的用量计数器在 **00:00 GMT 归零**，这样归零前必定有一份"当日终值"快照；同时那一刻顺手把本地计数归零，一条 cron 就够（计数区间为昨天 23:00 → 今天 23:00，1 小时偏移可接受）。
- 需要更密集的快照就多加几条，例如 `["0 23 * * *", "0 11 * * *"]`（每 12 小时），并把 `USAGE_SCAN_HOURS` 改成 `"11,23"`。
- 用 wrangler 部署时，`[triggers]` 会与控制台里的 Cron 触发器保持同步；若只在控制台配置 Cron，则本文件这段可以留空。
- 如果你更想要"有人访问就顺手刷新"的老行为，把 `USAGE_AUTO_SCAN` 设为 `true`，并可配合 `USAGE_REFRESH_AT_UTC_HOUR=23` 打开 23 点窗口逻辑。
- `$path` / `$host` 多桶模式无法枚举桶，**必须在 `USAGE_SCHEDULE_BUCKETS` 里显式列出**要定时统计的桶，否则 `scheduled()` 会跳过并在日志里提示。

**成本**：一次全量扫描 = ⌈对象数 ÷ 1000⌉ 次 Class C。1 万对象 = 10 次，约占每日免费额度（2,500 次）的 0.4%；默认单次扫描上限 20 页（2 万对象），超出会标注"扫描到上限，实际更多"。

> **关于 `/favicon.ico`**：三个页面的 `<head>` 里都放了空 favicon（`<link rel="icon" href="data:,">`）。浏览器默认会自动请求 `/favicon.ico`，而该路径在固定桶模式下会被当作**对象下载**（`HEAD/GET` 非列举型 → 记 Class B），于是每次打开/刷新页面都白记 1 次 Class B，控制台还会出现 404 报错。空 favicon 让浏览器不再发这个请求。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENABLE_USAGE_PANEL` | `true` | 是否启用用量面板与 `/__api/usage` |
| `STORAGE_QUOTA_BYTES` | `10000000000` | 「总空间」基准（十进制 10 GB）；设 `0` 不显示比例 |
| `USAGE_CACHE_TTL` | `21600`（6h） | 仅 `USAGE_AUTO_SCAN=true` 时用作"多久算过期"；Cron 模式不用它（快照默认留 2 天） |
| `USAGE_SCAN_MAX_PAGES` | `20` | 单次扫描最多页数（每页 1000 对象） |
| `USAGE_SCAN_HOURS` | `23` | `scheduled()` 里刷新空间快照的 UTC 小时（`*`=每次，`-`=从不） |
| `USAGE_RESET_HOURS` | `23` | `scheduled()` 里重置 Class A/B/C/D 的 UTC 小时；默认与统计同点（一条 cron 搞定），改成 `0` 可贴齐 B2 官方 00:00 GMT |
| `USAGE_AUTO_SCAN` | `false` | `false` = 只由 Cron 触发（推荐）；`true` = 额外允许惰性自动扫描 |
| `USAGE_REFRESH_AT_UTC_HOUR` | `-1` | 惰性窗口：UTC 进入该小时后当天首次读取强制重扫；默认关闭（已有 Cron） |
| `USAGE_SCHEDULE_BUCKETS` | 空 | Cron 要统计的桶（逗号分隔）；固定桶模式留空即用 `BUCKET_NAME` |
| `USAGE_DO_WRITE_EVERY` | `1` | DO 计数每累计多少批才落盘（1 = 每次都写，最精确） |
| `CLASS_B_DAILY_QUOTA` | `2500` | Class B 每日额度（仅用于算"剩余"） |
| `CLASS_C_DAILY_QUOTA` | `2500` | Class C 每日额度（仅用于算"剩余"） |

> 想拿到**账单级**的空间数字（含 non-current/hidden 版本），需要改用 B2 Native API 的 `b2_list_file_versions`（本 Worker 目前只用 S3 签名，没有 native 授权流程）；控制台 Caps & Alerts 页面看到的数字才是官方口径。

### 3.6 隐私收敛（防信息泄露）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HIDE_BUCKET_INFO` | `true` | 匿名视图隐藏桶名/区域；`/__api/health` 对匿名只返回 `{ok,service,authenticated,publicRead}`；匿名遇到上游错误只回状态码、不回 XML 正文（错误详情写 `wrangler tail` 日志） |
| `STRIP_UPSTREAM_META` | `true` | 删除 `x-bz-*`、`x-amz-request-id`、`x-amz-id-2`、`x-amz-version-id`、`x-amz-server-side-encryption*` 等内部头；`ETag`/`Content-Range`/`Last-Modified` 保留以保证断点续传 |

### 3.7 调试

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEBUG` | `false` | 保留项；异常时会在日志输出堆栈（`wrangler tail` 可见），响应体始终只返回简短错误信息 |

### 3.8 匿名可见信息清单（默认配置下）

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
| `/__api/logout` | POST | 退出登录（返回 401 + `WWW-Authenticate`，促浏览器丢弃缓存凭据） |
| `/__api/*` | 见下节 | 管理 API（需鉴权，`/health`、`/logout` 除外） |
| `/<bucket>/__api/*` | 同上 | `$path` 模式下显式指定桶；也可用 `/__api/*?bucket=<桶名>` |
| `/__api/usage` | GET | B2 用量：空间快照 + Class A/B/C/D 计数（**无手动重算参数**）。需管理员鉴权 |
| `/__api/cors` | GET/POST | 读取/写入**桶级 CORS 规则**（走 B2 原生 API，免费不计 Class A-D）。`POST body {origin}` 追加一条放行规则（按规则名去重、保留已有规则）。需管理员鉴权 |
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

- 目录浏览、面包屑导航；列表为**瀑布流**（滚动到底部自动续接下一页，无上下页按钮）
- 公开目录页顶部同样是**可点击面包屑**：匿名显示 `公开目录 / images / icons`（`公开目录` 与各级均点得动，当前级为普通文字），管理员显示 `桶名 / share / …`；另保留「返回上一级」行
- 匿名面包屑**不会暴露桶根**（根级固定指向公开目录），管理员则可一路回到桶根
- 上传只通过右上角 **「上传」** 按钮选择文件（不再有拖拽区）；带进度条
- **主题切换**（按钮在右上角）：暖色（默认）/ 深色，选择记在 localStorage
- **复制**：把该文件的 Worker 分享链接写入剪贴板（与「下载」同一路径，附加 `?dl=1` 即强制另存）
- 下载（走 Worker：`/<key>?dl=1`，由 Worker 下发 `Content-Disposition: attachment`；**不再提供 B2 直链**）
- 重命名（服务端复制 + 删除）
- 新建目录、删除文件/目录
- 右上角输入 Basic 用户名/密码或 Bearer 令牌后点"鉴权"；若浏览器已完成 Basic 弹窗登录，通常无需再填
- 右上角 **「退出」**：清除本地凭据并触发浏览器丢弃缓存的 Basic 凭据（详见 3.2.2）
- 亮色主题下**目录行**为暖色底 + 琥珀色文字，文件行为浅色卡片；深色模式维持单色不变

### 6.1 两种上传方式怎么选

| | 直传（默认，推荐） | Worker 代理 |
| --- | --- | --- |
| 数据路径 | 浏览器 → 预签名 URL → B2 | 浏览器 → Worker → B2 |
| 是否需要桶配 CORS | **需要** | 不需要 |
| 分片 | 超过 `MULTIPART_THRESHOLD`（默认 100MB）自动分片（**并发**，默认 3） | 超过 `MAX_UPLOAD_BYTES`（默认 96MB）自动分片（**并发**，默认 3） |
| 单请求体积上限 | **100 MiB**（B2 硬上限，达到即被中断） | 96MB/请求（Workers 硬上限 100MB） |
| 中断代价 | 只重传失败分片（自动重试 3 次，最终失败自动 abort 清理） | 只重传失败分片（同上） |
| 适用 | 生产环境、需要分片直发 B2 | 不方便配 CORS，或想完全走 Worker 中继时 |

| 场景 | 行为 |
| --- | --- |
| 直传 + `≤MULTIPART_THRESHOLD` | 签一张预签名 PUT URL，浏览器**一次 PUT** 到 B2 |
| 直传 + `>MULTIPART_THRESHOLD` | `create` → 逐片取预签名 URL → 按 `UPLOAD_CONCURRENCY` **并发**直发 B2 → `complete` |
| Worker 代理 + `≤MAX_UPLOAD_BYTES` | 一次 PUT 到 `/__api/object` |
| Worker 代理 + `>MAX_UPLOAD_BYTES` | `create` → 按 `UPLOAD_CONCURRENCY` **并发** PUT `/__api/multipart/part`（Worker 中继）→ `complete` |

两条分片路径都带**失败自动重试（3 次，退避 0.8s/1.6s）**，最终失败会 `abort` 清理未完成碎片。

> ⚠️ **实测数据（重要）**：B2 的 S3 兼容 API 对**单次 PUT** 的上限是 **100 MiB = 104857600 字节**，达到或超过会被上游中断——B2 回 `500 InternalError`（响应体只有空的 `<Message/>`），浏览器因该响应缺少 CORS 头而显示成 `CORS Failed`。
> 实测：104,000,000 字节 ✅ 成功；104,857,600 / 105,000,000 / 130MB / 190MB ❌ 均在 103–104 MiB 处被切断。
> 另经对照实验（30MB 限速 300KB/s、耗时 103 秒）确认**与耗时无关**，纯字节上限。
> 因此超过 100MB 的文件**必须分片**，`MULTIPART_THRESHOLD` 会被强制钳制在 104857600 以下。

### 6.2 目录是怎么"存在"的：`.keep` 占位对象

对象存储没有真正的目录，**目录只是 key 上的公共前缀**。因此在**空目录**里：

- 桶中不存在任何以 `some/dir/` 开头的 key；
- `ListObjectsV2` 就不会返回 `CommonPrefixes`，目录在列表里**凭空消失**（即使你在管理器里刚"新建"过它）。

所以本项目的 `POST /__api/mkdir`（管理器的「新建目录」）会写入一个 **0 字节的 `<prefix>/.keep`** 作为**占位**：

| 行为 | 说明 |
| --- | --- |
| 新建目录 | 写 `<prefix>/.keep`（0 字节），让该前缀在列举结果中出现 |
| 目录里有文件后 | `.keep` 已无作用，但**不影响**任何功能，可留可删 |
| 删除目录 | 管理器中目录行的「删除」按钮删的就是 `p + ".keep"`（目录内还有真实文件时需先自行清理） |
| 是否显示 | 目录页与管理器列表**默认隐藏**（`HIDE_KEEP_FILES=true`）；`/__api/list?format=json` 返回的原始数据里仍然包含它，便于排查 |
| 上传同名文件 | 无影响；`.keep` 只是普通对象 |

> 你如果在 `share/images/` 里看到过 `.keep`，说明那个目录是用管理器"新建目录"建的（或曾用其他工具做过占位）。
> 想彻底不留占位，也可以用别的方式建目录：**直接上传一个 `share/images/.placeholder` 之类的文件**，或让任何以该前缀开头的对象先存在（例如 `share/images/first.jpg`）——只要有 key，目录就会出现。

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

当前 `axyz-bucket` 上两条规则：

1. `restore-download-any-https`：`https` 任意来源、`s3_get`/`s3_head`、`authorization`/`range`（桶上原有规则）
2. `allow-worker-b2-upload`：`s3_put`/`s3_get`/`s3_head`、`content-type`/`x-amz-content-sha256`，来源为：
   - `https://b2.mose19960101.workers.dev`
   - `https://b2.edgeoneai.cc.cd`

两个域名的预检实测均返回 `HTTP 200 + access-control-allow-methods: PUT`。

脚本支持**多来源合并**，新增域名不会覆盖已有来源：

```bash
B2_ORIGIN='https://b2.mose19960101.workers.dev,https://b2.edgeoneai.cc.cd' node tools/setup-b2-cors.mjs
```

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
