/**
 * 限价带纯函数(2026-08-02 复查抽取)。
 *
 * 为什么单独成模块:实盘下单的限价由 limitPriceFor 决定,而 execCheck 的
 * fillAvail 走簿天花板必须与它**逐字同源**。第一轮修复选了"只共享 env 键、
 * 两边各写一份公式"绕开依赖问题,结果宣告档(按剩余边缩放的 upDriftBand)在
 * 低价位实盘限价远宽于 execCheck 天花板:
 *   ask 0.200 → 天花板 0.230 vs 实盘 0.320(窄 0.090)
 *   ask 0.500 → 0.530 vs 0.570(窄 0.040)
 *   ask 0.664 → 0.694 vs 0.710(窄 0.016)
 * 宣告子类正是 EXEC_FORECAST_LIVE 验证期与 8 月 go/no-go 的样本源,少记
 * shares/usd + 误打 limitCapped 的偏差方向是"paper 记的入场价优于实盘真实
 * 成交价"(自我美化)。公式一旦分叉就必然静默漂移,所以只留一份。
 *
 * 本模块零依赖:不 import 任何 polymarket 模块,无 fs/网络/钱包副作用。
 * 依赖图上只有 execCheck→priceBands、tradeExecutor→priceBands 两条单向边,
 * 不成环 —— execCheck 是注解层叶子(tiering/localDb/heartbeat/chain-watch 共用),
 * 让它反向 import 执行层的 tradeExecutor 既是依赖方向倒置也埋循环隐患。
 * tradeExecutor 仍 re-export 这两个符号,既有导入路径(含
 * tests/tradeExecutor.test.ts)不动。
 */

/** 限价帽的配置切面。刻意写成结构化接口而不是
 * Pick<ReturnType<typeof execConfig>, …>:后者会把本模块钉回 tradeExecutor,
 * 环立刻回来。三个键与 execConfig 同名同义(EXEC_SLIPPAGE /
 * EXEC_SLIPPAGE_EDGE_FRAC / EXEC_MAX_PRICE),结构上与原 Pick 类型完全一致。 */
export interface LimitBandConfig {
  slippage: number;
  slippageEdgeFrac: number;
  maxPrice: number;
}

/** 上行漂移容忍带(§2.3):绝对带在低价位是过窄的相对档 —— 肥尾回归途中
 * 0.164→0.20 仍 +400% EV 却被 0.03 绝对带拒单。带宽按剩余边(1−signalAsk)
 * 缩放,高价位退化回绝对带(只放宽低价位,绝不收紧既有行为)。 */
export const upDriftBand = (signalAsk: number, slippage: number, edgeFrac: number): number =>
  Math.max(slippage, edgeFrac * (1 - signalAsk));

/** 限价帽(2026-08-02 宣告扫单)。
 *
 * 普通 🟢:维持绝对滑点带(freshAsk + slippage)。bt3 均值 +21.3%/笔,这条边
 * 很薄,把帽子放宽是确定的 EV 侵蚀换不确定的成交量,n=1 证据不足以支撑。
 *
 * 宣告类(官方文本直接写明结算结果,历史兑现 98.8%):按边缩放放宽,与漂移带
 * 同一口径。这个子类里"少买"的成本远高于"多付两个价位" —— 对一张几乎确定
 * 赔付 $1 的票,0.664 买是 +50.6%、0.711 买是 +40.8%,两倍的量显然胜过略高的
 * 单位赢面。2026-07-28 实测:成交后 4.5 分钟内 ≤0.69 的 85 股被他人吃走。
 *
 * Math.round(x*100)/100 是既有的"取整到分档"惯用法,含一个已知浮点边界:
 * 0.5 + max(0.03, 0.15×0.5) = 0.575,而 0.575×100 在双精度下是 57.4999…,
 * Math.round 落到 57 → 0.57。方向是"少付一个 tick"(保守),刻意不改 ——
 * 改成向上取整会在所有现存路径上普涨限价(tests/tradeExecutor.test.ts 按
 * 0.57 锁死这条边界)。
 *
 * 2026-08-06:第三个钳位原为硬编码 0.99,与 EXEC_MAX_PRICE 各管一半 —— 闸门抬到
 * 0.995 后它会把限价压回 0.99,使 ask∈(0.99, 0.995] 的腿"过得了闸、成不了交"
 * (限价低于最优 ask,FAK 立即全撤)。策略上限归 cfg.maxPrice 单一控制,这里只留
 * 协议上限 0.999(CLOB 最高有效报价,≥1.0 会被拒单)。 */
const CLOB_MAX_TICK = 0.999;

export const limitPriceFor = (
  freshAsk: number,
  declarative: boolean,
  cfg: LimitBandConfig
): number => {
  const band = declarative ? upDriftBand(freshAsk, cfg.slippage, cfg.slippageEdgeFrac) : cfg.slippage;
  return Math.min(Math.round((freshAsk + band) * 100) / 100, cfg.maxPrice, CLOB_MAX_TICK);
};
