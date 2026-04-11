import type { EventItem, TopologyEdge } from '../lib/api';

type Props = {
  events: EventItem[];
  edges: TopologyEdge[];
  focusService?: string;
};

function formatTimestamp(value?: string) {
  if (!value) {
    return 'just now';
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? 'just now'
    : timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function verdictTone(verdict: string) {
  switch (verdict) {
    case 'deny':
      return 'warn';
    case 'tls_reject':
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
}

export function EventFeed({ events, edges, focusService }: Props) {
  const recentJourneys = [...edges]
    .sort((a, b) => {
      const next = new Date(b.last_seen || 0).getTime();
      const prev = new Date(a.last_seen || 0).getTime();
      return next - prev || b.requests - a.requests;
    })
    .slice(0, 5);

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h3>Operational watchlist</h3>
          <p className="panel-copy">
            {focusService ? `Signals related to ${focusService}.` : 'Signals and recent journeys for the current view.'}
          </p>
        </div>
        <span className="panel-pill">{events.length > 0 ? `${events.length} flagged` : 'Healthy'}</span>
      </div>

      <div className="event-section">
        <h4 className="event-section-title">Policy / TLS issues</h4>
        <div className="event-list">
          {events.length === 0 ? (
            <div className="empty-state compact">No policy, TLS, or delivery issues recorded in this view.</div>
          ) : (
            events.slice(0, 6).map((event, index) => (
              <div className="event-item" key={`${event.source_service}-${event.destination_service}-${index}`}>
                <div className="event-main">
                  <strong>{event.source_service}</strong> → <strong>{event.destination_service}</strong>
                  <span className={`health-pill ${verdictTone(event.verdict)}`}>{event.verdict}</span>
                </div>
                <div className="event-meta">
                  <span>{event.leg === 'cross_cluster' ? 'Cross-cluster' : 'In-cluster'}</span>
                  {event.error_reason ? <span>{event.error_reason}</span> : null}
                  <span>{formatTimestamp(event.timestamp)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="event-section">
        <h4 className="event-section-title">Recently active journeys</h4>
        <div className="event-list">
          {recentJourneys.length === 0 ? (
            <div className="empty-state compact">No service journey activity recorded yet.</div>
          ) : (
            recentJourneys.map((edge) => (
              <div className="event-item journey-item" key={`${edge.source}-${edge.target}-${edge.leg}`}>
                <div className="event-main">
                  <strong>{edge.source}</strong> → <strong>{edge.target}</strong>
                  <span className={`health-pill ${edge.leg === 'cross_cluster' ? 'info' : 'ok'}`}>
                    {edge.leg === 'cross_cluster' ? 'Cross-cluster' : 'In-cluster'}
                  </span>
                </div>
                <div className="event-meta">
                  <span>{edge.requests} requests</span>
                  <span>p95 {edge.p95_ms.toFixed(1)} ms</span>
                  <span>{formatTimestamp(edge.last_seen)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
