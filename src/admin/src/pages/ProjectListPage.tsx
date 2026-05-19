import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchProjects,
  type ProjectStatus,
  type ProjectSummary,
} from '../api/projects';
import { ApiError } from '../api/client';
import { ProjectListTable } from '../components/ProjectListTable';
import { canManageProjects } from '../components/AdminOnlyRoute';
import { useAuth } from '../hooks/useAuth';

const STATUS_OPTIONS: { value: '' | ProjectStatus; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '进行中' },
  { value: 'blocked', label: '已阻塞' },
  { value: 'completed', label: '已完成' },
  { value: 'unknown', label: '未知' },
];

export function ProjectListPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | ProjectStatus>('');
  const [searchQ, setSearchQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(searchQ), 300);
    return () => window.clearTimeout(timer);
  }, [searchQ]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchProjects({
        status: statusFilter,
        q: debouncedQ,
        sort: 'updated_at_desc',
      });
      setItems(data.items);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message || '加载项目列表失败，请稍后重试');
      } else {
        setError('加载项目列表失败，请稍后重试');
      }
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedQ]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <main className="projects-page">
      <header className="projects-page__header">
        <h1>项目列表</h1>
        {user && canManageProjects(user.role) && (
          <Link to="/projects/new" className="projects-page__new-btn">
            新建项目
          </Link>
        )}
      </header>

      <section className="projects-toolbar" aria-label="列表筛选">
        <label>
          状态筛选
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as '' | ProjectStatus)
            }
            aria-label="状态筛选下拉框"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          名称搜索
          <input
            type="search"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="中文或英文名称"
            aria-label="项目名称搜索输入框"
          />
        </label>
        <span className="projects-toolbar__sort" aria-label="按更新时间降序排序">
          按更新时间降序
        </span>
      </section>

      <section className="projects-list" aria-label="项目列表区域">
        {loading && (
          <p className="projects-list__loading" role="status">
            加载中…
          </p>
        )}

        {!loading && error && (
          <div className="projects-list__error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => void loadProjects()}>
              重试
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <div className="projects-list__empty" role="status">
            <p>暂无已登记项目</p>
            <p className="projects-list__empty-hint">
              可通过「新建项目」登记第一个项目。
            </p>
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <ProjectListTable items={items} />
        )}
      </section>
    </main>
  );
}
