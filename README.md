# cf-b2-worker

**Cloudflare Workers ⇄ Backblaze B2 一体化网关**：单文件、零依赖，自带 AWS Signature V4 实现和网页文件管理器。

## 项目预览

线上实例（Cloudflare Workers + Backblaze B2 私有桶）：

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| 站点首页 | https://b2.edgeoneai.cc.cd/ | 匿名访问根路径自动 302 到公开目录 `/share/` |
| 公开目录 | https://b2.edgeoneai.cc.cd/share/ | 匿名可浏览 + 下载（？format=json 返回 JSON） |
| 文件管理器 | https://b2.edgeoneai.cc.cd/__manage | Basic 鉴权后可上传/删除/重命名/建目录 |
| 备用域名 | https://b2.mose19960101.workers.dev/ | 同一 Worker 的 `workers.dev` 入口 |
| 健康检查 | https://b2.edgeoneai.cc.cd/__api/health | 匿名只返回最小信息，不含桶名/区域 |

预览要点：

- 桶 `axyz-bucket` 保持 **Private**，所有请求由 Worker 实时签 SigV4，客户端无需任何凭据
- 匿名只能在 `/share/` 前缀内读取，其余路径 403；管理员登录后全桶可读写删
- 下载**强制经 Worker**（不签发 B2 直链），`/<key>?dl=1` 触发附件下载
- 上传支持「预签名直传」与「Worker 代理」两种，超过阈值自动并发分片（失败自动重试 3 次）；页头可直接调**分片大小**与**并发数**，输入框内即服务端默认值
- 注意：**B2 单次 PUT 上限 100 MiB**（104857600 字节），超过必被中断，所以 >100MB 必须走分片；两个域名均已加入 B2 的 CORS 允许来源

它是对下面两个项目的分析、对比与重写：

| 上游项目 | 地址 | 一句话概括 |
| --- | --- | --- |
| CF-Proxy-B2 | https://github.com/hoochanlon/CF-Proxy-B2 | 用 `aws4fetch` 给请求补 SigV4 签名，**只读**代理 B2 的 S3 兼容 API |
| cw4b2 | https://github.com/ka3hun9/cw4b2 | 用 **B2 原生 API** 换取下载授权令牌，定时通过 CF API 生成第二个 Worker |

目录：

```
cf-b2-worker/
├─ src/b2-worker.js        # 唯一需要的 Worker 文件（单文件、零依赖）
├─ wrangler.toml           # 部署配置（含全部参数注释）
├─ .dev.vars.example       # 本地开发环境变量模板
├─ package.json            # 可选：固化 wrangler 版本与 npm scripts
├─ tests/sigv4.test.mjs    # SigV4 与 AWS 官方示例的对拍测试
├─ tests/router.test.mjs   # 桩化 fetch/caches 的路由冒烟测试
├─ tests/manage-ui.test.mjs# 假 DOM 里执行管理器前端脚本，验证调参默认值与钳制
├─ README.md               # 本文档：对比分析 + 快速开始
└─ DEPLOY.md               # 部署步骤与参数详解
```

本地自检：

```bash
npm test      # 等价于 node tests/sigv4.test.mjs && node tests/router.test.mjs
```

- `sigv4.test.mjs`：用 AWS 官方文档的 IAM 示例（`20150830T123600Z`）验证签名结果与官方 Signature 完全一致。
- `manage-ui.test.mjs`：把管理器页内联脚本放进极简假 DOM 中真实执行，验证「分片大小 / 并发数」输入框的
  默认值来自服务端配置、上下限钳制、非法值回落、切换通道时收紧上限、以及 localStorage 记忆回填。
- `router.test.mjs`：桩化 `fetch` / `caches`，覆盖鉴权、下载代理、Range 透传、目录列表 HTML/JSON、
  中文与空格 key 编码、路径穿越防护、`$path` 多桶模式、预签名、分片上传、管理页渲染。

---

## 一、两个仓库的分析

### 1. CF-Proxy-B2（hoochanlon）

