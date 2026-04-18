import { useState } from 'react';
import type { EventItem } from '../lib/api';
import { formatLatencyMs, formatTimestamp, latencyClass } from '../lib/utils';

const VERDICTS = ['all', 'allow', 'deny', 'tls_reject', 'error'] as const;
type VerdictFilter = (typeof VERDICTS)[number];

const PAGE_SIZE = 50;

type Props = {
  events: EventItem[];
};

export function LogViewer({ events }: Props) {
  const [verdict, setVerdict] = useState<VerdictFilter>('all');
  const [page, setPage] = useState(1);

  const filtered = verdict === 'all' ? events : events.filter((e) => e.verdict === verdict);
  const visible = filtered.slice(0, page * PAGE_SIZE);
  const remaining = filtered.length - visible.length;

  function handleFilter(v: VerdictFilter) {
    setVerdict(v);
    setPage(1);
  }

  return (
    <div className="panel log-panel">
      <div className="panel-header">
        <div>
          <h3>Request log</h3>
          <p className="panel-copy">Every observed request — newest first. Use verdict filters to drill down.</p>
        </div>
        <span className="panel-pill">{filtered.length.toLocaleString()} entries</span>
      </div>

      <div className="log-filters">
        {VERDICTS.map((v) => {
          const count = v === 'all' ? events.length : events.filter((e) => e.verdict === v).length;
          const tone = v === 'allow' ? 'ok' : v === 'all' ? '' : 'warn';
          return (
            <button
              key={v}
              type="button"
              className={`filter-chip ${tone} ${verdict === v ? 'active' : ''}`}
              onClick={() => handleFilter(v)}
            >
              {v === 'all' ? 'All' : v.replace('_', ' ')}
              <span className="chip-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="log-table-wrap">
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Source</th>
              <th>Destination</th>
              <th>Verdict</th>
              <th>Latency</th>
              <th>Leg</th>
              <th>Reason / Protocol</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-cell">No events match the current filter.</td>
              </tr>
            ) : (
              visible.map((event, i) => (
                <tr key={`${event.timestamp ?? ''}-${i}`} className={`log-row verdict-${event.verdict}`}>
                  <td className="log-time">{formatTimestamp(event.timestamp)}</td>
                  <td className="log-svc">{event.source_service}</td>
                  <td className="log-svc">{event.destination_service}</td>
                  <td>
                    <span className={`health-pill ${verdictTone(event.verdict)}`}>{event.verdict}</span>
                  </td>
                  <td className={`log-latency ${latencyClass(event.latency_ms)}`}>
                    {formatLatencyMs(event.latency_ms)}
                  </td>
                  <td>{event.leg === 'cross_cluster' ? 'Cross-cluster' : 'In-cluster'}</td>
                  <td className="log-reason">
                    {event.error_reason
                      ? event.error_reason
                      : event.protocol
                        ? event.protocol.toUpperCase()
                        : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {remaining > 0 && (
        <div className="load-more-wrap">
          <button type="button" className="load-more" onClick={() => setPage((p) => p + 1)}>
            Load more ({remaining.toLocaleString()} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

function verdictTone(verdict: string) {
  switch (verdict) {
    case 'deny': return 'warn';
    case 'tls_reject':
    case 'error': return 'danger';
    default: return 'ok';
  }
}
