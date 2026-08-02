/**
 * 补仓复访的出队判据(2026-08-02 复查 R1 抽取)。
 *
 * 为什么单独成模块:判据本身是纯函数,但它此前是 scripts/chain-watch.ts 里
 * main() 内的一个闭包,而 chain-watch.ts 顶层直接 `main()` —— 任何 import 都会
 * 真的跑起一整个生产 tick(读链、发信、下单),因此**无法被任何离线测试覆盖**。
 * 第一轮那次回归(把判据从 reason 反转成 status,一次复访就关掉 12 分钟补仓
 * 窗口)之所以能落地并通过全部测试,根因正是这里没有可断言面。抽出来之后
 * tests/refillPolicy.test.ts 可以逐条钉死"哪些 reason 留队、哪些出队"。
 *
 * 本模块零运行时依赖:只 `import type` 一个 TradeAttempt(类型在编译期擦除,
 * 不产生对 tradeExecutor 的运行时边 —— 那是带钱包/账本/fs 副作用的执行层)。
 * 与 ./priceBands 同一套取舍。
 *
 * 行为相对抽取前逐字未变:两张表与判定顺序原样搬运,唯一的差别是未识别
 * reason 时的 warn 由调用方注入(默认仍是 console.warn),便于测试断言"确实
 * 报警了"而不是靠劫持全局 console。
 */
import type { TradeAttempt } from "./tradeExecutor";

/** 复访出队判据的原因表(2026-08-02 复查)——见 shouldKeepInRefillQueue。
 *
 * 背景:本批第一轮修复把出队判据从"skip 原因黑名单正则"反转成了看
 * attempt.status,于是**所有 skipped 一律出队** —— 而复访第一次最可能命中的
 * 两种 skip 恰恰是纯瞬态,补仓窗口因此在第一次复访就被自己关掉:
 *   (a) 「可用额度/限价内深度不足(可下 $X,最低 $5;深度 $Y…)」—— depthUsd 是
 *       **限价内**深度,刚被自己吃空后必然 < minOrderUsd($5)。这就是 12 分钟
 *       窗口存在的全部理由。(注:深度 < $5 时 executeSignal 根本不发 FAK,
 *       走的是 skipped 而不是 none —— 第一轮把"限价内当时无货 → 纯瞬态"这句
 *       挂在 status==="none" 上,意图对、分支错。)
 *   (b) 「信号后已重定价(注解 X → 现 Y,超漂移带 Z)」—— 锚恒为原始信号价,
 *       自己吃掉 ≤0.69 的档位后 freshAsk 抬到 0.75 就会触发,而 12 分钟内价格
 *       回落是常态。
 * 复现 07-28 原型:21:21 成交 $47 吃干限价内 ~$52 深度 → 21:24 复访命中 (a)/(b)
 * → 立即永久出队 → 21:26 挂出的 85 股 ≤0.69 无人复访(被他人吃走、全部结算
 * $1),REFILL_MAX_TRIES 的后 3 次作废。
 *
 * 结论:判据必须看 **reason**(skip 的成因),而不是 status(skip 这个动作)。
 * 两张表按 lib/polymarket/tradeExecutor.ts 的 executeSignal 全量 skip 文案逐条
 * 核过(2026-08-02 复查:23 处 status:"skipped" → 25 种文案,去重那处一个
 * finish() 带三分支文案;实测 25/25 唯一命中、无一条双表命中或落空)。
 * 未匹配到任何已知 reason 时的默认动作见 shouldKeepInRefillQueue 末尾。
 */
