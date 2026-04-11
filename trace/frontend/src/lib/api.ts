export type Summary = {
  total_requests: number;
  allowed: number;
  denied: number;
  tls_failures: number;
  errors: number;
  active_edges: number;
  active_services: number;
  generated_at?: string;
};

export type TopologyNode = {
  id: string;
  label: string;
  cluster_id?: string;
};

export type TopologyEdge = {
  source: string;
  target: string;
  cluster_id?: string;
  leg: string;
  requests: number;
  allow_count: number;
  deny_count: number;
  tls_rejects: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  last_latency_ms: number;
  last_seen?: string;
};

export type Topology = {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generated_at?: string;
};

export type EventItem = {
  source_service: string;
  destination_service: string;
  cluster_id?: string;
  leg: string;
  verdict: string;
  error_reason?: string;
  status_code?: number;
  latency_ms?: number;
  timestamp?: string;
};

async function getJSON<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const fetchSummary = () => getJSON<Summary>('/api/v1/summary');
export const fetchTopology = () => getJSON<Topology>('/api/v1/topology');
export const fetchEvents = () => getJSON<EventItem[]>('/api/v1/events');
