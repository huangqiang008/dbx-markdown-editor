/**
 * 来源一致性校验：防止 cherry-pick 时把 CC BY-NC 历史代码或低版本声明混进 MIT 分发。
 *
 * 这是「声明与文件数一致性」的守卫，不是逐文件来源证明。逐文件来源靠
 * assets/licenses/SOURCE-PROVENANCE.txt 第四节的人工清单 + 上游 git 历史保证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(editorRoot, '..');

const errors = [];
const ok = [];
const check = (cond, pass, fail) => (cond ? ok : errors).push(cond ? pass : fail);

// 1. 基准版本：lite-v 前缀 + 版本号 >= 26.4.6
const appInfo = fs.readFileSync(path.join(editorRoot, 'src/utils/appInfo.ts'), 'utf8');
const ver = /UPSTREAM_VERSION\s*=\s*'([^']+)'/.exec(appInfo)?.[1] ?? '';
const m = /^lite-v(\d+)\.(\d+)\.(\d+)$/.exec(ver);
check(!!m, `基准版本格式正确：${ver}`, `UPSTREAM_VERSION 格式非法或缺失：'${ver}'（应为 lite-v26.4.6 及以上）`);
if (m) {
  const tuple = [Number(m[1]), Number(m[2]), Number(m[3])];
  const min = [26, 4, 6];
  const gte = tuple.some((n, i) => n !== min[i] ? n > min[i] : false) || tuple.every((n, i) => n === min[i]);
  check(gte, `基准版本 ${ver} >= lite-v26.4.6`, `基准版本 ${ver} 低于 MIT 起点 lite-v26.4.6，CC BY-NC 禁商用`);
}

// 2. 授权声明：MIT + imoling
const lic = /UPSTREAM_LICENSE\s*=\s*'([^']+)'/.exec(appInfo)?.[1] ?? '';
check(/MIT/.test(lic) && /imoling/.test(lic), `上游授权声明正确：${lic}`, `UPSTREAM_LICENSE 不是 MIT/imoling：'${lic}'`);

// 3. 来源清单存在且含 MIT 生效 commit hash
const provPath = path.join(projectRoot, 'assets/licenses/SOURCE-PROVENANCE.txt');
const prov = fs.existsSync(provPath) ? fs.readFileSync(provPath, 'utf8') : '';
check(prov.includes('f4c4ac584d3e797685186afb1639bb349f54d122'), '来源清单含 MIT 生效 commit', 'SOURCE-PROVENANCE.txt 缺失或不含 MIT 生效 commit hash');
check(/lite-v26\.4\.0 ~ lite-v26\.4\.5/.test(prov), '来源清单标注了禁止取码版本', 'SOURCE-PROVENANCE.txt 未标注 CC BY-NC 禁止版本');

// 4. 内核目录文件数快照（与 SOURCE-PROVENANCE.txt 第三节一致）
const snapshot = { utils: 50, shared: 17, extensions: 31 };
for (const [dir, expected] of Object.entries(snapshot)) {
  const abs = path.join(editorRoot, 'src', dir);
  const n = fs.existsSync(abs) ? fs.readdirSync(abs).filter((f) => f.endsWith('.ts')).length : -1;
  check(n === expected, `src/${dir} 文件数 ${n} = 快照 ${expected}`, `src/${dir} 文件数 ${n} ≠ 快照 ${expected}；同步后须更新 SOURCE-PROVENANCE.txt 与脚本快照`);
}

// 5. 本插件自有 LICENSE 为 MIT
const rootLic = fs.existsSync(path.join(projectRoot, 'LICENSE')) ? fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8') : '';
check(/MIT License/.test(rootLic), '根目录 LICENSE 为 MIT', '根目录 LICENSE 缺失或非 MIT');

for (const line of ok) console.log(`  [ok] ${line}`);
for (const line of errors) console.error(`  [FAIL] ${line}`);
if (errors.length) {
  console.error(`\n[provenance] ${errors.length} 项失败，禁止发布。`);
  process.exit(1);
}
console.log(`\n[provenance] ${ok.length} 项全部通过。`);
