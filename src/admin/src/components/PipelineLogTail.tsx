interface PipelineLogTailProps {
  logTail: string;
  truncated?: boolean;
}

export function PipelineLogTail({ logTail, truncated }: PipelineLogTailProps) {
  return (
    <section className="pipeline-panel" aria-label="最近日志 tail 只读展示区域">
      <h2>最近日志</h2>
      {truncated && (
        <p className="pipeline-panel__hint" role="note">
          日志已截断，仅展示最近部分。
        </p>
      )}
      {!logTail.trim() ? (
        <p className="pipeline-panel__empty" role="status">
          暂无日志输出。
        </p>
      ) : (
        <pre className="pipeline-log-tail">{logTail}</pre>
      )}
    </section>
  );
}
