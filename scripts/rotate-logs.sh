#!/usr/bin/env bash
# 日志轮转:$HOME/prededge/logs/*.log → <name>.log.<YYYY-MM-DD>.gz(原地截断原文件),
# 并按保留期(默认 84 天 ≈ 12 周)清理过期 .gz。
#
# 用法: rotate-logs.sh [--dry-run]
# 部署位置: $HOME/prededge/rotate-logs.sh(crontab 直接引用;仓库源在 scripts/rotate-logs.sh)
# crontab 建议(注意必须是 >> 追加,理由见下方"为什么是 >>"):
#   10 9 * * 0 $HOME/prededge/rotate-logs.sh >> $HOME/prededge/logs/rotate-logs.log 2>&1
#
# ── 为什么不写在 crontab 里(2026-08-02 审计实证)────────────────────────────
# 旧 crontab 是这么一行内联脚本:
#   10 9 * * 0 for f in $HOME/prededge/logs/*.log; do gzip -c "$f" > "$f.$(date +%F).gz" && : > "$f"; done; find ... -mtime +84 -delete
# Vixie cron 会把命令里**未转义的 %** 当成换行,并把其后内容改喂给命令的 stdin。
# 于是 shell 真正收到的只有:
#   for f in …; do gzip -c "$f" > "$f.$(date +
# —— $( 与 do 都没闭合,交给 /bin/sh 必然 unexpected EOF、exit=2、零产出。
# 后果:轮转与 84 天保留策略从未生效过一次(sufe 上 logs/ 里 0 个 .gz,三个 .log
# 合计 ~1.7MB 仍在涨),而这一行当初又替换掉了更早的 tail -c 丢弃式轮转,等于现在
# 完全没有轮转。把 % 转义成 \% 能修语法,但一行内联脚本不可测试、不可读、下一次
# 静默失败照样要等一周才发现;所以改成独立脚本文件 + crontab 只调用它,
# 与 scripts/run-cron.sh 同一模式(仓库里改、tar-over-ssh 部署到 $HOME/prededge/)。
#
# ── 为什么是 >>(而不是 >)──────────────────────────────────────────────────
# 本脚本对正在被写入的日志做"原地截断";持有该文件的进程若是以 > 打开(非 O_APPEND),
# 截断后它的写偏移不会回退,会在文件头部留下一大段 NUL 空洞。所有写 logs/ 的
# crontab 行都必须用 >>。
#
# ── 为什么单文件失败不连坐(2026-08-02 复查)─────────────────────────────────
# 第一轮修复里任何一个文件 gzip/gzip -t 失败就 exit 1,整轮中止:排在它后面的日志
# 本周完全不轮转,要等下周 09:10 才再试一次 —— 而这条 finding 的根因恰恰是"轮转一次
# 都没生效过",连坐正是最差的失败模式(一个坏文件就能把整个轮转策略长期废掉)。
# 现在改成 per-file:失败只记账 + continue,循环结束后若 failed>0 再以 1 退出,
# cron 侧照样能告警,但好文件已经轮转完了。
# 2026-08-02 三轮复查:上面这条只覆盖了轮转循环,保留期清理段当时仍是裸命令替换,
# 一旦 find -delete 失败就被 set -e 当场打死、绕过收尾的失败明细与 exit 1 —— 已一并
# 收编进同一条路径,详见下方清理段注释。
#
# 环境变量:
#   LOG_DIR       日志目录,默认 $HOME/prededge/logs(本地自测指到临时目录用)
#   RETAIN_DAYS   .gz 保留天数,默认 84
#
# 退出码:
#   0  全部处理完成(可能有 skip,但没有失败)
#   1  LOG_DIR 不存在,或至少一个文件轮转失败,或过期归档清理失败
#      (其余文件仍已照常轮转、能删的归档仍已照常清理)
#   2  参数错误
set -euo pipefail
# logs/ 为空(或没有 .log)时,*.log 不能退化成字面量当文件名 —— 否则 for 循环会拿到
# 一个不存在的路径,gzip 失败直接把整轮判死。
shopt -s nullglob

