package policy

import (
	"os"
	"testing"
)

// meshBasicYAML mirrors tests/fixtures/mesh-basic.yaml for unit tests.
// Keep in sync with the fixture file.
const meshBasicYAML = `
mesh:
  name: meshlite-dev
  cluster_id: dev

policy:
  mtls: enforce
  default_allow: false
  allow:
    - from: api-gateway
      to: [auth, orders]
    - from: orders
      to: [payments]
    - from: service-alpha
      to: [service-beta]
`

func engineFromYAML(t *testing.T, src string) *Engine {
	t.Helper()
	e, err := NewFromBytes([]byte(src))
	if err != nil {
		t.Fatalf("NewFromBytes() error = %v", err)
	}
	return e
}

// ─── Evaluate: explicit allow rules ──────────────────────────────────────────

func TestEvaluate_ExplicitAllow(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)

	cases := []struct{ from, to string }{
		{"api-gateway", "auth"},
		{"api-gateway", "orders"},
		{"orders", "payments"},
		{"service-alpha", "service-beta"},
	}
	for _, c := range cases {
		if got := e.Evaluate(c.from, c.to); got != Allow {
			t.Errorf("Evaluate(%q, %q) = %v, want Allow", c.from, c.to, got)
		}
	}
}

// ─── Evaluate: explicit deny (not in allow list, default_allow=false) ────────

func TestEvaluate_ExplicitDeny_KnownServices(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)

	cases := []struct{ from, to string }{
		{"auth", "payments"},     // auth has no allow rules
		{"payments", "api-gateway"}, // payments has no allow rules
		{"orders", "auth"},       // orders only allows → payments
		{"api-gateway", "payments"}, // api-gateway only allows → auth, orders
	}
	for _, c := range cases {
		if got := e.Evaluate(c.from, c.to); got != Deny {
			t.Errorf("Evaluate(%q, %q) = %v, want Deny", c.from, c.to, got)
		}
	}
}

// ─── Evaluate: unknown services ───────────────────────────────────────────────

func TestEvaluate_UnknownFrom(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if got := e.Evaluate("unknown-svc", "auth"); got != Deny {
		t.Errorf("Evaluate(unknown, auth) = %v, want Deny", got)
	}
}

func TestEvaluate_UnknownTo(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if got := e.Evaluate("api-gateway", "unknown-svc"); got != Deny {
		t.Errorf("Evaluate(api-gateway, unknown) = %v, want Deny", got)
	}
}

func TestEvaluate_BothUnknown(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if got := e.Evaluate("unknown-a", "unknown-b"); got != Deny {
		t.Errorf("Evaluate(unknown, unknown) = %v, want Deny", got)
	}
}

// ─── Evaluate: default_allow = true ──────────────────────────────────────────

func TestEvaluate_DefaultAllow_PermitsUnknownPairs(t *testing.T) {
	src := `
mesh:
  name: open-mesh
  cluster_id: dev
policy:
  default_allow: true
  mtls: permissive
`
	e := engineFromYAML(t, src)

	cases := []struct{ from, to string }{
		{"any-service", "any-other"},
		{"foo", "bar"},
	}
	for _, c := range cases {
		if got := e.Evaluate(c.from, c.to); got != Allow {
			t.Errorf("Evaluate(%q, %q) = %v, want Allow (default_allow=true)", c.from, c.to, got)
		}
	}
}

func TestEvaluate_DefaultAllow_ExplicitRuleStillWorks(t *testing.T) {
	src := `
mesh:
  name: open-mesh
  cluster_id: dev
policy:
  default_allow: true
  allow:
    - from: svc-a
      to: [svc-b]
`
	e := engineFromYAML(t, src)
	// Explicit allow still returns Allow
	if got := e.Evaluate("svc-a", "svc-b"); got != Allow {
		t.Errorf("Evaluate(svc-a, svc-b) = %v, want Allow", got)
	}
	// Unknown pair also returns Allow because default_allow=true
	if got := e.Evaluate("svc-x", "svc-y"); got != Allow {
		t.Errorf("Evaluate(svc-x, svc-y) = %v, want Allow (default_allow=true)", got)
	}
}

// ─── Evaluate: empty allow list + default_allow=false ─────────────────────────

