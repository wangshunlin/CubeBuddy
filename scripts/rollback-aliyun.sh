#!/usr/bin/env bash
set -Eeuo pipefail

release_host=${CUBE_RELEASE_HOST:?请设置 CUBE_RELEASE_HOST，例如 deploy@example.com}
runtime_dir=${CUBE_RELEASE_RUNTIME_DIR:-/opt/cube-console}
state_dir=${CUBE_RELEASE_STATE_DIR:-/opt/cube-console-release-state}
cube_port=${CUBE_RELEASE_CUBE_PORT:-18180}

target_file=${1:-$state_dir/previous.env}
if [[ $target_file != /* ]]; then
  echo "回滚参数必须是服务器上的绝对状态文件路径。" >&2
  exit 2
fi

target=$(ssh "$release_host" "set -eu; test -f '$target_file'; CUBE_RELEASE_IMAGE=''; CUBE_RELEASE_IMAGE_ID=''; CUBE_RELEASE_CONSOLE_IMAGE=''; CUBE_RELEASE_CONSOLE_IMAGE_ID=''; CUBE_RELEASE_GATEWAY_IMAGE=''; CUBE_RELEASE_GATEWAY_IMAGE_ID=''; CUBE_RELEASE_REVISION=''; CUBE_RELEASE_COMPOSE=''; . '$target_file'; if test -z \"\$CUBE_RELEASE_CONSOLE_IMAGE\"; then CUBE_RELEASE_CONSOLE_IMAGE=\$CUBE_RELEASE_IMAGE; CUBE_RELEASE_CONSOLE_IMAGE_ID=\$CUBE_RELEASE_IMAGE_ID; fi; printf '%s|%s|%s|%s|%s|%s' \"\$CUBE_RELEASE_CONSOLE_IMAGE\" \"\$CUBE_RELEASE_CONSOLE_IMAGE_ID\" \"\$CUBE_RELEASE_GATEWAY_IMAGE\" \"\$CUBE_RELEASE_GATEWAY_IMAGE_ID\" \"\$CUBE_RELEASE_REVISION\" \"\$CUBE_RELEASE_COMPOSE\"")
IFS='|' read -r target_console_image target_console_image_id target_gateway_image target_gateway_image_id target_revision target_compose <<< "$target"

if [[ -z $target_console_image || -z $target_gateway_image || -z $target_compose ]]; then
  echo "回滚状态文件不完整。" >&2
  exit 1
fi

ssh "$release_host" "set -eu; target_dir=\$(dirname '$target_compose'); test \"\$(docker image inspect -f '{{.Id}}' '$target_console_image')\" = '$target_console_image_id'; test \"\$(docker image inspect -f '{{.Id}}' '$target_gateway_image')\" = '$target_gateway_image_id'; current_console_image=\$(docker inspect -f '{{.Config.Image}}' cube-console-cube_console-1); current_console_id=\$(docker inspect -f '{{.Image}}' cube-console-cube_console-1); current_gateway_image=\$(docker inspect -f '{{.Config.Image}}' cube-console-cube_gateway-1); current_gateway_id=\$(docker inspect -f '{{.Image}}' cube-console-cube_gateway-1); current_revision=\$(docker inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' cube-console-cube_console-1 2>/dev/null || true); current_compose=\$(awk -F= '/^CUBE_RELEASE_COMPOSE=/{print \$2}' '$state_dir/current.env' 2>/dev/null || true); cp '$state_dir/current.env' '$state_dir/rollback-from.env'; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' CONSOLE_IMAGE '$target_console_image'; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' GATEWAY_IMAGE '$target_gateway_image'; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' CUBE_DEPLOY_HOST_DIR '$runtime_dir/state'; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' CUBE_CONSOLE_SOURCE_HOST_DIR \"\$target_dir\"; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' CUBE_COMPOSE_ENV_READ_PATH '$runtime_dir/.env'; node \"\$target_dir/scripts/update-env-value.mjs\" '$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH '$runtime_dir/.env'; cd \"\$target_dir\"; CONSOLE_IMAGE='$target_console_image' GATEWAY_IMAGE='$target_gateway_image' CUBE_DEPLOY_HOST_DIR='$runtime_dir/state' CUBE_CONSOLE_SOURCE_HOST_DIR=\"\$target_dir\" CUBE_COMPOSE_ENV_READ_PATH='$runtime_dir/.env' CUBE_COMPOSE_ENV_HOST_PATH='$runtime_dir/.env' docker compose -f '$target_compose' --env-file '$runtime_dir/.env' up -d --no-build --force-recreate cube_console cube_gateway; for attempt in 1 2 3 4 5 6 7 8; do console_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1 2>/dev/null || true); gateway_status=\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1 2>/dev/null || true); test \"\$console_status\" = healthy -a \"\$gateway_status\" = healthy && break; sleep 2; done; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_console-1)\" = healthy; test \"\$(docker inspect -f '{{.State.Health.Status}}' cube-console-cube_gateway-1)\" = healthy; test \"\$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${cube_port}/mcp')\" = 401; printf 'CUBE_RELEASE_IMAGE=%s\nCUBE_RELEASE_IMAGE_ID=%s\nCUBE_RELEASE_CONSOLE_IMAGE=%s\nCUBE_RELEASE_CONSOLE_IMAGE_ID=%s\nCUBE_RELEASE_GATEWAY_IMAGE=%s\nCUBE_RELEASE_GATEWAY_IMAGE_ID=%s\nCUBE_RELEASE_REVISION=%s\nCUBE_RELEASE_COMPOSE=%s\n' \"\$current_console_image\" \"\$current_console_id\" \"\$current_console_image\" \"\$current_console_id\" \"\$current_gateway_image\" \"\$current_gateway_id\" \"\$current_revision\" \"\$current_compose\" > '$state_dir/previous.env'; printf 'CUBE_RELEASE_IMAGE=%s\nCUBE_RELEASE_IMAGE_ID=%s\nCUBE_RELEASE_CONSOLE_IMAGE=%s\nCUBE_RELEASE_CONSOLE_IMAGE_ID=%s\nCUBE_RELEASE_GATEWAY_IMAGE=%s\nCUBE_RELEASE_GATEWAY_IMAGE_ID=%s\nCUBE_RELEASE_REVISION=%s\nCUBE_RELEASE_COMPOSE=%s\n' '$target_console_image' '$target_console_image_id' '$target_console_image' '$target_console_image_id' '$target_gateway_image' '$target_gateway_image_id' '$target_revision' '$target_compose' > '$state_dir/current.env'"

echo "控制台已回滚到：$target_console_image"
echo "网关已回滚到：$target_gateway_image"
echo "Git revision：$target_revision"
