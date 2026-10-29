// e2e-mock.js — 模拟 DBX 宿主 + 真实 Go Sidecar 的浏览器 E2E
// 流程：静态服务器托管 ui/ -> Playwright(系统 Chrome) 加载 -> addInitScript 注入
// mock window.dbxPlugin -> invoke 经 exposeFunction 桥接到 Node -> Node 以
// stdio-jsonl 驱动真实的 bin/windows-x64/backend.exe。
// 运行：node tools/e2e-mock.js
"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const BACKEND = path.join(ROOT, "bin", "windows-x64", "backend.exe");
const TMP = path.join(ROOT, ".e2e-tmp");
const PORT = 5399;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

let failed = 0, passed = 0;
function ok(msg) { passed++; console.log("  ok: " + msg); }
function fail(msg) { failed++; console.error("  FAIL: " + msg); }
function check(cond, msg) { cond ? ok(msg) : fail(msg); }

/* ---------- 静态服务器 ---------- */
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(UI_DIR, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
      if (!p.startsWith(UI_DIR) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404); res.end("not found"); return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

/* ---------- Sidecar 桥 ---------- */
function startBackend() {
  const proc = spawn(BACKEND, [], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: rs } = pending.get(msg.id);
          pending.delete(msg.id);
          rs(msg);
        }
      } catch (e) { /* 忽略非协议输出 */ }
    }
  });
  proc.stderr.on("data", () => {});
  return {
    invoke(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve });
        const timer = setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error("timeout " + method)); }
        }, 20000);
        pending.get(id).timer = timer;
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n", () => {
          const p = pending.get(id);
          if (p) p.timer = timer;
        });
      });
    },
    close() { try { proc.kill(); } catch (e) { /* ignore */ } },
  };
}

