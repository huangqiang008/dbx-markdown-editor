import { useAppStore } from '../stores/appStore';
import { noteDirOf } from './assetUrl';

/** 当前标签页里的相对路径该相对哪个目录解析；未落盘的新文档用打开的文件夹（没有就是 null） */
export function currentNoteDir(): string | null {
  const state = useAppStore.getState();
  return noteDirOf(state.activeTabId, state.getNewNoteDir());
}

/**
 * 保存图片时用的「所属文档路径」。
 * 新文档还没落盘，但只要打开过文件夹，图片就该存进那个文件夹的 assets/ —— 后端 saveAsset
 * 只拿 docPath 取目录，不要求文件真的存在；currentNoteDir() 也用同一个目录解析相对路径。
 * 连文件夹都没打开时才返回 null，由调用方退回「写进文档里」。
 */
export function imageOwnerPath(tabId: string | null, fallbackDir: string | null = null): string | null {
  if (!tabId) return null;
  if (!tabId.startsWith('new-')) return tabId;
  if (!fallbackDir) return null;
  const sep = fallbackDir.includes('\\') ? '\\' : '/';
  return fallbackDir.replace(/[\\/]+$/, '') + sep + '__unsaved__.md';
}
