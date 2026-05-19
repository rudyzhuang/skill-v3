import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AuthContext, type AuthContextValue } from '../context/AuthContext';
import * as pipelineApi from '../api/pipeline';
import { ProjectDashboardPage } from './ProjectDashboardPage';

function wrap(projectId = 'proj-1') {
  const value: AuthContextValue = {
    user: { id: 'u1', email: 'admin@example.com', role: 'admin' },
    loading: false,
    login: async () => {},
    logout: async () => {},
    refreshMe: async () => {},
  };
  return (
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/dashboard`]}>
        <Routes>
          <Route
            path="/projects/:projectId/dashboard"
            element={<ProjectDashboardPage />}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

const sampleDashboard: pipelineApi.PipelineDashboardResponse = {
  project: {
    id: 'proj-1',
    name_zh: '示例',
    name_en: 'Sample',
    status: 'active',
    client_targets: ['admin'],
  },
  current_stage: 'codegen',
  last_completed_stage: 'prd',
  stages: [{ id: 'setup', name: 'setup', status: 'completed', started_at: null, completed_at: null }],
  features: [
    {
      feature_id: 'FEAT-1',
      name: 'Feature 1',
      phase: 'mvp',
      status: 'running',
      current_stage: 'codegen',
      dependencies: [],
    },
  ],
  blocking_issues: [],
  log_tail: 'line1\nline2',
  data_status: 'ok',
  synced_at: '2026-05-19T10:00:00.000Z',
};

describe('ProjectDashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows loading then dashboard sections', async () => {
    vi.spyOn(pipelineApi, 'fetchPipelineDashboard').mockResolvedValue(sampleDashboard);

    render(wrap());

    expect(screen.getByText('加载中…')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByLabelText('项目流水线看板主容器')).toBeTruthy();
    });

    expect(screen.getByLabelText('当前阶段横幅')).toBeTruthy();
    expect(screen.getByLabelText('流水线阶段表')).toBeTruthy();
    expect(screen.getByLabelText('feature 流水线进度区')).toBeTruthy();
    expect(screen.getByLabelText('阻塞摘要列表区域')).toBeTruthy();
    expect(screen.getByText('无阻塞')).toBeTruthy();
    expect(screen.getByLabelText('最近日志 tail 只读展示区域')).toBeTruthy();
  });

  it('shows empty state when data_status is empty', async () => {
    vi.spyOn(pipelineApi, 'fetchPipelineDashboard').mockResolvedValue({
      ...sampleDashboard,
      data_status: 'empty',
      current_stage: null,
      last_completed_stage: null,
      stages: [],
      features: [],
      log_tail: '',
      synced_at: null,
    });

    render(wrap());

    await waitFor(() => {
      expect(screen.getByText('尚未同步流水线数据')).toBeTruthy();
    });
  });

  it('shows project not found error', async () => {
    vi.spyOn(pipelineApi, 'fetchPipelineDashboard').mockRejectedValue(
      new ApiError('项目不存在', 404),
    );

    render(wrap('missing'));

    await waitFor(() => {
      expect(screen.getByText('项目不存在')).toBeTruthy();
    });
  });

  it('shows retry on fetch failure', async () => {
    vi.spyOn(pipelineApi, 'fetchPipelineDashboard').mockRejectedValue(
      new ApiError('服务不可用', 503),
    );

    render(wrap());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    });
  });
});
