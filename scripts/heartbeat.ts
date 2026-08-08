/**
 * 心跳监控 + 日报 — cron 入口。
 *
 * 用法:
 *   npx tsx scripts/heartbeat.ts --watch   每 10 分钟:两条通道超龄则发告警邮件,恢复发恢复邮件
 *   npx tsx scripts/heartbeat.ts --daily   每天 09:05:发运行日报(本身就是"系统活着"的日频心跳)
 *
 * 判活依据:run-cron.sh 在脚本 exit 0 后 touch 的 data/last-ok-<name> 标记文件
 * (chain-watch 兜底用 data/chain-watch-state.json,它每次成功 tick 都会重写)。
 * 告警只在状态翻转时发一次(ok→down / down→ok),状态存 data/heartbeat-state.json。
 * 日报统计基于日志字节 offset("自上次日报以来"),周日日志截断后自动归零重来。
 *
 * §3.1 静默单点探针(2026-07-11):mtime 判活只覆盖"进程死了",下列单点挂掉
 * 后进程照常 exit 0、监控全绿,系统却已实质停摆:
 *   探针 0 SMTP    — verify 握手,失败即 exit≠0 → run-cron 不 ping
 *                    HC_PING_HEARTBEAT → healthchecks.io 从外部拉响(SMTP
 *                    死了邮件自报是不可能的,这是唯一出路);
 *   探针 1 kill-switch — trading-halt 文件存在(自动熔断落的)即告警;
 *   探针 2 Clash   — 经代理探 gamma-api,连续 2 次(≈20min)失败告警;
 *   探针 3 claude  — 每小时跑一次 claude -p 探针,连续 2 次(≈2h)失败告警
 *                    (登录态失效时 LLM 判读静默 fail-open,🟢/自动下单闸门
 *                    整体消失而邮件表面全绿)。
 *   探针 4 RPC     — 逐路探活,可用少于 2 路即告警(信号入口的冗余度);
 *   探针 5 余额    — proxy 的 pUSD 低于两笔单的量即告警;
 *   探针 6 出口国别 — 代理出口 IP 落在 US 即告警。
 * 探针 1-6 的 key→label 登记在 PROBE_REGISTRY(唯一真相,--watch 告警与 --daily
 * 日报共用;2026-08-02 审计前是两份手抄列表,新探针进不了日报)。
 * 日报里的探针状态是**三态**(2026-08-02 复查):ok / down / unknown。判据是
 * state.probeRuns —— 每次探针真跑过才写的记录,探不到显式写 unknown。只看
 * alert 的话,fail-open 探针在探不到时不写 alert,"从未执行过"会被渲染成绿色
 * ok,这正是本文件反复引用的"日报全绿是假保证"。
 * 三态的**主题行**另有去抖(2026-08-02 三轮复查):unknown 需连续
 * PROBE_UNKNOWN_SUBJECT_RUNS 次才上标题(失联/无记录除外,立刻上),
 * 正文表格仍逐次如实显示 —— 主题行是唯一保证被读到的一行,不能常驻噪音。
 *
 * 注意:本机(sufe)整机死亡时本脚本同样死亡 —— 这层只报"进程还在但坏了";
 * "整机被清"必须靠外部 healthchecks.io(见 run-cron.sh 的 HC_PING_*)。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { sendMail, verifySmtp } from "./mailer";
import { writeFileAtomic } from "../lib/fsAtomic";
import { rpcPostRaw, rpcPostJson, proxyEndpoint } from "../lib/polymarket/rpcTransport";
import {
  classifyRpcRouteState,
  summarizeRpcQuorum,
  type RpcQuorum,
  type RpcRouteState,
} from "../lib/polymarket/rpcQuorum";

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const LOGS = path.join(ROOT, "logs");
const STATE_FILE = path.join(DATA, "heartbeat-state.json");

interface Channel {
  key: string;
  label: string;
  /** 按优先级取第一个存在的文件的 mtime 作为"最后成功时间" */
  markers: string[];
  log: string;
  staleMinutes: number;
}

const CHANNELS: Channel[] = [
  {
    key: "chain-watch",
    label: "chain-watch(哨兵/3分钟)",
    markers: [path.join(DATA, "last-ok-chain-watch"), path.join(DATA, "chain-watch-state.json")],
    log: path.join(LOGS, "chain-watch.log"),
    staleMinutes: 15, // 5 个 tick 全失败才算 down,容忍单次 RPC 抖动
  },
  {
    key: "scan-notify",
    label: "scan-notify(巡逻/30分钟)",
    markers: [path.join(DATA, "last-ok-scan-notify")],
    log: path.join(LOGS, "scan-notify.log"),
    staleMinutes: 130, // 4 个 tick;Gamma 偶发不可达不告警,持续挂(如 Clash 死)才告警
  },
];

// ── 状态 ──

interface AlertEntry {
  status: "ok" | "down";
  since: string;
}

/** 单个探针"最近一次**实际执行**"的结果(2026-08-02 复查)。
 * alert 只在状态翻转时写,而 fail-open 的探针在"根本探不到"时压根不进
 * pushProbeEvent —— 日报只看 alert 就会把"从未执行过"渲染成绿色 ok。
 * 这里独立记下每次真跑的时刻与三态结果:探不到必须显式落 "unknown",
 * 不允许"什么都不写"(什么都不写 = 日报里看起来一切正常)。 */
interface ProbeRun {
  at: string;
  status: "ok" | "down" | "unknown";
  /** 人读的一句话原因/读数(unknown 时会直接渲染进日报,让操作员知道缺什么)。 */
  detail?: string;
}

interface HeartbeatState {
  alert: Record<string, AlertEntry>;
  offsets: Record<string, number>;
  /** st_ino of each log at the time its offset was recorded. When the log is
   * rotated (tail -c ... > tmp && mv changes the inode) the byte offset is
   * meaningless against the new file, so a changed inode forces a from-0
   * reread instead of the offset-vs-size heuristic (which mis-fires when the
   * rotated file is smaller than the old offset). */
  logInodes: Record<string, number>;
  lastDigestAt: string | null;
  /** §3.1 探针连续失败计数(达到阈值才翻转告警,容忍单次网络抖动)。 */
  probeFails: Record<string, number>;
  /** key → 最近一次实际执行的探针结果(见 ProbeRun)。旧 state 文件没有这个
   * 字段,读到的就是空对象,于是全部按 unknown(黄)渲染 —— 向后兼容的失败
   * 方向必须是"未探到"而不是"正常"。 */
  probeRuns: Record<string, ProbeRun>;
  /** key → **连续**落到 unknown 的实际执行次数(非 unknown 的一次执行即清零)。
   * N2(2026-08-02 三轮复查):probeRuns 只留最后一条,daily() 于是一次瞬断就把
   * "⚠探针未探到×N" 顶上主题行;红(down)有 PROBE_FAIL_THRESHOLD 去抖,唯独黄没有。
   * 这个计数就是黄的去抖依据(见 PROBE_UNKNOWN_SUBJECT_RUNS)。旧 state 缺该字段
   * = 从 0 重新计数,方向安全(最多晚 N 个 watch 周期上主题行,表格照常显示)。 */
  probeUnknowns: Record<string, number>;
  /** claude 登录态探针的上次执行时刻(小时级节流,每次探针都是一次真调用)。 */
  lastClaudeProbeAt: string | null;
}

