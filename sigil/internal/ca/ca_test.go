package ca

import (
	"crypto/x509"
	"encoding/pem"
	"os"
	"strings"
	"testing"
	"time"
)

// tempDir creates a temp directory and registers cleanup.
func tempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "sigil-ca-test-*")
	if err != nil {
		t.Fatalf("create temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func newTestCA(t *testing.T, leafTTL time.Duration) *CA {
	t.Helper()
	dir := tempDir(t)
	ca, err := New(
		dir+"/sigil.db",
		dir+"/root.key",
		dir+"/root.crt",
		leafTTL,
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { ca.Close() })
	return ca
}

// ─── TestRootCAInit ────────────────────────────────────────────────────────────

func TestRootCAInit_GeneratesOnFirstStart(t *testing.T) {
	dir := tempDir(t)
	ca, err := New(dir+"/sigil.db", dir+"/root.key", dir+"/root.crt", 0)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer ca.Close()

	if len(ca.RootCAPEM()) == 0 {
		t.Error("RootCAPEM() returned empty PEM")
	}

	// key and cert files must be written to disk
	if _, err := os.Stat(dir + "/root.key"); err != nil {
		t.Errorf("root.key not written: %v", err)
	}
	if _, err := os.Stat(dir + "/root.crt"); err != nil {
		t.Errorf("root.crt not written: %v", err)
	}

	if !ca.IsNewRootCA() {
		t.Error("IsNewRootCA() = false, want true for a freshly generated CA")
	}
}

func TestRootCAInit_LoadsExistingCA(t *testing.T) {
	dir := tempDir(t)

	// Generate once
	ca1, err := New(dir+"/sigil.db", dir+"/root.key", dir+"/root.crt", 0)
	if err != nil {
		t.Fatalf("first New() error = %v", err)
	}
	originalPEM := make([]byte, len(ca1.RootCAPEM()))
	copy(originalPEM, ca1.RootCAPEM())
	ca1.Close()

	// Wait a tick so time.Now() is different — IsNewRootCA would return false
	// Load a second time
	ca2, err := New(dir+"/sigil.db", dir+"/root.key", dir+"/root.crt", 0)
	if err != nil {
		t.Fatalf("second New() error = %v", err)
	}
	defer ca2.Close()

	if string(ca2.RootCAPEM()) != string(originalPEM) {
		t.Error("second CA load returned different root PEM — a new root CA was generated instead of loading existing")
	}
}

// ─── TestIssueLeafCert ────────────────────────────────────────────────────────

func TestIssueLeafCert_ValidSPIFFECert(t *testing.T) {
	ca := newTestCA(t, time.Hour)

	ic, err := ca.Issue("service-alpha", "dev", "meshlite-test")
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}

	// Cert PEM must be non-empty
	if len(ic.CertPEM) == 0 {
		t.Fatal("CertPEM is empty")
	}

	// Parse the issued cert
	block, _ := pem.Decode(ic.CertPEM)
	if block == nil {
		t.Fatal("CertPEM is not valid PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("x509.ParseCertificate() error = %v", err)
	}

	// Must have exactly one URI SAN with the correct SPIFFE URI
	if len(cert.URIs) != 1 {
		t.Fatalf("expected 1 URI SAN, got %d", len(cert.URIs))
	}
	expectedURI := "spiffe://meshlite.local/cluster/dev/ns/meshlite-test/svc/service-alpha"
	if cert.URIs[0].String() != expectedURI {
		t.Errorf("URI SAN = %q, want %q", cert.URIs[0].String(), expectedURI)
	}

	// Must have correct ExtKeyUsage (both client and server auth)
	hasClientAuth, hasServerAuth := false, false
	for _, eku := range cert.ExtKeyUsage {
		if eku == x509.ExtKeyUsageClientAuth {
			hasClientAuth = true
		}
		if eku == x509.ExtKeyUsageServerAuth {
			hasServerAuth = true
		}
	}
	if !hasClientAuth {
		t.Error("leaf cert missing ExtKeyUsageClientAuth")
	}
	if !hasServerAuth {
		t.Error("leaf cert missing ExtKeyUsageServerAuth")
	}

	// Must not be a CA
	if cert.IsCA {
		t.Error("leaf cert has IsCA=true, want false")
	}
}

func TestIssueLeafCert_VerifiesAgainstRootCA(t *testing.T) {
	ca := newTestCA(t, time.Hour)

	ic, err := ca.Issue("service-beta", "dev", "meshlite-test")
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}

	// Build verification pool from the root CA PEM
	rootPool := x509.NewCertPool()
	if !rootPool.AppendCertsFromPEM(ic.RootCAPEM) {
		t.Fatal("failed to append root CA to pool")
	}

	leafBlock, _ := pem.Decode(ic.CertPEM)
	leafCert, err := x509.ParseCertificate(leafBlock.Bytes)
	if err != nil {
		t.Fatalf("parse leaf cert: %v", err)
	}

	_, err = leafCert.Verify(x509.VerifyOptions{
		Roots: rootPool,
		// SPIFFE certs have URI SANs, not DNS SANs — disable hostname check
		DNSName: "",
	})
	if err != nil {
		t.Errorf("openssl-equivalent verify failed: %v", err)
	}
}

