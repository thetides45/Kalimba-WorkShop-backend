# 卡林巴社区工坊 · 后端服务

> 卡林巴（拇指琴）爱好者的「**本地优先制谱 + 在线乐谱社区**」的 REST 服务端。
> 制谱全流程在浏览器内完成，谱面数据不上传；后端只承载账号、社区内容、附件与审核。

- **技术栈**：Spring Boot 3.2 / JDK 17 / MyBatis-Plus 3.5 / Sa-Token（JWT 模式）/ MySQL 8 / Redis
- **形态**：单体应用，默认端口 `8080`
- **在线接口文档**：启动后访问 `http://localhost:8080/swagger-ui.html`

---

## 一、三个仓库的分工

本项目按职责拆成三个仓库，互为上下游：

| 仓库 | 职责 | 地址 |
|---|---|---|
| **backend**（本仓库） | REST API、鉴权与权限、帖子/评论/互动、附件与下载分级、审核与审计 | 当前仓库 |
| **web-vue** | 社区前端（Vue 3 + Vite + Pinia）：首页、作品广场、在线制谱、帖子详情、发布、个人主页、消息、搜索、后台管理、404，含 PWA | <https://github.com/thetides45/Kalimba-WorkShop-web-vue> |
| **frontend** | 制谱内核的构建工具链：单文件制谱器 → ES 模块 → 离线单文件 → 派生出 web-vue 的在线制谱页 | <https://github.com/thetides45/Kalimba-WorkShop-frontend> |

用一句关系串起来：

```
frontend  ──产出──▶  web-vue/public/composer.html（在线制谱页）
web-vue   ──调用──▶  backend（/api/**）
backend   ──存储──▶  MySQL（社区数据） + uploads/（图片与乐谱附件）
```

- **一套内核、两种形态**：同一份制谱内核既被离线单文件内联，也被在线制谱页复用；后端不参与制谱计算，只保存「乐谱 JSON」这个交换载体。
- **前端先跑起来**：本仓库提供数据与鉴权，前端仓库的 `npm run dev` 通过 Vite 代理把 `/api` 转发到 `8080`。

---

## 二、功能一览

| 模块 | 能力 | 接口前缀 |
|---|---|---|
| 认证 | 注册、登录、令牌静默续期（Sa-Token + JWT） | `/api/auth/**` |
| 用户 | 个人主页、资料修改、关注/取关/粉丝列表 | `/api/users/**` |
| 帖子 | 列表与详情、发布、编辑、删除、草稿、上下架 | `/api/posts/**` |
| 正文块 | `text` / `image` / `score` / `divider` 四类块的**白名单清洗**后存 JSON | — |
| 评论 | 一级评论与回复、软删除 | `/api/posts/{postId}/comments` |
| 互动 | 点赞（帖子/评论）、收藏、互动状态查询 | `/api/posts/{id}/**` |
| 标签与分类 | 标签列表、琴谱分类字典 | `/api/tags`、`/api/meta/**` |
| 文件 | 图片上传、乐谱上传、元信息、**下载分级** | `/api/files/**` |
| 通知 | 未读数、单条已读、全部已读 | `/api/notifications/**` |
| 搜索 | 综合搜索（帖子/用户/标签）、热搜榜 | `/api/search/**`、`/api/hot` |
| 审核 | 举报提交与处理、待审帖子/评论 | `/api/reports`、`/api/admin/**` |
| 管理端 | 数据概览、用户封禁、帖子审核、评论审核、举报处理、审计日志、热榜重建 | `/api/admin/**` |

几个值得单独说明的设计：

- **乐谱下载分级**（`score_file.visibility`）：`login` < `favorite` < `follower` < `author` 四档，「能在线试听」与「能拿走源文件」被拆开——谱面 JSON 里的 `source` 就是作品本身（明文简谱），所以下载资格必须由服务端判定。作者本人与管理员永远可下载。
- **帖子状态**：`0` 待审核 / `1` 正常 / `2` 下架 / `3` 草稿（仅作者可见，不进列表、搜索与热榜）。
- **审计日志**：基于 AOP 的 `@OpLog` 注解写入 `op_log`，区分成功与失败，操作者存 username 快照（改名或注销后记录仍可读）。
- **热搜数据源**：`search_log` 按「关键词 + 天」唯一聚合，行数上界为词数 × 天数，避免一搜一行把表撑大。
- **限流**：Redis `INCR` + 首次过期实现固定窗口计数；Redis 不可用时**放行**而不是拒绝，避免限流本身变成故障点。
- **敏感词过滤**：`src/main/resources/sensitive-words.txt` 驱动，命中返回 `3002`。

