import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// 版权与许可声明不在这里注入：rollup 的 output.banner 会被 esbuild 的 minify 压掉
// （`/*!` 也保不住，实测丢了）。统一由 scripts/finalize.mjs 在写最终 index.html 时注入。

/** KaTeX 样式表列了 woff2 / woff / ttf 三种格式，只保留 woff2 */
const dropLegacyKatexFonts = {
  name: 'drop-legacy-katex-fonts',
  generateBundle(_options: unknown, bundle: Record<string, unknown>) {
    for (const file of Object.keys(bundle)) if (/KaTeX_[^/]*\.(ttf|woff)$/.test(file)) delete bundle[file];
  },
};

// 产物先按常规 Vite 结构落到 ui/lite/，再由 scripts/finalize.mjs 合成单个 index.html。
// 放在构建后处理而不是 generateBundle 钩子里，是为了绕开 Vite 内部 HTML 插件的注入顺序。
export default defineConfig({
  plugins: [react(), dropLegacyKatexFonts],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: '../ui/lite',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  base: './',
});