代码形态：单 `index.js` + `welcome.html`，依赖 `aws4fetch@^1.0.20`，pnpm + prettier，wrangler 3。

核心流程：

```
请求 → 只允许 GET/HEAD → 判断是否是列举请求 → 依据 BUCKET_NAME($path/$host/固定) 改写 URL 指向 B2
     → 过滤掉无法签名的头（accept-encoding / cf-* / x-forwarded-* …）
     → AwsClient 签名 → fetch → 原样回给客户端
```

值得肯定的地方：

- **选型正确**：走 S3 兼容 API + SigV4，密钥永不过期，天然没有令牌轮换问题。
- **踩坑经验保留**：HEAD 请求统一改写为 GET 再丢弃响应体（绕 Cloudflare 改写 HEAD 导致签名失效）；
  带 Range 请求若响应缺 `content-range` 会重试最多 3 次（绕 Cloudflare 忽略 Range 的已知问题）。
- 带宽联盟利用到位：CF ↔ B2 双方都免流量费。

主要短板：

| 问题 | 说明 |
| --- | --- |
| 只有读 | 只允许 GET/HEAD，其余一律 405，没有任何上传/删除/管理能力 |
| 无鉴权 | 任何人拿到域名即可读取私有桶全部对象；开放 `ALLOW_LIST_BUCKET` 后还能枚举整个桶 |
| 无访问控制粒度 | 无法区分"公开读取"和"管理操作"，也没有 CORS 配置，浏览器端几乎不可用 |
| 构建链脆弱 | `import welcomeHtml from './welcome.html' assert { type: 'text' }`：`assert` 导入断言已被 V8 移除（现为 `with`）；且 `wrangler.toml` 里既没有 `[rules] type = "Text"`，也没有 `[build]`，按原样部署大概率报 "No loader is configured for .html files" |
| 配置被提交 | 仓库内的 `wrangler.toml` 带真实 `keyID`、端点、`$path` 配置并已入库，属于敏感信息泄漏面 |
| 缓存策略简陋 | 只依赖桶元数据里的 `Cache-Control`，没有 Cache API / 没做条件请求与 304 的完整处理 |

### 2. cw4b2（ka3hun9）

代码形态：TypeScript（`src/index.ts`）+ wrangler 2.13 + vitest，`scheduled` 触发器 + cron。

核心流程：

```
cron(每周) → b2_authorize_account → b2_get_download_authorization(validDurationInSeconds=7天)
          → 拼接一段 Worker JS 源码 → PUT https://api.cloudflare.com/.../workers/scripts/<name>
          → 生成的 Worker 给每个请求追加 Authorization 头后转发到 f005.backblazeb2.com/file/<bucket>/<name>
```

值得肯定的地方：

- 用**原生 B2 下载授权令牌**（download authorization），业务请求不需要做签名计算，边缘 CPU 开销更低。
- 意识到令牌有 7 天有效期，用 cron 自动续期。

主要短板：

| 问题 | 严重度 | 说明 |
| --- | --- | --- |
| 需要 Cloudflare API Token | 🔴 高 | 令牌权限需覆盖 Workers 脚本写/部署，一旦泄漏等于账号级沦陷；而它和其他密钥一起放在环境变量里 |
| 双 Worker + cron 架构 | 🟡 中 | 复杂度高，且 `npm start` 本地测试也会**真实创建云端 Worker** |
| cron 注释与表达式不符 | 🟡 中 | `"17 4 * * 2"` 是**每周二** 04:17（UTC），README 写"每周一"；7 天令牌 + 7 天周期属于踩边界，抖动即失效 |
| 生成的 Worker 业务耦合 | 🔴 高 | 硬编码 `f005.backblazeb2.com`（换集群就不可用了）、硬编码 `poster/` 分支、只允许 jpg/jpeg/webp/png/gif |
| 正则可能为 null | 🔴 高 | `url.pathname.match(/…/)[0]` 当路径非图片时返回 `null[0]` → 直接抛错 500 |
| 功能面过窄 | 🟡 中 | 无 Range/断点续传、无条件请求、无列举、无上传、无删除、无缓存头控制 |
| 工具链过时 | 🟢 低 | wrangler 2.13 已 EOL，`wrangler publish` 已废弃（现在是 `wrangler deploy`） |

