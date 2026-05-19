import type { ProjectSummary } from '../api/projects';
import { ProjectStatusBadge } from './ProjectStatusBadge';

function formatUpdatedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function displayName(project: ProjectSummary): string {
  return project.name_zh?.trim() || project.name_en;
}

function secondaryName(project: ProjectSummary): string | null {
  if (project.name_zh?.trim() && project.name_en?.trim()) {
    return project.name_en;
  }
  return null;
}

interface ProjectListTableProps {
  items: ProjectSummary[];
}

export function ProjectListTable({ items }: ProjectListTableProps) {
  return (
    <table className="project-list-table" aria-label="项目列表表格">
      <thead>
        <tr>
          <th scope="col">项目名称</th>
          <th scope="col">登记状态</th>
          <th scope="col">客户端目标</th>
          <th scope="col">流水线摘要</th>
          <th scope="col">最近更新</th>
          <th scope="col">操作</th>
        </tr>
      </thead>
      <tbody>
        {items.map((project) => (
          <tr key={project.id}>
            <td className="project-list-table__name">
              <span className="project-list-table__primary">{displayName(project)}</span>
              {secondaryName(project) && (
                <span className="project-list-table__secondary">
                  {secondaryName(project)}
                </span>
              )}
            </td>
            <td>
              <ProjectStatusBadge status={project.status} />
            </td>
            <td className="project-list-table__targets" aria-label="列表行中的客户端目标或新增标识展示">
              <span className="project-list-table__client-targets">
                {project.client_targets.join(', ')}
              </span>
              {project.is_new && (
                <span className="project-list-table__is-new-badge">新增</span>
              )}
            </td>
            <td className="project-list-table__pipeline">
              {project.pipeline_summary?.trim() ? (
                <span title="流水线摘要">{project.pipeline_summary}</span>
              ) : (
                <span className="project-list-table__placeholder" title="暂无流水线摘要">
                  —
                </span>
              )}
            </td>
            <td>{formatUpdatedAt(project.updated_at)}</td>
            <td>
              <a
                href={`/projects/${encodeURIComponent(project.id)}/dashboard`}
                target="_blank"
                rel="noopener noreferrer"
                className="project-list-table__dashboard-link"
              >
                查看看板
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