function loadState(): HeartbeatState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      alert: raw.alert && typeof raw.alert === "object" ? raw.alert : {},
      offsets: raw.offsets && typeof raw.offsets === "object" ? raw.offsets : {},
      logInodes: raw.logInodes && typeof raw.logInodes === "object" ? raw.logInodes : {},
      lastDigestAt: typeof raw.lastDigestAt === "string" ? raw.lastDigestAt : null,
      probeFails: raw.probeFails && typeof raw.probeFails === "object" ? raw.probeFails : {},
      // 2026-08-02 复查:旧 state 文件(部署当天在产的那份)没有 probeRuns,
      // 这里必须容缺不能崩;缺失 = 全部 unknown。
      probeRuns: raw.probeRuns && typeof raw.probeRuns === "object" ? raw.probeRuns : {},
      // 同上,2026-08-02 三轮复查新增:缺失 = 空对象 = 从 0 重新计数。
      probeUnknowns: raw.probeUnknowns && typeof raw.probeUnknowns === "object" ? raw.probeUnknowns : {},
      lastClaudeProbeAt: typeof raw.lastClaudeProbeAt === "string" ? raw.lastClaudeProbeAt : null,
    };
  } catch {
    return { alert: {}, offsets: {}, logInodes: {}, lastDigestAt: null, probeFails: {}, probeRuns: {}, probeUnknowns: {}, lastClaudeProbeAt: null };
  }
}

function saveState(state: HeartbeatState): void {
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 1) + "\n");
}

/** 顺手项(2026-07-19 审查):claude 探针时间戳单独即时落盘 —— 探针是真实
 * 计费调用,只靠 tick 末尾的 saveState 的话,探针后任何一步挂死/被杀都会丢
 * 时间戳,下 tick 重复烧一次探针。只回写这一个字段:alert 翻转必须等发信
 * 成功才落盘(at-least-once),整个 state 不能提前保存。 */
function persistClaudeProbeAt(at: string | null): void {
  try {
    const onDisk = loadState();
    onDisk.lastClaudeProbeAt = at;
    saveState(onDisk);
  } catch {
    // 尽力而为:失败的代价只是可能多探针一次
  }
}

/** N8(2026-08-02 三轮复查):把"这一针确实跑过、结果是什么"独立落盘,不与发信
 * 成败绑定。watch() 末尾的 saveState 排在 `await sendMail` **之后**,SMTP 一抖
 * (或代理半开、超时抛错)整个 tick 的 probeRuns 就全丢;而 lastClaudeProbeAt 是
 * persistClaudeProbeAt 独立直写的,于是 claude 探针的 55 min 节流照常推进、执行
 * 记录却没落 —— 连续两次踩中(>130 min,正是 claude-login 的 PROBE_STALE_MINUTES)
 * 日报就把它渲染成 unknown。那是纯粹的假黄:探针跑了、也过了,只是邮件没发出去。
 *
 * 与 alert 的落盘语义**刻意不同,不要"统一"掉**:
 *   alert     = "这条告警送达了没有" → 必须发信成功才落(at-least-once)。提前落盘
 *               会让状态先翻转而邮件丢失,该 down 事件从此永不重发 = 真丢告警。
 *   probeRuns = "这一针跑过没有、结果是什么" → 客观事实,与告警是否送达无关。
 *               发信失败不会让它变成"没跑过";不落盘反而凭空转黄(假信号),
 *               而假黄的代价是把真黄淹掉。
 * 因此只回写 probeRuns / probeUnknowns 两个字段,并且**先从盘上重读再改**,
 * 绝不把内存里尚未获准落盘的 alert 一起带出去。 */
function persistProbeRuns(state: HeartbeatState): void {
  try {
    const onDisk = loadState();
    onDisk.probeRuns = state.probeRuns;
    onDisk.probeUnknowns = state.probeUnknowns;
    saveState(onDisk);
  } catch {
    // 尽力而为:失败的代价只是这一 tick 的探针记录退回到"等末尾 saveState"的老路
  }
}

// ── 工具 ──