---

## 三、目录结构

```
backend/
├── pom.xml
├── src/main/java/com/kalimba/workshop/
│   ├── common/                 公共设施
│   │   ├── aspect/             @OpLog 审计切面
│   │   ├── config/             Sa-Token / CORS 与静态映射 / MyBatis-Plus / SpringDoc / BCrypt
│   │   ├── exception/          BizException、ErrorCode、全局异常处理
│   │   ├── ratelimit/          Redis 固定窗口限流
│   │   ├── result/             R / PageResult 统一响应
│   │   └── sensitive/          敏感词过滤
│   ├── dto/  entity/  mapper/  请求响应对象、实体、Mapper
│   └── module/                 按业务分模块（controller + service）
│       ├── admin/ auth/ comment/ file/ follow/ hot/
│       ├── interaction/ meta/ moderation/ notification/
│       └── post/ search/ tag/ user/
├── src/main/resources/
│   ├── application-example.yml 配置模板（**入库**，不含真实凭据）
│   ├── application.yml         本地真实配置（**已 gitignore**）
│   ├── sensitive-words.txt
│   └── db/
│       ├── schema.sql          建库建表（12 张表）
│       ├── data.sql            种子数据（标签、演示账号、示例帖子）
│       └── migrations/         按日期归档的增量脚本
└── tools/                      端到端冒烟测试脚本（Node，不参与运行时）
```

---

## 四、快速开始

### 0. 前置

| 依赖 | 版本 | 必需 |
|---|---|---|
| JDK | 17+ | ✅ |
| Maven | 3.8+ | ✅ |
| MySQL | 8.0 | ✅ |
| Redis | 任意较新版本 | ⭕ 可选，缺失时热搜降级为数据库查询、限流放行 |
| Node.js | 18+ | ⭕ 仅跑 `tools/` 下的冒烟脚本时需要 |

### 1. 建库并导入种子数据

```bash
mysql -uroot -p < src/main/resources/db/schema.sql
mysql -uroot -p kalimba_workshop < src/main/resources/db/data.sql
```

`schema.sql` 自带 `CREATE DATABASE IF NOT EXISTS kalimba_workshop`，无需手工建库。
种子数据里的账号密码均为 BCrypt 哈希，明文是 `123456`。

> 表结构有更新时，按 `src/main/resources/db/migrations/` 下**日期顺序**手动执行增量脚本。

### 2. 配置

```bash
cp src/main/resources/application-example.yml src/main/resources/application.yml
```

然后填三处：

| 项 | 说明 |
|---|---|
| `spring.datasource.url / username / password` | 本地 MySQL 连接 |
| `sa-token.jwt-secret-key` | JWT 签名密钥，用 `openssl rand -base64 48` 生成，**不要手写、不要提交** |
| `kalimba.cors.allowed-origins` | 前端来源白名单，默认 `http://localhost:5173,http://127.0.0.1:5173`；`web-vue` 的 dev 端口是 **5174**，走 Vite 代理时不需要改 |

`application.yml` 已被 `.gitignore` 忽略，仓库里只有 `application-example.yml` 模板。
也可以用环境变量注入（模板里已经写成 `${KAL_JWT_SECRET}` 占位）：

```powershell
# Windows PowerShell
$env:KAL_JWT_SECRET = "<生成的密钥>"
```

### 3. 启动

```bash
mvn spring-boot:run          # 默认 8080
# 或
mvn clean package && java -jar target/kalimba-workshop-backend-1.0.0.jar
```

验证：

- 接口文档 <http://localhost:8080/swagger-ui.html>
- 任一接口应返回统一包裹体，例如 `GET /api/hot`

### 4. 前端联调

前端在 `web-vue` 仓库，`npm run dev` 后监听 `5174`，通过 Vite 代理把 `/api` 与 `/uploads` 转发到 `8080`。
代理会**主动去掉 `Origin` 头**——后端 CORS 白名单按来源逐条配置，新端口会被判 `Invalid CORS request`（403）。

---

## 五、接口约定

### 统一响应体

```json
{ "code": 0, "message": "ok", "data": {} }
```

