/**
 * 必须是 main.tsx 的第一个 import：不少模块一加载就读 `window.api.app.platform`，
 * 得赶在它们之前装好。DBX 宿主与浏览器冒烟都需要这个接口，所以无条件挂载。
 */
import { createDbxApi, hydrateDbxAssets } from './dbxApi';

window.api = createDbxApi();
hydrateDbxAssets();
