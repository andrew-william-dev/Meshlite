package cmd

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show live services, cert expiries, and policy summary",
	RunE: func(_ *cobra.Command, _ []string) error {
		var certs []certItem
		var policy policyResponse
		var summary traceSummary

		if err := httpGetJSON(joinURL(sigilURL, "/api/v1/certs"), &certs); err != nil {
			return err
		}
		if err := httpGetJSON(joinURL(sigilURL, "/api/v1/policy"), &policy); err != nil {
			return err
		}
		_ = httpGetJSON(joinURL(traceURL, "/api/v1/summary"), &summary)

		fmt.Println("MeshLite Status")
		fmt.Println("---------------")
		fmt.Printf("mTLS mode:      %s\n", policy.MTLSMode)
		fmt.Printf("default allow:  %v\n", policy.DefaultAllow)
		fmt.Printf("allow rules:    %d\n", len(policy.Rules))
		fmt.Printf("services/certs: %d\n", len(certs))
		fmt.Printf("trace requests: %d (allowed=%d denied=%d tls_failures=%d)\n", summary.TotalRequests, summary.Allowed, summary.Denied, summary.TLSFailures)
		fmt.Println()
		for _, cert := range certs {
			expiry := time.Unix(cert.ExpiresAt, 0).UTC().Format(time.RFC3339)
			fmt.Printf("- %s expires %s\n", cert.ServiceID, expiry)
		}
		return nil
	},
}
