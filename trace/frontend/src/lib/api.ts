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
  protocol?: string;
  request_id?: string;
  bytes_in?: number;
  bytes_out?: number;
};

export type PerformanceEdge = {
  source: string;
  target: string;
  leg: string;
  requests: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  avg_ms: number;
  bytes_in: number;
  bytes_out: number;
  error_rate: number;
  last_seen?: string;
};

export type PerformanceReport = {
  edges: PerformanceEdge[];
  generated_at?: string;
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
export const fetchPerformance = () => getJSON<PerformanceReport>('/api/v1/perf');

export function fetchEvents(params?: { service?: string; verdict?: string; limit?: number }): Promise<EventItem[]> {
  const qs = new URLSearchParams();
  if (params?.service) qs.set('service', params.service);
  if (params?.verdict) qs.set('verdict', params.verdict);
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return getJSON<EventItem[]>(`/api/v1/events${query ? `?${query}` : ''}`);
}
