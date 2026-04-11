package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var rotateService string

var rotateCmd = &cobra.Command{
	Use:   "rotate",
	Short: "Request immediate certificate rotation for a service",
	RunE: func(_ *cobra.Command, _ []string) error {
		if rotateService == "" {
			return fmt.Errorf("--service is required")
		}
		_, err := httpPost(joinURL(sigilURL, "/api/v1/certs/"+rotateService+"/rotate"), "application/json", []byte(`{}`))
		if err != nil {
			return err
		}
		fmt.Printf("🔄 rotation requested for %s\n", rotateService)
		return nil
	},
}

func init() {
	rotateCmd.Flags().StringVar(&rotateService, "service", "", "Service name to rotate")
}