/** 瞬态 skip 原因:12 分钟窗口内**有可能自愈**,留队等下个 tick 再探一次。 */
export const REFILL_TRANSIENT_SKIP: Array<{ re: RegExp; why: string }> = [
  // depthUsd 只统计限价内的档位:自己刚吃干那一层之后它必然塌到 minOrderUsd
  // 以下,而卖家补货(07-28 实测集中在成交后 39s–4.5min)会把它填回来。
  // 注:该文案把"限价内深度不足"与"额度余量不足"合并成一条 —— tokenLeft/
  // dailyLeft/totalLeft/eventLeft 只剩几美元时也命中这条。真正触顶的额度各有
  // 自己的终局文案(下表),能落到这里的只是"余量小但非零",误留队的代价上界
  // = 至多 3 次多余的 /book 拉取(受 REFILL_MAX_TRIES 封顶),不动用任何资金;
  // 与漏掉一次补仓机会不对称,故按瞬态处理。
  { re: /^可用额度\/限价内深度不足/, why: "限价内深度被自己吃空,卖家补货即自愈" },
  // 漂移带的锚恒为原始信号价:吃干便宜档后 freshAsk 自然抬高并越带,而下一轮
  // 补货往往重新挂回原价位附近。锚不重置,所以留队不会一路追高 —— 价格真跑掉
  // 时每一轮都会被同一条漂移带拒掉,最多白跑到 REFILL_MAX_TRIES 用完。
  { re: /^信号后已重定价/, why: "自己吃空便宜档抬高了 freshAsk,补货回落即回到带内" },
  // freshAsk == null:此刻卖侧空,但卖家可能回来 —— 这正是复访的形态本身。
  // (与下表的「盘口无卖侧挂单(空盘…)」不同:那条是 bestAskAtSignal 缺锚的
  // 分支,锚是队列里存死的,不会自愈。两条靠 ^ 前缀就分得开:第 5 个字一个是
  // 「单」一个是「侧」,不存在前缀劫持,不需要尾锚来撑这件事。)
  //
  // 尾锚放宽(2026-08-02 三轮复查):原式 /^盘口无卖单$/。reason 并非恒等于
  // executeSignal 里写下的那一串 —— lib/polymarket/tradeExecutor.ts:776 的
  // finish() 在 mode==="live" 且 appendLedger 抛错(磁盘满/权限)时,会把
  // 「; ledger 写入失败,已自动落 kill-switch」**追加**到 a.reason 尾部。于是
  // 这条恰好在磁盘满事故现场失配,掉进本文件末尾那行"未识别 reason"的 warn,
  // 让运维在事故现场去补一条其实早就在表里的文案(假线索,且掩盖真正的告警)。
  // 改成 (?![^;]):后面要么没有字符(原样),要么只能是 ";"(finish() 的追加恒
  // 以 "; " 起头)。比裸前缀严:任何别的新后缀仍会失配并照常报警,不会被静默
  // 吞进瞬态表。
  // 资金侧只增不减:命中后由"出队"变成"留队",而那一刻 kill-switch 已由 P0-3
  // 落下,下个 tick 的复访在任何网络调用之前就撞上 tradeExecutor.ts:786 的
  // haltFile 闸 → skip「kill-switch 存在」→ 按终局出队。多的只是一次纯本地的
  // existsSync,不动一分钱。
  { re: /^盘口无卖单(?![^;])/, why: "此刻卖侧空,卖家可能回来挂单" },
  // tick 预算是本 tick 的属性,下个 tick 从头计。
  { re: /^tick 预算不足/, why: "预算按 tick 重置,与市场状态无关" },
];
/** 终局 skip 原因:12 分钟窗口内不会自愈,立即出队(省下 /book 往返给新信号)。 */
export const REFILL_TERMINAL_SKIP: RegExp[] = [
  // ── 额度/敞口触顶:窗口内只会更满,不会更空 ──
  /累计敞口已满/, // per-token 帽(词干与 gonogo-materials 的 bucketOf 同源)
  /^同事件聚合敞口已满/,
  /^日额度已满/,
  /^未结算持仓已满/,
  // dry 模式的二值封锁文案(复访已由 executionMode()==="live" 把关,防御性列出)
  /^该 token 已有实盘敞口/,
  /^已对该 token 执行过/,
  // ── 停机/风控闸:需要人工介入,复访改变不了 ──
  // 顺手复核(2026-08-02 三轮复查):逐条过了两张表的 28 条正则,除上面那条外
  // 只有这一条还带 $ 尾锚,且它不受 finish() 追加影响 —— 这个 reason 由
  // tradeExecutor.ts:782 `if (mode === "off") return {...}` **直接 return**,
  // 根本不经过 finish()/appendLedger,拿不到那个后缀。加之它在终局表:即便真
  // 失配,默认分支也是出队,方向与命中时一致(只多一行 warn)。故保持原样。
  // 其余各条一律是纯 ^ 前缀锚(含无锚的 /累计敞口已满/ 词干),追加后缀不影响。
  /^EXEC_MODE=off$/,
  /^kill-switch 存在/,
  /^结算连亏/,
  /^同市场已持反向腿/, // 再买一腿 = 确定性锁损,窗口内绝不重试
  /^proxy USDC 余额不足/,
  // 注意括号必须转义:tradeExecutor 这条文案用的是**半角**括号(实测 0x28/0x29),
  // 不转义就成了捕获组、永远匹配不上,会静默掉进默认出队的 warn 分支。
  /^CLOB 拒单\(余额不足\)/,
  // ── 价格/盘口的终局形态 ──
  /^ask /, // "ask X > 上限 …" / "ask X < 下限 …":越价格带
  // 暴跌 = 市场读出反方向,便宜是毒饵。理论上价格可能弹回,但这条的语义是
  // 红旗+人工复核,自动重试正是不该做的事 —— 按终局出队(安全取向,非经济取向)。
  /^盘口反向暴跌/,
  /^盘口无卖侧挂单/, // 空盘且无锚:taker 任何价位不可成交,唯 maker 可吃(未开)
  /^信号注解无盘口基准/, // 锚在队列里存死,补货也补不出锚
  // ── 预告家族三闸(EXEC_SKIP_FORECAST_TEMPLATE / boundary / 防雷 / paper 验证期)──
  // 四条都只取决于入队时就固定下来的字段(forecastTemplate、llmEventStatus、
  // stance、bestAskAtSignal)与 env,复访不会改变任何一个。
  /^预告模板家族/,
  /^预告家族/,
  // chain-watch 自己的前置闸文案(复访路径直调 executeSignal、不经前置闸,
  // 理论不可达;列出以免日后复用该 helper 时误判为"未知原因")。
  /^市场已关闭/,
];

