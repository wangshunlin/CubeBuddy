# CubeBuddy

简体中文 | [English](./README.en.md)

面向 Cube Core 的轻量级语义层配置台与 AI 数据访问网关。

CubeBuddy 将数据源配置、Cube YAML 语义建模、业务术语、原生 MCP、OpenAPI 和 Docker Compose 部署整合在一个可自托管的工作台中，帮助团队把数据库能力转换成可发现、可约束、可追踪的 AI 数据工具。

> **状态：社区预览版**  
> 本项目不是 Cube Dev 官方产品，也不代表 Cube Dev。Cube Core 的能力、版本兼容性和许可证以 [Cube 官方文档](https://docs.cube.dev/) 为准。

## 特色与优势

与直接让 Agent 连接数据库、只做协议转换的通用网关或偏重可视化消费的管理工具相比，CubeBuddy 更关注“从业务定义到安全查询”的完整链路：

- **让 Agent 查询业务模型，而不是猜 SQL**：指标、维度和关联由语义模型统一定义，减少不同客户端重复解释表结构和计算口径。
- **原生 MCP 契约**：基于官方 TypeScript SDK 提供 Streamable HTTP 服务，六个只读工具分别定义输入和输出 Schema，不依赖 OpenAPI 到 MCP 的二次转换质量。
- **面向 Agent 的发现流程**：引导客户端按 `cube_meta → cube_meta_detail → cube_dry_run → cube_load` 的顺序发现并验证真实成员，降低字段猜测和无效重试。
- **MCP Server 级隔离**：每个 Server 可绑定独立语义模型集合、说明和服务密钥；服务端在元数据、搜索、预检和查询阶段持续执行模型白名单校验。
- **业务语言与技术模型衔接**：业务术语支持一个标准术语对应多个别名，可在查询前把中文口语、简称和业务表达解析为标准值。
- **配置、验证和运行闭环**：在同一界面完成数据源测试、模型编辑、YAML 校验、应用、查询验证和日志排查，写入前自动备份关键文件。
- **双接口并存**：原生 MCP 面向 AI Agent，静态 OpenAPI/REST 面向传统集成；两条路径共享同一语义层，而不是维护两套业务定义。
- **适合私有化与离线环境**：采用 Docker Compose 和目录挂载，代码与环境状态分离，可在本地、服务器和受限网络中迁移部署。

这些设计建立在语义层“集中定义指标与关系”、MCP 工具 Schema 和 Streamable HTTP、OpenAPI 标准接口描述等公开规范之上。相关依据见[设计参考](#设计参考)。

## 功能概览

- 管理并测试 MySQL/MariaDB、PostgreSQL 数据源连接。
- 读取数据库、表和字段，为 Cube 生成 YAML 语义模型草稿。
- 编辑维度、指标、关联及 YAML，校验后应用到 Cube。
- 维护、搜索、导入和导出中文业务术语及别名。
- 创建多个原生 MCP Server，绑定模型并签发可撤销的专属 JWT。
- 提供 `cube_meta`、`cube_meta_detail`、`cube_glossary_resolve`、`cube_search`、`cube_dry_run` 和 `cube_load` 六个只读 MCP 工具。
- 查看、导入、导出静态 OpenAPI，并通过 REST 兼容接口访问语义层。
- 查看 Cube 容器状态和原始日志，并从日志中提取近期查询事件。
- 使用 Docker Compose 进行本地构建、私有化部署和状态迁移。

## 架构

~~~text
浏览器 · 配置台 :18081 ─────────┐
AI 客户端 · /mcp/<server-id> ──┼──▶ cube_gateway
REST/OpenAPI 客户端 · :18080 ──┘          │
                                          ▼
                           ┌──────────────────────────────┐
                           │        cube_console          │
                           │ 数据源 / 模型 / 术语 / 密钥   │
                           │ 原生 MCP + Server/JWT/模型隔离 │
                           │ REST/OpenAPI 鉴权代理         │
                           └──────────────┬───────────────┘
                                          │ http://cube_api:4000
                                          ▼
                           ┌──────────────────────────────┐
                           │          Cube Core           │
                           │ 语义模型 / 查询 / 预聚合      │
                           └──────────────┬───────────────┘
                                          ▼
                                      SQL 数据库

运行配置和语义资产保存在 .env 与 state/；Gateway 也会把健康检查和未被
CubeBuddy 接管的 Cube API 路径直接转发给 Cube Core。
~~~

MCP 位于架构图中，因为它不是附属文档格式，而是 CubeBuddy 面向 AI 客户端的主要运行时接口。Gateway 默认暴露 `18080`（MCP、Cube API、OpenAPI）和 `18081`（配置台）。

## 首次部署与首次登录

### 前置条件

- Git 2.30+
- Docker Engine 24+
- Docker Compose v2
- 至少一个可访问的 MySQL/MariaDB 或 PostgreSQL 数据库
- 可用端口：`18080` 和 `18081`

仅使用 Docker 部署时不要求宿主机安装 Node.js。本地开发需要 Node.js 22 或 24。

### 1. 获取代码

~~~bash
git clone https://github.com/wangshunlin/CubeBuddy.git
cd CubeBuddy
~~~

当前仍处于社区预览阶段。正式 Release 发布后，生产环境应检出明确的 Release Tag；在此之前请使用经过测试的 Commit SHA。

### 2. 创建配置并生成首次登录令牌

~~~bash
cp .env.example .env
chmod 600 .env
~~~

管理员令牌不是项目提供的默认密码，而是由部署者自行创建。先生成两个彼此独立的随机值；**妥善保存第一个值**，它就是首次登录配置台时要输入的管理员令牌。

~~~bash
ADMIN_TOKEN="$(openssl rand -hex 32)"
CUBE_SECRET="$(openssl rand -hex 32)"
printf '管理员令牌（首次登录使用）：%s\nCube 签名密钥：%s\n' "$ADMIN_TOKEN" "$CUBE_SECRET"
~~~

编辑 `.env`，至少设置（将下方尖括号内容替换为上一步输出的实际值）：

~~~env
CUBE_PUBLIC_BASE=http://127.0.0.1:18080
CONSOLE_PUBLIC_BASE=http://127.0.0.1:18081
CUBE_UI_ADMIN_TOKEN=<ADMIN_TOKEN 的值>
CUBEJS_API_SECRET=<CUBE_SECRET 的值>

CUBEJS_DB_TYPE=mysql
CUBEJS_DB_HOST=数据库地址
CUBEJS_DB_PORT=3306
CUBEJS_DB_NAME=数据库名称
CUBEJS_DB_USER=数据库用户
CUBEJS_DB_PASS=数据库密码
~~~

不要提交 `.env`，不要把 `CUBE_UI_ADMIN_TOKEN` 或 `CUBEJS_API_SECRET` 发给他人。首次部署也可以暂时不填数据库信息，随后在配置台的“数据源”页面配置。

### 3. 启动并验证

~~~bash
mkdir -p state/schema state/modules state/glossary state/openapi
docker compose -f compose.yml -f compose.build.yml --env-file .env up -d --build
~~~

查看状态：

~~~bash
docker compose -f compose.yml -f compose.build.yml --env-file .env ps
docker compose -f compose.yml -f compose.build.yml --env-file .env logs -f cube_console
~~~

默认地址：

| 服务 | 地址 |
| --- | --- |
| 配置台 | `http://127.0.0.1:18081` |
| Cube API / MCP | `http://127.0.0.1:18080` |
| OpenAPI | `http://127.0.0.1:18080/openapi.yaml` |
| Gateway 健康检查 | `http://127.0.0.1:18080/gateway-healthz` |
| Cube 就绪检查 | `http://127.0.0.1:18080/readyz` |

`gateway-healthz` 返回成功且 `cube_console`、`cube_api` 处于运行状态后，再继续登录。若从另一台机器访问，请将 `127.0.0.1` 替换为部署机地址；公网场景请使用 HTTPS 域名，见[生产部署安全](#生产部署安全)。

### 4. 首次登录配置台

打开 `http://部署机地址:18081`，在登录页输入第 2 步生成的 **`ADMIN_TOKEN` 值**（也就是 `.env` 中的 `CUBE_UI_ADMIN_TOKEN`）。该令牌用于配置台和 `/api/*` 管理接口，不是 MCP 客户端使用的服务密钥。

令牌丢失时，在 `.env` 中设置一个新的 `CUBE_UI_ADMIN_TOKEN`，然后重建配置台容器：

~~~bash
docker compose -f compose.yml -f compose.build.yml --env-file .env up -d --force-recreate cube_console
~~~

旧管理员令牌会立即失效。不要为了找回令牌而修改 `CUBEJS_API_SECRET`；轮换后者会使已签发的 MCP/Cube JWT 失效。

### 5. 完成首次业务配置

登录后按以下顺序完成最小可用配置：

1. 在“数据源”中测试并保存数据库连接；生产数据库账号应遵循最小权限，优先使用只读账号。
2. 在“语义模型”中创建或导入 YAML，并执行校验和应用。
3. 在“业务术语”中按需导入术语和别名。
4. 如需供 AI 客户端调用，在“系统 → MCP 管理”创建 MCP Server、绑定语义模型，并签发专属服务密钥。

每个 MCP 服务密钥只在签发时完整显示，请立刻保存到调用方的受控密钥库；需要时可撤销并重新签发。

## 配置与状态

### 主要环境变量

| 变量 | 作用 | 默认/示例 |
| --- | --- | --- |
| `GATEWAY_CUBE_PORT` | MCP、Cube API、OpenAPI 对外端口 | `18080` |
| `GATEWAY_CONSOLE_PORT` | 配置台端口 | `18081` |
| `CUBE_PUBLIC_BASE` | MCP、OpenAPI 和 API 的外部基础地址 | `http://127.0.0.1:18080` |
| `CONSOLE_PUBLIC_BASE` | 配置台外部地址 | `http://127.0.0.1:18081` |
| `MCP_ALLOWED_HOSTS` | 原生 MCP Host 白名单 | 建议公网部署显式配置 |
| `MCP_ALLOWED_ORIGINS` | 浏览器 MCP Origin 白名单 | 建议公网部署显式配置 |
| `CUBE_IMAGE` | Cube Core 镜像 | `cubejs/cube:v1.7.25` |
| `CONSOLE_IMAGE` | CubeBuddy 配置台镜像 | `cube-console:local` |
| `CUBE_UI_ADMIN_TOKEN` | 管理接口和配置台登录令牌 | 必填 |
| `CUBEJS_API_SECRET` | Cube JWT 签名密钥 | 必填 |
| `CUBE_DEPLOY_HOST_DIR` | 宿主机状态目录 | `./state` |
| `CUBEJS_DB_*` | 默认数据源连接 | 按环境设置 |

完整模板见 [`.env.example`](./.env.example)。

### 文件边界

~~~text
Git（可公开）                    部署环境（不进入 Git）
├── server/                     ├── .env
├── public/                     └── state/
├── server/openapi/openapi.yaml     ├── schema/
├── examples/                       ├── glossary/
└── compose.yml                     ├── openapi/
                                    └── datasources.json
~~~

- 根目录 `.env` 是 Compose 的环境配置源。
- `state/` 保存当前部署的模型、术语、数据源、令牌摘要和最终 OpenAPI。
- 配置台修改环境时会维护 `state/.env`，并同步 Compose 使用的 `.env`；不要手工把两份文件提交到 Git。
- `server/openapi/openapi.yaml` 是内置模板。首次启动时复制到 `state/openapi/openapi.yaml`；文件已经存在时仅更新第一个 `servers.url`，不会自动合并新模板内容。
- 可公开的脱敏模型或术语示例放入 `examples/`，生产资产使用受控私有存储备份。

## 原生 MCP

在“系统 → MCP 管理”中创建 Server、绑定语义模型并签发专属密钥：

~~~text
http://部署机IP:18080/mcp/<server-id>
~~~

传输协议为 Streamable HTTP，客户端使用：

~~~http
Authorization: Bearer <CubeBuddy JWT>
~~~

每个 JWT 仅能访问所属 MCP Server。服务端在元数据发现、模型详情、维度搜索、预检和实际查询时校验模型白名单。旧 `/mcp` 路径是 `default` Server 的兼容入口。

## OpenAPI 与 REST

运行时 OpenAPI 地址：

~~~text
http://部署机IP:18080/openapi.yaml
~~~

该文件是静态、可导入导出的最终接口描述，包含五个操作：模型发现、模型详情、查询、维度搜索和术语解析。配置台支持查看、导入、导出和重新读取，但不提供逐工具路由开关。复杂查询预校验由原生 MCP 的 `cube_dry_run` 提供。

## 鉴权边界

| 接口 | 鉴权方式 |
| --- | --- |
| 配置台登录和 `/api/*` 管理接口 | `CUBE_UI_ADMIN_TOKEN` |
| `/mcp`、`/mcp/<server-id>` | 对应 MCP Server 的 CubeBuddy JWT |
| Cube 查询兼容接口 | Cube JWT / CubeBuddy JWT |
| `/openapi.yaml`、`/openapi.json` | 默认公开 |
| `/healthz`、`/readyz`、`/livez`、`/gateway-healthz` | 默认公开 |

配置台完整令牌只在签发时返回；服务端持久化摘要。撤销 MCP Server 令牌会立即阻止该令牌继续访问对应 Server。轮换 `CUBEJS_API_SECRET` 会使现有 JWT 失效。

## 生产部署安全

- 公网部署必须使用 HTTPS；IP + HTTP 仅适用于受信任的隔离网络。
- 公网部署应将对外地址和 MCP 白名单改为自己的域名，例如：

  ~~~env
  CUBE_PUBLIC_BASE=https://cube.example.com
  CONSOLE_PUBLIC_BASE=https://console.example.com
  MCP_ALLOWED_HOSTS=cube.example.com
  MCP_ALLOWED_ORIGINS=chatgpt.com,claude.ai
  ~~~

  示例域名仅作说明；按实际反向代理和客户端来源调整。`MCP_ALLOWED_HOSTS` 不应保留不需要的公共主机名。
- 只通过 Gateway 暴露服务，不直接映射容器的 `4000` 或 `4010`。
- 配置台可以访问 Docker Socket，相当于拥有很高的宿主机权限。应限制 `18081` 的网络访问，并避免向不受信任用户开放管理令牌。
- 数据库账号遵循最小权限原则，生产环境优先使用只读账号。
- `.env`、`state/`、日志、数据库导出和备份不得进入公开 Git。
- 当前社区预览版包含面向维护者的阿里云发布脚本。它要求显式设置目标主机、MCP 地址和烟测模型，不是通用的一键部署入口。

## 本地开发与验证

~~~bash
npm ci
npm test
~~~

`npm test` 会执行 TypeScript 构建、JavaScript 语法检查、MCP 测试、OpenAPI 校验、发布配置检查和公开文件扫描。

直接启动配置台需要准备可写状态目录和可访问的 Cube API：

~~~bash
export CUBE_DEPLOY_DIR=/path/to/state
export CUBE_API_BASE=http://127.0.0.1:4000
export CUBE_PUBLIC_BASE=http://127.0.0.1:18080
export CUBE_UI_ADMIN_TOKEN=local-dev-token
export PORT=4010
npm start
~~~

开发时使用隔离数据库和独立 `state/`，不要使用生产凭证。

## 已知限制

- 社区预览版尚未发布稳定 Release Tag。
- 配置台自动建模和连接测试目前面向 MySQL/MariaDB 与 PostgreSQL；其他 Cube 数据源需要自行维护模型和运行配置。
- 查询事件来自 Cube 运行日志筛选，不是持久化审计数据库。
- 已存在的运行时 OpenAPI 不会在镜像升级时自动合并模板变化。

## 贡献与安全

- 开发流程：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全问题：[SECURITY.md](./SECURITY.md)
- 社区行为准则：[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- 离线部署：[docs/README-离线部署.md](./docs/README-离线部署.md)
- MCP 端到端测试：[docs/MCP端到端测试.md](./docs/MCP端到端测试.md)

## 设计参考

- [Cube 语义层介绍](https://docs.cube.dev/docs/introduction)：集中定义指标、维度、关系、访问控制和 API。
- [Cube AI Context](https://docs.cube.dev/docs/data-modeling/ai-context)：通过描述和上下文提高 Agent 对语义模型的理解。
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：MCP HTTP 传输、Origin 校验和鉴权要求。
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：工具发现、输入/输出 Schema 和结构化结果。
- [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html)：REST 接口的机器可读描述规范。

## 许可证

本项目采用 [Apache License 2.0](./LICENSE)。第三方组件分别适用其各自许可证。
