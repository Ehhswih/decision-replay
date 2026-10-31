#!/usr/bin/env bash
# 部署到云服务器：打包已提交的代码 → 上传 → 在服务器上用 docker compose 构建并启动。
# 用法：bash scripts/deploy.sh <用户@服务器IP> [站点地址]
#   站点地址填 1-2-3-4.sslip.io（把 IP 里的点换成横线）可以自动获得 HTTPS；不填则只开 HTTP（:80）。
# 前提：服务器装好 Docker（腾讯云轻量选 Docker 镜像即可），本机能用 SSH 密钥登录，防火墙放行 80/443。
set -euo pipefail

HOST=${1:?用法：bash scripts/deploy.sh 用户@服务器IP [站点地址]}
SITE=${2:-:80}
DIR=/opt/decision-replay
TMP=$(mktemp -d)

cd "$(dirname "$0")/.."
git diff --quiet HEAD || echo "提醒：有未提交的改动，只会部署已提交的版本"
git archive --format=tar.gz -o "$TMP/app.tgz" HEAD

# 服务器上的 .env：本机 .env.local 的密钥 + 站点地址（经 SSH 传输，不进仓库）
grep -v '^SITE_ADDRESS=' .env.local > "$TMP/app.env"
echo "SITE_ADDRESS=$SITE" >> "$TMP/app.env"

scp "$TMP/app.tgz" "$TMP/app.env" "$HOST:/tmp/"
rm -rf "$TMP"

ssh "$HOST" "set -e
  sudo mkdir -p $DIR
  sudo tar -xzf /tmp/app.tgz -C $DIR
  sudo mv /tmp/app.env $DIR/.env && sudo chmod 600 $DIR/.env
  rm -f /tmp/app.tgz
  # 2G 内存构建 Next.js 偏紧：没有交换分区时加 2G
  if [ \$(swapon --show | wc -l) -eq 0 ]; then
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  cd $DIR && sudo docker compose up -d --build
  sudo docker compose ps"

echo "部署完成。站点：$([ "$SITE" = ":80" ] && echo "http://${HOST#*@}" || echo "https://$SITE")"
echo "预生成示例复盘：ADMIN_TOKEN=\$(grep ADMIN_TOKEN .env.local | cut -d= -f2) bash scripts/pregenerate.sh <站点地址>"