- 业务错误**一律 HTTP 200**，成败只看 `body.code`
- 认证令牌放在**自定义请求头 `sa-token`**（不是 `Authorization: Bearer`，也不是 Cookie）
- `code === 2001` 表示未登录或令牌过期，前端据此静默续期一次再重放

### 错误码分区

| 区间 | 含义 | 示例 |
|---|---|---|
| `1xxx` | 参数与通用 | `1003` 操作过于频繁 |
| `2xxx` | 认证与用户 | `2003` 用户名或密码错误、`2004` 账号已封禁 |
| `3xxx` | 内容 | `3002` 内容包含不允许的词汇 |
| `4xxx` | 互动 | `4001` 已经点过赞了 |
| `5xxx` | 文件 | `5001` 文件超出大小限制、`5003` 该乐谱暂不可下载 |
| `6xxx` | 管理 | `6001` 需要管理员权限 |

### 附件访问

- **图片**（`/uploads/img/**`）挂成静态资源，免鉴权：`<img>` 发不出自定义请求头，只能直出
- **乐谱**（`/api/files/{id}`）必须带令牌：若把 `/uploads/score/**` 也挂成静态资源，等于开了一条绕过登录的旁路
- 上传限制：单文件 `5MB`，单请求 `20MB`

---

## 六、数据模型

`schema.sql` 共 12 张表：

| 表 | 用途 |
|---|---|
| `user` | 账号、昵称、简介、琴型（17/21 键）、角色、封禁状态 |
| `post` | 帖子：标题、正文、正文块 JSON、封面、标签、乐谱附件、计数、状态 |
| `comment` | 评论与回复（`parent_id` 自关联），软删除 |
| `like_record` | 点赞（`target_type` 区分帖子/评论，唯一键防重复） |
| `favorite` | 收藏 |
| `follow` | 关注关系 |
| `tag` | 标签 |
| `score_file` | 乐谱附件：路径、格式、下载分级、归属 |
| `notification` | 通知 |
| `report` | 举报 |
| `op_log` | 操作审计（只增不改） |
| `search_log` | 搜索关键词按天聚合（热搜数据源） |

字符集统一 `utf8mb4`，引擎 InnoDB。

---

## 七、测试

本仓库的测试入口在 `tools/`，是**端到端冒烟脚本**（Node.js，零第三方依赖），不是单元测试：

```bash
# 前置：后端已在 8080 启动
node tools/api_smoke.js            # 基础接口连通与响应体约定
node tools/admin_api_smoke.js      # 管理端接口与权限
node tools/search_api_smoke.js     # 搜索与热搜
node tools/upload_smoke.js         # 文件上传
node tools/e2e_flow.js             # 浏览器端全流程（需要本机 Edge）
```

- 需要浏览器的脚本统一通过 `tools/browser_profile.js` 复用固定 profile 目录（`.smoke_prof`），并在启动前清扫历史残留——否则 profile 会堆积到 GB 级。
- 这些脚本覆盖「接口契约 + 页面真实交互」，但**不能替代单元测试**，见「已知边界」。

---

## 八、安全约定

- `application.yml`、`application-local.yml`、`application-prod.yml` 一律**不入库**；只入库 `application-example.yml` 模板。
- JWT 密钥、数据库口令**绝不写死进模板**；模板里统一用 `${KAL_JWT_SECRET}` 之类的占位符。
- 密钥一旦进入提交历史，即使后续删除文件也仍然可见——**泄露过的密钥应当轮换**，而不是只删文件。
- CORS 白名单按来源逐条配置，不使用 `*`。

---

## 九、已知边界

- **缺少单元测试**：目前靠 `tools/` 的冒烟脚本 + 前端产物链校验覆盖，没有 JUnit 用例。
- **文件存本地磁盘**：`kalimba.upload.dir`（默认 `./uploads`），生产环境建议换对象存储，并由 Nginx 只放行 `/uploads/img/`。
- **单体应用**：全部模块同进程部署，未做服务拆分；这是当前数据量下的刻意取舍。
- **Redis 非强依赖**：热搜与限流降级可用，但热点统计精度会下降。

---

## 十、相关链接

- 前端门户（Vue 3）：<https://github.com/thetides45/Kalimba-WorkShop-web-vue>
- 制谱内核构建链：<https://github.com/thetides45/Kalimba-WorkShop-frontend>
