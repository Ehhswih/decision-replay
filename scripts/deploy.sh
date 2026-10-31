#!/usr/bin/env bash
# 部署到云服务器：打包已提交的代码 → 上传 → 在服务器上用 docker compose 构建并启动。
#
# 用法：bash scripts/deploy.sh <用户@服务器IP> [站点地址] [-i 私钥路径]
#   站点地址默认 :80（按 IP 用 HTTP 访问，国内服务器没有备案域名时用这个）；
#   有备案域名或境外服务器时填域名，Caddy 会自动申请 HTTPS。
#   MODE=image bash scripts/deploy.sh ...  在本机构建镜像再上传（服务器拉镜像或装依赖失败时用）。
#
# 前提：服务器装好 Docker（腾讯云轻量选 Docker CE 镜像），本机能用 SSH 密钥登录，防火墙放行 80。
set -euo pipefail

HOST=${1:?用法：bash scripts/deploy.sh 用户@服务器IP [站点地址] [-i 私钥路径]}
SITE=${2:-:80}
KEY_ARGS=()
if [ "${3:-}" = "-i" ]; then KEY_ARGS=(-i "${4:?缺少私钥路径}"); fi
MODE=${MODE:-build}
DIR=/opt/decision-replay
TMP=$(mktemp -d)
SSH=(ssh -o StrictHostKeyChecking=accept-new "${KEY_ARGS[@]}")
SCP=(scp -o StrictHostKeyChecking=accept-new "${KEY_ARGS[@]}")

cd "$(dirname "$0")/.."
git diff --quiet HEAD || echo "提醒：有未提交的改动，只会部署已提交的版本"
git archive --format=tar.gz -o "$TMP/app.tgz" HEAD

# 服务器上的 .env：本机 .env.local 的密钥 + 站点地址 + 国内 npm 镜像（经 SSH 传输，不进仓库）
grep -vE '^(SITE_ADDRESS|NPM_REGISTRY|DATA_DIR)=' .env.local > "$TMP/app.env"
{
  echo "SITE_ADDRESS=$SITE"
  echo "NPM_REGISTRY=https://registry.npmmirror.com"
} >> "$TMP/app.env"

if [ "$MODE" = "image" ]; then
  echo "在本机构建镜像……"
  docker build -t decision-replay:latest .
  docker save decision-replay:latest | gzip > "$TMP/image.tgz"
fi

"${SCP[@]}" "$TMP"/* "$HOST:/tmp/"
rm -rf "$TMP"

"${SSH[@]}" "$HOST" "set -e
  # 国内服务器拉不动 Docker Hub：配置腾讯云内网镜像源（已经配置过就跳过）
  if ! grep -q registry-mirrors /etc/docker/daemon.json 2>/dev/null; then
    echo '{\"registry-mirrors\": [\"https://mirror.ccs.tencentyun.com\"]}' | sudo tee /etc/docker/daemon.json >/dev/null
    sudo systemctl restart docker
  fi
  # 2G 内存构建 Next.js 偏紧：没有交换分区时加 2G
  if [ \$(swapon --show | wc -l) -eq 0 ]; then
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  sudo mkdir -p $DIR
  sudo tar -xzf /tmp/app.tgz -C $DIR
  sudo mv /tmp/app.env $DIR/.env && sudo chmod 600 $DIR/.env
  rm -f /tmp/app.tgz
  cd $DIR
  if [ -f /tmp/image.tgz ]; then
    gunzip -c /tmp/image.tgz | sudo docker load && rm -f /tmp/image.tgz
    sudo docker compose up -d --no-build
  else
    sudo docker compose up -d --build
  fi
  sudo docker compose ps"

ADDR=$([ "$SITE" = ":80" ] && echo "http://${HOST#*@}" || echo "https://$SITE")
echo
echo "部署完成：$ADDR"
echo "下一步（预热示例组合并生成复盘，约 6 分钟）："
echo "  ADMIN_TOKEN=\$(grep '^ADMIN_TOKEN=' .env.local | cut -d= -f2) bash scripts/pregenerate.sh $ADDR"
echo "  node scripts/smoke.mjs $ADDR"
