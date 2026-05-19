import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read .pipeline/stages.json from project root (Node.js / wrangler local dev only). */
export function readStagesJsonFromRoot(rootPath: string): unknown | null {
  try {
    const filePath = join(rootPath, '.pipeline', 'stages.json');
    const content = readFileSync(filePath, 'utf8');
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}