LOG_DIR="${LOG_DIR:-$HOME/prededge/logs}"
RETAIN_DAYS="${RETAIN_DAYS:-84}"
DRY_RUN=0

# 参数解析用 while+shift 而不是 for arg in "$@" —— bash 3.2(macOS 自带,本地自测环境)
# 在 set -u 下展开空的 "$@" 会报 unbound variable。
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "[rotate-logs] FATAL: unknown arg '$1' (usage: rotate-logs.sh [--dry-run])" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[rotate-logs] $(date '+%F %T') $*"; }

rotated=0
skipped=0
failed=0
# 失败明细用换行分隔的字符串,不用数组:bash 3.2(macOS 自带,本地自测环境)在 set -u 下
# 展开空数组 "${arr[@]}" 会报 unbound variable,与上面参数解析避开 for arg in "$@" 同因。
FAILURES=""

# fail <base> <reason>:记一笔失败并继续下一个文件(调用方负责 continue)。
# 失败行同时进 stdout(与 log 同流,保序)——明细会在最末尾再复述一次到 stderr,理由见收尾处。
fail() {
  log "ERROR $1 — $2"
  FAILURES="${FAILURES}  - $1: $2
"
  failed=$((failed + 1))
}

# 目录不存在 = 部署坏了(路径写错 / tar 没解全)。这里宁可显式非零退出也不 mkdir -p:
# 静默把一个拼错的 LOG_DIR 创建出来,只会让"轮转看起来在跑、真日志继续无限增长"
# 这类故障再瞒一次 —— 本 finding 的根因就是静默失败。
if [ ! -d "$LOG_DIR" ]; then
  log "FATAL: LOG_DIR not found: $LOG_DIR"
  exit 1
fi

DATE_TAG="$(date '+%F')"
log "start LOG_DIR=$LOG_DIR RETAIN_DAYS=$RETAIN_DAYS dryRun=$DRY_RUN tag=$DATE_TAG"

