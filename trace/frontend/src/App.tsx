import { useEffect, useMemo, useState } from 'react';
import { EventFeed } from './components/EventFeed';
import { ServiceGraph } from './components/ServiceGraph';
import { TrafficSummary } from './components/TrafficSummary';
import {
  fetchEvents,
  fetchSummary,
  fetchTopology,
  type EventItem,
  type Summary,
  type Topology,
  type TopologyEdge,
} from './lib/api';

type ViewMode = 'application' | 'crossCluster' | 'policy' | 'platform';

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

const viewOptions: Array<{ id: ViewMode; label: string; description: string }> = [
  {
    id: 'application',
    label: 'App traffic',
    description: 'Hide mesh and cluster chatter so user journeys stay readable.',
  },
  {
    id: 'crossCluster',
    label: 'Cross-cluster',
    description: 'Show only calls that traverse cluster boundaries.',
  },
  {
    id: 'policy',
    label: 'Risk events',
    description: 'Focus on denials, TLS failures, and delivery problems.',
  },
  {
    id: 'platform',
    label: 'Platform',
    description: 'Include mesh internals and infrastructure traffic when needed.',
  },
];

function isPlatformService(name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return [
    'trace',
    'sigil',
    'kprobe',
    'conduit',
    'kindnet',
    'coredns',
    'prometheus',
    'grafana',
    'metrics-server',
    'unknown',
  ].some((keyword) => normalized === keyword || normalized.startsWith(`${keyword}-`) || normalized.includes(keyword)) || normalized.startsWith('kube-');
}

function matchesView(edge: TopologyEdge, viewMode: ViewMode) {
  const includesPlatform = isPlatformService(edge.source) || isPlatformService(edge.target);

  switch (viewMode) {
    case 'application':
      return !includesPlatform;
    case 'crossCluster':
      return edge.leg === 'cross_cluster' && !includesPlatform;
    case 'policy':
      return edge.deny_count > 0 || edge.tls_rejects > 0 || edge.error_count > 0;
    case 'platform':
    default:
      return true;
  }
}

function buildSummary(edges: TopologyEdge[]): Summary {
  const services = new Set<string>();
  let allowed = 0;
  let denied = 0;
  let tlsFailures = 0;
  let errors = 0;
  let totalRequests = 0;

  for (const edge of edges) {
    services.add(edge.source);
    services.add(edge.target);
    totalRequests += edge.requests;
    allowed += edge.allow_count;
    denied += edge.deny_count;
    tlsFailures += edge.tls_rejects;
    errors += edge.error_count;
  }

  return {
    total_requests: totalRequests,
    allowed,
    denied,
    tls_failures: tlsFailures,
    errors,
    active_edges: edges.length,
    active_services: services.size,
    generated_at: new Date().toISOString(),
  };
}

