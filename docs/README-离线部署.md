# Cube Console 离线部署包

本目录对应标准化后的 Cube Console 项目：根目录使用 `compose.yml`，运行时配置使用根目录 `.env`，运行状态使用 `state/`。当前默认 Cube Core 为 `cubejs/cube:v1.7.25`。

## 文件

- 源码包：源码、根目录 Compose、Gateway 配置和部署文档。
- Docker 镜像包：按发布版本导出的 Cube Core、配置台和 Gateway 镜像。
- `.env` 和 `state/`：目标环境专属数据，不进入 Git，也不放入公共离线包。

## 内网服务器部署

```bash
install -d -m 755 /opt/cube-console
tar -xzf cube-console-source.tar.gz -C /opt/cube-console --strip-components=1
docker load -i cube-platform-images.tar.gz

cd /opt/cube-console
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，至少填写：

- `CUBE_UI_ADMIN_TOKEN`
- `CUBEJS_API_SECRET`
- `CUBEJS_DB_HOST`
- `CUBEJS_DB_NAME`
- `CUBEJS_DB_USER`
- `CUBEJS_DB_PASS`
- `CUBE_PUBLIC_BASE=http://内网IP:18080`
- `CONSOLE_PUBLIC_BASE=http://内网IP:18081`

创建状态目录并启动。由于镜像已经通过 `docker load` 导入，内网部署使用 `--no-build`，避免尝试访问 Docker Hub：

```bash
mkdir -p /opt/cube-console/state/{schema,modules,glossary,openapi}
touch /opt/cube-console/state/cube.py
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --no-build
docker compose ps
```

默认访问地址：

- 配置台：`http://内网IP:18081`
- Cube API/OpenAPI：`http://内网IP:18080`

首次进入配置台后，在“数据源”页面填写内网数据库连接；业务术语通过业务术语模块导入；语义模型在“语义模型”页面导入 YAML。最终 OpenAPI 文件随配置台镜像初始化到 `state/openapi/openapi.yaml`，并在容器启动时根据 `CUBE_PUBLIC_BASE` 写入 `servers.url`。

## 注意事项

- `.env`、数据库密码、JWT 密钥和 `state/` 不在源码包中，需要按目标环境填写。
- 如果目标环境的 Docker 版本过旧，先确认可以加载 Docker v2 镜像归档。
- 数据库地址应使用目标环境可达的内网 IP、服务名或 `host.docker.internal`，不要默认填写 `127.0.0.1`。
- 若要使用不同 Cube 版本，应重新导出对应版本镜像，并同步修改 `.env` 中的 `CUBE_IMAGE`。
