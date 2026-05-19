import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  fetchPipelineDashboard,
  type PipelineDashboardResponse,
} from '../api/pipeline';
import { PipelineBlockingSummary } from '../components/PipelineBlockingSummary';
import { PipelineCurrentStageBanner } from '../components/PipelineCurrentStageBanner';
import { PipelineFeatureList } from '../components/PipelineFeatureList';
import { PipelineLogTail } from '../components/PipelineLogTail';
import { PipelineStageTable } from '../components/PipelineStageTable';

function displayProjectName(data: PipelineDashboardResponse): string {
  return data.project.name_zh?.trim() || data.project.name_en;
}

export function ProjectDashboardPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [data, setData] = useState<PipelineDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setError('缺少项目 ID');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPipelineDashboard(projectId);
      setData(result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setError('项目不存在');
        } else {
          setError(err.message || '加载看板失败，请稍后重试');
        }
      } else {
        setError('加载看板失败，请稍后重试');
      }
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pipeline-dashboard" aria-label="项目流水线看板主容器">
      <header className="pipeline-dashboard__header">
        <h1>项目流水线看板</h1>
        <Link to="/" className="pipeline-dashboard__back">
          返回项目列表
        </Link>
      </header>

      {loading && (
        <p className="pipeline-dashboard__loading" role="status">
          加载中…
        </p>
      )}

      {!loading && error && (
        <div className="pipeline-dashboard__error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <p className="pipeline-dashboard__project-name">
            {displayProjectName(data)}
            <span className="pipeline-dashboard__project-id">({data.project.id})</span>
          </p>

          {data.data_status === 'empty' && (
            <p className="pipeline-dashboard__unsynced" role="status">
              尚未同步流水线数据
            </p>
          )}

          <PipelineCurrentStageBanner
            currentStage={data.current_stage}
            lastCompletedStage={data.last_completed_stage}
            syncedAt={data.synced_at}
            dataStatus={data.data_status}
          />

          <div className="pipeline-dashboard__grid">
            <PipelineStageTable stages={data.stages} dataStatus={data.data_status} />
            <PipelineFeatureList features={data.features} dataStatus={data.data_status} />
            <PipelineBlockingSummary issues={data.blocking_issues} />
            <PipelineLogTail
              logTail={data.log_tail}
              truncated={data.meta?.truncated}
            />
          </div>
        </>
      )}
    </main>
  );
}
