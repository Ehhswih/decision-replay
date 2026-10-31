#!/usr/bin/env bash
# 预先生成示例组合所有持仓段的复盘（逐个生成，避免并发打满模型和数据源）
# 用法：ADMIN_TOKEN=xxx bash scripts/pregenerate.sh [base_url] [force]
# 示例组合对访客只读；重新生成（force=1）需要和服务端一致的 ADMIN_TOKEN
BASE=${1:-http://localhost:3000}
FORCE=${2:-0}
IDS=$(curl -s "$BASE/api/episodes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).episodes.map(e=>e.id).join(" ")))')
for ID in $IDS; do
  start=$(date +%s)
  curl -s -X POST -H "x-admin-token: ${ADMIN_TOKEN:-}" "$BASE/api/episodes/$ID/review?force=$FORCE" > /dev/null
  while true; do
    sleep 4
    ST=$(curl -s "$BASE/api/episodes/$ID/review" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status+(j.review?" mode="+j.review.mode+" log="+j.review.validationLog.length:"")+(j.error?" "+j.error:""))})')
    case "$ST" in running*) ;; *) break ;; esac
  done
  echo "$ID $(( $(date +%s) - start ))s $ST"
done
