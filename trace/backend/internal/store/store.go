package store

import (
	"net"
	"sort"
	"strings"
	"sync"
	"time"
)

// TelemetryRecord is the JSON payload accepted from Kprobe and Conduit.
type TelemetryRecord struct {
	SourceService      string    `json:"source_service"`
	DestinationService string    `json:"destination_service"`
	ClusterID          string    `json:"cluster_id,omitempty"`
	Leg                string    `json:"leg,omitempty"`
	Verdict            string    `json:"verdict,omitempty"`
	LatencyMs          float64   `json:"latency_ms,omitempty"`
	TLSVerified        bool      `json:"tls_verified"`
	StatusCode         int       `json:"status_code,omitempty"`
	ErrorReason        string    `json:"error_reason,omitempty"`
	Timestamp          time.Time `json:"timestamp,omitempty"`
	// Extended optional fields emitted by newer agent versions.
	Protocol  string `json:"protocol,omitempty"`   // tcp | http | grpc | https
	RequestID string `json:"request_id,omitempty"` // correlation / trace id
	SourceIP  string `json:"source_ip,omitempty"`  // raw source IP fallback for service name
	DestIP    string `json:"dest_ip,omitempty"`    // raw dest IP fallback for service name
	BytesIn   int64  `json:"bytes_in,omitempty"`
	BytesOut  int64  `json:"bytes_out,omitempty"`
}

type Summary struct {
	TotalRequests  int64     `json:"total_requests"`
	Allowed        int64     `json:"allowed"`
	Denied         int64     `json:"denied"`
	TLSFailures    int64     `json:"tls_failures"`
	Errors         int64     `json:"errors"`
	ActiveEdges    int       `json:"active_edges"`
	ActiveServices int       `json:"active_services"`
	GeneratedAt    time.Time `json:"generated_at"`
}

type Node struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	ClusterID string `json:"cluster_id,omitempty"`
}

type Edge struct {
	Source        string    `json:"source"`
	Target        string    `json:"target"`
	ClusterID     string    `json:"cluster_id,omitempty"`
	Leg           string    `json:"leg"`
	Requests      int64     `json:"requests"`
	AllowCount    int64     `json:"allow_count"`
	DenyCount     int64     `json:"deny_count"`
	TLSRejects    int64     `json:"tls_rejects"`
	ErrorCount    int64     `json:"error_count"`
	P50Ms         float64   `json:"p50_ms"`
	P95Ms         float64   `json:"p95_ms"`
	P99Ms         float64   `json:"p99_ms"`
	LastLatencyMs float64   `json:"last_latency_ms"`
	LastSeen      time.Time `json:"last_seen"`
}

type Topology struct {
	Nodes       []Node    `json:"nodes"`
	Edges       []Edge    `json:"edges"`
	GeneratedAt time.Time `json:"generated_at"`
}

