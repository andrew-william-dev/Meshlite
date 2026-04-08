// Package ca implements the Sigil Certificate Authority.
// It generates a self-signed root CA on first startup, persists the key pair,
// and issues SPIFFE x509 SVIDs for service identities.
package ca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// spiffeScheme is the URI scheme for SPIFFE SVIDs.
	spiffeScheme = "spiffe"
	// spiffeTrustDomain is the trust domain for all MeshLite certificates.
	spiffeTrustDomain = "meshlite.local"
	// defaultLeafTTL is the default lifetime for issued leaf certificates.
	defaultLeafTTL = 24 * time.Hour
	// rotateAt is the fraction of TTL remaining at which rotation is triggered.
	rotateAt = 0.80
)

// CA holds the root CA key pair and the SQLite database for issued certs.
type CA struct {
	rootKey  *ecdsa.PrivateKey
	rootCert *x509.Certificate
	rootPEM  []byte // PEM of the root CA cert, cached for push to agents
	db       *sql.DB
	leafTTL  time.Duration
}

// IssuedCert is the record stored in SQLite and returned to callers.
type IssuedCert struct {
	ServiceID    string
	ClusterID    string
	Namespace    string
	CertPEM      []byte
	KeyPEM       []byte // non-nil only when returned by IssueWithDNS
	RootCAPEM    []byte
	ExpiresAt    time.Time
	RotateAt     time.Time
	SerialNumber string
}

// New opens (or creates) the SQLite database at dbPath and initialises the CA.
// If a root CA already exists on disk at keyPath/certPath it is loaded;
// otherwise a new root CA is generated and saved.
func New(dbPath, keyPath, certPath string, leafTTL time.Duration) (*CA, error) {
	if leafTTL <= 0 {
		leafTTL = defaultLeafTTL
	}

	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("ca: open db: %w", err)
	}
	if err := initSchema(db); err != nil {
		return nil, fmt.Errorf("ca: init schema: %w", err)
	}

	var rootKey *ecdsa.PrivateKey
	var rootCert *x509.Certificate
	var rootPEM []byte

	if fileExists(keyPath) && fileExists(certPath) {
		rootKey, rootCert, rootPEM, err = loadRootCA(keyPath, certPath)
		if err != nil {
			return nil, fmt.Errorf("ca: load existing root CA: %w", err)
		}
	} else {
		rootKey, rootCert, rootPEM, err = generateRootCA(keyPath, certPath)
		if err != nil {
			return nil, fmt.Errorf("ca: generate root CA: %w", err)
		}
	}

	return &CA{
		rootKey:  rootKey,
		rootCert: rootCert,
		rootPEM:  rootPEM,
		db:       db,
		leafTTL:  leafTTL,
	}, nil
}

// IsNewRootCA returns true if this CA was freshly generated (not loaded from disk).
// Callers use this to log "generating new root CA" vs "loaded existing root CA from disk".
func (c *CA) IsNewRootCA() bool {
	return c.rootCert.NotBefore.After(time.Now().Add(-5 * time.Second))
}

// RootCAPEM returns the PEM-encoded root CA certificate.
func (c *CA) RootCAPEM() []byte {
	return c.rootPEM
}

// Issue issues a SPIFFE x509 SVID leaf certificate for the given service identity.
// clusterID and namespace are used to build the SPIFFE URI in the SAN.
func (c *CA) Issue(serviceID, clusterID, namespace string) (*IssuedCert, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("ca: generate serial: %w", err)
	}

	spiffeURI := buildSPIFFEURI(clusterID, namespace, serviceID)
	u, err := url.Parse(spiffeURI)
	if err != nil {
		return nil, fmt.Errorf("ca: parse spiffe URI: %w", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ca: generate leaf key: %w", err)
	}

	now := time.Now()
	expiry := now.Add(c.leafTTL)
	rotateAtTime := now.Add(time.Duration(float64(c.leafTTL) * rotateAt))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   serviceID,
			Organization: []string{"MeshLite"},
		},
		URIs:      []*url.URL{u},
		NotBefore: now,
		NotAfter:  expiry,
		KeyUsage:  x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageClientAuth,
			x509.ExtKeyUsageServerAuth,
		},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, c.rootCert, &leafKey.PublicKey, c.rootKey)
	if err != nil {
		return nil, fmt.Errorf("ca: sign leaf cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	if err := c.persistCert(serial.String(), serviceID, clusterID, namespace, certPEM, expiry, rotateAtTime); err != nil {
		return nil, fmt.Errorf("ca: persist cert: %w", err)
	}

	return &IssuedCert{
		ServiceID:    serviceID,
		ClusterID:    clusterID,
		Namespace:    namespace,
		CertPEM:      certPEM,
		RootCAPEM:    c.rootPEM,
		ExpiresAt:    expiry,
		RotateAt:     rotateAtTime,
		SerialNumber: serial.String(),
	}, nil
}

