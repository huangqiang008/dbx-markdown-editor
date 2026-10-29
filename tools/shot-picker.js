"use strict";
// shot-picker.js — 内置文件/文件夹选择器截图（模拟 DBX 宿主原生对话框失败）
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const BACKEND = path.join(ROOT, "bin", "windows-x64", "backend.exe");
const TMP = path.join(ROOT, ".e2e-tmp");
const PORT = 5432;
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
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
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
  // 模拟 DBX：原生对话框 RPC 失败
  await page.evaluate(() => {
    var orig = window.dbxPlugin.invoke;
    window.dbxPlugin.invoke = function (m, p, o) {
      if (m === "fs/pickDir" || m === "fs/pickFile" || m === "fs/pickSaveFile") {
        return Promise.reject(new Error('dialog failed: exec: "powershell.exe": executable file not found in $PATH'));
      }
      return orig(m, p, o);
    };
  });
  // 打开文件夹 -> 自动降级到内置选择器（驱动器列表）
  await page.click("#btn-open-dir");
  await page.waitForSelector("#pane-picker:not(.hidden)", { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(TMP, "shot-picker-drives.png") });
  // 双击进入第一个驱动器
  await page.dblclick("#picker-list .picker-row");
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(TMP, "shot-picker-inside.png") });
  console.log("screenshots saved");
  await browser.close(); backend.kill(); server.close();
})().catch((e) => { console.error("异常:", e); process.exit(1); });
