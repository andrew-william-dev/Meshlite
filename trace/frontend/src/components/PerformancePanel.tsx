import type { PerformanceEdge } from '../lib/api';
import { formatLatencyMs, formatTimestamp, latencyClass } from '../lib/utils';

type Props = {
  edges: PerformanceEdge[];
};

function errorRateClass(rate: number): string {
  if (rate === 0) return 'ok';
  if (rate < 5) return 'warn';
  return 'danger';
}

export function PerformancePanel({ edges }: Props) {
  return (
    <div className="panel perf-panel">
      <div className="panel-header">
        <div>
          <h3>Performance by path</h3>
          <p className="panel-copy">Latency percentiles per service pair, sorted by worst p99.</p>
        </div>
        <span className="panel-pill">{edges.length} paths</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Path</th>
              <th>Category</th>
              <th>Requests</th>
              <th>p50</th>
              <th>p95</th>
              <th>p99</th>
              <th>Avg</th>
              <th>Error rate</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {edges.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-cell">No performance data yet — send traffic to populate this view.</td>
              </tr>
            ) : (
              edges.map((edge) => (
                <tr key={`${edge.source}-${edge.target}-${edge.leg}`}>
                  <td>{edge.source} → {edge.target}</td>
                  <td>{edge.leg === 'cross_cluster' ? 'Cross-cluster' : 'In-cluster'}</td>
                  <td>{edge.requests.toLocaleString()}</td>
                  <td className={latencyClass(edge.p50_ms)}>{formatLatencyMs(edge.p50_ms)}</td>
                  <td className={latencyClass(edge.p95_ms)}>{formatLatencyMs(edge.p95_ms)}</td>
                  <td className={latencyClass(edge.p99_ms)}>{formatLatencyMs(edge.p99_ms)}</td>
                  <td className={latencyClass(edge.avg_ms)}>{formatLatencyMs(edge.avg_ms)}</td>
                  <td>
                    <span className={`health-pill ${errorRateClass(edge.error_rate)}`}>
                      {edge.error_rate.toFixed(1)}%
                    </span>
                  </td>
                  <td>{formatTimestamp(edge.last_seen)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