// IssueWithDNS issues a leaf certificate like Issue, but also sets DNS SANs.
// It returns the certificate AND the leaf private key PEM so the caller can
// use them directly as a TLS credential (e.g. for the Sigil gRPC server).
func (c *CA) IssueWithDNS(serviceID, clusterID, namespace string, dnsNames []string) (*IssuedCert, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, fmt.Errorf("ca: generate serial: %w", err)
	}

	spiffeURI := buildSPIFFEURI(clusterID, namespace, serviceID)
	u, err := url.Parse(spiffeURI)
	if err != nil {
		return nil, fmt.Errorf("ca: parse spiffe URI: %w", err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("ca: generate leaf key: %w", err)
	}

	now := time.Now()
	expiry := now.Add(c.leafTTL)
	rotateAtTime := now.Add(time.Duration(float64(c.leafTTL) * rotateAt))

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   serviceID,
			Organization: []string{"MeshLite"},
		},
		URIs:      []*url.URL{u},
		DNSNames:  dnsNames,
		NotBefore: now,
		NotAfter:  expiry,
		KeyUsage:  x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{
			x509.ExtKeyUsageClientAuth,
			x509.ExtKeyUsageServerAuth,
		},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, c.rootCert, &leafKey.PublicKey, c.rootKey)
	if err != nil {
		return nil, fmt.Errorf("ca: sign leaf cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return nil, fmt.Errorf("ca: marshal leaf key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := c.persistCert(serial.String(), serviceID, clusterID, namespace, certPEM, expiry, rotateAtTime); err != nil {
		return nil, fmt.Errorf("ca: persist cert: %w", err)
	}

	return &IssuedCert{
		ServiceID:    serviceID,
		ClusterID:    clusterID,
		Namespace:    namespace,
		CertPEM:      certPEM,
		KeyPEM:       keyPEM,
		RootCAPEM:    c.rootPEM,
		ExpiresAt:    expiry,
		RotateAt:     rotateAtTime,
		SerialNumber: serial.String(),
	}, nil
}

// Revoke removes the cert for serviceID from the database.
// The caller is responsible for pushing a revocation notice to connected agents.
func (c *CA) Revoke(serviceID string) error {
	_, err := c.db.Exec(`DELETE FROM certs WHERE service_id = ?`, serviceID)
	if err != nil {
		return fmt.Errorf("ca: revoke %s: %w", serviceID, err)
	}
	return nil
}

// ListCerts returns all currently issued (non-revoked) certificates.
func (c *CA) ListCerts() ([]IssuedCert, error) {
	rows, err := c.db.Query(
		`SELECT service_id, cluster_id, namespace, cert_pem, expires_at, rotate_at FROM certs ORDER BY service_id`,
	)
	if err != nil {
		return nil, fmt.Errorf("ca: list certs: %w", err)
	}
	defer rows.Close()

	var certs []IssuedCert
	for rows.Next() {
		var ic IssuedCert
		var expiresAtUnix, rotateAtUnix int64
		if err := rows.Scan(&ic.ServiceID, &ic.ClusterID, &ic.Namespace, &ic.CertPEM, &expiresAtUnix, &rotateAtUnix); err != nil {
			return nil, fmt.Errorf("ca: scan cert row: %w", err)
		}
		ic.ExpiresAt = time.Unix(expiresAtUnix, 0)
		ic.RotateAt = time.Unix(rotateAtUnix, 0)
		ic.RootCAPEM = c.rootPEM
		certs = append(certs, ic)
	}
	return certs, rows.Err()
}

// Close closes the underlying SQLite database.
func (c *CA) Close() error {
	return c.db.Close()
}

// ─── helpers ──────────────────────────────────────────────────────────────────

func buildSPIFFEURI(clusterID, namespace, serviceID string) string {
	return fmt.Sprintf("%s://%s/cluster/%s/ns/%s/svc/%s",
		spiffeScheme, spiffeTrustDomain, clusterID, namespace, serviceID)
}

func initSchema(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS certs (
			serial     TEXT PRIMARY KEY,
			service_id TEXT NOT NULL UNIQUE,
			cluster_id TEXT NOT NULL DEFAULT '',
			namespace  TEXT NOT NULL DEFAULT '',
			cert_pem   BLOB NOT NULL,
			expires_at INTEGER NOT NULL,
			rotate_at  INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_certs_service_id ON certs(service_id);
	`)
	return err
}

func generateRootCA(keyPath, certPath string) (*ecdsa.PrivateKey, *x509.Certificate, []byte, error) {
	key, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate root key: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, nil, fmt.Errorf("generate root serial: %w", err)
	}

	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   "MeshLite Root CA",
			Organization: []string{"MeshLite"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("sign root cert: %w", err)
	}

	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse root cert: %w", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("marshal root key: %w", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := os.WriteFile(keyPath, keyPEM, 0600); err != nil {
		return nil, nil, nil, fmt.Errorf("write root key: %w", err)
	}
	if err := os.WriteFile(certPath, certPEM, 0644); err != nil {
		return nil, nil, nil, fmt.Errorf("write root cert: %w", err)
	}

	return key, cert, certPEM, nil
}

func loadRootCA(keyPath, certPath string) (*ecdsa.PrivateKey, *x509.Certificate, []byte, error) {
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read root key: %w", err)
	}
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("read root cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return nil, nil, nil, errors.New("root key PEM is empty or malformed")
	}
	key, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse root key: %w", err)
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return nil, nil, nil, errors.New("root cert PEM is empty or malformed")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("parse root cert: %w", err)
	}

	return key, cert, certPEM, nil
}

func (c *CA) persistCert(serial, serviceID, clusterID, namespace string, certPEM []byte, expiresAt, rotateAt time.Time) error {
	_, err := c.db.Exec(
		`INSERT OR REPLACE INTO certs (serial, service_id, cluster_id, namespace, cert_pem, expires_at, rotate_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		serial, serviceID, clusterID, namespace, certPEM, expiresAt.Unix(), rotateAt.Unix(),
	)
	return err
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
