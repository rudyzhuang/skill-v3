import type { PipelineBlockingIssue } from '../api/pipeline';

interface PipelineBlockingSummaryProps {
  issues: PipelineBlockingIssue[];
}

export function PipelineBlockingSummary({ issues }: PipelineBlockingSummaryProps) {
  return (
    <section className="pipeline-panel" aria-label="阻塞摘要列表区域">
      <h2>阻塞摘要</h2>
      {issues.length === 0 ? (
        <p className="pipeline-panel__empty pipeline-panel__no-block" role="status">
          无阻塞
        </p>
      ) : (
        <ul className="pipeline-blocking-list">
          {issues.map((issue, index) => (
            <li key={`${issue.stage ?? ''}-${issue.message}-${index}`}>
              <span className="pipeline-blocking-list__stage">
                {issue.stage ?? '—'}
              </span>
              <span className="pipeline-blocking-list__message">{issue.message}</span>
              {issue.severity && (
                <span className="pipeline-blocking-list__severity">{issue.severity}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
