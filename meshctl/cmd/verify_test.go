package cmd

import "testing"

func TestIsAllowed(t *testing.T) {
	policy := policyResponse{
		DefaultAllow: false,
		Rules: []allowRule{{From: "service-alpha", To: []string{"service-beta"}}},
	}
	if !isAllowed(policy, "service-alpha", "service-beta") {
		t.Fatalf("expected allow for service-alpha -> service-beta")
	}
	if isAllowed(policy, "service-beta", "service-alpha") {
		t.Fatalf("expected deny for service-beta -> service-alpha")
	}
}