---

## 二、对比总结

| 维度 | CF-Proxy-B2 | cw4b2 | **cf-b2-worker（本实现）** |
| --- | --- | --- | --- |
| 认证方式 | S3 SigV4（aws4fetch） | B2 原生 authorizationToken | S3 SigV4（**内置**，零依赖） |
| 是否需要 CF API Token | 否 | **是（高危）** | 否 |
| 是否需要第二个 Worker / cron | 否 | **是** | 否（密钥不过期，无需轮换） |
| 依赖打包 | 需要 npm/pnpm + esbuild + `.html` loader | 需要 npm + TS 编译 | **不需要**，单文件直接部署 |
| 读取 | ✅ GET/HEAD | ✅ 图片为主 | ✅ GET/HEAD（Range、条件请求、304 全支持） |
| 目录列举 | 可（HTML 欢迎页/桶列表） | ❌ | ✅ HTML + JSON + 分页游标 |
| 上传 | ❌ | ❌ | ✅ 代理上传 / 预签名直传 / S3 分片上传 |
| 删除 / 复制 / 重命名 / 建目录 | ❌ | ❌ | ✅ |
| Web 文件管理器 | 静态欢迎页 | ❌ | ✅ 内置（浏览/上传/直链/删除/重命名/拖拽/分片） |
| Range 处理 | ✅ 含 CF 缺陷重试 | ❌ | ✅ 继承并修正了重试边界 |
| 缓存 | 依赖桶元数据 | ❌ | ✅ Cache API + Cache-Control 覆写 + `X-B2-Cache` 标记 |
| 鉴权 | ❌ | ❌ | ✅ Basic / Bearer 恒定时间比较，默认拒绝 |
| 安全 | 路径未做穿越防护、无条件透传 key | 生成的 Worker 无白名单 | ✅ `../` 归一化、写删开关、CORS 白名单、敏感信息不入库 |
| 体积 / 复杂度 | 中 | 中（双 Worker） | 单文件约 1000 行 |

### 关键优化结论

1. **砍掉第二个 Worker 与 cron**：S3 SigV4 用永久密钥即时签名，天然替代了"B2 令牌 7 天轮换"整套机制，同时消除了 Cloudflare API Token 这个最大攻击面。
2. **把依赖归零**：自实现 SigV4 并用 AWS 官方测试向量校验（见 `tests/sigv4.test.mjs`），省掉 `aws4fetch` 打包、`.html` loader、TS 编译这些易碎环节，可以直接粘贴到 Cloudflare 控制台部署。
3. **只读 → 读写闭环**：补上上传/删除/复制/重命名/建目录与可视化管理器，且不牺牲原有的 CDN 加速与零流量成本。
4. **大文件不穿 Worker**：预签名直传 + S3 分片上传，绕开 Workers 100MB 请求体上限；`complete` 阶段服务端自行 ListParts 取 ETag，规避跨域 ETag 暴露问题。
5. **默认安全**：未配置凭据时写操作默认拒绝；`../` 归一化；`Cache-Control`、`nosniff`、CORS 白名单统一处理。

---

## 三、功能一览