function fmtTime(d: Date): string {
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 最后成功时间(取存在的标记文件里最新的 mtime);全都不存在返回 null。 */
function lastOkAt(ch: Channel): Date | null {
  let best: Date | null = null;
  for (const p of ch.markers) {
    try {
      const m = fs.statSync(p).mtime;
      if (!best || m > best) best = m;
    } catch {
      // 文件不存在 — 试下一个
    }
  }
  return best;
}

function ageMinutes(d: Date): number {
  return Math.round((Date.now() - d.getTime()) / 60_000);
}

function tailLines(file: string, n: number): string[] {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const len = Math.min(size, 16_384);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

// ── §3.1 静默单点探针 ──

const HALT_KEY = "trading-halt";
const PROXY_KEY = "proxy-gamma";
const CLAUDE_KEY = "claude-login";
const RPC_KEY = "rpc-quorum";
const BALANCE_KEY = "pusd-balance";
const EGRESS_KEY = "proxy-egress";
/** 连续失败达到该次数才翻转 down(容忍单次网络抖动)。 */
const PROBE_FAIL_THRESHOLD = 2;
/** unknown(黄)升日报**主题行**所需的连续"探到但没结果"次数(N2,2026-08-02
 * 三轮复查)。此前红有 PROBE_FAIL_THRESHOLD=2 的去抖,黄却一次瞬断就上主题行 ——
 * 而 probeEgressCountry 走 ipinfo.io、经 Clash、10 s 超时、零重试,系统完全健康时
 * 也会周期性挂黄。主题行是唯一保证被读到的一行,让它常驻噪音等于把它作废。
 * 取 3,严于 PROBE_FAIL_THRESHOLD(2),理由是两者证据强度不同:down 是探针明确
 * 判定"坏了",unknown 连"确认坏了"都算不上、噪音率却更高,门槛只能更严不能更松。
 * 3 次 × watch 10 min ≈ 30 min,远短于日报 24 h 周期 —— 真故障当天照样上主题行,
 * 只是额外要求它在发报时刻仍然成立,而不是半夜闪了一下。
 * 作用域**仅限主题行**:正文表格 / text / JSON 口径继续如实显示单次 unknown。
 * 例外(不走本阈值、立刻上主题行):"没有执行记录 / 记录过旧"这一类 unknown ——
 * 它意味着 --watch 自己停了或该 key 压根没跑过,记录停更已 ≥ probeStaleMinutes
 * (默认 25 min = 2 个 watch 周期,本身就是时间维度的去抖),与"跑了但这一针没取到
 * 值"性质完全不同,恰恰是最该立刻看见的一种。 */
const PROBE_UNKNOWN_SUBJECT_RUNS = 3;

/** 探针清单的唯一真相(2026-08-02 审计)。此前 watch() 的探针注册与 daily() 的
 * PROBE_LABELS 是两份互不相干的列表,本批新增的 rpc-quorum / pusd-balance /
 * proxy-egress 只进了前者 —— 即时翻转告警会发,而第二天日报的探针表格与主题行
 * "⛔探针down×N" 完全看不到它们,等于把 2026-07-11 claude token 那个
 * "日报全绿是假保证" 的坑原样再踩一遍。key→label 从此只在这里维护:
 * pushProbeEvent 不再收 label 参数(没有参数就漂移不了),daily() 也从这里取,
 * 新增探针改一处即可。文案沿用告警邮件的口径(label 直接当邮件小标题渲染,
 * 要能独立读懂),日报表格里同样自洽。 */
const PROBE_REGISTRY: Array<[string, string]> = [
  [HALT_KEY, "自动交易 kill-switch(trading-halt)"],
  [PROXY_KEY, "Gamma/代理连通(Clash 单点)"],
  [CLAUDE_KEY, "claude CLI 登录态(LLM 判读)"],
  [RPC_KEY, "链上 RPC 冗余度"],
  [BALANCE_KEY, "抵押品余额(pUSD)"],
  [EGRESS_KEY, "代理出口国别"],
];
/** 未登记的 key 回落到 key 本身:label 缺失绝不能让告警整封发不出去。 */
const probeLabel = (key: string): string => PROBE_REGISTRY.find(([k]) => k === key)?.[1] ?? key;

/** 探针记录的新鲜度上限(分钟)。超过即视为"这段时间根本没探过",日报按
 * unknown 渲染(2026-08-02 复查):watch 整个挂掉时 state 会原地冻结,只看
 * 冻结下来的 alert 一样是"全绿",和探针从未执行是同一种假保证。
 * 默认 25 = 2 个 watch 周期(10 min)+ cron 抖动余量。
 * claude-login 例外:它自身按 55 min 节流(每次都是真实计费调用,见探针 3),
 * 用 2 个它自己的周期,否则日报里它会常驻黄色误报、把真信号淹掉。
 * 未登记的 key 回落到默认值 —— 漏登记只会更早翻黄,方向是安全的。 */
const PROBE_STALE_DEFAULT_MINUTES = 25;
const PROBE_STALE_MINUTES: Record<string, number> = { [CLAUDE_KEY]: 130 };
const probeStaleMinutes = (key: string): number => PROBE_STALE_MINUTES[key] ?? PROBE_STALE_DEFAULT_MINUTES;

/** 记一次"探针实际执行过"。2026-08-02 复查:第一轮把 daily() 改成遍历
 * PROBE_REGISTRY(方向正确),但状态仍只从 state.alert 推断,而三个 fail-open
 * 新探针在探不到时不写 alert —— ONCHAIN_RPC_URLS 未配 / 全部 RPC 挂 / 代理死掉
 * (恰恰是最该看见的三种情况)在日报里全渲染成绿色 ok,把 2026-07-11
 * "日报全绿是假保证"的坑原样复刻了一遍。fail-open 的语义只是"不告警",
 * 绝不等于"判为正常"——所以探不到时也必须落一条 status:"unknown"。 */
function markProbeRun(state: HeartbeatState, key: string, status: ProbeRun["status"], detail?: string): void {
  state.probeRuns[key] = { at: new Date().toISOString(), status, ...(detail ? { detail } : {}) };
  // N2(2026-08-02 三轮复查):连续 unknown 计数,daily() 的主题行去抖依据。
  // 任何一次探到结果(ok 或 down)都清零 —— 去抖要的是"持续没探到",不是累计。
  // 记在这里而不是各 unknown 调用点:与 probeRuns 同源同时机,新增探针漏不掉。
  state.probeUnknowns[key] = status === "unknown" ? (state.probeUnknowns[key] ?? 0) + 1 : 0;
}

function haltFilePath(): string {
  const p = process.env.EXEC_HALT_FILE?.trim() || "data/trading-halt";
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

/** Gamma 经代理(heartbeat 在 run-cron 下继承 HTTPS_PROXY+NODE_USE_ENV_PROXY,
 * 走的正是 scan-notify/盘口注解/自动下单同一条 Clash 路径)。 */
async function probeGamma(): Promise<boolean> {
  try {
    const res = await fetch("https://gamma-api.polymarket.com/markets?limit=1", {
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 探针自身只多带一个"代理配没配"的标志,判据全部在 lib/polymarket/rpcQuorum.ts。 */
interface RpcQuorumProbe extends RpcQuorum {
  proxyConfigured: boolean;
}

/** RPC 法定人数(2026-08-02 复盘;2026-08-07 改双路标定):chain-watch 的
 * eth_getLogs 是全系统唯一的信号入口,4 路冗余里 nodies 已被付费墙挡死
 * (实测 3/3 403)。而原有告警按 marker 文件 mtime 判活,需要连续 5 个 tick
 * 全挂才翻 down —— 一周约 6 次的散点 fatal 永远够不到门槛。这里逐个探,
 * 活的少于 2 路即告警。
 * 用 eth_blockNumber 而非 getLogs:后者各家的窗口/地址过滤限制不同,
 * 会把"策略不同"误报成"端点已死"(2026-08-02 复盘就先踩过这个坑)。
 *
 * 2026-08-07:业务侧已改成代理优先+直连兜底,探针必须按同一口径判活 ——
 * 否则会重演 08-06 的假警(探针并发直连报 0/4 全死,同一 tick 里串行的
 * pUSD 余额却读得到 835.26,chain-watch 也一路 ok)。两条路分别标定还顺带
 * 把"哪一层烂了"直接写进日报:此前这是要人肉 ssh 上去跑对照实验才知道的。 */
async function probeRpcQuorum(): Promise<RpcQuorumProbe> {
  const urls = (process.env.ONCHAIN_RPC_URLS?.trim() || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const proxyConfigured = proxyEndpoint() != null;
  if (urls.length === 0) {
    return {
      alive: 0,
      total: 0,
      dead: [],
      throttled: [],
      viaProxy: 0,
      viaDirect: 0,
      usableProxy: 0,
      usableDirect: 0,
      proxyConfigured,
    };
  }
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });

  const probeOne = async (u: string, route: "proxy" | "direct"): Promise<RpcRouteState> => {
    try {
      const res = await rpcPostRaw(u, payload, { only: route, timeoutMs: 10_000 });
      return classifyRpcRouteState(res.status, res.body);
    } catch {
      // 超时 / 连接被拒:一个应答都没拿到,链路层面判不可达。
      return "unreachable";
    }
  };

  const results = await Promise.all(
    urls.map(async (u) => {
      // 2026-08-07 晚:两条路**串行**,不再对同一主机同时双发。原并发写法把最容易
      // 限流的端点的瞬时压力直接翻倍,是 `死:1rpc.io` 假警的自产来源(实测:背景
      // 0 并发 → 代理 4.00/4;8 并发 → 3.80/4 且失败恰为 `1rpc.io: HTTP 429`)。
      // URL 之间仍并行,所以墙钟只从"一条路"变成"两条路",10 分钟一针完全够用。
      // 注意**两条路照测**:代理成功就跳过直连会毁掉双路标定,而分辨
      // "Clash 死了"和"国际出口烂了"正是这个探针存在的理由。
      const proxy: RpcRouteState = proxyConfigured ? await probeOne(u, "proxy") : "unreachable";
      const direct: RpcRouteState = await probeOne(u, "direct");
      return { host: hostOf(u), proxy, direct };
    })
  );

  return { ...summarizeRpcQuorum(results), proxyConfigured };
}

/** 只取主机名 —— RPC URL 的 path 常含 API key,绝不进日志/邮件。 */
function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "(unparseable)";
  }
}

/** 抵押品余额。2026-07 底 Polymarket 把结算币从 USDC.e 换成自家 pUSD,
 * 任何按旧 token 查余额的监控都会读到 0 并误判"没钱了"。 */
const PUSD_ADDRESS = (process.env.PUSD_ADDRESS?.trim() || "0xc011a7e12A19F7b1F670D46f03b03f3342e82dfb").toLowerCase();

async function probeCollateralBalance(): Promise<number | null> {
  const funder = process.env.EXEC_FUNDER?.trim() || "0x3a60750796A52e84DA325B74C5ad5c031f296Db9";
  const urls = (process.env.ONCHAIN_RPC_URLS?.trim() || "https://polygon.drpc.org")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  // balanceOf(address) = 0x70a08231
  const data = `0x70a08231${funder.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  for (const u of urls) {
    try {
      // 与业务侧同一条传输路径(代理优先+直连兜底)。此前这里是串行 fetch 直连,
      // 恰好比并发的 quorum 探针更耐拥塞 —— 08-06 "0/4 全死却读到 835.26 pUSD"
      // 的分叉就出在这个差异上。两针口径统一后不会再互相打脸。
      const result = await rpcPostJson<string>(
        u,
        "eth_call",
        [{ to: PUSD_ADDRESS, data }, "latest"],
        { timeoutMs: 10_000 }
      );
      if (typeof result !== "string") continue;
      // pUSD 是 6 位小数
      return Number(BigInt(result)) / 1e6;
    } catch {
      // 下一个端点
    }
  }
  return null;
}

/** 代理出口国别。平台对美国出口 IP 有 KYC/风控限制,Clash 节点漂到美国会让
 * 下单静默被拒;此前完全不可见。查不到国别不算故障(fail-open)。 */
async function probeEgressCountry(): Promise<string | null> {
  try {
    const res = await fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { country?: string };
    return typeof j.country === "string" ? j.country : null;
  } catch {
    return null;
  }
}

/** claude CLI 登录态:与 llmStance.runClaude 同一 bin/参数形态/env 白名单的
 * 最小真实调用(登录态失效只有真调用才暴露)。 */
function probeClaude(): Promise<{ ok: boolean; detail: string }> {
  const bin = process.env.CLAUDE_BIN?.trim() || "claude";
  const model = process.env.LLM_STANCE_MODEL?.trim() || "claude-opus-4-8";
  const args = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--model", model];
  const allow = [
    "PATH", "HOME", "SHELL", "USER", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "NODE_USE_ENV_PROXY", "TMPDIR", "LANG", "LC_ALL", "TERM",
  ];
  const env = {} as NodeJS.ProcessEnv;
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, cwd: os.tmpdir(), env },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, detail: `${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ""}` });
          return;
        }
        try {
          const wrapper = JSON.parse(String(stdout)) as { is_error?: boolean; result?: unknown };
          if (wrapper?.is_error) {
            resolve({ ok: false, detail: `is_error: ${String(wrapper.result).slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, detail: "" });
        } catch {
          resolve({ ok: false, detail: `非 JSON 输出: ${String(stdout).slice(0, 120)}` });
        }
      }
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end("只回复两个字:正常");
  });
}

