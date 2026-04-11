import { useEffect, useState } from 'react';
import { EventFeed } from './components/EventFeed';
import { ServiceGraph } from './components/ServiceGraph';
import { TrafficSummary } from './components/TrafficSummary';
import { fetchEvents, fetchSummary, fetchTopology, type EventItem, type Summary, type Topology } from './lib/api';

const emptySummary: Summary = {
  total_requests: 0,
  allowed: 0,
  denied: 0,
  tls_failures: 0,
  errors: 0,
  active_edges: 0,
  active_services: 0,
};

const emptyTopology: Topology = {
  nodes: [],
  edges: [],
};

export function App() {
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [topology, setTopology] = useState<Topology>(emptyTopology);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      try {
        const [nextSummary, nextTopology, nextEvents] = await Promise.all([
          fetchSummary(),
          fetchTopology(),
          fetchEvents(),
        ]);
        if (!disposed) {
          setSummary(nextSummary);
          setTopology(nextTopology);
          setEvents(nextEvents);
          setError('');
        }
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : 'Failed to load Trace data');
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">MeshLite Trace</div>
        <nav>
          <a className="active">Overview</a>
          <a>Traffic</a>
          <a>Policy Events</a>
          <a>Certificates</a>
        </nav>
        <div className="sidebar-footnote">
          Rancher-inspired MVP UI for service-mesh operators.
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>Cluster Observability</h1>
            <p>Live service traffic, policy outcomes, and boundary telemetry.</p>
          </div>
          <div className="topbar-status">
            <span className="status-dot" />
            Trace API active
          </div>
        </header>

        {error ? <div className="error-banner">Trace API error: {error}</div> : null}

        <TrafficSummary summary={summary} edges={topology.edges} />

        <div className="layout-grid">
          <ServiceGraph topology={topology} />
          <EventFeed events={events} />
        </div>
      </main>
    </div>
  );
}
