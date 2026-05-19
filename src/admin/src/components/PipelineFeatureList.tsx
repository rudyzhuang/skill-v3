import type { PipelineFeatureRow } from '../api/pipeline';

interface PipelineFeatureListProps {
  features: PipelineFeatureRow[];
  dataStatus: 'ok' | 'empty' | 'partial';
}

export function PipelineFeatureList({ features, dataStatus }: PipelineFeatureListProps) {
  if (features.length === 0) {
    return (
      <section className="pipeline-panel" aria-label="feature 流水线进度区">
        <h2>Feature 流水线</h2>
        <p className="pipeline-panel__empty" role="status">
          {dataStatus === 'empty'
            ? '尚未同步流水线，暂无 feature 进度。'
            : '暂无 feature 数据。'}
        </p>
      </section>
    );
  }

  return (
    <section className="pipeline-panel" aria-label="feature 流水线进度区">
      <h2>Feature 流水线</h2>
      <table className="pipeline-table">
        <thead>
          <tr>
            <th scope="col">feature_id</th>
            <th scope="col">名称</th>
            <th scope="col">阶段</th>
            <th scope="col">状态</th>
            <th scope="col">当前 stage</th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <tr key={feature.feature_id}>
              <td>{feature.feature_id}</td>
              <td>{feature.name}</td>
              <td>{feature.phase ?? '—'}</td>
              <td>{feature.status}</td>
              <td>{feature.current_stage ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