/** 复访后是否值得留在队列里等下个 tick(2026-08-02 审计,同日复查修正)。
 * 意图不变:只有"下个 tick 真有可能变好"的瞬态结果才留队,免得终局 skip
 * 白跑满 REFILL_MAX_TRIES=4 次 /book 拉取(每次 2-4 个代理往返,挤的是新
 * 信号的 tick 预算)。修正的是**判据挑错了分支**:第一轮只看 attempt.status,
 * 于是所有 skipped 一律出队,而复访第一次最可能命中的两种 skip(限价内深度
 * 不足 / 已重定价)恰恰是纯瞬态 —— 12 分钟窗口在第一次复访就被自己关掉,
 * 07-28 那 85 股 ≤0.69 的补货照样没人接。故 skipped 改为按 **reason** 分流,
 * 表与逐条理由见 REFILL_TRANSIENT_SKIP / REFILL_TERMINAL_SKIP。
 *
 * onUnknownReason 只是把那行 warn 的落点参数化(默认 console.warn),让测试
 * 能断言"未识别 reason 确实报了警"而不必劫持全局 console。 */
export function shouldKeepInRefillQueue(
  attempt: TradeAttempt,
  onUnknownReason: (msg: string) => void = (msg) => console.warn(msg)
): boolean {
  // 成交/部分成交 = 卖家确实在补货,这正是复访存在的理由(07-28 形态)。敞口
  // 若已打满,下一次复访会被 executeSignal 的 per-token 帽拒成「累计敞口已满」,
  // 那时才按终局出队 —— 判据留在执行侧,这里不重复实现敞口口径。
  if (attempt.status === "filled" || attempt.status === "partial") return true;
  // none = FAK 已发出但零成交(三种文案:未成交即撤 ×2、撮合未终局):限价内
  // 当时无对手,下个 tick 可能就挂出来了 —— 纯瞬态。
  if (attempt.status === "none") return true;
  // 异常:仅当确知"没发出去"才算传输层瞬态可重试。posted===true 或 "unknown"
  // 一律出队 —— 单可能已在链上,重试等于对未知持仓再加一腿(fail-closed,与
  // P0-3/M4 同口径)。
  if (attempt.status === "error") {
    return attempt.posted !== true && attempt.posted !== "unknown";
  }
  // dry:复访扫描已由 executionMode()==="live" 把关,理论不可达;真到了也是
  // 终局(干跑不该占着复访预算)。
  if (attempt.status !== "skipped") return false;
  const reason = attempt.reason ?? "";
  const transient = REFILL_TRANSIENT_SKIP.find((t) => t.re.test(reason));
  if (transient) return true;
  if (REFILL_TERMINAL_SKIP.some((re) => re.test(reason))) return false;
  // 未匹配到任何已知 reason → 默认**出队**(保守):资金路径上"不认识的
  // 状态"绝不按可继续下单处理,默认留队会让未知形态每 tick 再动一次真金。
  // 代价是 executeSignal 新增 skip 文案时会静默丢掉一次补仓机会 —— 所以必须
  // 留这行 warn:第一轮的失配正是因为没有任何告警,静默了整整一批。
  onUnknownReason(
    `[chain-watch] 补仓复访:未识别的 skip 原因,按终局出队(保守)——` +
      ` 请补进 REFILL_TRANSIENT_SKIP/REFILL_TERMINAL_SKIP: ${reason.slice(0, 160)}`
  );
  return false;
}
