package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var applyFile string

var applyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply a mesh.yaml config to Sigil",
	RunE: func(_ *cobra.Command, _ []string) error {
		if applyFile == "" {
			return fmt.Errorf("--file is required")
		}
		payload, err := os.ReadFile(applyFile)
		if err != nil {
			return err
		}
		_, err = httpPost(joinURL(sigilURL, "/api/v1/config"), "application/x-yaml", payload)
		if err != nil {
			return err
		}
		fmt.Printf("✅ applied %s\n", applyFile)
		return nil
	},
}

func init() {
	applyCmd.Flags().StringVarP(&applyFile, "file", "f", "", "Path to mesh.yaml")
}
