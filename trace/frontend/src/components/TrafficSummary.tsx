import type { Summary, TopologyEdge } from '../lib/api';

type Props = {
  summary: Summary;
  edges: TopologyEdge[];
  viewLabel: string;
};

function formatTimestamp(value?: string) {
  if (!value) {
    return 'Waiting for traffic';
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? 'Waiting for traffic'
    : timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getHealth(edge: TopologyEdge) {
  const issues = edge.deny_count + edge.tls_rejects + edge.error_count;
  if (issues === 0) {
    return { label: 'Healthy', className: 'ok' };
  }
  if (edge.deny_count > 0) {
    return { label: `${issues} blocked`, className: 'warn' };
  }
  return { label: `${issues} issues`, className: 'danger' };
}

export function TrafficSummary({ summary, edges, viewLabel }: Props) {
  const topEdges = [...edges].sort((a, b) => b.requests - a.requests).slice(0, 8);
  const crossClusterFlows = edges.filter((edge) => edge.leg === 'cross_cluster').length;
  const flaggedFlows = edges.filter((edge) => edge.deny_count > 0 || edge.tls_rejects > 0 || edge.error_count > 0).length;

  return (
    <>
      <div className="cards-grid">
        <MetricCard label="Requests in view" value={summary.total_requests} helper={`${summary.active_edges} active journeys`} />
        <MetricCard label="Allowed" value={summary.allowed} helper="Successful mesh decisions" tone="success" />
        <MetricCard label="Cross-cluster paths" value={crossClusterFlows} helper="Visible service boundaries" tone="info" />
        <MetricCard label="Attention needed" value={summary.denied + summary.tls_failures + summary.errors} helper={`${flaggedFlows} journeys with issues`} tone="warning" />
      </div>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>Top service journeys</h3>
            <p className="panel-copy">A readable view of the busiest paths in {viewLabel.toLowerCase()}.</p>
          </div>
          <span className="panel-pill">Active services: {summary.active_services}</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Journey</th>
                <th>Category</th>
                <th>Volume</th>
                <th>Latency profile</th>
                <th>Health</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {topEdges.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">No traffic recorded yet for this view.</td>
                </tr>
              ) : (
                topEdges.map((edge) => {
                  const health = getHealth(edge);
                  return (
                    <tr key={`${edge.source}-${edge.target}-${edge.leg}`}>
                      <td>{edge.source} → {edge.target}</td>
                      <td>{edge.leg === 'cross_cluster' ? 'Cross-cluster' : 'In-cluster'}</td>
                      <td>{edge.requests}</td>
                      <td>
                        p50 {edge.p50_ms.toFixed(1)} ms · p95 {edge.p95_ms.toFixed(1)} ms
                      </td>
                      <td>
                        <span className={`health-pill ${health.className}`}>{health.label}</span>
                      </td>
                      <td>{formatTimestamp(edge.last_seen)}</td>
                    </tr>
                  );
                })
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
  helper: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
};

function MetricCard({ label, value, helper, tone = 'default' }: MetricCardProps) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </div>
  );
}
