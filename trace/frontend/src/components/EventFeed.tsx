import type { EventItem } from '../lib/api';
import { formatTimestamp } from '../lib/utils';

type Props = {
  events: EventItem[];
  focusService?: string;
};

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

export function EventFeed({ events, focusService }: Props) {
  return (
    <div className={`panel${events.length > 0 ? ' panel-alert' : ''}`}>
      <div className="panel-header">
        <div>
          <h3>Operational watchlist</h3>
          <p className="panel-copy">
            {focusService ? `Policy and TLS signals for ${focusService}.` : 'Policy denials, TLS failures, and delivery errors.'}
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
            events.slice(0, 8).map((event, index) => (
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
    </div>
  );
}
