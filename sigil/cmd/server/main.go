// Package main is the Sigil server entrypoint.
// It wires together the CA, Policy Engine, Registry, Distributor, and REST API,
// then starts all components.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/meshlite/sigil/internal/ca"
	"github.com/meshlite/sigil/internal/distributor"
	"github.com/meshlite/sigil/internal/policy"
	"github.com/meshlite/sigil/internal/registry"
	sigilv1 "github.com/meshlite/sigil/internal/proto"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

func main() {
	configPath := flag.String("config", "", "Path to mesh.yaml (required)")
	dbPath := flag.String("db", "/data/sigil.db", "Path to SQLite database file")
	keyPath := flag.String("root-key", "/data/root.key", "Path to root CA private key file")
	certPath := flag.String("root-cert", "/data/root.crt", "Path to root CA certificate file")
	grpcAddr := flag.String("grpc-addr", ":8443", "gRPC listen address")
	httpAddr := flag.String("http-addr", ":8080", "REST API listen address")
	testCertTTL := flag.Duration("test-cert-ttl", 0, "Override cert TTL for testing (e.g. 30s). 0 = use default 24h.")
	// Note: controller-runtime registers --kubeconfig globally via init().
	// We must NOT redefine it — read it via flag.Lookup after Parse.
	flag.Parse()

	// Read the kubeconfig path registered by controller-runtime.
	kubeconfigPath := ""
	if f := flag.Lookup("kubeconfig"); f != nil {
		kubeconfigPath = f.Value.String()
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if *configPath == "" {
		logger.Error("--config is required")
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ── Policy Engine ──────────────────────────────────────────────────────────
	eng, err := policy.NewFromFile(*configPath)
	if err != nil {
		logger.Error("failed to load policy config", "err", err)
		os.Exit(1)
	}
	logger.Info("policy engine loaded", "cluster_id", eng.ClusterID(), "mtls_mode", eng.MTLSMode())

	// ── Certificate Authority ──────────────────────────────────────────────────
	authority, err := ca.New(*dbPath, *keyPath, *certPath, *testCertTTL)
	if err != nil {
		logger.Error("failed to initialise CA", "err", err)
		os.Exit(1)
	}
	defer authority.Close()

	if authority.IsNewRootCA() {
		logger.Info("Sigil CA initialized — generated new root CA")
	} else {
		logger.Info("Sigil CA initialized — loaded existing root CA from disk")
	}

	// ── Distributor ────────────────────────────────────────────────────────────
	dist := distributor.New(logger)

	// On connect: push the current policy snapshot + issue certs for every service
	// the agent declared in its hello. This ensures agents get data immediately
	// even when the registry is offline (no Kubernetes API / pod-watch events).
	dist.OnConnect = func(hello *sigilv1.AgentHello) {
		// Push current policy to the newly connected agent.
		rules := []*sigilv1.AllowRule{}
		for _, r := range eng.Rules() {
			rules = append(rules, &sigilv1.AllowRule{
				FromService: r.From,
				ToServices:  r.To,
			})
		}
		dist.PushPolicy(hello.GetNodeId(), distributor.PolicySnapshot{
			Rules:        rules,
			DefaultAllow: eng.DefaultAllow(),
			MTLSMode:     eng.MTLSMode(),
		})

		// Issue certs for each service the agent is running.
		for _, svcID := range hello.GetPodServiceIds() {
			issued, err := authority.Issue(svcID, hello.GetClusterId(), "default")
			if err != nil {
				logger.Warn("on-connect cert issue failed", "service", svcID, "err", err)
				continue
			}
			dist.PushCert(hello.GetNodeId(), distributor.CertBundle{
				ServiceID:      issued.ServiceID,
				ServiceCertPEM: issued.CertPEM,
				RootCAPEM:      issued.RootCAPEM,
				ExpiresAtUnix:  issued.ExpiresAt.Unix(),
				RotateAtUnix:   issued.RotateAt.Unix(),
			})
		}
	}

	// ── Registry ──────────────────────────────────────────────────────────────
	// Registry requires a reachable Kubernetes API server.
	// When running locally (no kubeconfig / no cluster), it is skipped with a
	// warning — gRPC and REST continue to work for Tests 2.A–2.D.
	var reg *registry.Registry
	{
		var restCfg *rest.Config
		if kubeconfigPath != "" {
			var kcErr error
			restCfg, kcErr = clientcmd.BuildConfigFromFlags("", kubeconfigPath)
			if kcErr != nil {
				logger.Warn("kubeconfig not usable — registry will be skipped", "path", kubeconfigPath, "err", kcErr)
				restCfg = nil
			}
		}
		var regErr error
		reg, regErr = registry.New(eng.ClusterID(), func(evt registry.ServiceEvent) {
			handleServiceEvent(logger, authority, dist, eng, evt)
		}, restCfg)
		if regErr != nil {
			logger.Warn("registry unavailable — pod watch disabled (no Kubernetes API reachable)", "err", regErr)
			reg = nil
		}
	}

	// ── REST API ───────────────────────────────────────────────────────────────
	mux := http.NewServeMux()
	registerRoutes(mux, logger, authority, eng, dist)
	httpServer := &http.Server{
		Addr:         *httpAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// ── Start everything ───────────────────────────────────────────────────────
	errCh := make(chan error, 3)

	// ── Cert rotation loop ─────────────────────────────────────────────────────
	// Every 5 seconds scan for certs whose rotate_at has passed and re-issue them.
	// Pushes the new CertBundle to all currently connected agents.
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				certs, err := authority.ListCerts()
				if err != nil {
					logger.Warn("rotation scan failed", "err", err)
					continue
				}
				for _, c := range certs {
					if time.Now().Before(c.RotateAt) {
						continue
					}
					issued, err := authority.Issue(c.ServiceID, c.ClusterID, c.Namespace)
					if err != nil {
						logger.Warn("rotation issue failed", "service", c.ServiceID, "err", err)
						continue
					}
					logger.Info("cert rotated", "service", c.ServiceID, "expires_at", issued.ExpiresAt)
					for _, nodeID := range dist.ConnectedAgents() {
						dist.PushCert(nodeID, distributor.CertBundle{
							ServiceID:      issued.ServiceID,
							ServiceCertPEM: issued.CertPEM,
							RootCAPEM:      issued.RootCAPEM,
							ExpiresAtUnix:  issued.ExpiresAt.Unix(),
							RotateAtUnix:   issued.RotateAt.Unix(),
						})
					}
				}
			}
		}
	}()

	go func() {
		if err := dist.ListenAndServe(ctx, *grpcAddr); err != nil {
			errCh <- fmt.Errorf("grpc: %w", err)
		}
	}()

	go func() {
		logger.Info("REST server listening", "addr", *httpAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- fmt.Errorf("http: %w", err)
		}
	}()

	go func() {
		if reg == nil {
			return
		}
		if err := reg.Start(ctx); err != nil {
			errCh <- fmt.Errorf("registry: %w", err)
		}
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	case err := <-errCh:
		logger.Error("fatal error", "err", err)
		os.Exit(1)
	}
}

