import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface ClawSetupOptions {
  installRoot: string;
  /** 若设置则优先 git clone；否则复制内置 stub */
  clawGitUrl?: string;
  log?: (line: string) => void;
  /** 单元测试或未安装 Bun 的环境可跳过检测（生产 Setup 不应关闭） */
  skipBunCheck?: boolean;
}

const ENV_TEMPLATE = `# feishu-cursor-claw 本地配置（不入库）
# 凭证仅保存在本文件；日志禁止输出密钥原文。
FEISHU_APP_ID=
FEISHU_APP_SECRET=

# 可选：bridge 额外参数占位
FEISHU_ENCRYPT_KEY=

`;

function stubRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../resources/feishu-cursor-claw-stub");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertBunAvailable(log?: (line: string) => void): void {
  const res = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(
      "[feishu-setup] 未检测到可用的 bun：请先安装 Bun（https://bun.sh）并确保在 PATH 中",
    );
  }
  const ver = String(res.stdout ?? "").trim();
  if (ver) log?.(`[feishu-setup] bun ${ver}`);
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

/**
 * 在工作目录 installRoot 下物化 feishu-cursor-claw，并写入仅本地的 .env 模板。
 */
export async function runClawSetup(opts: ClawSetupOptions): Promise<string> {
  const log = opts.log ?? (() => {});
  if (!opts.skipBunCheck) {
    assertBunAvailable(log);
  }
  const clawRoot = path.join(opts.installRoot, "feishu-cursor-claw");
  await fs.mkdir(opts.installRoot, { recursive: true });

  if (!(await pathExists(clawRoot))) {
    await fs.mkdir(clawRoot, { recursive: true });
  }

  const hasServer = await pathExists(path.join(clawRoot, "server.ts"));
  if (!hasServer) {
    if (opts.clawGitUrl) {
      log(`[feishu-setup] cloning claw from git`);
      const res = spawnSync(
        "git",
        ["clone", "--depth", "1", opts.clawGitUrl, clawRoot],
        { encoding: "utf8" },
      );
      if (res.status !== 0) {
        log(`[feishu-setup] git clone failed, falling back to stub`);
        await fs.rm(clawRoot, { recursive: true, force: true });
        await copyDir(stubRoot(), clawRoot);
      }
    } else {
      log(`[feishu-setup] materializing embedded stub template`);
      await copyDir(stubRoot(), clawRoot);
    }
  }

  const envPath = path.join(clawRoot, ".env");
  if (!(await pathExists(envPath))) {
    await fs.writeFile(envPath, ENV_TEMPLATE, "utf8");
  }

  log(`[feishu-setup] done clawRoot=${clawRoot}`);
  return clawRoot;
}
