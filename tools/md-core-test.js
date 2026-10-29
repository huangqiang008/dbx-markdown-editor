// md-core-test.js — md.js 纯函数部分单测（Node 运行，无 DOM）
// 运行：node tools/md-core-test.js
"use strict";
var axMd = require("../ui/md.js");

var failed = 0, passed = 0;
function eq(actual, expected, msg) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error("FAIL: " + msg + "\n  actual:   " + a + "\n  expected: " + e); }
}
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; console.error("FAIL: " + msg); }
}

/* ---------- 块解析 ---------- */
var sample = [
  "# 标题一",
  "",
  "普通段落，含 **加粗**、*斜体*、`代码`、~~删除~~ 与 [链接](https://example.com)。",
  "",
  "第二段带软换行",
  "延续行。",
  "",
  "## 列表",
  "",
  "- 项目 A",
  "- 项目 B",
  "  - 嵌套 B1",
  "  - 嵌套 B2",
  "- 项目 C",
  "",
  "1. 第一",
  "2. 第二",
  "",
  "- [x] 完成任务",
  "- [ ] 未完成任务",
  "",
  "> 引用第一行",
  "> 引用第二行",
  "",
  "```go",
  "func main() {",
  "\tfmt.Println(\"hi\")",
  "}",
  "```",
  "",
  "| 名称 | 值 |",
  "| --- | --- |",
  "| a | 1 |",
  "| b | 2 |",
  "",
  "---",
  "",
  "末尾段落。",
].join("\n");

var blocks = axMd.parse(sample);
eq(blocks.map(function (b) { return b.type; }),
  ["h1", "p", "p", "h2", "ul", "ol", "task", "quote", "code", "table", "hr", "p"],
  "块类型序列");
eq(blocks[0].src, "标题一", "h1 src");
eq(blocks[1].src, "普通段落，含 **加粗**、*斜体*、`代码`、~~删除~~ 与 [链接](https://example.com)。", "p src");
eq(blocks[2].src, "第二段带软换行\n延续行。", "多行 p src");
eq(blocks[4].src, "- 项目 A\n- 项目 B\n  - 嵌套 B1\n  - 嵌套 B2\n- 项目 C", "ul src 保缩进");
eq(blocks[5].src, "1. 第一\n2. 第二", "ol src");
eq(blocks[6].src, "- [x] 完成任务\n- [ ] 未完成任务", "task src");
eq(blocks[7].src, "引用第一行\n引用第二行", "quote src 不含 >");
eq(blocks[8].lang, "go", "code lang");
eq(blocks[8].src, "func main() {\n\tfmt.Println(\"hi\")\n}", "code src");
eq(blocks[9].src, "| 名称 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |", "table src 规范化");

/* ---------- 往返稳定性 ---------- */
var round1 = axMd.serialize(blocks);
var blocks2 = axMd.parse(round1);
eq(axMd.serialize(blocks2), round1, "serialize(parse(serialize)) 幂等");
eq(blocks2.map(function (b) { return b.type + "|" + b.src + "|" + (b.lang || ""); }),
   blocks.map(function (b) { return b.type + "|" + b.src + "|" + (b.lang || ""); }),
   "parse->serialize 往返块级一致");

/* ---------- 边界 ---------- */
eq(axMd.parse("").map(function (b) { return b.type; }), ["p"], "空文档 -> 单空段");
eq(axMd.parse("\n\n").map(function (b) { return b.type; }), ["p"], "全空文档 -> 单空段");
eq(axMd.parse("#hashtag 不是标题").map(function (b) { return b.type; }), ["p"], "# 后无空格不是标题");
eq(axMd.parse("**加粗** 行首").map(function (b) { return b.type; }), ["p"], "** 行首不是列表");
eq(axMd.parse("- a\n\n- b").map(function (b) { return b.type; }), ["ul", "ul"], "空行分隔两个列表块");
eq(axMd.parse("1) 括号序号").map(function (b) { return b.type + b.src; }), ["ol1) 括号序号"], "1) 有序列表");
eq(axMd.parse("```\n未闭合代码").map(function (b) { return b.type + "|" + b.src; }), ["code|未闭合代码"], "未闭合代码块吃到 EOF");
eq(axMd.parse("para\n```\ncode\n```").map(function (b) { return b.type; }), ["p", "code"], "段落+代码块");