// ── watch 模式:超龄告警 / 恢复通知 ──

async function watch(): Promise<void> {
  // 探针 0:SMTP。verify 失败即硬失败(exit≠0)—— run-cron 不 ping
  // HC_PING_HEARTBEAT,由 healthchecks.io 从外部拉响。SMTP 死了后面的一切
  // 告警邮件都发不出去,继续跑只是自欺。
  await verifySmtp();

  const state = loadState();
  const events: Array<{ ch: Channel; kind: "down" | "recovered"; detail: string }> = [];
  const summary: Record<string, string> = {};

  // 探针事件与通道告警共用同一封翻转邮件;probe 无日志文件(tail 为空)。
  // label 一律由 PROBE_REGISTRY 提供、不再由调用点传入(2026-08-02 审计):
  // 调用点各写各的文案正是日报与告警两张探针清单漂移的根因。
  // runDetail 只是给日报/state 的一句读数(如 "3/4 路可用"),与告警正文无关;
  // 走到这里就意味着这一针真的探到了结果,顺手落 probeRuns —— 记录写在
  // pushProbeEvent 里而不是各调用点,新增探针就漏不掉(2026-08-02 复查)。
  const pushProbeEvent = (
    key: string,
    down: boolean,
    downDetail: string,
    recoverDetail: string,
    runDetail?: string
  ): void => {
    const prev = state.alert[key]?.status ?? "ok";
    const ch: Channel = { key, label: probeLabel(key), markers: [], log: "", staleMinutes: 0 };
    if (down && prev !== "down") {
      events.push({ ch, kind: "down", detail: downDetail });
      state.alert[key] = { status: "down", since: new Date().toISOString() };
    } else if (!down && prev === "down") {
      events.push({ ch, kind: "recovered", detail: recoverDetail });
      state.alert[key] = { status: "ok", since: new Date().toISOString() };
    }
    summary[key] = down ? "down" : "ok";
    // 记的是 latched 后的告警态(与 daily 的判据同源);阈值以下的抖动仍靠
    // probeFails 在日报里显示 failing(n/N),文案不变。
    markProbeRun(state, key, down ? "down" : "ok", runDetail);
  };

  // 探针 1:kill-switch 文件。自动熔断(连续错误/连亏/ledger 写失败)只落
  // 本地文件,不报的话操作员可能几天不知道引擎已停。文件存在与否是确定态,
  // 不走连续失败阈值。
  {
    let haltContent: string | null = null;
    try {
      haltContent = fs.readFileSync(haltFilePath(), "utf8").slice(0, 400);
    } catch {
      haltContent = null;
    }
    pushProbeEvent(
      HALT_KEY,
      haltContent != null,
      `kill-switch 文件存在,自动交易已全部停止:${haltFilePath()}\n内容:${haltContent || "(空)"}\n人工排查后删除该文件恢复。`,
      "kill-switch 已移除,自动交易恢复。"
    );
  }

  // 探针 2:Clash 代理(经代理访问 gamma-api)。
  {
    const ok = await probeGamma();
    const fails = ok ? 0 : (state.probeFails[PROXY_KEY] ?? 0) + 1;
    state.probeFails[PROXY_KEY] = fails;
    // 低于阈值的失败不翻转(保持原状态),单次成功即恢复。
    const down = fails >= PROBE_FAIL_THRESHOLD || (!ok && state.alert[PROXY_KEY]?.status === "down");
    pushProbeEvent(
      PROXY_KEY,
      down,
      `连续 ${fails} 次无法经代理访问 gamma-api —— Clash 大概率已死。scan-notify 整通道、盘口注解、自动下单、结算对账全部依赖它;chain-watch 链上告警(直连 RPC)不受影响。`,
      "Gamma 经代理已恢复可达。"
    );
    // 低于阈值的失败必须可见:显示 "ok" 曾把"claude token 已死一针"糊过部署验证
    // (2026-07-11 实测教训)。
    if (!down && fails > 0) summary[PROXY_KEY] = `failing(${fails}/${PROBE_FAIL_THRESHOLD})`;
  }

  // 探针 3:claude CLI 登录态(每小时一次,每次是真调用)。
  {
    const last = state.lastClaudeProbeAt ? Date.parse(state.lastClaudeProbeAt) : 0;
    if (Date.now() - last > 55 * 60_000) {
      state.lastClaudeProbeAt = new Date().toISOString();
      persistClaudeProbeAt(state.lastClaudeProbeAt); // 探针发起前即落盘,防重复计费探针
      const { ok, detail } = await probeClaude();
      const fails = ok ? 0 : (state.probeFails[CLAUDE_KEY] ?? 0) + 1;
      state.probeFails[CLAUDE_KEY] = fails;
      const down = fails >= PROBE_FAIL_THRESHOLD || (!ok && state.alert[CLAUDE_KEY]?.status === "down");
      pushProbeEvent(
        CLAUDE_KEY,
        down,
        `连续 ${fails} 次 claude -p 探针失败:${detail || "无输出"}\nLLM 判读正在静默 fail-open —— 🟢 双确认档与自动下单闸门已实质停摆(只发 🟠),邮件表面全绿。ssh sufe 后重新 claude setup-token 并更新 .env 的 CLAUDE_CODE_OAUTH_TOKEN。`,
        "claude CLI 探针已恢复。"
      );
      if (!down && fails > 0) summary[CLAUDE_KEY] = `failing(${fails}/${PROBE_FAIL_THRESHOLD})`;
    } else {
      // 节流命中:这一 tick 没有真调用,故意**不**写 probeRuns —— 记录的语义是
      // "最近一次实际执行",在这里刷新时间戳等于用一次没发生的探测冒充成功。
      // 日报侧对 claude-login 用 130 分钟的新鲜度窗口(见 PROBE_STALE_MINUTES)
      // 容纳这 55 分钟节流。
      const st = state.alert[CLAUDE_KEY]?.status ?? "ok";
      const fails = state.probeFails[CLAUDE_KEY] ?? 0;
      summary[CLAUDE_KEY] =
        st === "down" ? "down" : fails > 0 ? `failing(${fails}/${PROBE_FAIL_THRESHOLD})` : "ok";
    }
  }

  // 探针 4:RPC 法定人数(2026-08-02;2026-08-07 起按代理/直连双路标定)。
  // 信号入口的冗余度必须可见。
  {
    const {
      alive,
      total,
      dead,
      throttled,
      viaProxy,
      viaDirect,
      usableProxy,
      usableDirect,
      proxyConfigured,
    } = await probeRpcQuorum();
    if (total > 0) {
      // 判据是**链路可达**数,不是可用读数:被限流的末位兜底腿(1rpc.io 在 .env
      // 里排第 4,而三个业务消费点全是 for 循环按序降级、第一个成功即返回 ——
      // 前三路健康时它根本不会被调用)不该把告警拖成 degraded。真正要报的是
      // 链路层面的失明。2026-08-07 晚实测:该噪音占 `死:1rpc.io` 的全部来源。
      const ok = alive >= 2;
      const fails = ok ? 0 : (state.probeFails[RPC_KEY] ?? 0) + 1;
      state.probeFails[RPC_KEY] = fails;
      const down = fails >= PROBE_FAIL_THRESHOLD || (!ok && state.alert[RPC_KEY]?.status === "down");
      // 分路读数直接进告警正文 —— "代理 0/4 直连 4/4" 一眼看出是 Clash 死了,
      // "代理 4/4 直连 0/4" 则是国际出口烂了(08-06 的常态,当时无法从日报区分)。
      // 可达数与可用数不等时两个都写,否则"4/4 却取不到数"会变成看不见的坑。
      const leg = (label: string, reach: number, usable: number) =>
        `${label} ${reach}/${total}${usable < reach ? `(可用 ${usable})` : ""}`;
      const routes = proxyConfigured
        ? `${leg("代理", viaProxy, usableProxy)} · ${leg("直连", viaDirect, usableDirect)}`
        : `${leg("直连", viaDirect, usableDirect)}(未配代理)`;
      // 限流与死分开挂 —— 前者是对端的配额闸(链路是通的),后者才是失明。
      const tail =
        (dead.length > 0 ? `,死:${dead.join("/")}` : "") +
        (throttled.length > 0 ? `,限流:${throttled.join("/")}` : "");
      pushProbeEvent(
        RPC_KEY,
        down,
        `可达 RPC 仅剩 ${alive}/${total} 路(${routes};两路皆不可达:${dead.join(", ") || "—"})。eth_getLogs 是全系统唯一的信号入口,冗余耗尽即链上告警完全失明。请更换端点或接入付费 RPC。`,
        "RPC 冗余度已恢复(≥2 路可达)。",
        `${alive}/${total} 路可达(${routes})${tail}`
      );
      summary[RPC_KEY] = down
        ? `down(${alive}/${total};${routes})`
        : dead.length > 0
          ? `degraded(${alive}/${total};${routes}${tail})`
          : `ok(${alive}/${total};${routes}${tail})`;
    } else {
      // ONCHAIN_RPC_URLS 没配 = 这一针根本没探过。2026-08-02 复查:此前这里既不写
      // alert 也不写 summary,日报只看 alert 就渲染成绿色 ok —— 而"一条 RPC 都没配"
      // 恰恰意味着链上信号入口可能整个是空的,最不该被涂绿的正是这一种。
      markProbeRun(state, RPC_KEY, "unknown", "ONCHAIN_RPC_URLS 未配置,未探测");
      summary[RPC_KEY] = "unknown(ONCHAIN_RPC_URLS 未配置)";
    }
  }

  // 探针 5:抵押品余额(pUSD)。低于两笔单的量即预警 —— 余额不足会让整批
  // 绿档信号静默变成 "余额不足" skip。
  {
    const bal = await probeCollateralBalance();
    if (bal != null) {
      const floor = Number(process.env.EXEC_MAX_ORDER_USD || 50) * 2;
      const low = bal < floor;
      const fails = low ? (state.probeFails[BALANCE_KEY] ?? 0) + 1 : 0;
      state.probeFails[BALANCE_KEY] = fails;
      const down = fails >= PROBE_FAIL_THRESHOLD || (low && state.alert[BALANCE_KEY]?.status === "down");
      pushProbeEvent(
        BALANCE_KEY,
        down,
        `proxy 余额 ${bal.toFixed(2)} pUSD < 两笔单的量($${floor})。自动下单会退化成"余额不足"skip;若同时有已结算未回款的持仓,检查平台 relayer 赎回是否停摆。`,
        "pUSD 余额已恢复到安全水位。",
        `${bal.toFixed(2)} pUSD`
      );
      summary[BALANCE_KEY] = `${bal.toFixed(2)} pUSD${low ? " ⚠低" : ""}`;
    } else {
      // 全部 RPC 挂掉时读不到余额:这是"未知",不是"余额充足"。summary 里本来
      // 就写着 unknown,但 summary 是 run 内局部变量、从不落盘,daily() 拿不到
      // ——第二天日报照样一片绿(2026-08-02 复查发现)。落进 probeRuns 才能跨进程。
      markProbeRun(state, BALANCE_KEY, "unknown", "全部 RPC 不可用,余额未读到");
      summary[BALANCE_KEY] = "unknown(RPC 均不可用)";
    }
  }

  // 探针 6:代理出口国别(fail-open,查不到不告警)。
  {
    const cc = await probeEgressCountry();
    if (cc) {
      const bad = cc.toUpperCase() === "US";
      const fails = bad ? (state.probeFails[EGRESS_KEY] ?? 0) + 1 : 0;
      state.probeFails[EGRESS_KEY] = fails;
      const down = fails >= PROBE_FAIL_THRESHOLD || (bad && state.alert[EGRESS_KEY]?.status === "down");
      pushProbeEvent(
        EGRESS_KEY,
        down,
        `代理出口 IP 落在 ${cc} —— Polymarket 对美国出口有 KYC/风控限制,下单可能被静默拒绝。请切换 Clash 节点到非美地区。`,
        "代理出口已切回非美地区。",
        `出口 ${cc}`
      );
      summary[EGRESS_KEY] = bad ? `${cc} ⚠` : cc;
    } else {
      // 代理一死 ipinfo 必然探不到 —— 也就是说"探不到"几乎总与"代理坏了"同时
      // 发生,正是最该看见的时刻。fail-open 只放弃告警,不能顺手判成正常。
      markProbeRun(state, EGRESS_KEY, "unknown", "ipinfo 未返回国别(代理不通时必然如此)");
      summary[EGRESS_KEY] = "unknown";
    }
  }

  // N8(2026-08-02 三轮复查):探针段到此结束,probeRuns/probeUnknowns 之后不再变化
  // —— 就地独立落盘。后面还有日志解析(tailLines/JSON.parse)和 `await sendMail`,
  // 其中任一处抛错都会让末尾的 saveState 永远执行不到,把"探针跑过没有"这个客观
  // 事实一并带走(claude 探针尤其致命:它的节流时间戳是独立直写的,记录丢了 = 假黄)。
  // alert 仍然只在末尾、发信成功之后才落盘,语义原样不动 —— 两者的区别见
  // persistProbeRuns 的注释。
  persistProbeRuns(state);

  for (const ch of CHANNELS) {
    const last = lastOkAt(ch);
    const prev = state.alert[ch.key]?.status ?? "ok";
    if (last == null) {
      summary[ch.key] = "unknown(尚无成功标记)";
      continue; // 部署初期标记还没生成 — 不判定
    }
    const age = ageMinutes(last);
    const now: "ok" | "down" = age > ch.staleMinutes ? "down" : "ok";
    summary[ch.key] = `${now}(最后成功 ${age} 分钟前)`;

    if (now === "down" && prev !== "down") {
      events.push({
        ch,
        kind: "down",
        detail: `最后一次成功运行在 ${fmtTime(last)}(${age} 分钟前),超过阈值 ${ch.staleMinutes} 分钟。`,
      });
      state.alert[ch.key] = { status: "down", since: new Date().toISOString() };
    } else if (now === "ok" && prev === "down") {
      const since = state.alert[ch.key]?.since;
      const downMin = since ? Math.round((Date.now() - Date.parse(since)) / 60_000) : null;
      events.push({
        ch,
        kind: "recovered",
        detail: `已恢复正常运行${downMin != null ? `(告警持续约 ${downMin} 分钟)` : ""}。`,
      });
      state.alert[ch.key] = { status: "ok", since: new Date().toISOString() };
    }
  }

  // Degradation check for chain-watch: it exits 0 (marker stays fresh) even
  // when only the first block window of each tick succeeds, so a marker-mtime
  // check alone never goes "down" while the cursor silently falls behind and
  // starts permanently skipping blocks. Inspect recent tick summaries for
  // persistent partial failures (sweep_error) or accumulating gap.
  {
    const chainCh = CHANNELS[0];
    const DEG_KEY = "chain-watch-degraded";
    const recent = tailLines(chainCh.log, 12).filter((l) => l.startsWith("{"));
    let samples = 0;
    let sweepErrs = 0;
    let gapSum = 0;
    let gapTicks = 0;
    for (const l of recent) {
      try {
        const j = JSON.parse(l);
        if (j.mode !== "chain-watch") continue;
        samples += 1;
        if (j.sweep_error) sweepErrs += 1;
        const g = Number(j.gap) || 0;
        gapSum += g;
        if (g > 0) gapTicks += 1;
      } catch {
        // non-JSON line — ignore
      }
    }
    // gap 要求至少 2 个 tick 都出现:停机后的首个追赶 tick 会一次性记录一个大
    // gap(chain-watch 自己已就此发过 gap 告警),那是已结束的历史事件;只有多个
    // tick 连续产生 gap 才说明"正在持续漏扫"。sweep_error 保持原判据。
    const degraded = samples >= 5 && (sweepErrs >= 5 || (gapTicks >= 2 && gapSum > 300));
    const prevDegraded = state.alert[DEG_KEY]?.status === "down";
    const degChannel: Channel = { ...chainCh, key: DEG_KEY };
    if (degraded && !prevDegraded) {
      events.push({
        ch: { ...degChannel, label: "chain-watch(持续部分失败 / 漏块)" },
        kind: "down",
        detail: `进程仍在运行(exit 0)但最近 ${samples} 个 tick 中 ${sweepErrs} 个部分失败,累计 gap ${gapSum} 块 —— 正在持续漏扫,监控 mtime 检查无法发现。`,
      });
      state.alert[DEG_KEY] = { status: "down", since: new Date().toISOString() };
    } else if (!degraded && prevDegraded) {
      events.push({
        ch: { ...degChannel, label: "chain-watch(部分失败已恢复)" },
        kind: "recovered",
        detail: "部分失败 / 漏块累积已恢复正常。",
      });
      state.alert[DEG_KEY] = { status: "ok", since: new Date().toISOString() };
    }
    summary[DEG_KEY] = degraded ? `degraded(${sweepErrs}/${samples} 部分失败, gap累计 ${gapSum})` : "ok";
  }

  if (events.length > 0) {
    const downs = events.filter((e) => e.kind === "down");
    const subject =
      downs.length > 0
        ? `[PredEdge 告警] ${downs.map((e) => e.ch.key).join(" + ")} 停止工作`
        : `[PredEdge 恢复] ${events.map((e) => e.ch.key).join(" + ")} 已恢复`;

    const blocks = events
      .map((e) => {
        const tail = tailLines(e.ch.log, 10)
          .map((l) => escapeHtml(l))
          .join("\n");
        return `<h3 style="margin:14px 0 4px;font-size:14px;color:${e.kind === "down" ? "#f87171" : "#34d399"}">${
          e.kind === "down" ? "⛔" : "✅"
        } ${escapeHtml(e.ch.label)}</h3>
        <p style="margin:0 0 6px">${escapeHtml(e.detail)}</p>
        ${tail ? `<pre style="background:#1b1f26;padding:8px 10px;border-radius:6px;font-size:11px;overflow-x:auto;color:#9aa3ad">${tail}</pre>` : ""}`;
      })
      .join("\n");

    const html = `<div style="background:#14171c;color:#e6e8eb;padding:18px 20px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:760px">
      <h2 style="margin:0 0 8px;font-size:16px">PredEdge 心跳监控</h2>
      ${blocks}
      <p style="margin:12px 0 0;font-size:11px;color:#6b7280">手动体检:ssh sufe 后 tail 各日志;本邮件由 scripts/heartbeat.ts --watch 发送,只在状态翻转时发一次。</p>
    </div>`;
    const text = events.map((e) => `${e.kind === "down" ? "DOWN" : "RECOVERED"}: ${e.ch.key} — ${e.detail}`).join("\n");

    await sendMail({ subject, html, text });
    // 发信成功后才落状态 — 发信失败则保持旧状态,下个 tick 重试
  }
  saveState(state);
  console.log(JSON.stringify({ mode: "heartbeat-watch", at: new Date().toISOString(), ...summary, mailed: events.length }));
}

