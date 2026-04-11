package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show meshctl version",
	Run: func(_ *cobra.Command, _ []string) {
		fmt.Printf("meshctl %s\n", version)
	},
}