/* ---------- 行内 tokenize ---------- */
var toks = axMd.tokenizeInline("a **b** c");
eq(toks.map(function (t) { return t.t; }), ["text", "strong", "text"], "token 类型");
eq([toks[0].a, toks[0].b], [0, 2], "text 区间");
eq([toks[1].a, toks[1].b], [2, 7], "strong 区间含 **");
eq(toks[1].kids.map(function (t) { return t.t + ":" + t.v; }), ["text:b"], "strong 子 token");
ok(axMd.tokenizeInline("`a<b>`")[0].t === "code", "行内代码");
ok(axMd.tokenizeInline("[t](u)")[0].t === "link", "链接");
ok(axMd.tokenizeInline("![a](u)")[0].t === "img", "图片");
ok(axMd.tokenizeInline("x\ny")[1].t === "space", "软换行 -> space");
ok(axMd.tokenizeInline("x  \ny")[1].t === "br", "两空格硬换行 -> br");
eq(axMd.tokenizeInline("a * b").map(function (t) { return t.t; }), ["text"], "单独 * 是文本");
ok(axMd.tokenizeInline("javascript:x")[0].t === "text", "无链接语法");
eq(axMd.inlinePlain("**粗** *斜* `码` [链接](u)"), "粗 斜 码 链接", "inlinePlain");

/* ---------- 列表工具 ---------- */
var items = axMd.parseList("- a\n  - b\n1. c");
eq(items.map(function (i) { return i.indent + ":" + i.type + ":" + i.inline; }),
   ["0:ul:a", "2:ul:b", "0:ol:c"], "parseList 缩进/类型");
eq(axMd.listSrc(items), "- a\n  - b\n1. c", "listSrc 往返");
var tree = axMd.listTree(items);
ok(tree.length === 2 && tree[0].children.length === 1, "listTree 嵌套");

/* ---------- 表格工具 ---------- */
var tb = axMd.parseTableCols("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |");
eq([tb.cols, tb.rows.length], [2, 3], "表格解析");
eq(tb.rows[2], ["3", ""], "缺列补齐");
eq(axMd.serializeTableCols(tb), "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 |  |", "表格序列化");
eq(axMd.tableSrcOffset("| a | b |\n| --- | --- |\n| 1 | 2 |", 0, 0, 0), 2, "表格表头单元格偏移不落到分隔行");
eq(axMd.tableSrcOffset("| a | b |\n| --- | --- |\n| 1 | 2 |", 1, 0, 0), 26, "表格数据单元格跳过分隔行");

/* ---------- 大纲 / 统计 ---------- */
var ol = axMd.outline(blocks);
eq(ol.map(function (o) { return o.level + ":" + o.text; }), ["1:标题一", "2:列表"], "outline");
ok(axMd.plainText(blocks).indexOf("标题一") === 0, "plainText 开头");
ok(axMd.plainText(blocks).indexOf("func main() {") >= 0, "plainText 含代码");

/* ---------- 导出 HTML ---------- */
var html = axMd.toStandaloneHtml(blocks, "测试", "zh-CN");
ok(html.indexOf("<!DOCTYPE html>") === 0, "导出 DOCTYPE");
ok(html.indexOf("<h1>标题一</h1>") >= 0, "导出标题");
ok(html.indexOf("<strong>加粗</strong>") >= 0, "导出加粗");
ok(html.indexOf("<blockquote>") >= 0, "导出引用");
ok(html.indexOf("<table>") >= 0, "导出表格");
ok(html.indexOf("<pre><code>") >= 0, "导出代码块");
ok(html.indexOf("☑") >= 0, "导出任务勾选框");
ok(html.indexOf("<hr>") >= 0, "导出分割线");

