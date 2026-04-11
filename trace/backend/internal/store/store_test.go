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
	if got := len(s.Events("")); got != 1 {
		t.Fatalf("expected 1 stored event, got %d", got)
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
