interface PipelineCurrentStageBannerProps {
  currentStage: string | null;
  lastCompletedStage: string | null;
  syncedAt: string | null;
  dataStatus: 'ok' | 'empty' | 'partial';
}

function formatSyncedAt(iso: string | null): string {
  if (!iso) {
    return '—';
  }
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

export function PipelineCurrentStageBanner({
  currentStage,
  lastCompletedStage,
  syncedAt,
  dataStatus,
}: PipelineCurrentStageBannerProps) {
  return (
    <section className="pipeline-banner" aria-label="当前阶段横幅">
      <div className="pipeline-banner__main">
        <span className="pipeline-banner__label">当前阶段</span>
        <strong className="pipeline-banner__stage">
          {currentStage ?? (dataStatus === 'empty' ? '未同步' : '—')}
        </strong>
      </div>
      <div className="pipeline-banner__meta">
        <span>
          上一完成阶段：
          <strong>{lastCompletedStage ?? '—'}</strong>
        </span>
        <span>
          同步时间：
          <time dateTime={syncedAt ?? undefined}>{formatSyncedAt(syncedAt)}</time>
        </span>
      </div>
    </section>
  );
}
