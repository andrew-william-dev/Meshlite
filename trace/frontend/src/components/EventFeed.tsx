import type { EventItem } from '../lib/api';

type Props = {
  events: EventItem[];
};

export function EventFeed({ events }: Props) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h3>Recent policy / TLS events</h3>
        <span className="panel-pill">Live feed</span>
      </div>

      <div className="event-list">
        {events.length === 0 ? (
          <div className="empty-state compact">No denial or TLS-failure events yet.</div>
        ) : (
          events.slice(0, 12).map((event, index) => (
            <div className="event-item" key={`${event.source_service}-${event.destination_service}-${index}`}>
              <div>
                <strong>{event.source_service}</strong> → <strong>{event.destination_service}</strong>
              </div>
              <div className="event-meta">
                <span>{event.verdict}</span>
                <span>{event.leg}</span>
                {event.error_reason ? <span>{event.error_reason}</span> : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
