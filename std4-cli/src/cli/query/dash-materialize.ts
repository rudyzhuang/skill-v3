import fs from "node:fs/promises";
import path from "node:path";

import type { PendingProjectItem } from "../../dash/open-api/list-pending-projects.js";

export function filesystemSlugForProjectId(projectId: string): string {
  return projectId.replace(/[^-+.\p{L}\p{N}_]+/gu, "_").replace(/_+/g, "_").slice(0, 120) || "project";
}

export interface MaterializeDashProjectOptions {
  workspaceRootAbs: string;
  item: PendingProjectItem;
  /** create hand-off：若 id 匹配则直接在此目录就绪，而不是嵌套子目录。 */
  anchor?: {
    projectId: string;
    projectRootAbs: string;
  };
}

/**
 * 将 pending 项落到磁盘：优先复用 anchor 目录；否则使用 `workspaceRoot/<slug(project_id)>`。
 * 有 `repository_url` 时尝试 `git clone`（浅克隆）；否则写入最小脚手架与 `project-context.json`。
 */
export async function materializeDashPendingProject(opts: MaterializeDashProjectOptions): Promise<string> {
  const anchorOk =
    opts.anchor &&
    opts.anchor.projectId === opts.item.project_id &&
    path.resolve(opts.anchor.projectRootAbs).length > 0;

  const targetRoot =
    anchorOk ? path.resolve(opts.anchor!.projectRootAbs) : path.join(opts.workspaceRootAbs, filesystemSlugForProjectId(opts.item.project_id));

  await fs.mkdir(targetRoot, { recursive: true });

  const ctxPath = path.join(targetRoot, ".std4-cli", "project-context.json");
  await fs.mkdir(path.dirname(ctxPath), { recursive: true });

  const repo = opts.item.repository_url?.trim();
  const gitRef = opts.item.git_ref?.trim();

  if (repo?.length) {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const marker = path.join(targetRoot, ".git");
    try {
      await fs.access(marker);
    } catch {
      const cloneArgs = ["clone", "--depth", "1"];
      if (gitRef?.length) {
        cloneArgs.push("--branch", gitRef);
      }
      cloneArgs.push(repo, targetRoot);

      await execFileAsync("git", cloneArgs, {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  } else {
    const docsDir = path.join(targetRoot, "docs");
    const inputsDir = path.join(targetRoot, "inputs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.mkdir(inputsDir, { recursive: true });

    const reqPath = path.join(inputsDir, "req.md");
    try {
      await fs.access(reqPath);
    } catch {
      await fs.writeFile(
        reqPath,
        `# 需求占位\n\n（Query materialize 自动生成；project_id=${opts.item.project_id}）\n`,
        "utf8",
      );
    }
  }

  const payload = {
    version: 1 as const,
    schema: "std4.cli.project-context",
    generated_by: "std4-cli.query",
    project_root_abs: targetRoot,
    associate: {
      project_id: opts.item.project_id,
      repository_url: opts.item.repository_url,
      git_ref: opts.item.git_ref,
      workspace_hint: opts.item.workspace_hint ?? targetRoot.replace(/\\/g, "/"),
    },
  };

  await fs.writeFile(ctxPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return targetRoot;
}