/* ---------- 公式块 ---------- */
var mathDoc = [
  "行内 $E=mc^2$ 公式。",
  "",
  "$$",
  "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
  "$$",
  "",
  "单行 $$a+b=1$$ 公式。",
  "",
  "价格 $5 and $10 dollars。",
].join("\n");
var mathBlocks = axMd.parse(mathDoc);
eq(mathBlocks.map(function (b) { return b.type; }), ["p", "math", "p", "p"], "公式块解析");
eq(mathBlocks[1].src, "\\int_0^1 x^2 \\, dx = \\frac{1}{3}", "公式块 src");
eq(axMd.serializeBlock(mathBlocks[1]), "$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$", "公式块序列化");
eq(mathBlocks[2].src, "单行 $$a+b=1$$ 公式。", "单行公式留在段落（行内规则不误判块级）");
// 货币用法不产生公式 token
var moneyToks = axMd.tokenizeInline("价格 $5 and $10 dollars。");
ok(moneyToks.every(function (tk) { return tk.t !== "math"; }), "货币 $5 and $10 不误判为公式");
var inlineMathToks = axMd.tokenizeInline("行内 $E=mc^2$ 公式。");
ok(inlineMathToks.some(function (tk) { return tk.t === "math" && tk.v === "E=mc^2"; }), "行内公式 token");
eq(axMd.inlinePlain("行内 $E=mc^2$ 公式。"), "行内 E=mc^2 公式。", "inlinePlain 行内公式");
// 公式块 -> 解析 -> 序列化 往返稳定
eq(axMd.serialize(axMd.parse(axMd.serialize(mathBlocks))), axMd.serialize(mathBlocks), "公式块往返稳定");

/* ---------- Front Matter 边界 ---------- */
eq(axMd.parse("---").map(function (b) { return b.type; }), ["hr"], "未闭合 Front Matter 不吞掉分割线");
eq(axMd.parse("---\n# 正文").map(function (b) { return b.type; }), ["hr", "h1"], "未闭合 Front Matter 保留后续正文");

/* ---------- 图表块（mermaid） ---------- */
var chartDoc = "```mermaid\nflowchart TD\n    A --> B\n```";
var chartBlocks = axMd.parse(chartDoc);
eq(chartBlocks.map(function (b) { return b.type; }), ["chart"], "mermaid 围栏解析为图表块");
eq(chartBlocks[0].src, "flowchart TD\n    A --> B", "图表块 src");
eq(chartBlocks[0].lang, "mermaid", "图表块 lang");
eq(axMd.serializeBlock(chartBlocks[0]), "```mermaid\nflowchart TD\n    A --> B\n```", "图表块序列化");
eq(axMd.parse("```go\nx\n```")[0].type, "code", "普通围栏仍是代码块");

/* ---------- Front Matter ---------- */
var fmDoc = "---\ntitle: 测试\ndate: 2026-10-19\n---\n\n正文。";
var fmBlocks = axMd.parse(fmDoc);
eq(fmBlocks.map(function (b) { return b.type; }), ["frontmatter", "p"], "Front Matter 解析");
eq(fmBlocks[0].src, "title: 测试\ndate: 2026-10-19", "Front Matter src");
eq(axMd.serializeBlock(fmBlocks[0]), "---\ntitle: 测试\ndate: 2026-10-19\n---", "Front Matter 序列化");
eq(axMd.parse("正文\n\n---\ntitle: x\n---")[1].type, "hr", "文档中部 --- 是分割线不是 Front Matter");

/* ---------- 脚注 ---------- */
var fnDoc = [
  "正文带脚注[^1]与命名脚注[^note]。",
  "",
  "[^1]: 第一条定义。",
  "[^note]: 第二条定义。",
].join("\n");
var fnBlocks = axMd.parse(fnDoc);
eq(fnBlocks.map(function (b) { return b.type; }), ["p", "footnotes"], "脚注定义聚合");
eq(axMd.parseFootnotes(fnBlocks[1].src).map(function (d) { return d.label + ":" + d.text; }),
  ["1:第一条定义。", "note:第二条定义。"], "parseFootnotes");