// ── daily 模式:运行日报 ──

/** Polygon 出块实测 1.5000 s/块(5 个独立样本,跨 2026-06→08;早先的 ~2s 是
 * 链提速前的旧值)。与 lib/polymarket/onchainEvents.ts 的 lookback 常量同源 ——
 * 那批按 1.5 s 重算后 MAX_LOOKBACK_BLOCKS 才真的是 3 天。此处 2026-08-02 审计前
 * 仍写死 2.1,日报"永久漏块 ≈ N 分钟链上时间"整整高估 40%,越是排查漏扫事故
 * 越会被这个数字带偏。 */
const POLYGON_BLOCK_SECONDS = 1.5;

interface ChainStats {
  okTicks: number;
  fatalTicks: number;
  partialTicks: number;
  events: number;
  eventsContext: number;
  notified: number;
  directional: number;
  gapBlocks: number;
  /** 业务活性(2026-08-02):告警面此前全是"进程/依赖还活着",
   * "跑着但一笔都不做"完全透明。这几个数进日报并设阈值。 */
  execChecked: number;
  llmCliCalls: number;
  llmSkipped: number;
  tradeAttempts: number;
  tradeFilled: number;
  paperRegistered: number;
  llmEvicted: number;
}

interface ScanStats {
  starts: number;
  fullOk: number;
  gammaUnreachable: number;
  mailsSent: number;
  lastOpportunities: number | null;
  lastNotified: number | null;
}

