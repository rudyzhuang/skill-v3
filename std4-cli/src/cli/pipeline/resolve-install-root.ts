import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 相对安装根目录，用于定位内置 ai-std4 流水线入口。 */
const VENDOR_PIPELINE_PARTS = ['vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs'];

/**
 * 自 `fromEntryFileUrl`（通常为 CLI 模块的 import.meta.url）向上查找含 vendor/ai-std4 的安装根目录。
 */
export function resolveInstallRoot(fromEntryFileUrl: string | URL): string {
  let dir = path.dirname(fileURLToPath(fromEntryFileUrl));
  const { root } = path.parse(dir);
  while (true) {
    const marker = path.join(dir, ...VENDOR_PIPELINE_PARTS);
    if (fs.existsSync(marker)) {
      return dir;
    }
    if (dir === root) {
      break;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    'std4_cli_resolve_install_root_failed: vendor/ai-std4/scripts/run-pipeline.cjs 不存在（请先 npm run vendor:ai-std4）',
  );
}
