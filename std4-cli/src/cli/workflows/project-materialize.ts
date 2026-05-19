import type { PendingProjectItem } from "../../dash/open-api/list-pending-projects.js";
import { materializeDashPendingProject, type MaterializeDashProjectOptions } from "../query/dash-materialize.js";

export interface ProjectMaterializeContext {
  workspaceRootAbs: string;
  item: PendingProjectItem;
  anchor?: MaterializeDashProjectOptions["anchor"];
}

/**
 * Query 与后续 CLI-CONFIG-INJECT-001 共用的定点：spawn run-pipeline **之前**目录必须就绪。
 */
export async function materializeProjectForQuery(ctx: ProjectMaterializeContext): Promise<string> {
  return materializeDashPendingProject({
    workspaceRootAbs: ctx.workspaceRootAbs,
    item: ctx.item,
    anchor: ctx.anchor,
  });
}
