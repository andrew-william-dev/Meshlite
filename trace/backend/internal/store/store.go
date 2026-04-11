package store

import (
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
		maxEvents = 200
	}
	return &Store{
		nodes:     make(map[string]*nodeState),
		edges:     make(map[string]*edgeState),
		events:    make([]Event, 0, maxEvents),
		maxEvents: maxEvents,
	}
}

func NormalizeRecord(r TelemetryRecord) TelemetryRecord {
	if strings.TrimSpace(r.SourceService) == "" {
		r.SourceService = "unknown"
	}
	if strings.TrimSpace(r.DestinationService) == "" {
		r.DestinationService = "unknown"
	}
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

func (s *Store) AddRecord(record TelemetryRecord) {
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
		if len(edge.latencies) > 256 {
			edge.latencies = edge.latencies[len(edge.latencies)-256:]
		}
	}

	switch r.Verdict {
	case "deny":
		s.summary.Denied++
		edge.denyCount++
		s.appendEventLocked(r)
	case "tls_reject":
		s.summary.TLSFailures++
		edge.tlsRejects++
		s.appendEventLocked(r)
	case "error":
		s.summary.Errors++
		edge.errorCount++
		s.appendEventLocked(r)
	default:
		s.summary.Allowed++
		edge.allowCount++
	}

	s.summary.ActiveEdges = len(s.edges)
	s.summary.ActiveServices = len(s.nodes)
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

func (s *Store) Events(filterService string) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if strings.TrimSpace(filterService) == "" {
		out := make([]Event, len(s.events))
		copy(out, s.events)
		return out
	}

	filtered := make([]Event, 0, len(s.events))
	for _, event := range s.events {
		if event.SourceService == filterService || event.DestinationService == filterService {
			filtered = append(filtered, event)
		}
	}
	return filtered
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
