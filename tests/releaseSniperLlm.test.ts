/**
 * release-sniper 的 LLM 降级读数路径(2026-08-05)。
 *
 * 这条路径的输出直接进实弹下单,所以防线全部要有断言接缝 —— 判据埋在
 * main() 的 while 循环里就等于没有(08-03 修复批的教训)。测的是
 * parseNumberReading:模型说什么 → 我们信什么 → 送进 bracketFor 的是什么。
 *
 * 不测 CLI 调用本身(那要真跑 claude),只测"模型已经回话之后"的全部校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseNumberReading } from "../lib/polymarket/llmStance";
import { bracketFor, parseNamedStorms, parseNamedStormsTiered } from "../scripts/release-sniper";

/** 一段接近真实排版的页面文本(已 strip 标签、折叠空白)。 */
const PAGE =
  "CSU Forecast for 2026 Hurricane Activity Issued: 5 August 2026 " +
  "Forecast Parameter and 1991-2020 Climatology (in parentheses) Issued 5 August 2026 " +
  "Named Storms 8 14.4 Hurricanes 4 7.2 Major Hurricanes 1 3.2 " +
  "Accumulated Cyclone Energy 65 123";

const ok = (o: Record<string, unknown>) => JSON.stringify(o);

test("point:正常读数 —— 引文命中且含该数字", () => {
  const r = parseNumberReading(
    ok({ found: true, kind: "point", value: 8, quote: "Named Storms 8 14.4", reasoning: "表内取值" }),
    PAGE,
    0,
    30
  );
  assert.equal(r?.value, 8);
  assert.equal(r?.kind, "point");
  assert.equal(r?.raw, "8");
});

test("幻觉防线 1:引文不在页面里 → 丢弃", () => {
  const r = parseNumberReading(
    ok({ found: true, kind: "point", value: 12, quote: "Named Storms 12 14.4", reasoning: "编的" }),
    PAGE,
    0,
    30
  );
  assert.equal(r, null);
});

test("幻觉防线 2:引文是真的、但报的数不在引文里 → 丢弃", () => {
  // 最典型的幻觉形态:引用真实存在的一段,结论却是编的。
  const r = parseNumberReading(
    ok({ found: true, kind: "point", value: 9, quote: "Named Storms 8 14.4", reasoning: "引真报假" }),
    PAGE,
    0,
    30
  );
  assert.equal(r, null);
});

test("幻觉防线 3:报的数是另一行的(Hurricanes 4)且引文只含那行 → 值仍须自洽", () => {
  // 引文命中、数字也在引文里 —— 这一层拦不住"读错行"。它由 prompt 的口径
  // 约束 + 双读一致 + [0,30] 闸共同兜底。这里锁住的是:校验层不会自作主张
  // 放行一个引文里根本没有的数,而不是它能识别语义读错行。
  const r = parseNumberReading(
    ok({ found: true, kind: "point", value: 4, quote: "Hurricanes 4 7.2", reasoning: "读错行" }),
    PAGE,
    0,
    30
  );
  assert.equal(r?.value, 4, "校验层放行(语义错行不归它管),靠双读+口径约束兜底");
});

test("合理性闸:越界即丢弃", () => {
  const page = `${PAGE} Extra 99`;
  assert.equal(parseNumberReading(ok({ found: true, kind: "point", value: 99, quote: "Extra 99", reasoning: "" }), page, 0, 30), null);
  assert.equal(parseNumberReading(ok({ found: true, kind: "point", value: -1, quote: "Extra 99", reasoning: "" }), page, 0, 30), null);
});

test("found:false / 非法 JSON / kind 缺失 一律 null", () => {
  assert.equal(parseNumberReading(ok({ found: false }), PAGE, 0, 30), null);
  assert.equal(parseNumberReading("模型开始闲聊,没有 JSON", PAGE, 0, 30), null);
  assert.equal(parseNumberReading("{找不到闭合", PAGE, 0, 30), null);
  assert.equal(
    parseNumberReading(ok({ found: true, value: 8, quote: "Named Storms 8 14.4" }), PAGE, 0, 30),
    null,
    "kind 缺失不猜"
  );
});

test("range:中点向下取整,且两个端点都要在引文里", () => {
  const page = "Forecast Parameter Named Storms 8-10 14.4 Hurricanes 4 7.2";
  const r = parseNumberReading(
    ok({ found: true, kind: "range", low: 8, high: 10, quote: "Named Storms 8-10 14.4", reasoning: "区间" }),
    page,
    0,
    30
  );
  assert.equal(r?.value, 9, "中点 9 向下取整仍是 9");
  assert.equal(r?.raw, "8-10");

  // 端点没全出现在引文里 → 丢弃
  assert.equal(
    parseNumberReading(
      ok({ found: true, kind: "range", low: 8, high: 12, quote: "Named Storms 8-10 14.4", reasoning: "" }),
      page,
      0,
      30
    ),
    null
  );
  // low > high 是模型犯浑,不猜
  assert.equal(
    parseNumberReading(
      ok({ found: true, kind: "range", low: 10, high: 8, quote: "Named Storms 8-10 14.4", reasoning: "" }),
      page,
      0,
      30
    ),
    null
  );
});

