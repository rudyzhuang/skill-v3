import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read output-stages/stages.json (legacy: .pipeline/stages.json) from project root. */
export function readStagesJsonFromRoot(rootPath: string): unknown | null {
  const candidates = [
    join(rootPath, 'output-stages', 'stages.json'),
    join(rootPath, '.pipeline', 'stages.json'),
  ];
  for (const filePath of candidates) {
    try {
      const content = readFileSync(filePath, 'utf8');
      return JSON.parse(content) as unknown;
    } catch {
      /* try next */
    }
  }
  return null;
}
