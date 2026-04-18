package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	storepkg "github.com/meshlite/trace-backend/internal/store"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	httpAddr := flag.String("http-addr", ":3000", "UI + API listen address")
	metricsAddr := flag.String("metrics-addr", ":9090", "Prometheus metrics listen address")
	webDir := flag.String("web-dir", "./web", "Directory containing built frontend assets")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store := storepkg.New(1000)
	registry := prometheus.NewRegistry()

	requestsTotal := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "meshlite_requests_total", Help: "Total telemetry records received by Trace."},
		[]string{"src", "dst", "leg", "verdict"},
	)
	requestDuration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "meshlite_request_duration_seconds",
			Help:    "Latency samples in seconds.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5},
		},
		[]string{"src", "dst", "leg"},
	)
	denialsTotal := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "meshlite_policy_denials_total", Help: "Denied requests observed by Trace."},
		[]string{"src", "dst", "leg"},
	)
	tlsFailuresTotal := prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "meshlite_tls_failures_total", Help: "TLS verification failures observed by Trace."},
		[]string{"src", "dst", "reason"},
	)
	registry.MustRegister(requestsTotal, requestDuration, denialsTotal, tlsFailuresTotal)

	apiMux := http.NewServeMux()
	apiMux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})
	apiMux.HandleFunc("POST /api/v1/telemetry", func(w http.ResponseWriter, r *http.Request) {
		var records []storepkg.TelemetryRecord
		payload, err := readPayload(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		trimmed := strings.TrimSpace(string(payload))
		switch {
		case strings.HasPrefix(trimmed, "["):
			if err := json.Unmarshal(payload, &records); err != nil {
				http.Error(w, fmt.Sprintf("invalid telemetry batch: %v", err), http.StatusBadRequest)
				return
			}
		default:
			var record storepkg.TelemetryRecord
			if err := json.Unmarshal(payload, &record); err != nil {
				http.Error(w, fmt.Sprintf("invalid telemetry record: %v", err), http.StatusBadRequest)
				return
			}
			records = []storepkg.TelemetryRecord{record}
		}

		for _, record := range records {
			normalized := store.AddRecord(record)
			requestsTotal.WithLabelValues(normalized.SourceService, normalized.DestinationService, normalized.Leg, normalized.Verdict).Inc()
			if normalized.LatencyMs > 0 {
				requestDuration.WithLabelValues(normalized.SourceService, normalized.DestinationService, normalized.Leg).Observe(normalized.LatencyMs / 1000.0)
			}
			switch normalized.Verdict {
			case "deny":
				denialsTotal.WithLabelValues(normalized.SourceService, normalized.DestinationService, normalized.Leg).Inc()
			case "tls_reject":
				reason := normalized.ErrorReason
				if reason == "" {
					reason = "unknown"
				}
				tlsFailuresTotal.WithLabelValues(normalized.SourceService, normalized.DestinationService, reason).Inc()
			}
		}

		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, map[string]any{"status": "accepted", "records": len(records)})
	})
	apiMux.HandleFunc("GET /api/v1/summary", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, store.Summary())
	})
	apiMux.HandleFunc("GET /api/v1/topology", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, store.Topology())
	})
	apiMux.HandleFunc("GET /api/v1/perf", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, store.Performance())
	})
	apiMux.HandleFunc("GET /api/v1/events", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit, _ := strconv.Atoi(q.Get("limit"))
		writeJSON(w, store.Events(storepkg.EventQuery{
			Service: q.Get("service"),
			Verdict: q.Get("verdict"),
			Limit:   limit,
		}))
	})

	apiMux.Handle("/", staticHandler(*webDir))

	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))

	apiServer := &http.Server{Addr: *httpAddr, Handler: apiMux}
	metricsServer := &http.Server{Addr: *metricsAddr, Handler: metricsMux}

	go func() {
		log.Printf("[trace] metrics listening on %s", *metricsAddr)
		if err := metricsServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("metrics server failed: %v", err)
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = apiServer.Shutdown(shutdownCtx)
		_ = metricsServer.Shutdown(shutdownCtx)
	}()

	log.Printf("[trace] API/UI listening on %s", *httpAddr)
	if err := apiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("api server failed: %v", err)
	}
}

func readPayload(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

func staticHandler(webDir string) http.Handler {
	fileServer := http.FileServer(http.Dir(webDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/healthz" {
			http.NotFound(w, r)
			return
		}

		requested := filepath.Join(webDir, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(requested); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		index := filepath.Join(webDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(w, r, index)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body><h1>MeshLite Trace</h1><p>Frontend assets not built yet.</p></body></html>"))
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
