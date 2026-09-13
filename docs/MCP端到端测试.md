# CubeBuddy 原生 MCP 端到端测试

## 目标

测试原生 Streamable HTTP MCP 的协议兼容性、鉴权、安全边界、工具契约、真实数据查询、错误处理和并发稳定性。测试使用官方 TypeScript MCP Client，不通过 AnythingMCP 或 OpenAPI 转换器。

## 测试矩阵

| 类别 | 验收内容 |
| --- | --- |
| 鉴权 | 缺失 JWT、无效 JWT、有效 JWT、撤销 JWT、跨 MCP Server 使用 JWT |
| 模型隔离 | `cube_meta` 仅返回绑定模型；查询、预检和搜索拒绝未绑定模型成员 |
| 安全 | 拒绝不受信任 Origin；JWT 不写入测试日志和仓库 |
| 协议 | Streamable HTTP 初始化、畸形 JSON、会话生命周期 |
| 工具目录 | 六个工具名称、标题、说明、输入/输出 Schema、只读与幂等注解 |
| 业务链路 | `cube_meta` → `cube_meta_detail` → `cube_glossary_resolve` → `cube_search` → `cube_dry_run` → `cube_load` |
| 业务问题 | “机构 A有哪些数据”：识别元数据目录模型，以 `is_report = 是` 查询发布名称、数源部门和数据类型 |
| 可选参数 | `cache` 为 load 顶层参数；`responseFormat` 位于 query 内；输出 `queryType` 可选 |
| 输入边界 | 缺失必填参数、字符串 query、超限 limit、未知 cache 策略 |
| 错误边界 | 不存在的 member、未知工具；错误后会话仍可继续使用 |
| 并发 | 同一客户端并发执行八个只读调用 |
| 接口边界 | OpenAPI 保持五个操作；`cube_dry_run` 只由原生 MCP 暴露 |

令牌签发、摘要存储、撤销和旧明文令牌迁移另由 `test/mcp/server-integration.test.mjs` 覆盖。

## 执行

```bash
MCP_ENDPOINT='https://cube.example.com/mcp/<server-id>' \
MCP_TOKEN='<一次性 CubeBuddy JWT>' \
npm run test:mcp:e2e
```

测试程序不会输出 JWT。生产验收建议从“MCP 管理 → 服务密钥”签发短期测试令牌，执行后立即撤销。旧 `/mcp` 入口仅对应 `default` MCP Server。

本地环境若未加载生产模型，协议、鉴权和工具契约测试仍可通过，但依赖 `catalog_items` 的业务数据验收会明确失败；这表示测试数据环境不完整，不应被当作全量生产验收通过。
