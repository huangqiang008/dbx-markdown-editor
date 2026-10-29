// verify-inline-bug.js — 判决性验证：宿主内联 <script src> 时是否转义 </script>
// 情形 A（真实宿主行为假设）：不转义 → md.js 被截断 → axMd 未定义 + parse TypeError
// 情形 B（dev runtime 行为）：转义 <\/script → 一切正常
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const UI = path.join(ROOT, "ui");

function buildHtml(escapeClose) {
  let html = fs.readFileSync(path.join(UI, "index.html"), "utf8");
  // 只内联非 vendor 脚本（katex/mermaid 与验证无关，减小体积）
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
    (m, before, _q, url, after) => {
      if (/^vendor\//.test(url)) return ""; // 跳过 vendor（由 mock 提供）
      const content = fs.readFileSync(path.join(UI, url), "utf8");
      const safe = escapeClose ? content.replace(/<\/script/gi, "<\\/script") : content;
      return `<script${before}${after}>${safe}</script>`;
    });
  // 提供 vendor mock（main.js 只在交互时用 katex/mermaid，加载期不需要）
  html = html.replace("</head>", `<script>window.katex=undefined;window.mermaid=undefined;</script></head>`);
  return html;
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const escapeClose of [false, true]) {
    console.log(`\n===== 情形 ${escapeClose ? "B: 转义 </script（dev runtime 行为）" : "A: 不转义 </script（真实宿主疑似行为）"} =====`);
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 160)); });

    await page.addInitScript(() => {
      window.dbxPlugin = {
        ready: Promise.resolve(),
        context: {},
        capabilities: { storage: true },
        storage: {
          get: async () => null,
          set: async () => {},
        },
        invoke: async () => ({ cancelled: true }),
      };
    });

    const html = buildHtml(escapeClose);
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForTimeout(1200);

    const probe = await page.evaluate(() => {
      const out = { axMd: typeof window.axMd };
      try {
        // 模拟 main.js loadDoc 的第一步（用户打开文件的实际路径）
        out.parseThrows = String(() => window.axMd.parse("")).constructor === Function
          ? (() => { try { window.axMd.parse(""); return "no-throw"; } catch (e) { return e.message; } })()
          : "skipped";
        out.parseResult = (() => { try { const b = window.axMd.parse("# hi"); return "blocks:" + b.length; } catch (e) { return "throws: " + e.message; } })();
      } catch (e) { out.evalError = e.message; }
      out.editorHasContent = !!(document.querySelector("#editor") && document.querySelector("#editor").children.length);
      // 检测 md.js 截断泄漏：body 里是否出现 JS 源码文本
      const bodyText = document.body ? document.body.textContent : "";
      out.leakedMdSource = /serInlineNode|tokenizeInline/.test(bodyText);
      return out;
    });
    console.log("probe:", JSON.stringify(probe));
    console.log("errors:", errs.slice(0, 6));
    await page.close();
  }

  await browser.close();
})().catch((e) => { console.error("VERIFY ERROR:", e); process.exit(1); });
