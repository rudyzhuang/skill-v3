import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type AuthContextValue } from '../context/AuthContext';
import * as projectsApi from '../api/projects';
import { ProjectListPage } from './ProjectListPage';

function wrap(ui: React.ReactNode, auth: Partial<AuthContextValue> = {}) {
  const value: AuthContextValue = {
    user: { id: 'u1', email: 'admin@example.com', role: 'admin' },
    loading: false,
    login: async () => {},
    logout: async () => {},
    refreshMe: async () => {},
    ...auth,
  };
  return (
    <AuthContext.Provider value={value}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('ProjectListPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows loading then empty state when no projects', async () => {
    vi.spyOn(projectsApi, 'fetchProjects').mockResolvedValue({ items: [] });

    render(wrap(<ProjectListPage />));

    expect(screen.getByText('加载中…')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText(/暂无已登记项目/)).toBeTruthy();
    });
    expect(screen.queryByLabelText('项目列表表格')).toBeNull();
  });

  it('renders project table with dashboard link and new project entry', async () => {
    vi.spyOn(projectsApi, 'fetchProjects').mockResolvedValue({
      items: [
        {
          id: 'proj-abc',
          name_zh: '示例项目',
          name_en: 'Sample',
          status: 'active',
          client_targets: ['admin'],
          pipeline_summary: null,
          updated_at: '2026-05-01T10:00:00.000Z',
        },
      ],
    });

    render(wrap(<ProjectListPage />));

    await waitFor(() => {
      expect(screen.getByLabelText('项目列表表格')).toBeTruthy();
    });

    expect(screen.getByText('示例项目')).toBeTruthy();
    expect(screen.getByLabelText('登记状态：进行中')).toBeTruthy();
    const dashboardLink = screen.getByRole('link', { name: '查看看板' });
    expect(dashboardLink.getAttribute('href')).toBe(
      '/projects/proj-abc/dashboard',
    );
    expect(dashboardLink.getAttribute('target')).toBe('_blank');

    expect(screen.getByRole('link', { name: '新建项目' })).toBeTruthy();
  });

  it('shows readable error with retry on fetch failure', async () => {
    vi.spyOn(projectsApi, 'fetchProjects').mockRejectedValue(
      new ApiError('服务不可用', 503),
    );

    render(wrap(<ProjectListPage />));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByText('服务不可用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('hides new project link for operator role', async () => {
    vi.spyOn(projectsApi, 'fetchProjects').mockResolvedValue({ items: [] });

    render(
      wrap(<ProjectListPage />, {
        user: { id: 'op1', email: 'op@example.com', role: 'operator' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/暂无已登记项目/)).toBeTruthy();
    });
    expect(document.querySelector('.projects-page__new-btn')).toBeNull();
  });
});