/* ---------- 主流程 ---------- */
(async () => {
  // 准备临时目录与样例文件
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(TMP, "notes"), { recursive: true });
  fs.writeFileSync(path.join(TMP, "sample.md"),
    "# 样例文档\n\n这是**样例**内容。\n\n- 甲\n- 乙\n", "utf8");
  fs.writeFileSync(path.join(TMP, "notes", "nested.md"), "# 嵌套笔记\n\n深层文件。\n", "utf8");

  const server = await startServer();
  const backend = startBackend();

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => fail("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // 资源 404 的通用报错按 URL 单独断言（见 bad404）
    if (/Failed to load resource/.test(m.text())) return;
    // 降级测试中的诊断日志（预期内，见第 12 节）
    if (/\[picker\] native dialog failed/.test(m.text())) return;
    fail("console.error: " + m.text());
  });

  // 注入 mock 宿主桥
  await page.exposeFunction("__dbxInvoke", async (method, params) => {
    // 对话框类方法在 E2E 中模拟用户选择，避免阻塞
    if (method === "fs/pickSaveFile") {
      return { cancelled: false, path: path.join(TMP, params.name || "untitled.md") };
    }
    if (method === "fs/pickDir") return { cancelled: false, path: TMP };
    if (method === "fs/pickFile") return { cancelled: true };
    const resp = await backend.invoke(method, params);
    if (resp.error) throw new Error(resp.error.message);
    return resp.result;
  });
  await page.addInitScript(() => {
    var store = {};
    window.dbxPlugin = {
      ready: Promise.resolve(),
      context: { theme: { locale: "zh-CN" } },
      capabilities: { storage: true, workbench: true },
      storage: {
        get: (k) => Promise.resolve(store[k] !== undefined ? store[k] : null),
        set: (k, v) => { store[k] = v; return Promise.resolve(); },
      },
      invoke: (m, p) => window.__dbxInvoke(m, p || {}),
      clipboard: { writeText: (t) => { window.__lastCopy = t; return Promise.resolve(); } },
    };
  });

  const $ = (sel) => page.$(sel);
  const $$ = (sel) => page.$$(sel);
  const editorText = () => page.$eval("#editor", (n) => n.textContent);
  const sourceValue = () => page.$eval("#source", (n) => n.value);

  // 404 按 URL 断言（浏览器自动请求 favicon.ico 与插件无关）
  const bad404 = [];
  page.on("response", (r) => { if (r.status() === 404) bad404.push(r.url()); });

  console.log("\n== 1. 欢迎文档渲染 ==");
  await page.goto("http://127.0.0.1:" + PORT + "/index.html");
  await page.waitForSelector("#editor h1", { timeout: 8000 });
  check(bad404.filter((u) => !/favicon\.ico/.test(u)).length === 0, "无资源 404（favicon 除外）");
  check((await editorText()).indexOf("欢迎使用 Markdown 编辑器") >= 0, "欢迎文档渲染");
  check((await $$("#editor .b-list li")).length >= 7, "列表项渲染（ul + task）");
  check((await $$("#editor .b-table table")).length === 1, "表格渲染");
  check((await $$("#editor blockquote")).length === 1, "引用渲染");
  check((await $$("#editor .cbx")).length === 2, "任务勾选框渲染");
  check((await $$("#editor code")).length >= 1, "行内代码渲染");
  check(await page.$("#editor .b-math") !== null, "欢迎文档公式块渲染");
  check(await page.$("#editor .b-math .katex") !== null, "KaTeX 渲染公式");
  check(await page.$("#editor sup.md-fn-ref") !== null, "脚注引用渲染（上标）");
  check((await $$("#editor .b-footnotes .fn-item")).length >= 1, "脚注定义区渲染");

  console.log("\n== 2. 输入即渲染（行内语法） ==");
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("End");
  await page.keyboard.type(" **粗体** *斜体* ~~删~~ `码`");
  await page.waitForTimeout(150);
  const strongTexts = await page.$$eval("#editor strong", (ns) => ns.map((n) => n.textContent));
  check(strongTexts.indexOf("粗体") >= 0, "加粗实时渲染");
  check(await page.$("#editor em") !== null, "斜体实时渲染");
  check(await page.$("#editor s") !== null, "删除线实时渲染");

  console.log("\n== 3. 行首输入规则 ==");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# 标题测试 ");
  await page.waitForTimeout(150);
  const h1s = await page.$$("#editor h1");
  check((await h1s[h1s.length - 1].textContent()).trim() === "标题测试", "# 空格变标题");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 列表项甲 ");
  await page.waitForTimeout(150);
  check(await page.$("#editor .b-list li") !== null, "- 空格变列表");
  await page.keyboard.type("列表项乙");
  await page.keyboard.press("Enter");
  await page.keyboard.type("第二段");
  await page.waitForTimeout(150);
  const liTexts = await page.$$eval("#editor .b-list li", (ns) => ns.map((n) => n.textContent));
  check(liTexts.indexOf("列表项甲 列表项乙") >= 0 || liTexts.indexOf("列表项甲") >= 0, "列表回车产生新项");
  check(liTexts.some((x) => x === "第二段"), "第二个列表项");

  console.log("\n== 4. 任务勾选 + 源码模式 ==");
  // 欢迎文档第一个任务默认已勾选，点未勾选的那个
  await page.click("#editor .cbx:not(.on)");
  await page.waitForTimeout(100);
  check(await page.$("#editor .cbx.on") !== null, "点击勾选任务");
  await page.click("#btn-source");
  await page.waitForTimeout(100);
  const src1 = await sourceValue();
  check(src1.indexOf("- [x] 写下第一篇笔记") >= 0, "勾选同步到模型");
  check(src1.indexOf("# 标题测试") >= 0, "标题同步到模型");
  check(src1.indexOf("**粗体**") >= 0, "加粗语法同步到模型");
  await page.click("#btn-source");
  await page.waitForTimeout(100);

  console.log("\n== 5. 工具条加粗 + 撤销 ==");
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("Home");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.click('.tb-btn[data-cmd="bold"]');
  await page.waitForTimeout(150);
  const strongCount1 = (await $$("#editor strong")).length;
  check(strongCount1 >= 2, "工具条包裹加粗");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check((await $$("#editor strong")).length === strongCount1 - 1, "撤销还原");

  console.log("\n== 6. 打开文件夹 -> 文件树 -> 打开文件 -> 保存 ==");
  await page.click("#btn-open-dir");
  await page.waitForSelector("#files-tree .ft-row.file", { timeout: 8000 });
  const fileRows = await $$("#files-tree .ft-row.file");
  check(fileRows.length >= 2, "文件树列出 md（含子目录）");
  await page.click('#files-tree .ft-row.file:has-text("sample.md")');
  // 文档有未保存更改 -> 确认框 -> 不保存
  await page.waitForSelector("#overlay:not(.hidden)", { timeout: 5000 });
  await page.click("#dlg-foot .btn:nth-child(2)");
  await page.waitForTimeout(500);
  check((await editorText()).indexOf("样例文档") >= 0, "点击打开文件");
  check((await page.$eval("#status-file", (n) => n.textContent)).indexOf("sample.md") >= 0, "状态栏显示路径");
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("End");
  await page.keyboard.type(" 追加一行");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(600);
  const saved = fs.readFileSync(path.join(TMP, "sample.md"), "utf8");
  check(saved.indexOf("追加一行") >= 0, "Ctrl+S 真实写盘");
  check(saved.indexOf("# 样例文档") === 0, "写盘内容保持原结构");

  console.log("\n== 7. 外部变更检测 ==");
  fs.writeFileSync(path.join(TMP, "sample.md"), "# 外部修改版\n\n磁盘被改。\n", "utf8");
  await page.waitForTimeout(5600);
  check((await editorText()).indexOf("外部修改版") >= 0, "外部修改自动重载");

  console.log("\n== 8. 大纲导航 ==");
  await page.click('.side-tab[data-tab="outline"]');
  await page.waitForTimeout(150);
  const olRows = await $$("#outline-list .ol-row");
  check(olRows.length >= 1, "大纲列出标题");
  if (olRows.length) await olRows[0].click();

  console.log("\n== 9. IME 拼音输入光标保持 ==");
  // 忠实模拟真实 IME：compositionstart -> 浏览器在光标处插入裸文本节点 ->
  // compositionupdate -> compositionend -> input(insertCompositionText)
  const imeType = async (text) => {
    await page.evaluate(() => {
      document.getElementById("editor").dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    });
    await page.evaluate((t) => {
      var sel = window.getSelection();
      if (!sel.rangeCount) return;
      var r = sel.getRangeAt(0);
      r.deleteContents();
      var node = document.createTextNode(t);
      r.insertNode(node);
      var r2 = document.createRange();
      r2.setStart(node, t.length);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
    }, text);
    await page.evaluate((t) => {
      document.getElementById("editor").dispatchEvent(new CompositionEvent("compositionupdate", { data: t, bubbles: true }));
    }, text);
    await page.evaluate((t) => {
      const editor = document.getElementById("editor");
      editor.dispatchEvent(new CompositionEvent("compositionend", { data: t, bubbles: true }));
      // Native browsers dispatch the final input in the same event turn.
      editor.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", bubbles: true }));
    }, text);
  };
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hello ");
  await page.waitForTimeout(120);
  await imeType("世界");
  await page.waitForTimeout(120);
  await page.keyboard.type("XY");
  await page.waitForTimeout(150);
  const imeP1 = await page.$eval("#editor p:last-of-type", (n) => n.textContent);
  check(imeP1 === "hello 世界XY", "段落末尾拼音后光标停留正确（hello 世界XY）");
  // 行内格式中间的 IME：裸文本落在带 data-a 的 span 内
  await page.keyboard.press("Enter");
  await page.keyboard.type("**粗体**");
  await page.waitForTimeout(120);
  await imeType("拼音");
  await page.waitForTimeout(120);
  const imeP2 = await page.$eval("#editor p:last-of-type", (n) => n.textContent);
  check(imeP2 === "粗体拼音", "行内格式中间拼音后光标停留正确（粗体拼音）");
  // 列表中先输入已有文字，再用 IME 提交后续中文，验证列表不会按旧 src 截断光标。
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 我爱");
  await page.waitForTimeout(120);
  await imeType("中国");
  await page.waitForTimeout(120);
  await page.keyboard.type("XY");
  await page.waitForTimeout(150);
  const imeList = await page.$eval("#editor .b-list li:last-child", (n) => n.textContent.trim());
  check(imeList === "我爱中国XY", "无序列表拼音提交后光标停留正确（我爱中国XY）");
  await page.click("#btn-source");
  await page.waitForTimeout(100);
  const srcIme = await sourceValue();
  check(srcIme.indexOf("hello 世界XY") >= 0, "IME 内容同步到模型（hello 世界XY）");
  check(srcIme.indexOf("**粗体拼音**") >= 0, "IME 内容同步到模型（**粗体拼音**）");
  check(srcIme.indexOf("- 我爱中国XY") >= 0, "列表 IME 内容同步到模型（我爱中国XY）");
  await page.click("#btn-source");
  await page.waitForTimeout(100);

  console.log("\n== 10. 段落菜单：公式 / 图表 / 脚注 / Front Matter / 插段 ==");
  // 段落菜单 -> 图表 -> 流程图（子菜单 hover 展开）
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("End");
  await page.click("#btn-menu-paragraph");
  check(await page.$("#tb-menu-paragraph.open") !== null, "段落菜单可打开");
  await page.hover("#dropdown-paragraph .dd-sub:has([data-preset]) .dd-sub-trigger");
  await page.click("#dropdown-paragraph .dd-item[data-cmd='chart'][data-preset='flow']");
  await page.waitForSelector("#editor .b-chart svg", { timeout: 10000 });
  check(true, "图表块插入并渲染出 SVG");
  check(await page.$("#tb-menu-paragraph.open") === null, "菜单选择后自动关闭");
  // Ctrl+Shift+M 公式块
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("Control+Shift+m");
  await page.waitForSelector("#overlay:not(.hidden)", { timeout: 5000 });
  await page.fill(".dlg-src", "x^2 + y^2 = z^2");
  await page.click("#dlg-foot .btn-primary");
  await page.waitForSelector("#editor .b-math", { timeout: 5000 });
  check((await page.$eval("#editor .b-math:last-of-type .math-body", (n) => n.getAttribute("data-math"))) === "x^2 + y^2 = z^2",
    "公式块经对话框编辑");
  // 脚注：引用 + 定义（当前文档无既有脚注，编号从 1 起）
  var fnRefsBefore = (await $$("#editor sup.md-fn-ref")).length;
  await page.click("#editor p:last-of-type");
  await page.click("#btn-menu-paragraph");
  await page.click("#dropdown-paragraph .dd-item[data-cmd='footnote']");
  await page.waitForTimeout(200);
  check((await $$("#editor sup.md-fn-ref")).length === fnRefsBefore + 1, "脚注引用插入");
  check((await $$("#editor .b-footnotes .fn-item")).length === 1, "脚注定义追加");
  // Front Matter
  await page.click("#editor p:nth-of-type(1)");
  await page.click("#btn-menu-paragraph");
  await page.click("#dropdown-paragraph .dd-item[data-cmd='frontmatter']");
  await page.waitForTimeout(200);
  check(await page.$("#editor .b-frontmatter") !== null, "Front Matter 插入到文档头");
  // 上/下方插入段落
  var nBlocks0 = (await $$("#editor [data-type]")).length;
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("Control+Shift+Enter");
  await page.waitForTimeout(150);
  check((await $$("#editor [data-type]")).length === nBlocks0 + 1, "Ctrl+Shift+Enter 上方插段");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(150);
  check((await $$("#editor [data-type]")).length === nBlocks0 + 2, "Ctrl+Enter 下方插段");
  // 源码模式核对
  await page.click("#btn-source");
  await page.waitForTimeout(100);
  const srcNew = await sourceValue();
  check(srcNew.indexOf("```mermaid") >= 0, "源码含 mermaid 围栏");
  check(srcNew.indexOf("$$") >= 0, "源码含公式块");
  check(srcNew.indexOf("[^1]") >= 0, "源码含新脚注引用");
  check(srcNew.indexOf("---\ntitle: ") >= 0, "源码含 Front Matter");
  await page.click("#btn-source");
  await page.waitForTimeout(100);

  console.log("\n== 11. 格式菜单：下划线 / 高亮 / 删除线 / 清除样式 / 查看菜单 ==");
  // 格式菜单 + 下划线（折叠光标插入 <u></u>，输入即包裹）
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.click("#btn-menu-format");
  check(await page.$("#tb-menu-format.open") !== null, "格式菜单可打开");
  await page.click("#dropdown-format .dd-item[data-cmd='underline']");
  await page.keyboard.type("下划线文字");
  await page.waitForTimeout(150);
  // 文字必须落在 <u> 内部（曾出现标记插到文字外侧的缺陷）
  const uEl = await page.$("#editor p:last-of-type u");
  const uText = uEl ? await uEl.evaluate((n) => n.textContent) : "";
  check(uText.indexOf("下划线文字") >= 0, "下划线渲染（菜单插入 + 输入即包裹）");
  // Ctrl+U 选区切换：整段文字已在下划线内 -> 移除
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+u");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type u") === null, "Ctrl+U 选区切换（已包裹则移除）");
  // 再次 Ctrl+U：重新包裹
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+u");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type u") !== null, "Ctrl+U 选区加下划线");
  // Ctrl+Shift+H 高亮
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+Shift+h");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type mark") !== null, "Ctrl+Shift+H 高亮");
  // Alt+Shift+5 删除线
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Alt+Shift+5");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type s") !== null, "Alt+Shift+5 删除线");
  // Ctrl+\ 清除样式：选区只覆盖文字（标记在选区外）也要能剥掉——需扩张到格式 token 边界
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+\\");
  await page.waitForTimeout(200);
  check(await page.$("#editor p:last-of-type u") === null &&
        await page.$("#editor p:last-of-type mark") === null &&
        await page.$("#editor p:last-of-type s") === null, "Ctrl+\\ 选区清除样式（含选区外标记）");
  const fmtLastP = await page.$eval("#editor p:last-of-type", (n) => n.textContent);
  check(fmtLastP.indexOf("下划线文字") >= 0, "Ctrl+\\ 清除样式保留文字");
  // 折叠光标：插入高亮后输入（空 mark 包裹回归），再折叠光标清除整块
  await page.keyboard.press("End");
  await page.keyboard.press("Control+Shift+h");
  await page.keyboard.type("高亮");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type mark") !== null, "Ctrl+Shift+H 折叠光标插入高亮并输入");
  // 折叠光标在格式内容区内再按一次 = 切换移除（不残留字面 == 文本）
  await page.keyboard.press("Control+Shift+h");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type mark") === null, "Ctrl+Shift+H 折叠光标切换移除");
  check((await page.$eval("#editor p:last-of-type", (n) => n.textContent)).indexOf("==") < 0,
    "切换移除不残留字面标记");
  await page.keyboard.press("Control+\\");
  await page.waitForTimeout(150);
  check(await page.$("#editor p:last-of-type mark") === null, "Ctrl+\\ 折叠光标清除整块");
  // 查看菜单：源码模式切换
  await page.click("#btn-menu-view");
  check(await page.$("#tb-menu-view.open") !== null, "查看菜单可打开");
  await page.click("#dropdown-view .dd-item[data-cmd='source']");
  await page.waitForTimeout(150);
  check(await page.$("#source:not(.hidden)") !== null, "查看菜单切换源码模式");
  await page.click("#btn-menu-view");
  await page.click("#dropdown-view .dd-item[data-cmd='source']");
  await page.waitForTimeout(150);
  check(await page.$("#editor:not(.hidden)") !== null, "查看菜单切回所见即所得");

  console.log("\n== 12. 内置选择器降级（模拟 DBX 宿主原生对话框失败） ==");
  // 前面的测试把侧栏停在大纲面板，先切回文件面板
  await page.click('.side-tab[data-tab="files"]');
  await page.waitForTimeout(150);
  // 模拟 DBX 宿主环境：sidecar spawn powershell 失败，三个原生对话框 RPC 全部拒绝
  await page.evaluate(() => {
    var orig = window.dbxPlugin.invoke;
    window.dbxPlugin.invoke = function (m, p, o) {
      if (m === "fs/pickDir" || m === "fs/pickFile" || m === "fs/pickSaveFile") {
        return Promise.reject(new Error('dialog failed: exec: "powershell.exe": executable file not found in $PATH'));
      }
      return orig(m, p, o);
    };
  });
  // 12.1 文件夹选择：失败 -> 自动打开内置选择器 -> 驱动器列表 -> 进入/上级 -> 取消
  await page.click("#btn-open-dir");
  await page.waitForSelector("#pane-picker:not(.hidden)", { timeout: 5000 });
  check(true, "原生对话框失败后自动打开内置选择器");
  const fbToast = await page.$eval("#toast", (n) => n.textContent);
  check(fbToast.indexOf("内置选择器") >= 0, "降级提示 toast");
  check((await $$("#picker-list .picker-row")).length >= 1, "驱动器列表渲染");
  const driveName = await page.$eval("#picker-list .picker-row .picker-label", (n) => n.textContent);
  check(/^[A-Za-z]:\\$/.test(driveName), "驱动器条目格式（盘符:\\）");
  await page.dblclick("#picker-list .picker-row");
  await page.waitForTimeout(250);
  const crumb1 = await page.$eval("#picker-crumb", (n) => n.textContent);
  check(crumb1.indexOf(driveName.charAt(0)) >= 0, "双击进入驱动器并更新面包屑");
  await page.click("#picker-up");
  await page.waitForTimeout(200);
  check((await $$("#picker-list .picker-row")).length >= 1, "上级按钮返回驱动器列表");
  await page.click("#picker-cancel");
  await page.waitForTimeout(150);
  check(await page.$("#pane-picker.hidden") !== null, "取消关闭选择器");
  check(await page.$("#pane-files:not(.hidden)") !== null, "取消后回到文件面板");

  // 12.2 保存模式：新建文档 -> 保存 -> 内置选择器（起点=当前目录）-> 写盘
  await page.click("#btn-new");
  const cbox = await page.$("#overlay:not(.hidden)");
  if (cbox) await page.click("#dlg-foot .btn:nth-child(2)"); // 不保存
  await page.waitForTimeout(200);
  await page.click("#editor");
  await page.keyboard.type("选择器保存测试");
  await page.click("#btn-save");
  await page.waitForSelector("#pane-picker:not(.hidden)", { timeout: 5000 });
  check(await page.$("#picker-name:not(.hidden)") !== null, "保存模式显示文件名输入");
  const crumb2 = await page.$eval("#picker-crumb", (n) => n.textContent);
  check(crumb2.indexOf("此电脑") < 0 && crumb2.length > 0, "保存模式起点为当前目录（非驱动器列表）");
  await page.fill("#picker-name", "picker-e2e.md");
  await page.click("#picker-ok");
  await page.waitForTimeout(400);
  check(fs.existsSync(path.join(TMP, "picker-e2e.md")), "内置选择器保存写盘");
  check((await page.$eval("#doc-name", (n) => n.textContent)) === "picker-e2e.md", "保存后标题更新");

  // 12.3 打开模式：列出 Markdown 文件，双击直接打开
  await page.click("#btn-open");
  await page.waitForSelector("#pane-picker:not(.hidden)", { timeout: 5000 });
  check(await page.$("#picker-name.hidden") !== null, "打开模式无文件名输入");
  const pickerFileRows = await $$("#picker-list .picker-row.is-file");
  check(pickerFileRows.length >= 1, "打开模式列出 Markdown 文件");
  const openName = await pickerFileRows[0].$eval(".picker-label", (n) => n.textContent);
  await pickerFileRows[0].dblclick();
  await page.waitForTimeout(400);
  check((await page.$eval("#doc-name", (n) => n.textContent)) === openName, "双击文件直接打开");

  console.log("\n== 13. 截图 ==");
  // 先制造未保存更改，确认"新建"会弹出保存确认框
  await page.click("#editor p");
  await page.keyboard.press("End");
  await page.keyboard.type("截图测试");
  await page.click("#btn-new"); // 新建（有未保存更改会弹确认框）
  await page.waitForSelector("#overlay:not(.hidden)", { timeout: 5000 });
  await page.click("#dlg-foot .btn:nth-child(2)"); // 不保存
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(TMP, "shot-empty.png") });
  // 打开样例再截一张（先切回文件面板）
  await page.click('.side-tab[data-tab="files"]');
  await page.waitForTimeout(150);
  await page.click('#files-tree .ft-row.file:has-text("sample.md")');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(TMP, "shot-sample.png"), fullPage: false });
  ok("截图已保存");

  console.log("\n== 14. 沙箱内联回归（真实 DBX 宿主：内联 script 不转义闭合序列） ==");
  // 回归背景：DBX 宿主把 ui/index.html 的 <script src> 内容内联进 iframe srcdoc，
  // 且不复义 </script。md.js 导出模板里的裸 </script 曾把脚本截断成 SyntaxError，
  // 导致 window.axMd 未定义、打开文件报 "Cannot read properties of undefined (reading 'parse')"。
  // 本断面用同样无转义的内联方式重建页面，验证 axMd 正常挂载、无诊断横幅。
  {
    const inlineNoEscape = (html0) => html0.replace(
      /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
      (m, before, _q, url, after) => {
        if (/^vendor\//.test(url)) return "";
        const content = fs.readFileSync(path.join(UI_DIR, url), "utf8");
        return `<script${before}${after}>${content}</script>`; // 故意不转义 </script
      });
    const page2 = await browser.newPage();
    const errs2 = [];
    page2.on("pageerror", (e) => errs2.push(e.message));
    page2.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs2.push(m.text()); });
    await page2.addInitScript(() => {
      window.dbxPlugin = {
        ready: Promise.resolve(), context: {}, capabilities: { storage: true },
        storage: { get: async () => null, set: async () => {} },
        invoke: async () => ({ cancelled: true }),
      };
    });
    const rawHtml = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8");
    await page2.setContent(inlineNoEscape(rawHtml), { waitUntil: "load" });
    await page2.waitForTimeout(800);
    const probe2 = await page2.evaluate(() => ({
      axMd: typeof window.axMd,
      parseOk: (() => { try { return window.axMd.parse("# hi").length; } catch (e) { return "throws:" + e.message; } })(),
      banner: !!document.querySelector("[data-boot-error]"),
    }));
    check(probe2.axMd === "object", "无转义内联后 axMd 已挂载（修复前为 undefined）");
    check(probe2.parseOk === 1, "axMd.parse 可用（修复前抛 parse TypeError）");
    check(!probe2.banner, "无启动诊断横幅");
    check(errs2.length === 0, "无页面错误" + (errs2.length ? "：" + errs2.slice(0, 3).join(" | ") : ""));
    await page2.close();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  await browser.close();
  backend.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("E2E 异常:", e);
  process.exit(1);
});
