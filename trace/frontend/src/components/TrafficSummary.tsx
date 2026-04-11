import type { Summary, TopologyEdge } from '../lib/api';

type Props = {
  summary: Summary;
  edges: TopologyEdge[];
};

export function TrafficSummary({ summary, edges }: Props) {
  const topEdges = [...edges].sort((a, b) => b.requests - a.requests).slice(0, 6);

  return (
    <>
      <div className="cards-grid">
        <MetricCard label="Total requests" value={summary.total_requests} />
        <MetricCard label="Allowed" value={summary.allowed} tone="success" />
        <MetricCard label="Denied" value={summary.denied} tone="warning" />
        <MetricCard label="TLS failures" value={summary.tls_failures} tone="danger" />
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3>Traffic summary</h3>
          <span className="panel-pill">Active services: {summary.active_services}</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Flow</th>
                <th>Leg</th>
                <th>Requests</th>
                <th>p50</th>
                <th>p95</th>
                <th>p99</th>
                <th>Verdict mix</th>
              </tr>
            </thead>
            <tbody>
              {topEdges.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty-cell">No traffic recorded yet.</td>
                </tr>
              ) : (
                topEdges.map((edge) => (
                  <tr key={`${edge.source}-${edge.target}-${edge.leg}`}>
                    <td>{edge.source} → {edge.target}</td>
                    <td>{edge.leg}</td>
                    <td>{edge.requests}</td>
                    <td>{edge.p50_ms.toFixed(2)} ms</td>
                    <td>{edge.p95_ms.toFixed(2)} ms</td>
                    <td>{edge.p99_ms.toFixed(2)} ms</td>
                    <td>
                      ✅ {edge.allow_count} / ⚠️ {edge.deny_count} / ❌ {edge.tls_rejects + edge.error_count}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

type MetricCardProps = {
  label: string;
  value: number;
  tone?: 'default' | 'success' | 'warning' | 'danger';
};

function MetricCard({ label, value, tone = 'default' }: MetricCardProps) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
