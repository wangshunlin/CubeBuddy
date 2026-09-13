#!/usr/bin/env bash
set -Eeuo pipefail

release_ref=${1:-HEAD}
release_host=${CUBE_RELEASE_HOST:?请设置 CUBE_RELEASE_HOST，例如 deploy@example.com}
runtime_dir=${CUBE_RELEASE_RUNTIME_DIR:-/opt/cube-console}
releases_dir=${CUBE_RELEASES_DIR:-/opt/cube-console-releases}
backups_dir=${CUBE_RELEASE_BACKUPS_DIR:-/opt/cube-console-deploy-backups}
state_dir=${CUBE_RELEASE_STATE_DIR:-/opt/cube-console-release-state}
cube_port=${CUBE_RELEASE_CUBE_PORT:-18180}
console_port=${CUBE_RELEASE_CONSOLE_PORT:-18181}
mcp_endpoint=${CUBE_RELEASE_MCP_ENDPOINT:?请设置 CUBE_RELEASE_MCP_ENDPOINT}
mcp_endpoint_base=$(printf '%s' "$mcp_endpoint" | sed 's:/*$::')
mcp_smoke_model=${CUBE_RELEASE_MCP_SMOKE_MODEL:?请设置 CUBE_RELEASE_MCP_SMOKE_MODEL}
primary_registry=${CUBE_RELEASE_NPM_REGISTRY:-https://registry.npmjs.org}
fallback_registry=${CUBE_RELEASE_NPM_FALLBACK_REGISTRY:-https://registry.npmmirror.com}
apk_repository=${CUBE_RELEASE_APK_REPOSITORY:-https://mirrors.aliyun.com/alpine}
ssh_keepalive_interval=${CUBE_RELEASE_SSH_KEEPALIVE_INTERVAL:-15}
ssh_keepalive_count=${CUBE_RELEASE_SSH_KEEPALIVE_COUNT:-4}

ssh() {
  command ssh -o "ServerAliveInterval=$ssh_keepalive_interval" -o "ServerAliveCountMax=$ssh_keepalive_count" -o TCPKeepAlive=yes "$@"
}

scp() {
  command scp -o "ServerAliveInterval=$ssh_keepalive_interval" -o "ServerAliveCountMax=$ssh_keepalive_count" -o TCPKeepAlive=yes "$@"
}

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ -n $(git status --porcelain) ]]; then
  echo "发布已停止：Git 工作区不干净，请先提交当前修改。" >&2
  exit 1
fi

revision=$(git rev-parse "${release_ref}^{commit}")
short_revision=$(git rev-parse --short=7 "$revision")
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
release_id="$(date -u +%Y%m%dT%H%M%SZ)-${short_revision}"
release_dir="${releases_dir}/${release_id}"
console_image="cube-console:release-${short_revision}-amd64"
gateway_image="cube-console-gateway:release-${short_revision}-amd64"
smoke_image="cube-console-mcp-smoke:${short_revision}-amd64"
remote_archive="/tmp/cube-console-${release_id}.tgz"

if [[ ${CUBE_RELEASE_SKIP_TESTS:-0} != 1 ]]; then
  npm run check
  npm run check:release
  npm run test:mcp
  npm run validate:openapi
fi

release_tmp=$(mktemp -d /tmp/cube-console-release-XXXXXX)
cleanup() {
  if [[ ${release_tmp:-} == /tmp/cube-console-release-* && -d $release_tmp ]]; then
    rm -rf "$release_tmp"
  fi
}
trap cleanup EXIT

mkdir -p "$release_tmp/source"
git archive "$revision" | tar -x -C "$release_tmp/source"
node "$release_tmp/source/scripts/release-manifest.mjs" \
  --root "$release_tmp/source" \
  --output "$release_tmp/source/release-manifest.json" \
  --revision "$revision" \
  --created-at "$created_at"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$release_tmp/release.tgz" -C "$release_tmp/source" .

for immutable_image in "$console_image" "$gateway_image"; do
  if ssh "$release_host" "docker image inspect '$immutable_image' >/dev/null 2>&1"; then
    echo "发布已停止：不可变镜像标签已存在：$immutable_image" >&2
    exit 1
  fi
done

ssh "$release_host" "set -eu; mkdir -p '$releases_dir' '$backups_dir' '$state_dir'; test ! -e '$release_dir'"
scp "$release_tmp/release.tgz" "${release_host}:${remote_archive}"
ssh "$release_host" "set -eu; mkdir '$release_dir'; tar -xzf '$remote_archive' -C '$release_dir'; rm -f '$remote_archive'; chmod -R go-w '$release_dir'"

ssh "$release_host" "set -eu; cd '$release_dir'; if ! BUILD_REVISION='$revision' BUILD_CREATED='$created_at' NPM_REGISTRY='$primary_registry' APK_REPOSITORY='$apk_repository' CONSOLE_IMAGE='$console_image' GATEWAY_IMAGE='$gateway_image' CUBE_DEPLOY_HOST_DIR='$runtime_dir/state' CUBE_CONSOLE_SOURCE_HOST_DIR='$release_dir' CUBE_COMPOSE_ENV_READ_PATH='$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH='$runtime_dir/.env' timeout 300 docker compose -f compose.yml -f compose.build.yml --env-file '$runtime_dir/.env' build cube_console cube_gateway; then echo '主 npm 镜像源构建失败，切换备用源重试' >&2; BUILD_REVISION='$revision' BUILD_CREATED='$created_at' NPM_REGISTRY='$fallback_registry' APK_REPOSITORY='$apk_repository' CONSOLE_IMAGE='$console_image' GATEWAY_IMAGE='$gateway_image' CUBE_DEPLOY_HOST_DIR='$runtime_dir/state' CUBE_CONSOLE_SOURCE_HOST_DIR='$release_dir' CUBE_COMPOSE_ENV_READ_PATH='$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH='$runtime_dir/.env' timeout 300 docker compose -f compose.yml -f compose.build.yml --env-file '$runtime_dir/.env' build cube_console cube_gateway; fi; NPM_REGISTRY='$primary_registry' timeout 300 docker build --build-arg NPM_REGISTRY='$primary_registry' --target mcp_builder -t '$smoke_image' .; test \"\$(docker image inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$console_image')\" = '$revision'; test \"\$(docker image inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$gateway_image')\" = '$revision'; docker run --rm --entrypoint sh '$console_image' -c 'test -s /app/dist/mcp/index.js && grep -q \"CubeBuddy 原生 MCP\" /app/server/server.js'; docker run --rm --entrypoint sh '$gateway_image' -c 'grep -q \"location ^~ /mcp\" /etc/nginx/nginx.conf'"

previous_console_image=$(ssh "$release_host" "docker inspect -f '{{.Config.Image}}' cube-console-cube_console-1")
previous_console_image_id=$(ssh "$release_host" "docker inspect -f '{{.Image}}' cube-console-cube_console-1")
previous_gateway_image=$(ssh "$release_host" "docker inspect -f '{{.Config.Image}}' cube-console-cube_gateway-1")
previous_gateway_image_id=$(ssh "$release_host" "docker inspect -f '{{.Image}}' cube-console-cube_gateway-1")
previous_revision=$(ssh "$release_host" "docker inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' cube-console-cube_console-1 2>/dev/null || true")
previous_compose=$(ssh "$release_host" "awk -F= '/^CUBE_RELEASE_COMPOSE=/{print \$2}' '$state_dir/current.env' 2>/dev/null || true")
if [[ -z $previous_revision ]]; then previous_revision=baseline; fi
if [[ -z $previous_compose ]]; then previous_compose="$runtime_dir/compose.yml"; fi
backup_id="$(date -u +%Y%m%dT%H%M%SZ)-before-${short_revision}"
backup_dir="${backups_dir}/${backup_id}"

ssh "$release_host" "set -eu; mkdir '$backup_dir'; cp '$runtime_dir/.env' '$backup_dir/runtime.env'; chmod 600 '$backup_dir/runtime.env'; tar -czf '$backup_dir/state.tgz' -C '$runtime_dir' state; cp '$runtime_dir/state/glossary/glossary.json' '$backup_dir/glossary.json'; printf 'CONSOLE_IMAGE=%s\nCONSOLE_IMAGE_ID=%s\nGATEWAY_IMAGE=%s\nGATEWAY_IMAGE_ID=%s\n' '$previous_console_image' '$previous_console_image_id' '$previous_gateway_image' '$previous_gateway_image_id' > '$backup_dir/image.env'"

rollback_on_failure() {
  echo "新版本验收失败，正在恢复 $previous_console_image 和 $previous_gateway_image" >&2
  ssh "$release_host" "set -eu; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CONSOLE_IMAGE '$previous_console_image'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' GATEWAY_IMAGE '$previous_gateway_image'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_DEPLOY_HOST_DIR '$runtime_dir/state'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_CONSOLE_SOURCE_HOST_DIR '$release_dir'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_COMPOSE_ENV_READ_PATH '$runtime_dir/.env'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH '$runtime_dir/.env'; cd '$release_dir'; CONSOLE_IMAGE='$previous_console_image' GATEWAY_IMAGE='$previous_gateway_image' CUBE_DEPLOY_HOST_DIR='$runtime_dir/state' CUBE_CONSOLE_SOURCE_HOST_DIR='$release_dir' CUBE_COMPOSE_ENV_READ_PATH='$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH='$runtime_dir/.env' docker compose -f compose.yml --env-file '$runtime_dir/.env' up -d --no-build --force-recreate cube_console cube_gateway; for attempt in 1 2 3 4 5 6 7 8; do console_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1 2>/dev/null || true); gateway_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1 2>/dev/null || true); test \"\$console_status\" = healthy -a \"\$gateway_status\" = healthy && break; sleep 2; done; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1)\" = healthy; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1)\" = healthy; test \"\$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${cube_port}/mcp')\" = 401"
}

if ! ssh "$release_host" "set -eu; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CONSOLE_IMAGE '$console_image'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' GATEWAY_IMAGE '$gateway_image'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_DEPLOY_HOST_DIR '$runtime_dir/state'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_CONSOLE_SOURCE_HOST_DIR '$release_dir'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_COMPOSE_ENV_READ_PATH '$runtime_dir/.env'; node '$release_dir/scripts/update-env-value.mjs' '$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH '$runtime_dir/.env'; cd '$release_dir'; CONSOLE_IMAGE='$console_image' GATEWAY_IMAGE='$gateway_image' CUBE_DEPLOY_HOST_DIR='$runtime_dir/state' CUBE_CONSOLE_SOURCE_HOST_DIR='$release_dir' CUBE_COMPOSE_ENV_READ_PATH='$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH='$runtime_dir/.env' docker compose -f compose.yml --env-file '$runtime_dir/.env' up -d --no-build --force-recreate cube_console cube_gateway; for attempt in 1 2 3 4 5 6 7 8; do console_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1 2>/dev/null || true); gateway_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1 2>/dev/null || true); test \"\$console_status\" = healthy -a \"\$gateway_status\" = healthy && break; sleep 2; done; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1)\" = healthy; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1)\" = healthy"; then
  rollback_on_failure
  exit 1
fi

if ! ssh "$release_host" "node '$release_dir/scripts/verify-deployment.mjs' --manifest '$release_dir/release-manifest.json' --container cube-console-cube_console-1 --gateway-container cube-console-cube_gateway-1 --revision '$revision' --console-port '$console_port' --cube-port '$cube_port' --glossary-state '$runtime_dir/state/glossary/glossary.json'"; then
  rollback_on_failure
  exit 1
fi

if ! ssh "$release_host" "set -eu; admin=\$(node -e 'const envfile=require(process.argv[1]);const value=envfile.read(process.argv[2]).data.CUBE_UI_ADMIN_TOKEN;if(!value)process.exit(2);process.stdout.write(value);' '$release_dir/server/lib/envfile.js' '$runtime_dir/.env'); server_id=\$(node -e 'const fs=require(\"fs\");const value=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));const servers=Array.isArray(value)?value:(value.servers||[]);const server=servers.find((item)=>item.enabled!==false&&Array.isArray(item.modelIds)&&item.modelIds.includes(process.argv[2]));if(!server)process.exit(2);process.stdout.write(server.id);' '$runtime_dir/state/mcp-servers.json' '$mcp_smoke_model'); response_file=\$(mktemp /tmp/cube-mcp-release-token-XXXXXX.json); token_id=''; cleanup_token() { if test -n \"\$token_id\"; then curl -fsS -X DELETE -H \"Authorization: Bearer \$admin\" \"http://127.0.0.1:${console_port}/api/mcp-servers/\$server_id/tokens/\$token_id\" >/dev/null 2>&1 || true; fi; rm -f \"\$response_file\"; }; trap cleanup_token EXIT; curl -fsS -o \"\$response_file\" -X POST -H \"Authorization: Bearer \$admin\" -H 'Content-Type: application/json' --data '{\"days\":1,\"purpose\":\"release-smoke\"}' \"http://127.0.0.1:${console_port}/api/mcp-servers/\$server_id/tokens\"; token=\$(node -e 'const value=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));if(!value.token||!value.record?.id)process.exit(2);process.stdout.write(value.token);' \"\$response_file\"); token_id=\$(node -e 'const value=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));process.stdout.write(value.record.id);' \"\$response_file\"); smoke_endpoint='$mcp_endpoint_base/'\"\$server_id\"; docker run --rm --network host -e MCP_ENDPOINT=\"\$smoke_endpoint\" -e MCP_TOKEN=\"\$token\" '$smoke_image' node scripts/test-mcp-e2e.mjs"; then
  rollback_on_failure
  exit 1
fi

new_console_image_id=$(ssh "$release_host" "docker inspect -f '{{.Image}}' cube-console-cube_console-1")
new_gateway_image_id=$(ssh "$release_host" "docker inspect -f '{{.Image}}' cube-console-cube_gateway-1")
ssh "$release_host" "set -eu; printf 'CUBE_RELEASE_IMAGE=%s\nCUBE_RELEASE_IMAGE_ID=%s\nCUBE_RELEASE_CONSOLE_IMAGE=%s\nCUBE_RELEASE_CONSOLE_IMAGE_ID=%s\nCUBE_RELEASE_GATEWAY_IMAGE=%s\nCUBE_RELEASE_GATEWAY_IMAGE_ID=%s\nCUBE_RELEASE_REVISION=%s\nCUBE_RELEASE_COMPOSE=%s\n' '$previous_console_image' '$previous_console_image_id' '$previous_console_image' '$previous_console_image_id' '$previous_gateway_image' '$previous_gateway_image_id' '$previous_revision' '$previous_compose' > '$state_dir/previous.env'; printf 'CUBE_RELEASE_IMAGE=%s\nCUBE_RELEASE_IMAGE_ID=%s\nCUBE_RELEASE_CONSOLE_IMAGE=%s\nCUBE_RELEASE_CONSOLE_IMAGE_ID=%s\nCUBE_RELEASE_GATEWAY_IMAGE=%s\nCUBE_RELEASE_GATEWAY_IMAGE_ID=%s\nCUBE_RELEASE_REVISION=%s\nCUBE_RELEASE_COMPOSE=%s\n' '$console_image' '$new_console_image_id' '$console_image' '$new_console_image_id' '$gateway_image' '$new_gateway_image_id' '$revision' '$release_dir/compose.yml' > '$state_dir/current.env'; cp '$release_dir/release-manifest.json' '$state_dir/current-manifest.json'"

echo "发布成功：$console_image"
echo "网关镜像：$gateway_image"
echo "Git revision：$revision"
echo "控制台回滚基线：$previous_console_image"
echo "网关回滚基线：$previous_gateway_image"
