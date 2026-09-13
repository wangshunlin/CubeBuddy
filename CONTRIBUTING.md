# Contributing to Cube Console

感谢你参与 Cube Console。提交代码前，请先搜索已有 Issue；较大的功能或兼容性变更建议先创建 Issue 讨论范围。

## 开发流程

1. Fork 仓库并从 `main` 创建功能分支，例如 `feat/glossary-import` 或 `fix/mcp-auth`。
2. 使用 `npm ci` 安装锁定版本的依赖。
3. 修改代码并补充相应测试与文档。
4. 提交前运行 `npm test`。
5. 创建 Pull Request，说明问题、解决方案、兼容性影响和验证方式。

## 本地配置

从 `.env.example` 创建本地 `.env`。只能使用隔离的开发数据库和测试凭证；`.env`、`state/`、日志、数据库导出以及生产配置不得提交。

如需验证 Compose：

```bash
cp .env.example .env
docker compose -f compose.yml -f compose.build.yml --env-file .env up -d --build
```

## Pull Request 要求

- 每个 PR 聚焦一个主题，避免夹带无关格式化。
- 行为变化应包含测试；用户可见变化应同步更新 README 或相关文档。
- 不得提交真实令牌、密码、内部地址、客户名称、生产日志或未经授权的数据。
- 新增依赖时说明用途，并确认其许可证与 Apache-2.0 分发兼容。

提交贡献即表示你同意按本仓库的 Apache License 2.0 对贡献进行许可。
