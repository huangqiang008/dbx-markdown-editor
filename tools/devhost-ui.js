// devhost-ui.js — 摸清调试控制台 UI 结构，找到打开插件 UI 的入口
"use strict";
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("console", (m) => { if (m.type() === "error") console.log("[err]", m.text().slice(0, 200)); });
  await page.goto("http://127.0.0.1:5190/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2500);

  const info = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const btns = Array.from(document.querySelectorAll("button, a, [role=button], [role=tab]"))
      .filter(vis).map((b) => ({ tag: b.tagName, text: (b.textContent || "").trim().slice(0, 40), cls: (b.className || "").toString().slice(0, 60), id: b.id || "" }));
    const ifr = Array.from(document.querySelectorAll("iframe")).map((f) => ({ src: (f.getAttribute("src") || "").slice(0, 100), id: f.id, cls: (f.className || "").toString().slice(0, 60) }));
    return { title: document.title, btns: btns.slice(0, 40), ifr, bodyText: (document.body.innerText || "").slice(0, 600) };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: process.argv[2] || "/tmp/devhost.png", fullPage: false });
  await browser.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
