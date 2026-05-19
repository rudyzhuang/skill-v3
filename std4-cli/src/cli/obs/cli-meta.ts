import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CliBuildMeta = {
  version: string;
  commit?: string;
  buildId?: string;
};

function repoRootFromHere(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli/obs -> ../../../
  return join(here, '..', '..', '..');
}

/** 从仓库根 package.json 读取版本（运行时应从已构建的 dist 相对定位）。 */
export function loadPackageMeta(): CliBuildMeta {
  const root = repoRootFromHere();
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  const commit = process.env.STD4_CLI_COMMIT;
  const buildId = process.env.STD4_CLI_BUILD_ID;
  return {
    version: pkg.version ?? '0.0.0',
    ...(commit ? { commit } : {}),
    ...(buildId ? { buildId } : {}),
  };
}

export function formatVersionLine(meta: CliBuildMeta): string {
  const bits = [meta.version];
  if (meta.commit) bits.push(`commit=${meta.commit}`);
  if (meta.buildId) bits.push(`build=${meta.buildId}`);
  return bits.join(' ');
}