func TestEvaluate_EmptyRules_DefaultDeny(t *testing.T) {
	src := `
mesh:
  name: closed-mesh
  cluster_id: dev
policy:
  default_allow: false
`
	e := engineFromYAML(t, src)
	if got := e.Evaluate("svc-a", "svc-b"); got != Deny {
		t.Errorf("Evaluate with empty rules = %v, want Deny", got)
	}
}

// ─── MTLSMode ─────────────────────────────────────────────────────────────────

func TestMTLSMode_Enforce(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if got := e.MTLSMode(); got != "enforce" {
		t.Errorf("MTLSMode() = %q, want %q", got, "enforce")
	}
}

func TestMTLSMode_DefaultOff(t *testing.T) {
	src := `
mesh:
  name: m
  cluster_id: dev
policy:
  default_allow: false
`
	e := engineFromYAML(t, src)
	if got := e.MTLSMode(); got != "off" {
		t.Errorf("MTLSMode() = %q, want %q (default)", got, "off")
	}
}

// ─── Decision.String() ────────────────────────────────────────────────────────

func TestDecisionString(t *testing.T) {
	if Allow.String() != "Allow" {
		t.Errorf("Allow.String() = %q, want Allow", Allow.String())
	}
	if Deny.String() != "Deny" {
		t.Errorf("Deny.String() = %q, want Deny", Deny.String())
	}
}

// ─── NewFromBytes: malformed YAML ─────────────────────────────────────────────

func TestNewFromBytes_MalformedYAML(t *testing.T) {
	_, err := NewFromBytes([]byte("{{not yaml"))
	if err == nil {
		t.Error("NewFromBytes with malformed YAML returned nil error, want error")
	}
}

// ─── NewFromFile ──────────────────────────────────────────────────────────────

func TestNewFromFile_HappyPath(t *testing.T) {
	f, err := os.CreateTemp("", "mesh-*.yaml")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(meshBasicYAML); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	f.Close()

	e, err := NewFromFile(f.Name())
	if err != nil {
		t.Fatalf("NewFromFile() error = %v", err)
	}
	if e.ClusterID() != "dev" {
		t.Errorf("ClusterID() = %q, want dev", e.ClusterID())
	}
}

func TestNewFromFile_MissingFile(t *testing.T) {
	_, err := NewFromFile("/nonexistent/path/mesh.yaml")
	if err == nil {
		t.Error("NewFromFile with missing file returned nil error, want error")
	}
}

// ─── DefaultAllow getter ──────────────────────────────────────────────────────

func TestDefaultAllow_False(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if e.DefaultAllow() != false {
		t.Errorf("DefaultAllow() = true, want false")
	}
}

func TestDefaultAllow_True(t *testing.T) {
	src := `
mesh:
  name: m
  cluster_id: dev
policy:
  default_allow: true
`
	e := engineFromYAML(t, src)
	if e.DefaultAllow() != true {
		t.Errorf("DefaultAllow() = false, want true")
	}
}

// ─── ClusterID getter ─────────────────────────────────────────────────────────

func TestClusterID(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	if got := e.ClusterID(); got != "dev" {
		t.Errorf("ClusterID() = %q, want dev", got)
	}
}

func TestClusterID_Empty(t *testing.T) {
	src := `
mesh:
  name: m
policy:
  default_allow: false
`
	e := engineFromYAML(t, src)
	if got := e.ClusterID(); got != "" {
		t.Errorf("ClusterID() = %q, want empty string", got)
	}
}

// ─── Rules snapshot ───────────────────────────────────────────────────────────

func TestRules_ReturnsAllRules(t *testing.T) {
	e := engineFromYAML(t, meshBasicYAML)
	rules := e.Rules()
	// mesh-basic has 3 from-services with allow rules
	if len(rules) != 3 {
		t.Errorf("Rules() returned %d rules, want 3", len(rules))
	}
}

func TestRules_EmptyWhenNoAllowRules(t *testing.T) {
	src := `
mesh:
  name: m
  cluster_id: dev
policy:
  default_allow: false
`
	e := engineFromYAML(t, src)
	if got := e.Rules(); len(got) != 0 {
		t.Errorf("Rules() = %v, want empty slice", got)
	}
}
