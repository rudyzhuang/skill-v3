import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { QueryAssociateFields } from "../../dash/open-api/register-project.js";

export interface QueryHandoffContext {
  associate: QueryAssociateFields;
  projectRootAbs: string;
  nonInteractive?: boolean;
}

async function tryImportBootstrapQueryHandlers(): Promise<
  | {
      bootstrapQueryAfterCreate?: (ctx: QueryHandoffContext) => Promise<void>;
    }
  | undefined
> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidateJs = join(here, "query-command.js");
  if (!existsSync(candidateJs)) return undefined;

  return (await import(pathToFileURL(candidateJs).href)) as {
    bootstrapQueryAfterCreate?: (ctx: QueryHandoffContext) => Promise<void>;
  };
}

/**
 * After successful Create (+ optional Dash register), enters Query loop when
 * CLI-MODE-QUERY-001 exports `bootstrapQueryAfterCreate`; otherwise stderr 打印单行可复制命令（AC4）。
 */
export async function enterQueryAfterCreate(
  ctx: QueryHandoffContext,
): Promise<{ mode: "query_module" | "printed_command"; detail?: string }> {
  const mod = await tryImportBootstrapQueryHandlers();
  const handler = typeof mod?.bootstrapQueryAfterCreate === "function" ? mod.bootstrapQueryAfterCreate : undefined;
  if (handler) {
    await handler(ctx);
    return { mode: "query_module", detail: "query_bootstrap_hook" };
  }

  const cmd = commandLineEquivalent(ctx);
  // eslint-disable-next-line no-console
  console.error(cmd);
  return { mode: "printed_command", detail: cmd };
}

export function commandLineEquivalent(ctx: QueryHandoffContext): string {
  const parts = ["std4", "query"];

  parts.push("--project-root", JSON.stringify(ctx.projectRootAbs));
  parts.push("--focus-project-id", JSON.stringify(ctx.associate.project_id));

  const repo =
    typeof ctx.associate.repository_url === "string" && ctx.associate.repository_url.trim().length > 0 ?
      ctx.associate.repository_url.trim()
    : "";

  const ref =
    typeof ctx.associate.git_ref === "string" && ctx.associate.git_ref.trim().length > 0 ? ctx.associate.git_ref.trim() : "";

  if (repo) parts.push("--repository-url", JSON.stringify(repo));
  if (ref) parts.push("--git-ref", JSON.stringify(ref));
  if (ctx.nonInteractive) parts.push("--non-interactive");

  return parts.join(" ");
}
