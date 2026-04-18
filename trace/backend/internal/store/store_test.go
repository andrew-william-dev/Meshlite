package store

import "testing"

func TestAddRecordUpdatesSummaryAndEvents(t *testing.T) {
	s := New(10)
	s.AddRecord(TelemetryRecord{
		SourceService:      "service-alpha",
		DestinationService: "service-beta",
		ClusterID:          "dev",
		Leg:                "intra_cluster",
		Verdict:            "allow",
		LatencyMs:          4.2,
	})
	s.AddRecord(TelemetryRecord{
		SourceService:      "service-beta",
		DestinationService: "service-alpha",
		ClusterID:          "dev",
		Leg:                "intra_cluster",
		Verdict:            "deny",
		ErrorReason:        "policy_denied",
	})

	summary := s.Summary()
	if summary.TotalRequests != 2 {
		t.Fatalf("expected 2 total requests, got %d", summary.TotalRequests)
	}
	if summary.Allowed != 1 {
		t.Fatalf("expected 1 allowed request, got %d", summary.Allowed)
	}
	if summary.Denied != 1 {
		t.Fatalf("expected 1 denied request, got %d", summary.Denied)
	}
	if got := len(s.Events(EventQuery{})); got != 2 {
		t.Fatalf("expected 2 stored events, got %d", got)
	}
}

func TestAllEventsStored(t *testing.T) {
	s := New(100)
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow"})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "deny"})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "tls_reject"})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "error"})
	if got := len(s.Events(EventQuery{})); got != 4 {
		t.Fatalf("expected all 4 events stored, got %d", got)
	}
}

func TestEventQueryVerdictFilter(t *testing.T) {
	s := New(100)
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow"})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "deny"})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow"})
	deny := s.Events(EventQuery{Verdict: "deny"})
	if len(deny) != 1 {
		t.Fatalf("expected 1 deny event, got %d", len(deny))
	}
	allow := s.Events(EventQuery{Verdict: "allow"})
	if len(allow) != 2 {
		t.Fatalf("expected 2 allow events, got %d", len(allow))
	}
}

func TestPerformanceReport(t *testing.T) {
	s := New(100)
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow", LatencyMs: 10})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "deny", LatencyMs: 50})
	report := s.Performance()
	if len(report.Edges) != 1 {
		t.Fatalf("expected 1 performance edge, got %d", len(report.Edges))
	}
	edge := report.Edges[0]
	if edge.Requests != 2 {
		t.Fatalf("expected 2 requests, got %d", edge.Requests)
	}
	if edge.ErrorRate == 0 {
		t.Fatalf("expected non-zero error rate")
	}
}

func TestNormalizeRecordIPFallback(t *testing.T) {
	r := NormalizeRecord(TelemetryRecord{
		SourceService:      "",
		DestinationService: "unknown",
		SourceIP:           "10.0.1.5",
		DestIP:             "10.0.2.7:8080",
	})
	if r.SourceService != "10.0.1.5" {
		t.Fatalf("expected source IP fallback, got %q", r.SourceService)
	}
	if r.DestinationService != "10.0.2.7" {
		t.Fatalf("expected dest IP fallback with port stripped, got %q", r.DestinationService)
	}
}

func TestTopologyBuildsNodesAndEdges(t *testing.T) {
	s := New(10)
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow", Leg: "cross_cluster", LatencyMs: 7})
	s.AddRecord(TelemetryRecord{SourceService: "a", DestinationService: "b", Verdict: "allow", Leg: "cross_cluster", LatencyMs: 9})

	topology := s.Topology()
	if len(topology.Nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(topology.Nodes))
	}
	if len(topology.Edges) != 1 {
		t.Fatalf("expected 1 edge, got %d", len(topology.Edges))
	}
	if topology.Edges[0].Requests != 2 {
		t.Fatalf("expected 2 requests, got %d", topology.Edges[0].Requests)
	}
	if topology.Edges[0].P50Ms == 0 {
		t.Fatalf("expected non-zero latency percentile")
	}
}
