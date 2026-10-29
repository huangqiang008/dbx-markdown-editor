"use strict";
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const ROOT = path.join(__dirname, "..");
const UI_DIR = path.join(ROOT, "ui");
const BACKEND = path.join(ROOT, "bin", "windows-x64", "backend.exe");
const PORT = 5417;
(async () => {
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
  page.on("console", (m) => { var tx = m.text(); if (tx.indexOf("[DBG") === 0) console.log("    " + tx); else if (m.type() === "error") console.log("CONSOLE-ERR:", tx); });
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
    // 事件日志
    window.__evlog = [];
    document.addEventListener("compositionstart", () => window.__evlog.push("compositionstart"), true);
    document.addEventListener("compositionupdate", () => window.__evlog.push("compositionupdate"), true);
    document.addEventListener("compositionend", () => window.__evlog.push("compositionend"), true);
    document.addEventListener("beforeinput", (e) => window.__evlog.push("beforeinput:" + e.inputType), true);
    document.addEventListener("input", (e) => window.__evlog.push("input:" + e.inputType), true);
  });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html");
  await page.waitForSelector("#editor h1");

  // 忠实模拟真实 IME：compositionstart -> 浏览器插入裸文本节点 -> compositionupdate -> compositionend -> input
  async function imeType(text) {
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
      document.getElementById("editor").dispatchEvent(new CompositionEvent("compositionend", { data: t, bubbles: true }));
    }, text);
    await page.evaluate(() => {
      document.getElementById("editor").dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", bubbles: true }));
    });
  }
  async function state(label) {
    const st = await page.evaluate(() => {
      var sel = window.getSelection();
      var an = sel.anchorNode;
      var blk = an && (an.nodeType === 3 ? an.parentNode : an).closest ? (an.nodeType === 3 ? an.parentNode : an).closest("[data-type]") : null;
      var all = Array.from(document.querySelectorAll("#editor [data-type]"));
      var idx = blk ? all.indexOf(blk) : -1;
      return {
        caret: an ? (an.nodeType === 3 ? "text@" + an.parentNode.tagName : an.tagName) + "#" + sel.anchorOffset : "null",
        blockIdx: idx, nBlocks: all.length,
        blockText: blk ? blk.textContent.slice(0, 24) : "(none)",
        ev: window.__evlog.join(" | "),
      };
    });
    console.log("[" + label + "] " + JSON.stringify(st));
    await page.evaluate(() => { window.__evlog = []; });
  }

  console.log("== 场景 A：空段落里拼音输入 ==");
  await page.click("#editor p:nth-of-type(1)");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  await state("空段落");
  await imeType("你好");
  await state("IME 后");
  await page.keyboard.type("ABC");
  await page.waitForTimeout(150);
  await state("再打英文");

  console.log("\n== 场景 B：有内容段落末尾拼音 ==");
  await page.keyboard.press("Enter");
  await page.keyboard.type("hello ");
  await page.waitForTimeout(150);
  await state("英文后");
  await imeType("世界");
  await state("IME 后");
  await page.keyboard.type("XY");
  await page.waitForTimeout(150);
  await state("再打英文");

  console.log("\n== 场景 C：段落开头拼音 ==");
  await page.keyboard.press("Enter");
  await page.keyboard.type("tail");
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  await imeType("前缀");
  await state("IME 后");
  await page.keyboard.type("Z");
  await page.waitForTimeout(150);
  await state("再打英文");

  await page.click("#btn-source");
  await page.waitForTimeout(150);
  const src = await page.$eval("#source", (n) => n.value);
  console.log("\nMODEL:/n" + src.split("\n").slice(-8).join("\n"));
  await browser.close(); backend.kill(); server.close();
})().catch((e) => { console.error("DBG 异常:", e); process.exit(1); });
