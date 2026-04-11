package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const maxEvents = 20

const pageHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{.ServiceName}} · MeshLite Service Validator</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111a2e;
      --panel-border: #22314f;
      --text: #e5eefc;
      --muted: #8ea3c7;
      --accent: #00b3a4;
      --accent-2: #2f80ed;
      --danger: #e85d75;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: linear-gradient(180deg, #08101d 0%, #0d1525 100%);
      color: var(--text);
    }
    .wrap { max-width: 980px; margin: 0 auto; padding: 24px; }
    .hero, .panel {
      background: rgba(17, 26, 46, 0.95);
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
    }
    .hero { padding: 24px; margin-bottom: 18px; }
    .hero h1 { margin: 0 0 10px; font-size: 28px; }
    .hero p { margin: 6px 0; color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 16px;
    }
    .panel { padding: 18px; }
    .panel h2 { margin-top: 0; font-size: 18px; }
    .meta { display: grid; gap: 8px; color: var(--muted); font-size: 14px; }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: rgba(0, 179, 164, 0.16);
      color: #7fe7dd;
      margin-right: 8px;
    }
    button {
      width: 100%;
      margin-bottom: 10px;
      border: 0;
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 14px;
      font-weight: 600;
      color: white;
      cursor: pointer;
      transition: transform 0.12s ease, opacity 0.12s ease;
    }
    button:hover { transform: translateY(-1px); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .same { background: linear-gradient(135deg, var(--accent), #0da98b); }
    .cross { background: linear-gradient(135deg, var(--accent-2), #5d9df5); }
    .result, .events {
      min-height: 180px;
      white-space: pre-wrap;
      background: #0a1324;
      border: 1px solid #1e2c47;
      border-radius: 12px;
      padding: 12px;
      font-family: Consolas, monospace;
      font-size: 13px;
      overflow: auto;
    }
    .hint {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .events .ok { color: #6ee7b7; }
    .events .error { color: #fca5a5; }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <span class="badge">MeshLite Demo</span>
      <span class="badge">{{.ClusterName}}</span>
      <h1>{{.ServiceName}}</h1>
      <p>Use this service to generate live same-cluster and cross-cluster traffic and watch it appear in Trace in real time.</p>
      <p>If a button is disabled, the corresponding target is not configured for this instance.</p>
    </section>

    <div class="grid">
      <section class="panel">
        <h2>Trigger test traffic</h2>
        <div class="meta">
          <div><strong>Same-cluster target:</strong> {{.SameTargetName}}</div>
          <div><strong>Cross-cluster target:</strong> {{.CrossTargetName}}</div>
        </div>
        <div style="margin-top: 14px;">
          <button class="same" {{if not .HasSameTarget}}disabled{{end}} onclick="callTarget('same')">Call same-cluster service</button>
          <button class="cross" {{if not .HasCrossTarget}}disabled{{end}} onclick="callTarget('cross')">Call cross-cluster service</button>
        </div>
        <div class="hint">Tip: keep Trace open while clicking to see the edge and recent events update.</div>
      </section>

      <section class="panel">
        <h2>Latest result</h2>
        <pre id="result" class="result">Waiting for an action…</pre>
      </section>
    </div>

    <section class="panel" style="margin-top: 16px;">
      <h2>Recent local event log</h2>
      <div id="events" class="events">Loading…</div>
    </section>
  </div>

  <script>
    async function callTarget(kind) {
      const result = document.getElementById('result');
      result.textContent = 'Calling ' + kind + ' target…';
      try {
        const res = await fetch('/api/call/' + kind, { method: 'POST' });
        const data = await res.json();
        result.textContent = JSON.stringify(data, null, 2);
        await refreshEvents();
      } catch (err) {
        result.textContent = 'Request failed: ' + err;
      }
    }

    async function refreshEvents() {
      const root = document.getElementById('events');
      try {
        const res = await fetch('/api/events');
        const events = await res.json();
        if (!events.length) {
          root.textContent = 'No events recorded yet.';
          return;
        }
        root.innerHTML = events.map((event) => {
          const cls = event.verdict === 'success' ? 'ok' : 'error';
          return '<div class="' + cls + '">[' + event.timestamp + '] ' + event.kind + ' → ' + event.target + ' | ' + event.verdict + ' | ' + event.message + '</div>';
        }).join('');
      } catch (err) {
        root.textContent = 'Failed to load events: ' + err;
      }
    }

    refreshEvents();
    setInterval(refreshEvents, 4000);
  </script>
</body>
</html>`

type demoEvent struct {
	Kind      string `json:"kind"`
	Target    string `json:"target"`
	Verdict   string `json:"verdict"`
	Message   string `json:"message"`
	Timestamp string `json:"timestamp"`
}

type callResult struct {
	Service      string `json:"service"`
	Cluster      string `json:"cluster"`
	Kind         string `json:"kind"`
	TargetName   string `json:"target_name"`
	TargetURL    string `json:"target_url"`
	HostHeader   string `json:"host_header,omitempty"`
	StatusCode   int    `json:"status_code,omitempty"`
	DurationMS   int64  `json:"duration_ms"`
	ResponseBody string `json:"response_body,omitempty"`
	Error        string `json:"error,omitempty"`
	Timestamp    string `json:"timestamp"`
}

type pageData struct {
	ServiceName     string
	ClusterName     string
	SameTargetName  string
	CrossTargetName string
	HasSameTarget   bool
	HasCrossTarget  bool
}

type app struct {
	serviceName     string
	clusterName     string
	sameTargetURL   string
	sameTargetName  string
	crossTargetURL  string
	crossTargetName string
	crossTargetHost string
	client          *http.Client
	tpl             *template.Template

	mu     sync.Mutex
	events []demoEvent
}

func main() {
	validator := newAppFromEnv()
	mux := http.NewServeMux()
	mux.HandleFunc("/", validator.handleIndex)
	mux.HandleFunc("/healthz", validator.handleHealth)
	mux.HandleFunc("/api/ping", validator.handlePing)
	mux.HandleFunc("/api/events", validator.handleEvents)
	mux.HandleFunc("/api/call/same", validator.handleCall("same"))
	mux.HandleFunc("/api/call/cross", validator.handleCall("cross"))

	listenAddr := getenv("LISTEN_ADDR", ":8080")
	log.Printf("[service-validator] starting service=%s cluster=%s addr=%s", validator.serviceName, validator.clusterName, listenAddr)
	if err := http.ListenAndServe(listenAddr, logRequests(mux)); err != nil {
		log.Fatalf("listen failed: %v", err)
	}
}

func newAppFromEnv() *app {
	return &app{
		serviceName:     getenv("SERVICE_NAME", "validator-ui"),
		clusterName:     getenv("CLUSTER_NAME", "cluster-1"),
		sameTargetURL:   os.Getenv("SAME_TARGET_URL"),
		sameTargetName:  getenv("SAME_TARGET_NAME", "validator-same"),
		crossTargetURL:  os.Getenv("CROSS_TARGET_URL"),
		crossTargetName: getenv("CROSS_TARGET_NAME", "validator-cross"),
		crossTargetHost: os.Getenv("CROSS_TARGET_HOST"),
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		tpl: template.Must(template.New("page").Parse(pageHTML)),
	}
}

func (a *app) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data := pageData{
		ServiceName:     a.serviceName,
		ClusterName:     a.clusterName,
		SameTargetName:  a.sameTargetName,
		CrossTargetName: a.crossTargetName,
		HasSameTarget:   strings.TrimSpace(a.sameTargetURL) != "",
		HasCrossTarget:  strings.TrimSpace(a.crossTargetURL) != "",
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := a.tpl.Execute(w, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (a *app) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": a.serviceName,
		"cluster": a.clusterName,
	})
}

func (a *app) handlePing(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"service":   a.serviceName,
		"cluster":   a.clusterName,
		"message":   fmt.Sprintf("%s reachable", a.serviceName),
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (a *app) handleEvents(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.latestEvents())
}

func (a *app) handleCall(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		result := a.callTarget(kind)
		status := http.StatusOK
		if result.Error != "" {
			status = http.StatusBadGateway
		}
		writeJSON(w, status, result)
	}
}

func (a *app) callTarget(kind string) callResult {
	targetURL := a.sameTargetURL
	targetName := a.sameTargetName
	hostHeader := ""
	if kind == "cross" {
		targetURL = a.crossTargetURL
		targetName = a.crossTargetName
		hostHeader = a.crossTargetHost
	}

	result := callResult{
		Service:    a.serviceName,
		Cluster:    a.clusterName,
		Kind:       kind,
		TargetName: targetName,
		TargetURL:  targetURL,
		HostHeader: hostHeader,
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
	}

	if strings.TrimSpace(targetURL) == "" {
		result.Error = "target URL is not configured"
		a.addEvent(demoEvent{Kind: kind, Target: targetName, Verdict: "error", Message: result.Error, Timestamp: result.Timestamp})
		return result
	}

	start := time.Now()
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		result.Error = err.Error()
		a.addEvent(demoEvent{Kind: kind, Target: targetName, Verdict: "error", Message: result.Error, Timestamp: result.Timestamp})
		return result
	}
	if hostHeader != "" {
		req.Host = hostHeader
		req.Header.Set("Host", hostHeader)
	}
	req.Header.Set("User-Agent", "meshlite-service-validator/1.0")
	req.Header.Set("X-MeshLite-Demo-Caller", a.serviceName)

	resp, err := a.client.Do(req)
	result.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		result.Error = err.Error()
		a.addEvent(demoEvent{Kind: kind, Target: targetName, Verdict: "error", Message: result.Error, Timestamp: result.Timestamp})
		return result
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	result.StatusCode = resp.StatusCode
	result.ResponseBody = strings.TrimSpace(string(body))
	verdict := "success"
	message := fmt.Sprintf("HTTP %d in %d ms", resp.StatusCode, result.DurationMS)
	if resp.StatusCode >= 400 {
		verdict = "error"
		message = fmt.Sprintf("HTTP %d in %d ms", resp.StatusCode, result.DurationMS)
	}
	a.addEvent(demoEvent{Kind: kind, Target: targetName, Verdict: verdict, Message: message, Timestamp: result.Timestamp})
	return result
}

func (a *app) addEvent(event demoEvent) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.events = append([]demoEvent{event}, a.events...)
	if len(a.events) > maxEvents {
		a.events = a.events[:maxEvents]
	}
}

func (a *app) latestEvents() []demoEvent {
	a.mu.Lock()
	defer a.mu.Unlock()
	copied := make([]demoEvent, len(a.events))
	copy(copied, a.events)
	return copied
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(started).Round(time.Millisecond))
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
