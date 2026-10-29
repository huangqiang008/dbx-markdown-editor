"use strict";
// shot-format.js — 行内格式渲染 + 「格式/查看」菜单展开态截图
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const BACKEND = path.join(ROOT, "bin", "windows-x64", "backend.exe");
const TMP = path.join(ROOT, ".e2e-tmp");
const PORT = 5421;
(async () => {
  fs.mkdirSync(TMP, { recursive: true });
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.exposeFunction("__dbxInvoke", async (method, params) => {
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
  // 造一段带各种行内格式的文字（段间点击标题移开光标，避免再按格式键触发切换移除）
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("普通、");
  await page.keyboard.press("Control+b");
  await page.keyboard.type("粗体");
  await page.click("#editor h2");
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.type("、");
  await page.keyboard.press("Control+u");
  await page.keyboard.type("下划线");
  await page.click("#editor h2");
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.type("、");
  await page.keyboard.press("Control+Shift+h");
  await page.keyboard.type("高亮");
  await page.click("#editor h2");
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.type("、");
  await page.keyboard.press("Control+Shift+x");
  await page.keyboard.type("删除线");
  await page.click("#editor h2");
  await page.click("#editor p:last-of-type");
  await page.keyboard.press("End");
  await page.keyboard.type("。");
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(TMP, "shot-format.png") });
  // 展开「格式」菜单
  await page.click("#btn-menu-format");
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(TMP, "shot-menu-format.png") });
  // 展开「查看」菜单
  await page.click("#btn-menu-format");
  await page.click("#btn-menu-view");
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(TMP, "shot-menu-view.png") });
  console.log("screenshots saved");
  await browser.close(); backend.kill(); server.close();
})().catch((e) => { console.error("异常:", e); process.exit(1); });
