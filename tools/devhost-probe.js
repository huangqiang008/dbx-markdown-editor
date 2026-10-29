// devhost-probe.js — 在 dbx-plugin dev 调试宿主里观察插件 UI 的真实加载行为
// 目标：复现 window.axMd 未定义问题，收集所有 frame 的控制台/网络错误
"use strict";
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();

  const logs = [];
  page.on("console", (m) => logs.push(`[console:${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) =>
    logs.push(`[requestfailed] ${r.url().slice(0, 120)} :: ${(r.failure() || {}).errorText || "?"}`));
  page.on("response", (r) => {
    const u = r.url();
    if (/\.(js|css|html|woff2?)(\?|$)/.test(u)) logs.push(`[resp ${r.status()}] ${u.slice(0, 140)}`);
  });

  await page.goto("http://127.0.0.1:5190/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);

  // 列出所有 frame
  const frames = page.frames();
  console.log("== frames ==");
  for (const f of frames) console.log(" frame:", f.url().slice(0, 140));

  // 找插件 frame（URL 含 ui/index.html 或非调试台域）
  let pluginFrame = frames.find((f) => /index\.html/.test(f.url())) || frames.find((f) => f !== page.mainFrame());
  console.log("\n== plugin frame ==", pluginFrame ? pluginFrame.url() : "(none)");

  if (pluginFrame) {
    const probe = await pluginFrame.evaluate(() => {
      const out = { url: location.href, origin: location.origin, globals: {}, scripts: [] };
      for (const k of ["axMd", "axIcons", "axI18n", "katex", "mermaid", "dbxPlugin", "Vue"]) {
        out.globals[k] = typeof window[k];
      }
      for (const s of document.querySelectorAll("script[src]")) {
        out.scripts.push({ src: s.getAttribute("src"), readyState: s.readyState });
      }
      out.bodyStart = document.body ? document.body.innerHTML.slice(0, 200) : null;
      return out;
    });
    console.log(JSON.stringify(probe, null, 2));

    // 直接打开插件 UI URL（如果是 http URL 则直接导航）
    const u = pluginFrame.url();
    if (/^https?:/.test(u)) {
      console.log("\n== direct navigation to plugin UI ==");
      const p2 = await browser.newPage();
      const logs2 = [];
      p2.on("console", (m) => logs2.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
      p2.on("pageerror", (e) => logs2.push(`[pageerror] ${String(e).slice(0, 300)}`));
      p2.on("requestfailed", (r) => logs2.push(`[requestfailed] ${r.url().slice(0, 140)} :: ${(r.failure() || {}).errorText || "?"}`));
      await p2.goto(u, { waitUntil: "networkidle", timeout: 20000 }).catch((e) => logs2.push("[goto] " + e.message));
      await p2.waitForTimeout(2000);
      const probe2 = await p2.evaluate(() => {
        const out = { url: location.href, globals: {} };
        for (const k of ["axMd", "axIcons", "axI18n", "katex", "mermaid", "dbxPlugin"]) out.globals[k] = typeof window[k];
        out.scriptSrcs = Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src"));
        out.inlineScriptCount = Array.from(document.querySelectorAll("script:not([src])")).length;
        return out;
      });
      console.log(JSON.stringify(probe2, null, 2));
      console.log("== direct-nav logs ==");
      logs2.forEach((l) => console.log(" ", l));
      await p2.close();
    }
  }

  console.log("\n== main page logs ==");
  logs.slice(0, 60).forEach((l) => console.log(" ", l));

  await browser.close();
})().catch((e) => { console.error("PROBE ERROR:", e); process.exit(1); });