| 类别 | 说明 |
| --- | --- |
| 权限模型 | 匿名只读 `/share/`（`PUBLIC_PREFIX` 可配）、访问根路径自动跳转 `/share/`；管理员可读写删全桶 |
| 下载代理 | `GET/HEAD /<key>`，支持 Range、`If-*` 条件请求、304、`Accept-Ranges`；**下载强制经 Worker，不签发 B2 直链**，`?dl=1` 触发附件下载 |
| 边缘缓存 | `ENABLE_CACHE=true` 时使用 Cache API，命中返回头 `X-B2-Cache: HIT` |
| 直链跳转 | `ALLOW_REDIRECT=true` 时 `GET /<key>?redirect=1` 返回 302 到预签名 URL |
| 目录列表 | `GET /<prefix>/` 返回 HTML；`?format=json` 返回 JSON；`?cursor=` 翻页 |
| Web 管理器 | `GET /__manage`（Basic/Bearer 鉴权） |
| 管理 API | `/__api/list`、`/presign`、`/object`、`/copy`、`/mkdir`、`/multipart/*`、`/health` |
| 上传 | 代理 `PUT /<key>`（≤100MB）；浏览器默认走预签名直传；超限自动分片 |
| 兼容性 | `$path` / `$host` / 固定桶；`RCLONE_DOWNLOAD=true` 兼容 `rclone --b2-download-url` |

---

## 四、快速开始

### 1）准备 B2 密钥

B2 控制台 → **Account > Application Keys** → Add a New Application Key：

- 只允许访问目标桶（最小权限）
- 勾选需要的权限：`listBuckets`（`$path`/`$host` 模式需要）、`listFiles`、`readFiles`、`writeFiles`、`deleteFiles`
- 记下 **keyID** 和 **applicationKey**（applicationKey 只显示一次）

同时在桶详情页记下 **Endpoint**，形如 `s3.us-west-001.backblazeb2.com`。

### 2）部署

方式一：命令行

```bash
git clone <你的仓库地址> cf-b2-worker && cd cf-b2-worker
cp .dev.vars.example .dev.vars      # 本地调试用，按需填写
npx wrangler login
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put ADMIN_PASS
npx wrangler secret put ADMIN_USER        # 非敏感，也可写进 wrangler.toml 的 [vars]
npx wrangler deploy
```

方式二：控制台（无需本地环境）

1. Workers 和 Pages → Create Worker → 粘贴 `src/b2-worker.js` 全部内容 → Deploy
2. Settings → Variables：添加 `B2_ENDPOINT`、`BUCKET_NAME` 等明文变量；加密变量（Secrets）填 `B2_KEY_ID`、`B2_APPLICATION_KEY`、`ADMIN_PASS`
3. Settings → Domains & Routes 绑定自定义域名（可选，推荐）

### 3）验证

```bash
# 健康检查（鉴权状态）
curl https://<你的域名>/__api/health

# 上传一个小文件（Basic 鉴权）
curl -u admin:你的密码 -X PUT --data-binary "@./test.txt" \
  https://<你的域名>/test.txt

# 下载
curl -I https://<你的域名>/test.txt

# 列举
curl -u admin:你的密码 "https://<你的域名>/?format=json"

# 打开网页管理器
浏览器访问 https://<你的域名>/__manage
```

> **直传须知**：浏览器要用预签名 URL 直传时，B2 桶的 **CORS Rules** 必须允许你的域名来源与方法 `PUT`，否则会被浏览器拦截（界面会提示"网络错误，请确认桶的 CORS 允许本站 PUT"）。详见 `DEPLOY.md`。

---

## 五、重要提醒

- **Endpoint 必须对应桶所在区域**，region 会自动从 `B2_ENDPOINT` 推导（也可显式给 `B2_REGION`）。
- 顺带一提：**CF ↔ B2 同属 Bandwidth Alliance**，回源与出网均免费；真正的成本只有 Workers 请求数与 B2 存储量。
- **不要把 `wrangler.toml` / `.dev.vars` 提交到公开仓库**：密钥一律走 `wrangler secret put`。
- Workers 免费套餐请求体上限 100MB、子请求数/CPU 也有限额，具体限制与应对见 `DEPLOY.md` 的"配额与限制"章节。
- 未配置 `ADMIN_*` 时，所有写/删操作**默认拒绝**（fail-closed），避免出现"意外公开的公共网盘"。

完整参数表、B2 控制台操作步骤、CORS 配置、故障排查表与 API 参考见 → **[DEPLOY.md](./DEPLOY.md)**
