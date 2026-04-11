// Package policy implements the MeshLite policy engine.
// It parses mesh.yaml allow rules into an in-memory graph and evaluates
// whether traffic from one service to another is permitted.
package policy

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Decision is the result of a policy evaluation.
type Decision int

const (
	// Deny means the traffic is not permitted.
	Deny Decision = iota
	// Allow means the traffic is permitted.
	Allow
)

func (d Decision) String() string {
	if d == Allow {
		return "Allow"
	}
	return "Deny"
}

// MeshConfig is the top-level structure of a mesh.yaml file.
type MeshConfig struct {
	Mesh    MeshMeta     `yaml:"mesh"`
	Policy  PolicyConfig `yaml:"policy"`
	Services []ServiceDef `yaml:"services"`
}

// MeshMeta holds cluster-level identifiers.
type MeshMeta struct {
	Name      string `yaml:"name"`
	ClusterID string `yaml:"cluster_id"`
}

// PolicyConfig holds the allow rules and default behaviour.
type PolicyConfig struct {
	MTLSMode     string      `yaml:"mtls"`
	DefaultAllow bool        `yaml:"default_allow"`
	Allow        []AllowRule `yaml:"allow"`
}

// AllowRule permits traffic from one service to a set of destination services.
type AllowRule struct {
	From string   `yaml:"from" json:"from"`
	To   []string `yaml:"to"   json:"to"`
}

// ServiceDef declares a service managed by the mesh.
type ServiceDef struct {
	Name      string `yaml:"name"`
	Namespace string `yaml:"namespace"`
}

// Engine evaluates policy decisions for service-to-service traffic.
// It is safe for concurrent read access after construction.
type Engine struct {
	// allow is a set: allow[from][to] = true means the traffic is explicitly permitted.
	allow        map[string]map[string]bool
	defaultAllow bool
	mtlsMode     string
	clusterID    string
}

// NewFromFile parses mesh.yaml at path and returns a ready Engine.
func NewFromFile(path string) (*Engine, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("policy: read config: %w", err)
	}
	return NewFromBytes(data)
}

// NewFromBytes parses mesh.yaml content and returns a ready Engine.
func NewFromBytes(data []byte) (*Engine, error) {
	var cfg MeshConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("policy: parse yaml: %w", err)
	}
	return newEngine(cfg), nil
}

func newEngine(cfg MeshConfig) *Engine {
	allow := make(map[string]map[string]bool)
	for _, rule := range cfg.Policy.Allow {
		if allow[rule.From] == nil {
			allow[rule.From] = make(map[string]bool)
		}
		for _, to := range rule.To {
			allow[rule.From][to] = true
		}
	}

	mtls := cfg.Policy.MTLSMode
	if mtls == "" {
		mtls = "off"
	}

	return &Engine{
		allow:        allow,
		defaultAllow: cfg.Policy.DefaultAllow,
		mtlsMode:     mtls,
		clusterID:    cfg.Mesh.ClusterID,
	}
}

// Evaluate returns the policy Decision for traffic from → to.
// Rules are evaluated in this order:
//  1. If there is an explicit allow rule for (from, to) → Allow
//  2. If default_allow is true → Allow
//  3. Otherwise → Deny
func (e *Engine) Evaluate(from, to string) Decision {
	if dsts, ok := e.allow[from]; ok {
		if dsts[to] {
			return Allow
		}
	}
	if e.defaultAllow {
		return Allow
	}
	return Deny
}

// MTLSMode returns the configured mTLS enforcement mode.
func (e *Engine) MTLSMode() string {
	return e.mtlsMode
}

// DefaultAllow returns whether the policy defaults to allowing traffic.
func (e *Engine) DefaultAllow() bool {
	return e.defaultAllow
}

// ClusterID returns the cluster ID from the mesh config.
func (e *Engine) ClusterID() string {
	return e.clusterID
}

// Rules returns a snapshot of the allow rules for marshalling into a PolicyBundle.
func (e *Engine) Rules() []AllowRule {
	rules := make([]AllowRule, 0, len(e.allow))
	for from, dsts := range e.allow {
		rule := AllowRule{From: from}
		for to := range dsts {
			rule.To = append(rule.To, to)
		}
		rules = append(rules, rule)
	}
	return rules
}
