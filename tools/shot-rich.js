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
const PORT = 5415;
(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const doc = [
    "# 富文本渲染验证", "",
    "普通段落 + **加粗** + *斜体* + ~~删除~~ + `行内代码` + [链接](https://example.com)。", "",
    "## 任务与列表", "",
    "- [x] 已完成项", "- [ ] 待办项", "- 普通项", "  - 嵌套子项", "",
    "1. 第一项", "2. 第二项", "",
    "> 引用块：可以包含**格式**。", "> 第二行引用", "",
    "## 表格", "",
    "| 功能 | 状态 | 备注 |", "| --- | --- | --- |", "| 实时渲染 | ✅ | 输入即渲染 |", "| 源码模式 | ✅ | Ctrl+/ 切换 |", "",
    "## 代码块", "",
    "```js", "function hello(name) {", "  return `hi ${name}`;", "}", "```", "",
    "---", "",
    "结尾段落。", ""
  ].join("\n");
  fs.writeFileSync(path.join(TMP, "rich.md"), doc, "utf8");
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = path.join(UI_DIR, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
      if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": p.endsWith(".css") ? "text/css" : p.endsWith(".js") ? "text/javascript" : "text/html" });
      fs.createReadStream(p).pipe(res);
    });
    s.listen(PORT, "127.0.0.1", () => resolve(s));
  });
  const backend = spawn(BACKEND, [], { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1; const pending = new Map(); let buf = "";
  backend.stdout.on("data", (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } catch (e) {}
    }
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  await page.exposeFunction("__dbxInvoke", async (method, params) => {
    if (method === "fs/pickDir") return { cancelled: false, path: TMP.replace(/\\/g, "/") };
    return new Promise((resolve) => {
      const id = nextId++; pending.set(id, resolve);
      backend.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    }).then((r) => r.result);
  });
  await page.addInitScript(() => {
    var store = {};
    window.dbxPlugin = { ready: Promise.resolve(), context: { theme: { locale: "zh-CN" } }, capabilities: { storage: true, workbench: true },
      storage: { get: (k) => Promise.resolve(store[k] ?? null), set: (k, v) => { store[k] = v; return Promise.resolve(); } },
      invoke: (m, p) => window.__dbxInvoke(m, p || {}), clipboard: { writeText: () => Promise.resolve() } };
  });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html");
  await page.waitForSelector("#editor h1");
  await page.click("#btn-open-dir");
  await page.waitForSelector("#files-tree .ft-row.file", { timeout: 8000 });
  await page.click('#files-tree .ft-row.file:has-text("rich.md")');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(TMP, "shot-rich.png"), fullPage: false });
  // 大纲面板
  await page.click('.side-tab[data-tab="outline"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(TMP, "shot-outline.png"), fullPage: false });
  console.log("screenshots saved");
  await browser.close(); backend.kill(); server.close();
})().catch((e) => { console.error("异常:", e); process.exit(1); });
