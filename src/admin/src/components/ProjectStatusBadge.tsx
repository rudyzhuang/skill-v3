import type { ProjectStatus } from '../api/projects';

const STATUS_LABELS: Record<ProjectStatus, string> = {
  active: '进行中',
  blocked: '已阻塞',
  completed: '已完成',
  unknown: '未知',
};

const STATUS_CLASS: Record<ProjectStatus, string> = {
  active: 'status-badge--active',
  blocked: 'status-badge--blocked',
  completed: 'status-badge--completed',
  unknown: 'status-badge--unknown',
};

interface ProjectStatusBadgeProps {
  status: ProjectStatus;
}

export function ProjectStatusBadge({ status }: ProjectStatusBadgeProps) {
  return (
    <span
      className={`status-badge ${STATUS_CLASS[status]}`}
      aria-label={`登记状态：${STATUS_LABELS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
