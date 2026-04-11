package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var verifyFrom string
var verifyTo string

var verifyCmd = &cobra.Command{
	Use:   "verify",
	Short: "Predict whether a service-to-service call is allowed by live policy",
	RunE: func(_ *cobra.Command, _ []string) error {
		if verifyFrom == "" || verifyTo == "" {
			return fmt.Errorf("--from and --to are required")
		}
		var policy policyResponse
		if err := httpGetJSON(joinURL(sigilURL, "/api/v1/policy"), &policy); err != nil {
			return err
		}
		if isAllowed(policy, verifyFrom, verifyTo) {
			fmt.Printf("✅ ALLOW — %s -> %s\n", verifyFrom, verifyTo)
			return nil
		}
		fmt.Printf("❌ DENY — %s -> %s\n", verifyFrom, verifyTo)
		return nil
	},
}

func init() {
	verifyCmd.Flags().StringVar(&verifyFrom, "from", "", "Source service")
	verifyCmd.Flags().StringVar(&verifyTo, "to", "", "Destination service")
}