/**
 * Read new log bytes since the last offset. Rotation-aware: if the file's inode
 * changed since we recorded the offset (weekly `tail -c ... > tmp && mv`), the
 * old byte offset points into unrelated content, so we reread from 0. The plain
 * `offset > size` guard alone silently mis-aligns when the rotated file is
 * smaller than the old offset in a way that isn't a clean truncation.
 */
function readNewLog(
  file: string,
  offset: number,
  prevIno: number | undefined
): { content: string; nextOffset: number; ino: number | null } {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const ino = stat.ino;
    const rotated = prevIno != null && ino !== prevIno;
    const from = rotated || offset > size ? 0 : offset;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, size - from, from);
    fs.closeSync(fd);
    return { content: buf.toString("utf8"), nextOffset: size, ino };
  } catch {
    return { content: "", nextOffset: 0, ino: null };
  }
}

function chainStats(content: string): ChainStats {
  const s: ChainStats = {
    okTicks: 0, fatalTicks: 0, partialTicks: 0, events: 0, eventsContext: 0, notified: 0,
    directional: 0, gapBlocks: 0, execChecked: 0, llmCliCalls: 0, llmSkipped: 0,
    tradeAttempts: 0, tradeFilled: 0, paperRegistered: 0, llmEvicted: 0,
  };
  for (const line of content.split("\n")) {
    if (line.includes("] fatal:")) {
      s.fatalTicks += 1;
      continue;
    }
    if (!line.startsWith("{")) continue;
    try {
      const j = JSON.parse(line);
      if (j.mode === "chain-watch-llm-evicted") {
        s.llmEvicted += Number(j.evicted) || 0;
        continue;
      }
      if (j.mode !== "chain-watch") continue;
      s.okTicks += 1;
      s.events += Number(j.events) || 0;
      s.eventsContext += Number(j.events_context) || 0;
      s.notified += Number(j.notified) || 0;
      // 2026-08-02 修正:tick 行发的字段是 llm_backed,这里原来读的是不存在的
      // j.directional —— 日报的"方向性"一栏因此长期恒为 0,没人发现。
      s.directional += Number(j.llm_backed) || 0;
      s.gapBlocks += Number(j.gap) || 0;
      s.execChecked += Number(j.exec_checked) || 0;
      s.llmCliCalls += Number(j.llm_cli_calls) || 0;
      s.llmSkipped += Number(j.llm_skipped) || 0;
      s.tradeAttempts += Number(j.trade_attempts) || 0;
      s.tradeFilled += Number(j.trade_filled) || 0;
      s.paperRegistered += Number(j.paper_registered) || 0;
      if (j.sweep_error) s.partialTicks += 1;
    } catch {
      // 非 JSON 行(堆栈等)忽略
    }
  }
  return s;
}

