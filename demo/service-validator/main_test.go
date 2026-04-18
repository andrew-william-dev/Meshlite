package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCallTargetUsesHostOverride(t *testing.T) {
	gotHost := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer server.Close()

	app := &app{
		serviceName:     "validator-ui",
		clusterName:     "cluster-1",
		crossTargetURL:  server.URL,
		crossTargetName: "validator-cross",
		crossTargetHost: "validator-cross",
		client:          server.Client(),
	}

	result := app.callTarget("cross")
	if result.Error != "" {
		t.Fatalf("expected no error, got %q", result.Error)
	}
	if gotHost != "validator-cross" {
		t.Fatalf("expected host override %q, got %q", "validator-cross", gotHost)
	}
}

func TestEventBufferTrimmed(t *testing.T) {
	app := &app{}
	for i := 0; i < maxEvents+5; i++ {
		app.addEvent(demoEvent{Kind: "same", Target: "validator-same", Verdict: "success", Message: "ok", Timestamp: "now"})
	}
	if got := len(app.latestEvents()); got != maxEvents {
		t.Fatalf("expected %d events, got %d", maxEvents, got)
	}
}
