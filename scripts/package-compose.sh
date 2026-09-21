#!/usr/bin/env bash
# 生成可复制到无外网服务器的 Compose 离线部署包。
set -Eeuo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:-"$repo_root/dist/cube-console-compose"}
build_images=1

if [[ ${1:-} == "--skip-build" ]]; then
  build_images=0
  output_dir=${2:-"$repo_root/dist/cube-console-compose"}
fi

case "$output_dir" in
  "$repo_root"|"$repo_root"/*) ;;
  *)
    echo "输出目录必须位于项目根目录内：$repo_root" >&2
    exit 2
    ;;
esac

cd "$repo_root"
if ! docker info >/dev/null 2>&1; then
  echo "无法连接 Docker daemon；请启动 Docker 后重试。" >&2
  exit 1
fi

rm -rf "$output_dir"
mkdir -p "$output_dir/source"

if [[ $build_images == 1 ]]; then
  docker compose -f compose.yml -f compose.build.yml --env-file .env.example build cube_console cube_gateway
fi

for image in cubejs/cube:v1.7.25 cube-console:local cube-console-gateway:local; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "缺少镜像：$image。请去掉 --skip-build 重新打包，或先导入该镜像。" >&2
    exit 1
  }
done

# 仅收集 Git 跟踪文件和未忽略的新文件，避免把 .env、state、node_modules 等
# 本机数据意外带入离线包；同时允许打包尚未提交但已验证的发布改动。
git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C "$output_dir/source"
rm -rf "$output_dir/source/.github" "$output_dir/source/test" "$output_dir/source/examples" \
  "$output_dir/source/deploy"
mkdir -p "$output_dir/source/state/schema" "$output_dir/source/state/modules" \
  "$output_dir/source/state/glossary" "$output_dir/source/state/openapi"
touch "$output_dir/source/state/.gitkeep"
cp .env.example "$output_dir/source/.env.example"
docker save -o "$output_dir/source/cube-console-images.tar" \
  cubejs/cube:v1.7.25 cube-console:local cube-console-gateway:local

tar -C "$output_dir" -czf "$repo_root/dist/cube-console-compose.tar.gz" source
sha256sum "$repo_root/dist/cube-console-compose.tar.gz" > "$repo_root/dist/cube-console-compose.tar.gz.sha256"

echo "离线包已生成：$repo_root/dist/cube-console-compose.tar.gz"
echo "校验文件已生成：$repo_root/dist/cube-console-compose.tar.gz.sha256"