test("规则冲突锁:区间 8-9 必须走 floor(8.5)=8 → '=8',不能走 Math.round(8.5)=9 → '≥9'", () => {
  // 条款里两条规则在 x.5 上结论相反:"区间取中点向下取整" vs 小数 ".5 进位"。
  // 换算若留给 bracketFor 的 Math.round 做,这一档会系统性买错 —— 而且是
  // 买到相邻档,盘口上看起来毫无异样。这个测试就是钉死这个边界。
  const page = "Named Storms 8-9 14.4";
  const r = parseNumberReading(
    ok({ found: true, kind: "range", low: 8, high: 9, quote: "Named Storms 8-9 14.4", reasoning: "" }),
    page,
    0,
    30
  );
  assert.equal(r?.value, 8, "floor((8+9)/2) = 8");
  assert.equal(bracketFor(r!.value)?.short, "=8");
  assert.notEqual(bracketFor(Math.round(8.5))?.short, "=8", "反证:若交给 Math.round 会落到 ≥9");
});

test("主正则的 fail-closed 前提:排版一变就返回 null(不会读出个错数)", () => {
  // 这是降级路径存在的理由。若主正则在变形排版下会"读出个数"而不是 null,
  // 那降级永远不会被触发,而下单会用一个错数 —— 前提必须成立。
  assert.equal(parseNamedStorms("Named Storms 9 14.4"), 9, "标准排版能读");
  assert.equal(parseNamedStorms("Named Storms 8-10 14.4"), null, "区间排版 → null");
  assert.equal(parseNamedStorms("Named Storms 2 7 9 14.4"), null, "表里多一个数字 → null");
  assert.equal(parseNamedStorms("Named Storms 8 to 10 14.4"), null, "文字区间 → null");
  assert.equal(parseNamedStorms("Named Storms (observed 2) 9 14.4"), null, "插入括号注释 → null");
  assert.equal(parseNamedStorms("Named Storms 9 14.6"), null, "气候态锚不对 → null");
});

// ── 正则梯队(降级读法,排在 LLM 之前)────────────────────────────

test("梯队:四种排版各由对应层命中,值都正确", () => {
  const t = (s: string) => parseNamedStormsTiered(s);
  assert.deepEqual(t("Named Storms 9 14.4"), { value: 9, tier: "exact", raw: "9" });
  assert.deepEqual(t("Named Storms 8-10 14.4"), { value: 9, tier: "range", raw: "8-10" });
  assert.deepEqual(t("Named Storms 8 to 10 14.4"), { value: 9, tier: "range", raw: "8-10" });
  assert.deepEqual(t("Named Storms 2 7 9 14.4"), { value: 9, tier: "multicol", raw: "9" });
  assert.deepEqual(t("Named Storms (observed 2) 9 14.4"), { value: 9, tier: "loose", raw: "9" });
});

test("排序保护:loose 对区间会取到上界 10,所以 range 必须排在它前面", () => {
  // 这是梯队里唯一一处顺序**必须**正确的地方 —— 顺序写反就会把 8-10 读成
  // 10(落 ≥9)而不是中点 9(也落 ≥9,但 8-9 的情形会从 =8 变成 ≥9,直接买错档)。
  const r = parseNamedStormsTiered("Named Storms 8-9 14.4");
  assert.equal(r?.tier, "range", "必须由 range 层命中,不能落到 loose");
  assert.equal(r?.value, 8, "floor((8+9)/2)=8");
  assert.equal(bracketFor(r!.value)?.short, "=8");
  // 反证:若 range 层不存在,loose 会取上界 9 → 落到 ≥9,买错一档。
  assert.equal(/Named Storms.{0,40}?([\d.]+)\s+14\.4/.exec("Named Storms 8-9 14.4")?.[1], "9");
});

test("梯队每一层都仍锚定 14.4 —— 锚不对一律读不出", () => {
  // 放宽的只是"标签与数值之间允许出现什么",紧邻 14.4 取值这点从头到尾没动。
  // 丢了锚就退化成"页面上随便抓个数",那比 LLM 危险(LLM 至少还过引文校验)。
  assert.equal(parseNamedStormsTiered("Named Storms 2 7 9 15.1"), null);
  assert.equal(parseNamedStormsTiered("Named Storms (observed 2) 9 7.2"), null);
  assert.equal(parseNamedStormsTiered("Named Storms 8-10 7.2"), null);
  assert.equal(parseNamedStormsTiered("Hurricanes 4 14.4"), null, "标签不对也读不出");
});

test("梯队的合理性闸与 fail-closed", () => {
  assert.equal(parseNamedStormsTiered("Named Storms 99 14.4"), null, "越界 → null");
  assert.equal(
    parseNamedStormsTiered("Named Storms 10-8 14.4"),
    null,
    "区间形态已识别但端点颠倒 → null,不许落到更宽松的层去猜"
  );
  assert.equal(parseNamedStormsTiered("Named Storms 40-50 14.4"), null, "区间端点越界 → null");
  assert.equal(parseNamedStormsTiered("完全无关的页面内容"), null);
});

test("梯队不会误读兄弟行(Hurricanes/ACE 就在隔壁)", () => {
  // 真实页面里 Named Storms 下一行就是 Hurricanes 4 7.2,再下面是 ACE。
  // loose 层允许 40 个任意字符,必须确认它不会跨到隔壁行去取数。
  const page =
    "Forecast Parameter and 1991-2020 Climatology Named Storms 2 7 9 14.4 " +
    "Hurricanes 1 3 4 7.2 Major Hurricanes 0 1 1 3.2 ACE 12 53 65 123";
  const r = parseNamedStormsTiered(page);
  assert.equal(r?.value, 9, "取的是紧邻 14.4 的全季列,不是 Hurricanes 的 4");
  assert.equal(r?.tier, "multicol");
});