type Event struct {
	SourceService      string    `json:"source_service"`
	DestinationService string    `json:"destination_service"`
	ClusterID          string    `json:"cluster_id,omitempty"`
	Leg                string    `json:"leg"`
	Verdict            string    `json:"verdict"`
	ErrorReason        string    `json:"error_reason,omitempty"`
	StatusCode         int       `json:"status_code,omitempty"`
	LatencyMs          float64   `json:"latency_ms,omitempty"`
	Timestamp          time.Time `json:"timestamp"`
	// Extended — present when emitted by the agent.
	Protocol  string `json:"protocol,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	BytesIn   int64  `json:"bytes_in,omitempty"`
	BytesOut  int64  `json:"bytes_out,omitempty"`
}

// PerformanceEdge carries per-path latency and throughput statistics.
type PerformanceEdge struct {
	Source    string    `json:"source"`
	Target    string    `json:"target"`
	Leg       string    `json:"leg"`
	Requests  int64     `json:"requests"`
	P50Ms     float64   `json:"p50_ms"`
	P95Ms     float64   `json:"p95_ms"`
	P99Ms     float64   `json:"p99_ms"`
	MinMs     float64   `json:"min_ms"`
	MaxMs     float64   `json:"max_ms"`
	AvgMs     float64   `json:"avg_ms"`
	BytesIn   int64     `json:"bytes_in"`
	BytesOut  int64     `json:"bytes_out"`
	ErrorRate float64   `json:"error_rate"` // (deny+tls+error)/requests × 100
	LastSeen  time.Time `json:"last_seen"`
}

// PerformanceReport is the payload returned by /api/v1/perf.
type PerformanceReport struct {
	Edges       []PerformanceEdge `json:"edges"`
	GeneratedAt time.Time         `json:"generated_at"`
}

// EventQuery filters the events returned by Store.Events.
type EventQuery struct {
	Service string // filter by source or destination name; empty = all
	Verdict string // filter by verdict; empty or "all" = all verdicts
	Limit   int    // max results; <= 0 defaults to 200, capped at 1000
}

type nodeState struct {
	id        string
	clusterID string
}

type edgeState struct {
	source        string
	target        string
	clusterID     string
	leg           string
	requests      int64
	allowCount    int64
	denyCount     int64
	tlsRejects    int64
	errorCount    int64
	lastLatencyMs float64
	lastSeen      time.Time
	latencies     []float64
	bytesIn       int64
	bytesOut      int64
}

// Store keeps an in-memory view of current service topology and recent events.
type Store struct {
	mu        sync.RWMutex
	nodes     map[string]*nodeState
	edges     map[string]*edgeState
	events    []Event
	maxEvents int
	summary   Summary
}

func New(maxEvents int) *Store {
	if maxEvents <= 0 {
		maxEvents = 500
	}
	return &Store{
		nodes:     make(map[string]*nodeState),
		edges:     make(map[string]*edgeState),
		events:    make([]Event, 0, maxEvents),
		maxEvents: maxEvents,
	}
}

// NormalizeRecord fills in default values. When source_service or
// destination_service is blank or "unknown", it falls back to the raw IP
// so that destination nodes are always identifiable in the topology.
func NormalizeRecord(r TelemetryRecord) TelemetryRecord {
	r.SourceService = normalizeServiceName(r.SourceService, r.SourceIP)
	r.DestinationService = normalizeServiceName(r.DestinationService, r.DestIP)
	if strings.TrimSpace(r.Leg) == "" {
		r.Leg = "intra_cluster"
	}
	if strings.TrimSpace(r.Verdict) == "" {
		r.Verdict = "allow"
	}
	if r.Timestamp.IsZero() {
		r.Timestamp = time.Now().UTC()
	}
	return r
}

// normalizeServiceName returns a stable service identifier. Falls back to the
// raw IP (port stripped) when the service name is absent or generic.
func normalizeServiceName(name, ip string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || strings.EqualFold(trimmed, "unknown") {
		if ip != "" {
			if host, _, err := net.SplitHostPort(ip); err == nil {
				return host
			}
			return ip
		}
		return "unknown"
	}
	return trimmed
}

// AddRecord normalizes the record, updates all counters and topology state,
// appends to the event log (every verdict, not just failures), and returns the
// normalized form so the caller can use it for Prometheus labels.
func (s *Store) AddRecord(record TelemetryRecord) TelemetryRecord {
	r := NormalizeRecord(record)

	s.mu.Lock()
	defer s.mu.Unlock()

	s.summary.TotalRequests++
	s.summary.GeneratedAt = time.Now().UTC()

	s.nodes[r.SourceService] = &nodeState{id: r.SourceService, clusterID: r.ClusterID}
	s.nodes[r.DestinationService] = &nodeState{id: r.DestinationService, clusterID: r.ClusterID}

	key := r.SourceService + "|" + r.DestinationService + "|" + r.Leg
	edge, ok := s.edges[key]
	if !ok {
		edge = &edgeState{
			source:    r.SourceService,
			target:    r.DestinationService,
			clusterID: r.ClusterID,
			leg:       r.Leg,
			latencies: make([]float64, 0, 128),
		}
		s.edges[key] = edge
	}

	edge.requests++
	edge.lastSeen = r.Timestamp
	if r.LatencyMs > 0 {
		edge.lastLatencyMs = r.LatencyMs
		edge.latencies = append(edge.latencies, r.LatencyMs)
		if len(edge.latencies) > 512 {
			edge.latencies = edge.latencies[len(edge.latencies)-512:]
		}
	}
	edge.bytesIn += r.BytesIn
	edge.bytesOut += r.BytesOut

	switch r.Verdict {
	case "deny":
		s.summary.Denied++
		edge.denyCount++
	case "tls_reject":
		s.summary.TLSFailures++
		edge.tlsRejects++
	case "error":
		s.summary.Errors++
		edge.errorCount++
	default:
		s.summary.Allowed++
		edge.allowCount++
	}

	s.summary.ActiveEdges = len(s.edges)
	s.summary.ActiveServices = len(s.nodes)

	// Every record goes into the log — the UI decides what to show.
	s.appendEventLocked(r)

	return r
}

func (s *Store) appendEventLocked(r TelemetryRecord) {
	s.events = append([]Event{{
		SourceService:      r.SourceService,
		DestinationService: r.DestinationService,
		ClusterID:          r.ClusterID,
		Leg:                r.Leg,
		Verdict:            r.Verdict,
		ErrorReason:        r.ErrorReason,
		StatusCode:         r.StatusCode,
		LatencyMs:          r.LatencyMs,
		Timestamp:          r.Timestamp,
		Protocol:           r.Protocol,
		RequestID:          r.RequestID,
		BytesIn:            r.BytesIn,
		BytesOut:           r.BytesOut,
	}}, s.events...)
	if len(s.events) > s.maxEvents {
		s.events = s.events[:s.maxEvents]
	}
}

func (s *Store) Summary() Summary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.summary
}

func (s *Store) Topology() Topology {
	s.mu.RLock()
	defer s.mu.RUnlock()

	nodes := make([]Node, 0, len(s.nodes))
	for _, node := range s.nodes {
		nodes = append(nodes, Node{ID: node.id, Label: node.id, ClusterID: node.clusterID})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })

	edges := make([]Edge, 0, len(s.edges))
	for _, edge := range s.edges {
		edges = append(edges, Edge{
			Source:        edge.source,
			Target:        edge.target,
			ClusterID:     edge.clusterID,
			Leg:           edge.leg,
			Requests:      edge.requests,
			AllowCount:    edge.allowCount,
			DenyCount:     edge.denyCount,
			TLSRejects:    edge.tlsRejects,
			ErrorCount:    edge.errorCount,
			P50Ms:         percentile(edge.latencies, 0.50),
			P95Ms:         percentile(edge.latencies, 0.95),
			P99Ms:         percentile(edge.latencies, 0.99),
			LastLatencyMs: edge.lastLatencyMs,
			LastSeen:      edge.lastSeen,
		})
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Source == edges[j].Source {
			return edges[i].Target < edges[j].Target
		}
		return edges[i].Source < edges[j].Source
	})

	return Topology{Nodes: nodes, Edges: edges, GeneratedAt: time.Now().UTC()}
}

// Events returns a filtered, paginated slice of the event log (newest-first).
func (s *Store) Events(q EventQuery) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()

	limit := q.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}

	out := make([]Event, 0, limit)
	for _, event := range s.events {
		if len(out) >= limit {
			break
		}
		if q.Service != "" && event.SourceService != q.Service && event.DestinationService != q.Service {
			continue
		}
		if q.Verdict != "" && q.Verdict != "all" && event.Verdict != q.Verdict {
			continue
		}
		out = append(out, event)
	}
	return out
}

// Performance returns per-path latency and throughput statistics sorted by p99 descending.
func (s *Store) Performance() PerformanceReport {
	s.mu.RLock()
	defer s.mu.RUnlock()

	edges := make([]PerformanceEdge, 0, len(s.edges))
	for _, edge := range s.edges {
		issues := edge.denyCount + edge.tlsRejects + edge.errorCount
		errorRate := 0.0
		if edge.requests > 0 {
			errorRate = float64(issues) / float64(edge.requests) * 100.0
		}
		edges = append(edges, PerformanceEdge{
			Source:    edge.source,
			Target:    edge.target,
			Leg:       edge.leg,
			Requests:  edge.requests,
			P50Ms:     percentile(edge.latencies, 0.50),
			P95Ms:     percentile(edge.latencies, 0.95),
			P99Ms:     percentile(edge.latencies, 0.99),
			MinMs:     minSlice(edge.latencies),
			MaxMs:     maxSlice(edge.latencies),
			AvgMs:     avgSlice(edge.latencies),
			BytesIn:   edge.bytesIn,
			BytesOut:  edge.bytesOut,
			ErrorRate: errorRate,
			LastSeen:  edge.lastSeen,
		})
	}
	sort.Slice(edges, func(i, j int) bool {
		return edges[i].P99Ms > edges[j].P99Ms
	})
	return PerformanceReport{Edges: edges, GeneratedAt: time.Now().UTC()}
}

func percentile(values []float64, pct float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := append([]float64(nil), values...)
	sort.Float64s(cp)
	idx := int(float64(len(cp)-1) * pct)
	if idx < 0 {
		idx = 0
	}
	if idx >= len(cp) {
		idx = len(cp) - 1
	}
	return cp[idx]
}

func minSlice(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	min := values[0]
	for _, v := range values[1:] {
		if v < min {
			min = v
		}
	}
	return min
}

func maxSlice(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	max := values[0]
	for _, v := range values[1:] {
		if v > max {
			max = v
		}
	}
	return max
}

func avgSlice(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}
