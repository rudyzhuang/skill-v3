import type { PipelineStageRow } from '../api/pipeline';

interface PipelineStageTableProps {
  stages: PipelineStageRow[];
  dataStatus: 'ok' | 'empty' | 'partial';
}

export function PipelineStageTable({ stages, dataStatus }: PipelineStageTableProps) {
  if (stages.length === 0) {
    return (
      <section className="pipeline-panel" aria-label="流水线阶段表">
        <h2>流水线阶段</h2>
        <p className="pipeline-panel__empty" role="status">
          {dataStatus === 'empty'
            ? '尚未同步流水线数据，阶段表暂无内容。'
            : '暂无阶段数据。'}
        </p>
      </section>
    );
  }

  return (
    <section className="pipeline-panel" aria-label="流水线阶段表">
      <h2>流水线阶段</h2>
      <table className="pipeline-table">
        <thead>
          <tr>
            <th scope="col">阶段标识</th>
            <th scope="col">名称</th>
            <th scope="col">状态</th>
            <th scope="col">开始时间</th>
            <th scope="col">完成时间</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => (
            <tr key={stage.id}>
              <td>{stage.id}</td>
              <td>{stage.name}</td>
              <td>{stage.status}</td>
              <td>{stage.started_at ?? '—'}</td>
              <td>{stage.completed_at ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