func TestIssueLeafCert_ExpiryAndRotateAt(t *testing.T) {
	ttl := 10 * time.Minute
	ca := newTestCA(t, ttl)

	before := time.Now()
	ic, err := ca.Issue("service-alpha", "dev", "meshlite-test")
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}

	// ExpiresAt must be approximately now + TTL
	expectedExpiry := before.Add(ttl)
	if ic.ExpiresAt.Before(expectedExpiry.Add(-5*time.Second)) ||
		ic.ExpiresAt.After(expectedExpiry.Add(5*time.Second)) {
		t.Errorf("ExpiresAt = %v, want ~%v", ic.ExpiresAt, expectedExpiry)
	}

	// RotateAt must be before ExpiresAt
	if !ic.RotateAt.Before(ic.ExpiresAt) {
		t.Errorf("RotateAt %v is not before ExpiresAt %v", ic.RotateAt, ic.ExpiresAt)
	}
}

// ─── TestRevoke ───────────────────────────────────────────────────────────────

func TestRevoke_RemovesCertFromDB(t *testing.T) {
	ca := newTestCA(t, time.Hour)

	if _, err := ca.Issue("service-alpha", "dev", "meshlite-test"); err != nil {
		t.Fatalf("Issue() error = %v", err)
	}

	// Cert must be in list before revoke
	certs, err := ca.ListCerts()
	if err != nil {
		t.Fatalf("ListCerts() error = %v", err)
	}
	if !containsServiceID(certs, "service-alpha") {
		t.Fatal("service-alpha not found in certs after issue")
	}

	if err := ca.Revoke("service-alpha"); err != nil {
		t.Fatalf("Revoke() error = %v", err)
	}

	// Cert must be gone after revoke
	certs, err = ca.ListCerts()
	if err != nil {
		t.Fatalf("ListCerts() error = %v", err)
	}
	if containsServiceID(certs, "service-alpha") {
		t.Error("service-alpha still in certs after revoke")
	}
}

func TestRevoke_NonExistentServiceNoError(t *testing.T) {
	ca := newTestCA(t, time.Hour)
	// Revoking a service that was never issued must not return an error
	if err := ca.Revoke("does-not-exist"); err != nil {
		t.Errorf("Revoke() on non-existent service error = %v, want nil", err)
	}
}

// ─── TestSPIFFEURIFormat ──────────────────────────────────────────────────────

func TestBuildSPIFFEURI(t *testing.T) {
	tests := []struct {
		clusterID string
		namespace string
		serviceID string
		want      string
	}{
		{"dev", "meshlite-test", "service-alpha", "spiffe://meshlite.local/cluster/dev/ns/meshlite-test/svc/service-alpha"},
		{"prod", "payments", "payments-svc", "spiffe://meshlite.local/cluster/prod/ns/payments/svc/payments-svc"},
	}
	for _, tt := range tests {
		got := buildSPIFFEURI(tt.clusterID, tt.namespace, tt.serviceID)
		if got != tt.want {
			t.Errorf("buildSPIFFEURI(%q,%q,%q) = %q, want %q",
				tt.clusterID, tt.namespace, tt.serviceID, got, tt.want)
		}
		if !strings.HasPrefix(got, "spiffe://meshlite.local/") {
			t.Errorf("URI does not start with spiffe://meshlite.local/: %q", got)
		}
	}
}

func TestIssueWithDNS_HasDNSSANsAndKey(t *testing.T) {
	c := newTestCA(t, 0)
	dnsNames := []string{"sigil.meshlite-system.svc.cluster.local", "sigil", "localhost"}

	issued, err := c.IssueWithDNS("sigil", "dev", "meshlite-system", dnsNames)
	if err != nil {
		t.Fatalf("IssueWithDNS: %v", err)
	}

	// Key PEM must be present.
	if len(issued.KeyPEM) == 0 {
		t.Fatal("KeyPEM is empty")
	}
	block, _ := pem.Decode(issued.KeyPEM)
	if block == nil || block.Type != "EC PRIVATE KEY" {
		t.Fatalf("unexpected KeyPEM block type: %v", block)
	}

	// Cert must contain the expected DNS SANs.
	certBlock, _ := pem.Decode(issued.CertPEM)
	if certBlock == nil {
		t.Fatal("CertPEM did not decode")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}
	for _, want := range dnsNames {
		found := false
		for _, got := range cert.DNSNames {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("DNS SAN %q not found in cert; got %v", want, cert.DNSNames)
		}
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func containsServiceID(certs []IssuedCert, id string) bool {
	for _, c := range certs {
		if c.ServiceID == id {
			return true
		}
	}
	return false
}
