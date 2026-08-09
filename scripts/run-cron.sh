#!/usr/bin/env bash
# Cron wrapper:加载 env → 解析 WSL 宿主代理 → 跑脚本 → 成功后打标记 + healthchecks 心跳。
#
# 用法: run-cron.sh scripts/<name>.ts [args...]
# 部署位置: $HOME/prededge/run-cron.sh(crontab 直接引用;仓库源在 scripts/run-cron.sh)
#
# 成功(exit 0)时:
#   - touch data/last-ok-<name>            —— heartbeat.ts 靠它的 mtime 判活
#   - curl $HC_PING_<NAME>(如已配置)     —— healthchecks.io 死人开关
# 失败时不 ping:ping 的语义是"工作正常",不是"cron 在跑"。
set -a
source "$HOME/prededge/.env"
set +a

# RPC 与 hc-ping.com 一律直连(实测 drpc 走 Clash 会 TLS 失败;心跳走代理会在
# Clash 挂掉时产生"扫描器死了"的误报)。域名从 ONCHAIN_RPC_URLS 动态提取。
RPC_HOSTS=$(echo "${ONCHAIN_RPC_URLS:-}" | tr ',' '\n' | sed -E 's#https?://([^/]+).*#\1#' | paste -sd, -)
NO_PROXY_LIST="localhost,127.0.0.1,hc-ping.com,polygon-bor-rpc.publicnode.com,polygon.drpc.org,1rpc.io${RPC_HOSTS:+,$RPC_HOSTS}"

# WSL2: Clash Verge 监听在 Windows 宿主机 = 默认网关,IP 随 WSL 重启变化,运行时解析。
if [ -n "$PROXY_PORT" ]; then
  WSL_HOST=$(ip route show default | awk '{print $3}' | head -1)
  if [ -n "$WSL_HOST" ]; then
    export HTTPS_PROXY="http://$WSL_HOST:$PROXY_PORT"
    export HTTP_PROXY="http://$WSL_HOST:$PROXY_PORT"
    export NO_PROXY="$NO_PROXY_LIST"
    # curl 只认小写 http_proxy;no_proxy 两种大小写都补齐
    export https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY" no_proxy="$NO_PROXY"
  else
    # 网关解析失败(WSL 网络未就绪 / mirrored 模式 / VPN 切换):代理不设,
    # gamma/clob 直连会被 SNI 阻断,scan-notify 随即整通道失效。至少留一行日志,
    # 否则症状("Gamma 不可达")完全无法与"代理没设起来"区分。
    echo "[run-cron] WARN: default route not found, proxy NOT set ($(date '+%F %T'))"
  fi
fi
# Node fetch 只在此开关下才读 HTTP(S)_PROXY(Node >= 24)
export NODE_USE_ENV_PROXY=1
# ~/.local/bin: claude CLI(LLM 判读,lib/polymarket/llmStance.ts 经 PATH 解析)
export PATH="$HOME/opt/node/bin:$HOME/.local/bin:$PATH"
cd "$HOME/prededge" || exit 1

# Node 版本自检:NODE_USE_ENV_PROXY 只在 Node>=24 生效,低版本会静默忽略代理、
# 所有对外 fetch 直连失败。宁可显式失败也不要静默降级。
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "[run-cron] FATAL: node major $NODE_MAJOR < 24 — proxy env-passthrough disabled, aborting ($(date '+%F %T'))"
  exit 1
fi

# tsx 必须来自本地 node_modules —— 裸 `npx tsx` 在非 TTY 下会静默从 registry
# 拉取 tsx@latest 直接执行(不看 lockfile、无版本钉死),既是供应链风险又会在
# 代理不通时挂死。缺失即显式失败。
TSX_BIN="$HOME/prededge/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  echo "[run-cron] FATAL: $TSX_BIN not found — run npm ci ($(date '+%F %T'))"
  exit 1
fi

# 单轮超时(H11):热路径上的 fetch 即使各自带 AbortSignal 也可能因多端点串行
# 叠加超预算。GNU timeout 给整轮兜底,超时退非零码走失败路径,避免卡死的一轮
# 无限期占住 flock 锁、让后续所有轮次静默跳过。按脚本给不同预算。
name=$(basename "$1" .ts)
case "$name" in
  chain-watch) RUN_TIMEOUT=170 ;;   # 每 3 分钟一轮,留 10s 余量
  scan-notify) RUN_TIMEOUT=1500 ;;  # 每 30 分钟一轮,单轮正常 ~45s
  heartbeat)   RUN_TIMEOUT=540 ;;    # 每 10 分钟一轮
  # 值守型长跑(2026-08-05):不是 cron 轮次,而是蹲一个定时数据发布窗口的
  # 常驻进程,自己用 --max-hours 收尾。默认 300s 会把它们在发布前几小时
  # 静默杀掉 —— release-watch 首次上线就踩了(4分50秒被 SIGTERM,日志里
  # 只留一行 WARN,而外部看上去"进程起来了")。给 12h,始终大于脚本自身
  # 的 --max-hours,让收尾逻辑(留痕+收尾邮件)有机会跑完。
  # oregon-sniper 不是蹲发布窗口而是蹲**成交**(答案已知,守着把 ≤ 阈值价的
  # 卖单吃干净),同样是常驻长跑,同样必须大于它自己的 --max-hours 默认 11h。
  release-watch|release-sniper|oregon-sniper) RUN_TIMEOUT=43200 ;;
  # tornado-watch 单轮正常 ~15s,但 NCEI **会瞬时限流**(2026-08-08 实测:首读 200、
  # 随后 25s 与 60s 两次全超时、3 分钟后恢复),所以它的重试退避是 2s/15s/45s ——
  # 跨到分钟量级才有意义。最坏情形:探测两个 ytd 档 × 4 次尝试 ×(30s 超时 + 退避)
  # 已超过默认 300s,会被 SIGTERM 掉、在日志里只留一行 WARN,症状与"NCEI 挂了"
  # 完全无法区分。给 900s。
  tornado-watch) RUN_TIMEOUT=900 ;;
  *)           RUN_TIMEOUT=300 ;;
esac
timeout -k 30 "$RUN_TIMEOUT" "$TSX_BIN" "$@"
rc=$?
if [ "$rc" -eq 124 ]; then
  echo "[run-cron] WARN: $name timed out after ${RUN_TIMEOUT}s ($(date '+%F %T'))"
fi

if [ "$rc" -eq 0 ]; then
  mkdir -p data
  touch "data/last-ok-$name"

  ping_url=""
  case "$name" in
    chain-watch) ping_url="${HC_PING_CHAIN_WATCH:-}" ;;
    scan-notify) ping_url="${HC_PING_SCAN_NOTIFY:-}" ;;
    heartbeat)   ping_url="${HC_PING_HEARTBEAT:-}" ;;
  esac
  if [ -n "$ping_url" ]; then
    # 直连优先(hc-ping.com 在 NO_PROXY 里);失败再显式走一次代理兜底。
    # 兜底必须加 --noproxy '' 清空 no_proxy,否则 curl 会因 hc-ping.com 在
    # no_proxy 中而忽略 -x,再次直连、必然同样失败(-x 形同虚设)。
    curl -fsS -m 10 --retry 2 --retry-connrefused "$ping_url" >/dev/null 2>&1 \
      || { [ -n "${HTTPS_PROXY:-}" ] && curl -fsS -m 10 --noproxy '' -x "$HTTPS_PROXY" "$ping_url" >/dev/null 2>&1; } \
      || echo "[run-cron] healthchecks ping failed for $name ($(date '+%F %T'))"
  fi
fi

exit "$rc"