function formatTimestamp(value?: string) {
  if (!value) {
    return 'awaiting traffic';
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? 'awaiting traffic'
    : timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function App() {
  const [summary, setSummary] = useState<Summary>(emptySummary);
  const [topology, setTopology] = useState<Topology>(emptyTopology);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [error, setError] = useState<string>('');
  const [viewMode, setViewMode] = useState<ViewMode>('application');
  const [focusService, setFocusService] = useState<string>('all');

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

  const serviceOptions = useMemo(() => {
    const candidates = viewMode === 'platform'
      ? topology.nodes
      : topology.nodes.filter((node) => !isPlatformService(node.id));

    return candidates
      .map((node) => node.id)
      .filter((value, index, items) => items.indexOf(value) === index)
      .sort((a, b) => a.localeCompare(b));
  }, [topology.nodes, viewMode]);

  useEffect(() => {
    if (focusService !== 'all' && !serviceOptions.includes(focusService)) {
      setFocusService('all');
    }
  }, [focusService, serviceOptions]);

  const visibleEdges = useMemo(() => {
    return topology.edges
      .filter((edge) => matchesView(edge, viewMode))
      .filter((edge) => focusService === 'all' || edge.source === focusService || edge.target === focusService)
      .sort((a, b) => b.requests - a.requests);
  }, [topology.edges, viewMode, focusService]);

  const visibleNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const edge of visibleEdges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    return ids;
  }, [visibleEdges]);

  const visibleTopology = useMemo<Topology>(() => ({
    nodes: topology.nodes
      .filter((node) => visibleNodeIds.has(node.id))
      .sort((a, b) => a.label.localeCompare(b.label)),
    edges: visibleEdges,
    generated_at: topology.generated_at,
  }), [topology.nodes, topology.generated_at, visibleEdges, visibleNodeIds]);

  const visibleSummary = useMemo(() => buildSummary(visibleEdges), [visibleEdges]);

  const visibleEvents = useMemo(() => {
    return events.filter((event) => {
      const serviceMatch = focusService === 'all'
        || event.source_service === focusService
        || event.destination_service === focusService;
      const platformMatch = viewMode === 'platform'
        || (!isPlatformService(event.source_service) && !isPlatformService(event.destination_service));
      const crossClusterMatch = viewMode !== 'crossCluster' || event.leg === 'cross_cluster';
      return serviceMatch && platformMatch && crossClusterMatch;
    });
  }, [events, focusService, viewMode]);

  const activeView = viewOptions.find((option) => option.id === viewMode) ?? viewOptions[0];
  const topJourney = visibleEdges[0];
  const heroDetail = topJourney
    ? `${topJourney.requests} requests · p95 ${topJourney.p95_ms.toFixed(1)} ms · ${topJourney.leg === 'cross_cluster' ? 'cross-cluster' : 'in-cluster'}`
    : 'Generate traffic from the validator demo to populate this view.';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand-kicker">MeshLite</div>
          <div className="brand">Trace</div>
          <p className="brand-copy">Application-first visibility for service journeys.</p>
        </div>

        <section className="sidebar-section">
          <div className="sidebar-label">Views</div>
          <div className="sidebar-nav">
            {viewOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`sidebar-button ${viewMode === option.id ? 'active' : ''}`}
                onClick={() => setViewMode(option.id)}
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="sidebar-section">
          <div className="sidebar-label">Focus service</div>
          <div className="service-list">
            <button
              type="button"
              className={`service-chip ${focusService === 'all' ? 'active' : ''}`}
              onClick={() => setFocusService('all')}
            >
              All visible services
            </button>
            {serviceOptions.slice(0, 12).map((service) => (
              <button
                key={service}
                type="button"
                className={`service-chip ${focusService === service ? 'active' : ''}`}
                onClick={() => setFocusService(service)}
              >
                {service}
              </button>
            ))}
          </div>
        </section>

        <div className="sidebar-note">
          By default Trace hides mesh internals so same-cluster and cross-cluster application journeys stand out immediately.
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <h1>Service journey dashboard</h1>
            <p>{activeView.description}</p>
          </div>
          <div className="topbar-status">
            <span className="status-dot" />
            Data refreshed {formatTimestamp(summary.generated_at || topology.generated_at)}
          </div>
        </header>

        {error ? <div className="error-banner">Trace API error: {error}</div> : null}

        <section className="hero-strip">
          <div className="hero-card">
            <span className="eyebrow">Current lens</span>
            <strong>{activeView.label}</strong>
            <p>{activeView.description}</p>
          </div>
          <div className="hero-card">
            <span className="eyebrow">Focus</span>
            <strong>{focusService === 'all' ? 'All visible services' : focusService}</strong>
            <p>{visibleSummary.active_edges} active journeys across {visibleSummary.active_services} services.</p>
          </div>
          <div className="hero-card emphasis">
            <span className="eyebrow">Top journey</span>
            <strong>{topJourney ? `${topJourney.source} → ${topJourney.target}` : 'No active journeys yet'}</strong>
            <p>{heroDetail}</p>
          </div>
        </section>

        {viewMode !== 'platform' ? (
          <div className="view-banner">
            Platform and cluster noise is hidden in this view. Switch to <strong>Platform</strong> if you want to inspect internal mesh traffic.
          </div>
        ) : null}

        <TrafficSummary summary={visibleSummary} edges={visibleTopology.edges} viewLabel={activeView.label} />

        <div className="layout-grid">
          <ServiceGraph
            topology={visibleTopology}
            viewLabel={activeView.label}
            focusService={focusService === 'all' ? undefined : focusService}
          />
          <EventFeed
            events={visibleEvents}
            edges={visibleTopology.edges}
            focusService={focusService === 'all' ? undefined : focusService}
          />
        </div>
      </main>
    </div>
  );
}
