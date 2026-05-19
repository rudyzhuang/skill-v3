import fs from 'node:fs';
import path from 'node:path';

import { resolveInstallRoot } from './resolve-install-root.js';

/**
 * 返回 CURSOR_SKILLS_ROOT：为 `vendor/` 的绝对路径，使 `ai-std4` 位于其下。
 * 不回退到 ~/.cursor/skills。
 */
export function resolveCursorSkillsRoot(fromEntryFileUrl: string | URL): string {
  const installRoot = resolveInstallRoot(fromEntryFileUrl);
  const skillsRoot = path.resolve(installRoot, 'vendor');
  const pipeline = path.join(skillsRoot, 'ai-std4', 'scripts', 'run-pipeline.cjs');
  if (!fs.existsSync(pipeline)) {
    throw new Error('std4_cli_resolve_cursor_skills_root_failed: bundled ai-std4 入口缺失');
  }
  return skillsRoot;
}
