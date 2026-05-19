import fs from "node:fs/promises";
import path from "node:path";

export interface ScaffoldInputs {
  /** Display / registration name */
  displayName: string;
  /** Absolute target directory root */
  projectRoot: string;
}

function posixRelForHint(p: string): string {
  return p.replace(/\\/g, "/");
}

const MINIMAL_REQ_BODY = `# 项目需求说明

由 std4-cli create 自动生成，请按需完善各节占位内容。

## 项目名称 *

{DISPLAY_NAME_PLACEHOLDER}

## 项目简介 *

（简述项目）

## 客户端目标 *

- website — 前端站点
- admin — 后台
- backend — API
- mobile — Flutter

在此列出目标端与实际定位。

## 核心功能 *

1. ...

## 非功能需求

性能、可靠性、运维等约束。

## 部署与域名要求 *

### 主域名 *

DOMAIN=

### dev 环境

填充分环境域名与子域策略。
`;

export async function writeStd4BusinessScaffold(inp: ScaffoldInputs): Promise<{ reqPath: string; docsDir: string; inputsDir: string }> {
  const root = path.resolve(inp.projectRoot);
  await fs.mkdir(root, { recursive: true });

  const docsDir = path.join(root, "docs");
  const inputsDir = path.join(root, "inputs");

  await fs.mkdir(docsDir, { recursive: true });
  await fs.mkdir(inputsDir, { recursive: true });

  const reqPath = path.join(inputsDir, "req.md");
  const readmePath = path.join(docsDir, "README.md");

  const md = MINIMAL_REQ_BODY.replace("{DISPLAY_NAME_PLACEHOLDER}", inp.displayName);
  await fs.writeFile(reqPath, md.endsWith("\n") ? md : `${md}\n`, "utf8");

  await fs.writeFile(
    readmePath,
    `# Docs\n\n此目录存放 std4 / ai-std4 流水线所需的项目文档占位与生成物。\n\n` +
      `脚手架根路径（POSIX 线索）：${posixRelForHint(inp.projectRoot)}\n`,
    "utf8",
  );

  return { reqPath, docsDir, inputsDir };
}
