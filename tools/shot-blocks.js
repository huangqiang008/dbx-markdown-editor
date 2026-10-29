"use strict";
// shot-blocks.js — 新块类型（公式/图表/脚注/Front Matter/段落菜单）可视化验证
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const BACKEND = path.join(ROOT, "bin", "windows-x64", "backend.exe");
const TMP = path.join(ROOT, ".e2e-tmp");
const PORT = 5418;
(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const doc = [
    "---",
    "title: 新块类型验证",
    "date: 2026-10-19",
    "tags: [md, editor]",
    "---",
    "",
    "# 新块类型渲染验证",
    "",
    "行内公式 $E=mc^2$ 与 $\\sum_{i=1}^n i$ 混排。",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "## Mermaid 图表",
    "",
    "```mermaid",
    "flowchart TD",
    "    A[开始] --> B{条件}",
    "    B -->|是| C[完成]",
    "    B -->|否| A",
    "```",
    "",
    "## 脚注",
    "",
    "正文带脚注引用[^1]，还有命名脚注[^note]。",
    "",
    "[^1]: 这是第一条脚注定义。",
    "[^note]: 命名脚注同样支持。",
    "",
    "结尾段落。",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(TMP, "blocks.md"), doc, "utf8");
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
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE-ERR:", m.text()); });
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
  await page.click('#files-tree .ft-row.file:has-text("blocks.md")');
  await page.waitForSelector("#editor .b-chart svg", { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(TMP, "shot-blocks.png"), fullPage: false });
  // 段落菜单展开态
  await page.click("#btn-menu-paragraph");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(TMP, "shot-menu.png"), fullPage: false });
  await page.keyboard.press("Escape");
  console.log("screenshots saved");
  await browser.close(); backend.kill(); server.close();
})().catch((e) => { console.error("异常:", e); process.exit(1); });