eq(fnBlocks[1].src, "[^1]: 第一条定义。\n[^note]: 第二条定义。", "脚注区 src 原样");
var fnToks = axMd.tokenizeInline("正文带脚注[^1]与命名脚注[^note]。");
ok(fnToks.filter(function (tk) { return tk.t === "fn"; }).length === 2, "脚注引用 token ×2");
eq(axMd.inlinePlain("脚注[^1]"), "脚注[1]", "inlinePlain 脚注引用");
// 脚注区 src 偏移往返（无 DOM，仅纯函数部分）
eq(axMd.fnPosFromSrc(fnBlocks[1].src, 0), { liIndex: 0, itemLocal: 0 }, "fnPosFromSrc 首条行首");
eq(axMd.fnPosFromSrc(fnBlocks[1].src, "[^1]: 第一条定".length), { liIndex: 0, itemLocal: 4 }, "fnPosFromSrc 首条中部");
eq(axMd.fnPosFromSrc(fnBlocks[1].src, "[^1]: 第一条定义。\n[^note]: 第二条".length),
  { liIndex: 1, itemLocal: 3 }, "fnPosFromSrc 第二条中部");
eq(axMd.serialize(axMd.parse(axMd.serialize(fnBlocks))), axMd.serialize(fnBlocks), "脚注往返稳定");

/* ---------- 新块类型 HTML 导出 ---------- */
var newHtml = axMd.toStandaloneHtml([mathBlocks[1], chartBlocks[0], fnBlocks[1]], "t", "zh-CN");
ok(newHtml.indexOf("math-block") >= 0, "导出公式块容器");
ok(newHtml.indexOf('<div class="mermaid">') >= 0, "导出图表块（mermaid 容器）");
ok(newHtml.indexOf("fn-1") >= 0, "导出脚注锚点");
ok(newHtml.indexOf("mermaid.min.js") >= 0, "导出含图表时引入 mermaid 脚本");
ok(axMd.toStandaloneHtml([fmBlocks[0]], "t", "zh-CN").indexOf("frontmatter") < 0, "导出不含 Front Matter");
ok(axMd.toStandaloneHtml([{ type: "chart", lang: "mermaid", src: "graph TD" }], "t", "zh-CN").indexOf("mermaid.min.js") >= 0, "图表导出条件成立");

/* ---------- 下划线 / 高亮 / 清除样式 ---------- */
var uToks = axMd.tokenizeInline("普通 <u>下划线</u> 文本");
ok(uToks.some(function (tk) { return tk.t === "u" && tk.kids.length === 1; }), "下划线 token");
eq(axMd.inlinePlain("普通 <u>下划线</u> 文本"), "普通 下划线 文本", "inlinePlain 下划线");
var hlToks = axMd.tokenizeInline("普通 ==高亮== 文本");
ok(hlToks.some(function (tk) { return tk.t === "highlight"; }), "高亮 token");
eq(axMd.inlinePlain("普通 ==高亮== 文本"), "普通 高亮 文本", "inlinePlain 高亮");
// 高亮不误判单个等号与 == 比较写法
ok(axMd.tokenizeInline("a = b 且 a==b").every(function (tk) { return tk.t !== "highlight"; }), "比较运算符不误判为高亮");
ok(axMd.tokenizeInline("a = b 且 a==b").some(function (tk) { return tk.t === "text"; }), "等号文本保留");
// 下划线/高亮往返稳定
var uhlDoc = "**粗** 与 <u>下划</u> 与 ==高亮== 与 `码`。";
var uhlBlocks = axMd.parse(uhlDoc);
eq(uhlBlocks[0].type, "p", "行内格式混排解析为段落");
eq(uhlBlocks[0].src, uhlDoc, "行内格式混排 src 原样");
eq(axMd.serialize(axMd.parse(axMd.serialize(uhlBlocks))), axMd.serialize(uhlBlocks), "行内格式往返稳定");
// 清除样式
eq(axMd.stripInline("**粗** *斜* ~~删~~ ==亮== <u>下</u> `码` [链接](https://a.b) $x$ 图![a](p.png)"),
  "粗 斜 删 亮 下 码 链接 $x$ 图![a](p.png)", "stripInline 全格式（链接清为纯文本，图片/公式保留语法）");
eq(axMd.stripInline("**粗*斜*嵌套**"), "粗斜嵌套", "stripInline 嵌套");
eq(axMd.stripInline("无格式文本"), "无格式文本", "stripInline 无格式原样");
eq(axMd.stripInline("<u>仅下划</u>"), "仅下划", "stripInline 下划线");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
