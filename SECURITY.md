# Security Policy

## Supported versions

安全修复优先应用于最新正式 Release 和 `main`。较早版本可能需要先升级后才能获得修复。

## Reporting a vulnerability

请不要通过公开 Issue、Discussion 或 Pull Request 披露尚未修复的漏洞、凭证或生产环境信息。

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能，提供：

- 受影响版本或 Commit；
- 最小化复现步骤和影响说明；
- 必要时提供已脱敏的日志；
- 可行的缓解或修复建议。

维护者确认问题并准备修复前，请避免公开漏洞细节。若仓库尚未启用 GitHub 私密漏洞报告，请先通过维护者 GitHub 个人资料中公开的联系方式沟通，且不要发送真实生产凭证。

## Deployment responsibility

Cube Console 可以管理数据库连接、令牌并访问 Docker Socket。公网部署时应启用 HTTPS、限制网络访问、使用高强度独立密钥，并及时更新基础镜像和依赖。部署方负责其数据库权限、网络边界、备份和密钥生命周期。