function scanStats(content: string): ScanStats {
  const s: ScanStats = { starts: 0, fullOk: 0, gammaUnreachable: 0, mailsSent: 0, lastOpportunities: null, lastNotified: null };
  for (const line of content.split("\n")) {
    if (line.includes("启动,探测 Gamma")) s.starts += 1;
    if (line.includes("Gamma API 不可达")) s.gammaUnreachable += 1;
    if (line.includes("邮件已发送")) s.mailsSent += 1;
    if (line.startsWith("{") && line.includes("scanId")) {
      try {
        const j = JSON.parse(line);
        s.fullOk += 1;
        s.lastOpportunities = Number(j.opportunities) ?? null;
        s.lastNotified = Number(j.notified) ?? null;
      } catch {
        // ignore
      }
    }
  }
  return s;
}

async function daily(): Promise<void> {
  const state = loadState();
  const now = new Date();
  const periodFrom = state.lastDigestAt ? fmtTime(new Date(state.lastDigestAt)) : "日志起点";

  const chainLog = readNewLog(
    CHANNELS[0].log,
    state.offsets["chain-watch"] ?? 0,
    state.logInodes["chain-watch"]
  );
  const scanLog = readNewLog(
    CHANNELS[1].log,
    state.offsets["scan-notify"] ?? 0,
    state.logInodes["scan-notify"]
  );
  const cs = chainStats(chainLog.content);
  const ss = scanStats(scanLog.content);

  const chainLast = lastOkAt(CHANNELS[0]);
  const scanLast = lastOkAt(CHANNELS[1]);
  const hcConfigured = Boolean(
    process.env.HC_PING_CHAIN_WATCH?.trim() &&
      process.env.HC_PING_SCAN_NOTIFY?.trim() &&
      process.env.HC_PING_HEARTBEAT?.trim()
  );

  // §3.1:日报必须带探针状态。2026-07-11 实测教训:claude token 失效,凌晨
  // 告警已发,而 9:05 日报只看通道 tick 照样"一切正常"——两封邮件自相矛盾,
  // 日报的"全绿"必须覆盖探针,否则它就是假保证。
  // 2026-08-02 审计:这里原本手抄一份 PROBE_LABELS,漏掉了本批新增的三个探针
  // (rpc-quorum / pusd-balance / proxy-egress),同一个坑复发;改为直接遍历
  // PROBE_REGISTRY —— 探针清单只有一处真相,新增探针自动进日报表格与主题行。
  // 2026-08-02 复查:上面那版遍历方向是对的,但状态仍只由 state.alert 推断 ——
  // 三个 fail-open 新探针"探不到"时根本不写 alert,于是 RPC 未配置 / 全部 RPC 挂 /
  // 代理死掉这三种最危险的情况一律显示绿色 ok,等于换个地方复刻同一个假保证。
  // 现在改三态,判据是 state.probeRuns(最近一次**实际执行**):
  //   down    latched 告警仍在,或最近一次执行判定 down;
  //   unknown 没有执行记录 / 记录损坏 / 记录过旧 / 记录明写 unknown;
  //   ok      有新鲜记录且判定为 ok(其中 probeFails>0 仍按 failing 显示,文案不变)。
  // 优先级 down > unknown > failing > ok:latched 的红色告警绝不能被黄色盖掉
  // (探针从 down 直接失联时,红比黄更接近真相),而 unknown 绝不能落回绿色。
  // N2(2026-08-02 三轮复查):unknown 也去抖 —— 但**只对主题行**去抖。表格 / text /
  // JSON 三处口径一律照实,单次 unknown 立刻可见(信息一个字都不能丢,少的只是打扰)。
  const probes = PROBE_REGISTRY.map(([key, label]) => {
    const alertDown = state.alert[key]?.status === "down";
    const fails = state.probeFails[key] ?? 0;
    const since = state.alert[key]?.since;
    const run = state.probeRuns[key];
    const runAt = typeof run?.at === "string" ? Date.parse(run.at) : NaN;
    const staleMin = probeStaleMinutes(key);
    const fresh = Number.isFinite(runAt) && Date.now() - runAt <= staleMin * 60_000;
    const level: "ok" | "down" | "unknown" =
      alertDown || (fresh && run?.status === "down") ? "down" : fresh && run?.status === "ok" ? "ok" : "unknown";
    const why = fresh
      ? run?.detail || "探针本次未取到结果"
      : Number.isFinite(runAt)
        ? `最近一次实际执行在 ${fmtTime(new Date(runAt))}(超过 ${staleMin} 分钟未再执行)`
        : "无任何执行记录";
    // "探到了但这一针没取到值"(新鲜且明写 unknown)才是会被网络抖动刷屏的那一类,
    // 只有它走 PROBE_UNKNOWN_SUBJECT_RUNS 的连续次数门槛。记录过旧 / 无记录 / 记录
    // 损坏(fresh 但 status 不是三态之一)一律立刻上主题行:那是 --watch 自己停摆或
    // 状态文件坏了,时间维度早已去过抖,再压一层就成了掩盖。
    const freshUnknown = fresh && run?.status === "unknown";
    const unknownRuns = state.probeUnknowns[key] ?? 0;
    const inSubject = level === "unknown" && (!freshUnknown || unknownRuns >= PROBE_UNKNOWN_SUBJECT_RUNS);
    return {
      label,
      level,
      inSubject,
      disp:
        level === "down"
          ? `down${since ? `(自 ${fmtTime(new Date(since))})` : ""}`
          : level === "unknown"
            ? // 连续次数直接摊在表格里:操作员据此一眼分清"偶发瞬断"与"持续未探到"。
              `unknown — 未探到,非确认正常(${why})${freshUnknown ? `,连续 ${unknownRuns} 次` : ""}`
            : fails > 0
              ? `failing(${fails}/${PROBE_FAIL_THRESHOLD})`
              : "ok",
      color: level === "down" ? "#f87171" : level === "unknown" || fails > 0 ? "#fbbf24" : "#34d399",
    };
  });
  const probesDown = probes.filter((p) => p.level === "down");
  const probesUnknown = probes.filter((p) => p.level === "unknown");
  // 主题行专用口径(已去抖),与上面那个如实口径分开命名,防止后来者顺手混用。
  const probesUnknownSustained = probes.filter((p) => p.inSubject);

  // 业务活性静默失效(2026-08-02):"有官方文本却一次判读都没发生"是最危险的
  // 形态 —— 进程全绿、邮件全绿,而 🟢 双确认档实质停摆。必须上主题级。
  const llmDead = cs.eventsContext > 0 && cs.llmCliCalls === 0;
  // 未探到单列一个计数上主题行:混进 down×N 会让"确认坏了"与"不知道"两种性质
  // 不同的事实糊在一起,但它绝不能只留在正文里 —— 主题行是唯一保证被读到的一行。
  // 正因为它是唯一保证被读到的一行,这里用的是**去抖后**的 probesUnknownSustained
  // (N2,2026-08-02 三轮复查):单次瞬断天天挂 "⚠探针未探到×1" 会让主题行的告警位
  // 彻底脱敏,真出事那天反而没人看。表格里那份如实计数不受影响。
  const subject = `[PredEdge 日报] ${llmDead ? "⛔判读停摆 · " : ""}${probesDown.length > 0 ? `⛔探针down×${probesDown.length} · ` : ""}${probesUnknownSustained.length > 0 ? `⚠探针未探到×${probesUnknownSustained.length} · ` : ""}哨兵 ${cs.okTicks}✓/${cs.fatalTicks}✗ · 巡逻 ${ss.fullOk}✓/${ss.gammaUnreachable}✗ — ${fmtTime(now).slice(5, 16)}`;

  const row = (k: string, v: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#9aa3ad;white-space:nowrap">${k}</td><td style="padding:4px 0">${v}</td></tr>`;

  const gapMinutes = Math.round((cs.gapBlocks * POLYGON_BLOCK_SECONDS) / 60);
  const html = `<div style="background:#14171c;color:#e6e8eb;padding:18px 20px;border-radius:10px;font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;max-width:760px">
  <h2 style="margin:0 0 4px;font-size:16px">PredEdge 运行日报</h2>
  <p style="margin:0 0 12px;font-size:12px;color:#9aa3ad">统计区间:${escapeHtml(periodFrom)} → ${escapeHtml(fmtTime(now))}</p>

  <h3 style="margin:10px 0 4px;font-size:14px;color:#7dd3fc">通道一 chain-watch(哨兵,3 分钟)</h3>
  <table style="font-size:13px;border-collapse:collapse">
    ${row("成功 / 失败 tick", `${cs.okTicks} / <span style="color:${cs.fatalTicks > 0 ? "#fbbf24" : "#34d399"}">${cs.fatalTicks}</span>${cs.partialTicks > 0 ? `(另有 ${cs.partialTicks} 次部分成功)` : ""}`)}
    ${row("链上事件 / 官方澄清 / 已通知 / 双确认", `${cs.events} / ${cs.eventsContext} / ${cs.notified} / ${cs.directional}`)}
    ${row(
      "业务活性(注解/判读/跳过)",
      `${cs.execChecked} / ${cs.llmCliCalls} / ${cs.llmSkipped}` +
        (cs.eventsContext > 0 && cs.llmCliCalls === 0
          ? ' <span style="color:#f87171">⛔ 有官方文本却零判读 —— 判读链路可能已死</span>'
          : "")
    )}
    ${row(
      "执行(尝试/成交/paper 登记)",
      `${cs.tradeAttempts} / ${cs.tradeFilled} / ${cs.paperRegistered}`
    )}
    ${row(
      "永久漏块",
      `${cs.gapBlocks} 块 ≈ ${gapMinutes} 分钟链上时间` +
        (cs.fatalTicks >= 3 ? ` · <span style="color:#fbbf24">⚠ fatal tick ${cs.fatalTicks} 次(检查 RPC)</span>` : "")
    )}
    ${cs.llmEvicted > 0 ? row("判读队列淘汰", `<span style="color:#fbbf24">${cs.llmEvicted} 条(队列超限,不再补判)</span>`) : ""}
    ${row("最后成功", chainLast ? `${fmtTime(chainLast)}(${ageMinutes(chainLast)} 分钟前)` : '<span style="color:#f87171">无记录</span>')}
  </table>

  <h3 style="margin:14px 0 4px;font-size:14px;color:#7dd3fc">通道二 scan-notify(巡逻,30 分钟)</h3>
  <table style="font-size:13px;border-collapse:collapse">
    ${row("启动 / 完整成功 / Gamma 不可达", `${ss.starts} / ${ss.fullOk} / <span style="color:${ss.gammaUnreachable > 0 ? "#fbbf24" : "#34d399"}">${ss.gammaUnreachable}</span>`)}
    ${row("机会邮件发送次数", String(ss.mailsSent))}
    ${row("最近一次扫描", ss.lastOpportunities != null ? `${ss.lastOpportunities} 个机会,本次新通知 ${ss.lastNotified}` : "本区间无成功扫描")}
    ${row("最后成功", scanLast ? `${fmtTime(scanLast)}(${ageMinutes(scanLast)} 分钟前)` : '<span style="color:#f87171">无记录(或尚未生成标记)</span>')}
  </table>

  <h3 style="margin:14px 0 4px;font-size:14px;color:#7dd3fc">静默单点探针(--watch 每 10 分钟)</h3>
  <table style="font-size:13px;border-collapse:collapse">
    ${probes
      .map((p) => row(escapeHtml(p.label), `<span style="color:${p.color}">${escapeHtml(p.disp)}</span>`))
      .join("\n")}
  </table>
  <p style="margin:4px 0 0;font-size:11px;color:#6b7280">绿=探过且正常;红=确认故障;黄 unknown=<b>这一针没探到,不是"正常"</b>(未配置、依赖全挂、或 --watch 本身已停)——按故障处理去查。本表如实显示每一次 unknown;主题行只列<b>连续 ${PROBE_UNKNOWN_SUBJECT_RUNS} 次以上</b>未探到的(或已无执行记录/记录过旧的),单次瞬断不上标题,所以标题没提不等于本表全绿。</p>

  <p style="margin:14px 0 0;font-size:12px;color:${hcConfigured ? "#34d399" : "#fbbf24"}">
    ${hcConfigured ? "✅ healthchecks.io 三个心跳均已配置(整机/SMTP 死亡也会被外部告警)。" : "⚠️ healthchecks.io 心跳未配齐 — 需要三个 check:HC_PING_CHAIN_WATCH / HC_PING_SCAN_NOTIFY / HC_PING_HEARTBEAT(heartbeat 这个尤其关键:SMTP 挂掉时只有它能从外部报警),填入 ~/prededge/.env。"}
  </p>
  <p style="margin:8px 0 0;font-size:11px;color:#6b7280">约定:每天 09:05 必有本邮件;没收到 = 系统死了。scripts/heartbeat.ts --daily 自动发送。</p>
</div>`;

  const text = [
    `统计区间 ${periodFrom} → ${fmtTime(now)}`,
    `chain-watch: ok=${cs.okTicks} fatal=${cs.fatalTicks} partial=${cs.partialTicks} events=${cs.events} ctx=${cs.eventsContext} notified=${cs.notified} directional=${cs.directional} gap=${cs.gapBlocks} exec=${cs.execChecked} llm=${cs.llmCliCalls}/${cs.llmSkipped} trades=${cs.tradeAttempts}/${cs.tradeFilled} paper=${cs.paperRegistered} evicted=${cs.llmEvicted}`,
    `scan-notify: starts=${ss.starts} fullOk=${ss.fullOk} unreachable=${ss.gammaUnreachable} mails=${ss.mailsSent}`,
    // unknown 报如实计数,后面括号里补上进了主题行的那部分(去抖后),两个口径都留痕。
    `probes: down=${probesDown.length} unknown=${probesUnknown.length}(持续 ≥${PROBE_UNKNOWN_SUBJECT_RUNS} 次或已失联:${probesUnknownSustained.length})`,
    `probes: ${probes.map((p) => `${p.label}=${p.disp}`).join(" | ")}`,
    hcConfigured ? "HC ping: all 3 configured" : "HC ping: NOT fully configured",
  ].join("\n");

  await sendMail({ subject, html, text });
  // 发信成功后才推进 offset — 失败则本区间下次日报补上
  state.offsets["chain-watch"] = chainLog.nextOffset;
  state.offsets["scan-notify"] = scanLog.nextOffset;
  if (chainLog.ino != null) state.logInodes["chain-watch"] = chainLog.ino;
  if (scanLog.ino != null) state.logInodes["scan-notify"] = scanLog.ino;
  state.lastDigestAt = now.toISOString();
  saveState(state);
  console.log(
    JSON.stringify({
      mode: "heartbeat-daily",
      at: now.toISOString(),
      chain: cs,
      scan: ss,
      probes_down: probesDown.length,
      probes_unknown: probesUnknown.length,
      // 主题行口径另开一个字段,不覆盖上面的如实计数(日志留痕同样不允许丢信息)。
      probes_unknown_sustained: probesUnknownSustained.length,
    })
  );
}

// ── 入口 ──

const mode = process.argv.includes("--daily") ? "daily" : "watch";
(mode === "daily" ? daily() : watch()).catch((err) => {
  console.error(`[heartbeat] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