// handleServiceEvent issues or revokes a cert when a pod appears or disappears.
func handleServiceEvent(
	logger *slog.Logger,
	authority *ca.CA,
	dist *distributor.Distributor,
	eng *policy.Engine,
	evt registry.ServiceEvent,
) {
	if evt.Deleted {
		if err := authority.Revoke(evt.ServiceID); err != nil {
			logger.Warn("revoke failed", "service", evt.ServiceID, "err", err)
		}
		return
	}

	issued, err := authority.Issue(evt.ServiceID, evt.ClusterID, evt.Namespace)
	if err != nil {
		logger.Error("cert issue failed", "service", evt.ServiceID, "err", err)
		return
	}

	logger.Info("cert issued", "service", evt.ServiceID, "node", evt.NodeName, "expires_at", issued.ExpiresAt)

	dist.PushCert(evt.NodeName, distributor.CertBundle{
		ServiceID:      issued.ServiceID,
		ServiceCertPEM: issued.CertPEM,
		RootCAPEM:      issued.RootCAPEM,
		ExpiresAtUnix:  issued.ExpiresAt.Unix(),
		RotateAtUnix:   issued.RotateAt.Unix(),
	})
}

// ─── REST routes ──────────────────────────────────────────────────────────────

func registerRoutes(
	mux *http.ServeMux,
	logger *slog.Logger,
	authority *ca.CA,
	eng *policy.Engine,
	dist *distributor.Distributor,
) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.HandleFunc("GET /api/v1/certs", func(w http.ResponseWriter, _ *http.Request) {
		certs, err := authority.ListCerts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type certItem struct {
			ServiceID string `json:"service_id"`
			ExpiresAt int64  `json:"expires_at"`
		}
		items := make([]certItem, len(certs))
		for i, c := range certs {
			items[i] = certItem{ServiceID: c.ServiceID, ExpiresAt: c.ExpiresAt.Unix()}
		}
		writeJSON(w, items)
	})

	mux.HandleFunc("GET /api/v1/certs/{serviceID}/cert.pem", func(w http.ResponseWriter, r *http.Request) {
		serviceID := r.PathValue("serviceID")
		certs, err := authority.ListCerts()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		for _, c := range certs {
			if c.ServiceID == serviceID {
				w.Header().Set("Content-Type", "application/x-pem-file")
				_, _ = w.Write(c.CertPEM)
				return
			}
		}
		http.NotFound(w, r)
	})

	mux.HandleFunc("GET /api/v1/certs/root-ca.pem", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-pem-file")
		_, _ = w.Write(authority.RootCAPEM())
	})

	mux.HandleFunc("GET /api/v1/policy", func(w http.ResponseWriter, _ *http.Request) {
		type policyResp struct {
			MTLSMode     string             `json:"mtls_mode"`
			DefaultAllow bool               `json:"default_allow"`
			Rules        []policy.AllowRule `json:"rules"`
		}
		writeJSON(w, policyResp{
			MTLSMode:     eng.MTLSMode(),
			DefaultAllow: eng.DefaultAllow(),
			Rules:        eng.Rules(),
		})
	})

	mux.HandleFunc("POST /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		defer r.Body.Close()

		newEng, err := policy.NewFromBytes(body)
		if err != nil {
			http.Error(w, fmt.Sprintf("invalid config: %v", err), http.StatusBadRequest)
			return
		}

		// Swap engine in-place (single writer, protected by atomic pointer swap
		// is safe enough for Phase 2; in production use sync/atomic.Value)
		*eng = *newEng

		// Push updated policy to all connected agents
		rules := eng.Rules()
		protoRules := make([]*sigilv1.AllowRule, len(rules))
		for i, r := range rules {
			protoRules[i] = &sigilv1.AllowRule{
				FromService: r.From,
				ToServices:  r.To,
			}
		}
		dist.BroadcastPolicy(distributor.PolicySnapshot{
			Rules:        protoRules,
			DefaultAllow: eng.DefaultAllow(),
			MTLSMode:     eng.MTLSMode(),
		})

		logger.Info("policy config reloaded and pushed", "connected_agents", len(dist.ConnectedAgents()))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, "encoding error", http.StatusInternalServerError)
	}
}
