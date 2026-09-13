# CubeBuddy

[简体中文](./README.md) | English

A lightweight semantic-layer console and AI data access gateway for Cube Core.

CubeBuddy brings data source configuration, Cube YAML modeling, business terminology, native MCP, OpenAPI, and Docker Compose deployment into one self-hosted workspace. It helps teams turn database capabilities into discoverable, constrained, and traceable data tools for AI clients.

> **Status: Community Preview**  
> This is not an official Cube Dev product and does not represent Cube Dev. Refer to the [official Cube documentation](https://docs.cube.dev/) for Cube Core capabilities, compatibility, and licensing.

## Highlights and advantages

Compared with direct database access for agents, generic protocol-conversion gateways, or administration products centered on visual consumption, CubeBuddy focuses on the complete path from business definitions to controlled queries:

- **Agents query business models instead of guessing SQL**: measures, dimensions, and joins are defined once in the semantic model, reducing repeated interpretation of schemas and calculation rules.
- **Native MCP contracts**: the Streamable HTTP server uses the official TypeScript SDK. Each of its six read-only tools has a dedicated input and output schema and does not depend on the quality of an OpenAPI-to-MCP conversion.
- **Agent-oriented discovery flow**: clients are guided through `cube_meta → cube_meta_detail → cube_dry_run → cube_load` to discover and validate real members before querying.
- **Isolation per MCP Server**: every server can have its own semantic-model allowlist, instructions, and service keys. The allowlist is enforced during metadata discovery, search, dry runs, and queries.
- **A bridge between business language and technical models**: a standard term can have multiple aliases, allowing Chinese phrases, abbreviations, and business expressions to be normalized before a query.
- **Configuration-to-runtime workflow**: data source testing, model editing, YAML validation, application, query verification, and log inspection are available in one interface, with automatic backups before important writes.
- **Two integration surfaces, one semantic model**: native MCP serves AI agents while static OpenAPI/REST supports conventional integrations; both use the same business definitions.
- **Designed for self-hosted and offline environments**: Docker Compose and directory mounts keep code separate from runtime state and make deployments portable across local, server, and restricted-network environments.

These choices build on public specifications for centralized semantic models, MCP tool schemas and Streamable HTTP, and machine-readable OpenAPI contracts. See [Design references](#design-references).

## Features

- Configure and test MySQL/MariaDB and PostgreSQL data sources.
- Inspect databases, tables, and columns, then generate draft Cube YAML models.
- Edit dimensions, measures, joins, and YAML; validate and apply models to Cube.
- Search, import, and export Chinese business terms and aliases.
- Create multiple native MCP Servers, bind models, and issue revocable JWTs.
- Expose six read-only MCP tools: `cube_meta`, `cube_meta_detail`, `cube_glossary_resolve`, `cube_search`, `cube_dry_run`, and `cube_load`.
- Inspect, import, and export static OpenAPI contracts and use REST compatibility endpoints.
- Inspect Cube container status and raw logs, with recent query events derived from those logs.
- Build locally, deploy privately, and migrate state with Docker Compose.

## Architecture

~~~text
Browser · Admin UI :18081 ────────┐
AI client · /mcp/<server-id> ─────┼──▶ cube_gateway
REST/OpenAPI client · :18080 ─────┘          │
                                             ▼
                              ┌──────────────────────────────┐
                              │        cube_console          │
                              │ Sources / Models / Terms     │
                              │ Native MCP + server/JWT/model│
                              │ isolation + REST/OpenAPI     │
                              └──────────────┬───────────────┘
                                             │ http://cube_api:4000
                                             ▼
                              ┌──────────────────────────────┐
                              │          Cube Core           │
                              │ Models / Queries / Rollups    │
                              └──────────────┬───────────────┘
                                             ▼
                                         SQL database

Runtime configuration and semantic assets live in .env and state/. The Gateway
also sends health checks and Cube API paths not handled by CubeBuddy directly to
Cube Core.
~~~

MCP is part of the architecture because it is CubeBuddy's primary runtime interface for AI clients, not an auxiliary documentation format. The Gateway exposes `18080` for MCP, Cube APIs, and OpenAPI, and `18081` for the admin console by default.

## Quick start

### Requirements

- Git 2.30+
- Docker Engine 24+
- Docker Compose v2
- An accessible MySQL/MariaDB or PostgreSQL database
- Available ports `18080` and `18081`

Docker-only deployment does not require Node.js on the host. Local development requires Node.js 22 or 24.

### 1. Clone

~~~bash
git clone https://github.com/wangshunlin/cubebuddy.git
cd cubebuddy
~~~

The project is still a community preview. Once stable Releases are available, production deployments should pin a Release tag. Until then, pin a tested commit SHA.

### 2. Configure

~~~bash
cp .env.example .env
chmod 600 .env
~~~

Set at least these values in `.env`:

~~~env
CUBE_PUBLIC_BASE=http://127.0.0.1:18080
CONSOLE_PUBLIC_BASE=http://127.0.0.1:18081
CUBE_UI_ADMIN_TOKEN=replace-with-a-random-admin-token
CUBEJS_API_SECRET=replace-with-a-random-long-secret

CUBEJS_DB_TYPE=mysql
CUBEJS_DB_HOST=database-host
CUBEJS_DB_PORT=3306
CUBEJS_DB_NAME=database-name
CUBEJS_DB_USER=database-user
CUBEJS_DB_PASS=database-password
~~~

You can run `openssl rand -hex 32` twice to generate two independent secrets. Do not reuse the examples.

### 3. Start

~~~bash
mkdir -p state/schema state/modules state/glossary state/openapi
docker compose -f compose.yml -f compose.build.yml --env-file .env up -d --build
~~~

Inspect the deployment:

~~~bash
docker compose --env-file .env ps
docker compose --env-file .env logs -f cube_console
~~~

Default endpoints:

| Service | URL |
| --- | --- |
| Admin console | `http://127.0.0.1:18081` |
| Cube API / MCP | `http://127.0.0.1:18080` |
| OpenAPI | `http://127.0.0.1:18080/openapi.yaml` |
| Gateway health | `http://127.0.0.1:18080/gateway-healthz` |
| Cube readiness | `http://127.0.0.1:18080/readyz` |

## Configuration and state

### Main environment variables

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `GATEWAY_CUBE_PORT` | External port for MCP, Cube API, and OpenAPI | `18080` |
| `GATEWAY_CONSOLE_PORT` | Admin console port | `18081` |
| `CUBE_PUBLIC_BASE` | External MCP, OpenAPI, and API base URL | `http://127.0.0.1:18080` |
| `CONSOLE_PUBLIC_BASE` | External console URL | `http://127.0.0.1:18081` |
| `MCP_ALLOWED_HOSTS` | Allowed Host values for native MCP | Explicitly configure for public deployments |
| `MCP_ALLOWED_ORIGINS` | Allowed browser Origin values for native MCP | Explicitly configure for public deployments |
| `CUBE_IMAGE` | Cube Core image | `cubejs/cube:v1.7.25` |
| `CONSOLE_IMAGE` | CubeBuddy console image | `cube-console:local` |
| `CUBE_UI_ADMIN_TOKEN` | Admin API and console login token | Required |
| `CUBEJS_API_SECRET` | Cube JWT signing secret | Required |
| `CUBE_DEPLOY_HOST_DIR` | Runtime state directory on the host | `./state` |
| `CUBEJS_DB_*` | Default data source connection | Environment-specific |

See [`.env.example`](./.env.example) for the full template.

### File boundaries

~~~text
Git (public)                       Deployment state (never commit)
├── server/                       ├── .env
├── public/                       └── state/
├── server/openapi/openapi.yaml       ├── schema/
├── examples/                         ├── glossary/
└── compose.yml                       ├── openapi/
                                      └── datasources.json
~~~

- The root `.env` is the configuration source for Compose.
- `state/` contains deployed models, terms, data sources, token digests, and the final OpenAPI document.
- When configuration changes through the console, it maintains `state/.env` and synchronizes the `.env` used by Compose. Never commit either file.
- `server/openapi/openapi.yaml` is the built-in template. It is copied to `state/openapi/openapi.yaml` on first startup. When the runtime file exists, only its first `servers.url` is updated; template changes are not merged automatically.
- Put public, sanitized model and glossary samples in `examples/`. Back up production assets to controlled private storage.

## Native MCP

Create a Server, bind semantic models, and issue a dedicated key under **System → MCP Management**:

~~~text
http://deployment-host:18080/mcp/<server-id>
~~~

The transport is Streamable HTTP. Clients authenticate with:

~~~http
Authorization: Bearer <CubeBuddy JWT>
~~~

Each JWT can access only its MCP Server. The model allowlist is checked during metadata discovery, model details, dimension search, dry runs, and queries. The legacy `/mcp` path maps to the `default` Server.

## OpenAPI and REST

The runtime OpenAPI document is available at:

~~~text
http://deployment-host:18080/openapi.yaml
~~~

This static, importable and exportable document describes five operations: model discovery, model details, queries, dimension search, and terminology resolution. The console can inspect, import, export, and reload the document, but it does not provide per-tool route toggles. Complex-query validation is available through the native MCP `cube_dry_run` tool.

## Authentication boundaries

| Interface | Authentication |
| --- | --- |
| Console login and `/api/*` admin APIs | `CUBE_UI_ADMIN_TOKEN` |
| `/mcp` and `/mcp/<server-id>` | CubeBuddy JWT for that MCP Server |
| Cube query compatibility endpoints | Cube JWT / CubeBuddy JWT |
| `/openapi.yaml` and `/openapi.json` | Public by default |
| `/healthz`, `/readyz`, `/livez`, `/gateway-healthz` | Public by default |

The full service token is returned only when issued; the server persists its digest. Revoking an MCP Server token immediately blocks it from that Server. Rotating `CUBEJS_API_SECRET` invalidates existing JWTs.

## Production security

- Public deployments must use HTTPS. Plain HTTP with an IP address is appropriate only on a trusted, isolated network.
- Explicitly set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`.
- Expose only the Gateway; do not map container ports `4000` or `4010` directly.
- The console can access the Docker Socket, which grants powerful host capabilities. Restrict network access to port `18081` and never share the admin token with untrusted users.
- Follow least privilege for database users; prefer a read-only account in production.
- Never commit `.env`, `state/`, logs, database exports, or backups.
- The community preview contains a maintainer-oriented deployment script for one cloud environment. It requires explicit target host, MCP endpoint, and smoke-test model settings and is not a generic one-command deployment path.

## Local development and verification

~~~bash
npm ci
npm test
~~~

`npm test` runs the TypeScript build, JavaScript syntax checks, MCP tests, OpenAPI validation, release configuration checks, and the public-file scanner.

To run only the console, prepare a writable state directory and an accessible Cube API:

~~~bash
export CUBE_DEPLOY_DIR=/path/to/state
export CUBE_API_BASE=http://127.0.0.1:4000
export CUBE_PUBLIC_BASE=http://127.0.0.1:18080
export CUBE_UI_ADMIN_TOKEN=local-dev-token
export PORT=4010
npm start
~~~

Use an isolated database and a separate `state/` during development. Never use production credentials.

## Known limitations

- The community preview does not yet have a stable Release tag.
- Console-assisted introspection and model generation currently target MySQL/MariaDB and PostgreSQL. Other Cube data sources require manually maintained models and runtime configuration.
- Query events are derived from Cube runtime logs; they are not a persistent audit database.
- Existing runtime OpenAPI files do not automatically merge template changes after an image upgrade.

## Contributing and security

- Development workflow: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security reports: [SECURITY.md](./SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- Offline deployment (Chinese): [docs/README-离线部署.md](./docs/README-离线部署.md)
- MCP end-to-end tests (Chinese): [docs/MCP端到端测试.md](./docs/MCP端到端测试.md)

## Design references

- [Cube semantic-layer introduction](https://docs.cube.dev/docs/introduction): centralized measures, dimensions, relationships, access control, and APIs.
- [Cube AI Context](https://docs.cube.dev/docs/data-modeling/ai-context): descriptions and context that improve an agent's understanding of a semantic model.
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): HTTP transport, Origin validation, and authentication requirements.
- [MCP Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tool discovery, input/output schemas, and structured results.
- [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html): a machine-readable REST interface description.

## License

Licensed under the [Apache License 2.0](./LICENSE). Third-party components remain subject to their respective licenses.
