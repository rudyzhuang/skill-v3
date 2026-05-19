/**
 * Loads key=value pairs from a simple dotenv-ish file (~/.std4-cli/config.env).
 * Values are trimmed; BOM skipped; ignores blank lines / full-line comments (#).
 */

import { constants as FsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Std4UserConfig {
  /** HTTPS base URL (may include pathname prefix before /open-api/... joins). */
  dashStd4ApiBase?: string;
  dashStd4ApiKey?: string;
  /** Parsed map for forwards-compatible consumers. */
  raw: Record<string, string>;
}

function stripUtf8Bom(text: string): string {
  if (text.charCodeAt(0) === 0xfe_ff || text.startsWith("\uFEFF")) {
    return text.replace(/^\uFEFF/, "");
  }
  return text;
}

async function readablePath(p: string): Promise<boolean> {
  try {
    await fs.access(p, FsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadStd4UserConfigFromHome(home?: string): Promise<Std4UserConfig> {
  const cfgPathOverride = process.env.STD4_CLI_CONFIG_OVERRIDE?.trim();
  const resolvedHome =
    typeof home === "string" && home.trim().length > 0 ?
      path.resolve(home)
    : os.homedir();
  const cfgPath =
    cfgPathOverride && cfgPathOverride.length ?
      path.resolve(cfgPathOverride)
    : path.join(resolvedHome, ".std4-cli", "config.env");

  const merged: Record<string, string> = {};

  if (!(await readablePath(cfgPath))) {
    return { raw: merged };
  }

  const txt = stripUtf8Bom(await fs.readFile(cfgPath, "utf8"));
  const lines = txt.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    const unquoted = val.match(/^['"](.+?)['"]$/);
    if (unquoted) val = unquoted[1];
    merged[key] = val;
  }

  return {
    dashStd4ApiBase: merged["DASH_STD4_API_BASE"] ?? merged["DASH_STD4_BASE_URL"] ?? merged["STD4_DASH_OPENAPI_BASE_URL"],
    dashStd4ApiKey: merged["DASH_STD4_API_KEY"],
    raw: merged,
  };
}