for f in "$LOG_DIR"/*.log; do
  [ -f "$f" ] || continue
  base="$(basename "$f")"

  # 可读性先于一切:不可读时 `wc -c < "$f"` 的重定向会失败,在 set -e 下会直接把整轮打死
  # (而且是在 fail() 之前,连账都记不上)。显式挡在前面,既拿到清楚的失败原因,也保证
  # 原文件一个字节都不碰。(2026-08-02 复查)
  if [ ! -r "$f" ]; then
    fail "$base" "不可读(权限/属主),未做任何处理,原文件完整保留"
    continue
  fi

  # 空文件不轮转:上一轮已经截断过,再压一个 20 字节的空壳 .gz 只是噪声,还会白占
  # 一个当天的归档名。
  if [ ! -s "$f" ]; then
    log "skip $base (empty)"
    skipped=$((skipped + 1))
    continue
  fi

  # 取大小也走容错:文件可能在 -r 检查与这里之间被删/被换(cron 子进程重启、手工清理),
  # 那样命令替换非零 → set -e 会连坐整轮。
  if ! size="$(wc -c < "$f" | tr -d ' ')"; then
    fail "$base" "读取大小失败(文件可能已被删除或替换),跳过"
    continue
  fi
  target="$f.$DATE_TAG.gz"

  # 同名已存在 = 当天重复跑(手动补跑 / cron 重投 / 幂等重试)。绝不覆盖:那会把当天
  # 先前那份归档直接抹掉,等于用"轮转"制造丢数据。追加序号找第一个空位。
  if [ -e "$target" ]; then
    idx=1
    while [ "$idx" -lt 100 ] && [ -e "$f.$DATE_TAG.$idx.gz" ]; do idx=$((idx + 1)); done
    target="$f.$DATE_TAG.$idx.gz"
    if [ -e "$target" ]; then
      log "WARN skip $base — $DATE_TAG 归档序号已用尽(>=100),不覆盖"
      skipped=$((skipped + 1))
      continue
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN would gzip $base (${size}B) -> $(basename "$target") then truncate in place"
    rotated=$((rotated + 1))
    continue
  fi

  # gzip -c 复制出一份新文件,而不是 gzip/mv 原文件 —— 原 .log 必须保住同一个 inode:
  #   1) 正在写日志的 cron 子进程(chain-watch 每 3 分钟、scan-notify 每 30 分钟)持有的
  #      是这个 inode 的 fd,一旦 mv/rename,它们后续所有输出都写进"已改名的旧文件",
  #      新 .log 永远是空的,直到进程重启为止;
  #   2) heartbeat.ts 按 (inode, byte offset) 读增量,inode 一变就整份重读。原地截断则
  #      落进它的 `offset > size` 分支自动从 0 重读,既不丢行也不错位。
  # 代价:gzip 与截断之间(毫秒级)新追加的行会丢。周日 09:10 这种低频时点跑,期望丢
  # 0~1 行,远小于 mv 造成的"整周日志落进旧 inode"。
  #
  # 下面三处失败一律 fail+continue 而不是 exit:资金路径不受影响,而"因为一个坏文件
  # 就让其余日志整周不轮转"才是这条 finding 的原病。rm -f 补 `|| true`:target 若是
  # 目录/不可删,rm 非零会在 set -e 下反过来打死整轮。(2026-08-02 复查)
  if ! gzip -c "$f" > "$target"; then
    rm -f "$target" 2>/dev/null || true   # 半截的 .gz 比没有更危险:它会被下一轮当成已完成的归档
    fail "$base" "gzip 压缩失败 -> $(basename "$target");半成品已删,原文件未截断,原始日志完整"
    continue
  fi
  # 先验完整性再截断。顺序反了就是"归档坏了 + 原文件已清空"= 双份丢失。
  if ! gzip -t "$target" 2>/dev/null; then
    rm -f "$target" 2>/dev/null || true
    fail "$base" "gzip -t 校验失败 $(basename "$target");坏归档已删,原文件未截断,原始日志完整"
    continue
  fi

  # 截断本身也可能失败(只读挂载 / 属主变更 / 文件被替换成不可写)。此时归档已生成且校验
  # 通过,原文件保持原样 —— 数据没丢,只是下一轮会带序号再归档一份重叠内容,可接受。
  if ! : > "$f"; then
    fail "$base" "就地截断失败;归档 $(basename "$target") 已生成并校验通过,原文件保持原样(下轮会带序号重归档,内容重叠不丢失)"
    continue
  fi
  gzsize="$(wc -c < "$target" | tr -d ' ')"
  log "rotated $base (${size}B) -> $(basename "$target") (${gzsize}B), 原文件已就地截断"
  rotated=$((rotated + 1))
done

# 保留期清理。-mtime +N = 最后修改超过 N 天;归档一旦写完就不再改动,故等价于归档年龄。
# 比 crontab 原式多钉了 -maxdepth 1 -type f:删除面只能收窄不能放宽,避免 logs/ 下
# 万一出现子目录或同名目录时被连带命中。
#
# ── 清理段同样不连坐(2026-08-02 三轮复查)─────────────────────────────────────
# 此前这里是裸的 deleted="$(find … -print -delete | wc -l …)",两个缺陷:
#  ① 连坐 / 绕过失败明细。GNU find(生产是 WSL)删不掉某项时会打 stderr 并以非零码退出
#     (它自己是会继续删剩下的),而命令替换的非零状态经 set -o pipefail + set -e 直接把
#     脚本打死在这一行 —— 收尾的失败明细复述与 `exit 1` 语义被整段跳过,cron 日志里只剩
#     半截输出、连 done 汇总行都没有。这与 R11 修掉的"单文件失败连坐"是同一个病,只是当时
#     没覆盖到清理段。现在用 `|| purge_rc=$?` 接住(`||` 右侧存在时 set -e 不触发),走
#     fail() 的同一条「记账 + 继续 + 收尾非零退出」路径,明细照常打印。
#  ② 计数虚高。`-print -delete` 是先打印后删,数到的是**尝试**删除的条数,删失败的也照计。
# 判定不看 find 的返回值,而是"删前点数 / 删 / 删后复点数"(2026-08-02 三轮复查实测):
# -delete 的返回值约定两个方言正好相反 —— GNU find(生产 WSL)"删失败返回假且退出码非零",
# 而 macOS 的 BSD find man 明写 "Always returns true",实测删不掉 immutable 文件时只往
# stderr 打一行、整体仍 exit 0。任何基于 -delete 返回值/退出码的写法在本机自测里都测不出来,
# 也就等于没人验证过。改用"到期集合删完后还剩几个"这一事实判定:两个方言都准,且顺带得出
# 真实删除条数 deleted = expired − stuck。代价是每周多一次同目录 find(几十个文件,可忽略)。
# 残留 stuck 未知(点数命令本身失败)时按失败计 —— 这条路径只影响退出码与告警,fail-closed。
# 极小的竞态:两次点数之间恰有归档跨过 -mtime 边界会误报 1 个残留,方向是多报不是漏报,
# 且下一周自愈,可接受。
# 另:清理段到 exit 1 之间不允许再有任何能被 set -e 提前打死的语句,否则失败明细又会被
# 绕过 —— 故 expired/stuck/remaining 三处统计一律加 `|| …=""` / `|| …="?"` 兜底。
if [ "$DRY_RUN" -eq 1 ]; then
  expired="$(find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" -mtime "+$RETAIN_DAYS" -print | wc -l | tr -d ' ')" || expired="?"
  log "DRY-RUN would delete $expired archive(s) older than ${RETAIN_DAYS}d"
  deleted="$expired"
else
  purge_rc=0
  expired="$(find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" -mtime "+$RETAIN_DAYS" -print | wc -l | tr -d ' ')" || expired=""
  # 裸执行不接管道:-delete 的 stderr 要原样进日志(它会逐条点名文件与原因,
  # Permission denied / Operation not permitted),下面只记"这轮有清理失败"这一笔账。
  find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" -mtime "+$RETAIN_DAYS" -delete || purge_rc=$?
  stuck="$(find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" -mtime "+$RETAIN_DAYS" -print | wc -l | tr -d ' ')" || stuck=""
  if [ -n "$expired" ] && [ -n "$stuck" ]; then deleted=$((expired - stuck)); else deleted="?"; fi
  log "purged $deleted archive(s) older than ${RETAIN_DAYS}d"
  # 删除面只收窄:清理失败绝不改动轮转结果,也不重试删除,只记账让收尾非零退出。
  if [ "$purge_rc" -ne 0 ] || [ "$stuck" != "0" ]; then
    fail "(purge)" "过期归档清理失败(到期 ${expired:-?} 个,删后仍残留 ${stuck:-未知} 个,find 退出码 $purge_rc;权限/只读挂载/immutable);已删 $deleted 个,轮转结果与原始日志均不受影响"
  fi
fi

remaining="$(find "$LOG_DIR" -maxdepth 1 -type f -name "*.gz" | wc -l | tr -d ' ')" || remaining="?"
log "done rotated=$rotated skipped=$skipped failed=$failed deleted=$deleted archives=$remaining"

if [ "$failed" -gt 0 ]; then
  # 明细在最末尾整份复述一次,有两个理由:
  #   1) 一眼看全"哪些失败、为什么",不用回头翻循环里散落的 ERROR 行;
  #   2) 本脚本的 stdout 若按 crontab 建议追加进 $LOG_DIR/rotate-logs.log,该文件会在循环
  #      中途被自己轮转掉 —— 截断点之前打的 ERROR 行会跟着进当轮 .gz,只有截断点之后的
  #      输出才留在活文件里。收尾复述发生在循环之后,必定落在活文件,grep 活文件不会漏。
  #      (2026-08-02 复查:此前只在循环里打一次,自轮转会把失败记录连带归档走)
  # 措辞含清理段(2026-08-02 三轮复查):FAILURES 现在也收 "(purge)" 这类非文件条目,
  # 再写死 "file(s) ... to rotate" 会把清理失败误报成轮转失败,cron 告警指错方向。
  printf '[rotate-logs] %s failure(s) this run (rotate/purge):\n%s' "$failed" "$FAILURES" >&2
  log "exit 1 — 上述项目失败;其余文件已照常轮转、能删的过期归档已照常清理(失败不连坐)"
  exit 1
fi
