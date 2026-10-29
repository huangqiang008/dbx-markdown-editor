// devhost-open.js — 在调试控制台里点开插件工作台，抓 iframe URL 和全部 frame 诊断
"use strict";
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  page.on("requestfailed", (r) => logs.push(`[requestfailed] ${r.url().slice(0, 140)} :: ${(r.failure() || {}).errorText || "?"}`));
  page.on("response", (r) => {
    const u = r.url();
    if (/\.(js|css|html|woff2?)(\?|$)/.test(u)) logs.push(`[resp ${r.status()}] ${u.slice(0, 150)}`);
  });
  page.on("frameattached", (f) => logs.push(`[frameattached] ${f.url().slice(0, 140)}`));
  page.on("framenavigated", (f) => logs.push(`[framenavigated] ${f.url().slice(0, 140)}`));

  await page.goto("http://127.0.0.1:5190/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  // 点开插件工作台
  await page.getByRole("button", { name: "Markdown 编辑器" }).click().catch(async () => {
    await page.locator("button", { hasText: "Markdown 编辑器" }).first().click();
  });
  await page.waitForTimeout(4000);

  const frames = page.frames();
  console.log("== frames ==");
  frames.forEach((f) => console.log("  ", f.url().slice(0, 160)));

  const target = frames.find((f) => /index\.html/.test(f.url())) || frames.find((f) => f !== page.mainFrame());
  if (target) {
    const probe = await target.evaluate(() => {
      const out = { url: location.href, globals: {}, scripts: [] };
      for (const k of ["axMd", "axIcons", "axI18n", "katex", "mermaid", "dbxPlugin"]) out.globals[k] = typeof window[k];
      document.querySelectorAll("script[src]").forEach((s) => out.scripts.push(s.getAttribute("src")));
      out.editorHtml = document.querySelector("#editor") ? document.querySelector("#editor").innerHTML.slice(0, 150) : "(no #editor)";
      out.title = document.title;
      return out;
    });
    console.log("== plugin frame probe ==");
    console.log(JSON.stringify(probe, null, 2));
  } else {
    console.log("!! no plugin frame found");
  }

  console.log("== logs ==");
  logs.slice(0, 80).forEach((l) => console.log("  ", l));
  await page.screenshot({ path: process.argv[2] || "/tmp/devhost-open.png" });
  await browser.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
