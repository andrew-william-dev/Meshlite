package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var logsService string

var logsCmd = &cobra.Command{
	Use:   "logs",
	Short: "Show recent Trace events for a specific service",
	RunE: func(_ *cobra.Command, _ []string) error {
		if logsService == "" {
			return fmt.Errorf("--service is required")
		}
		var events []eventItem
		if err := httpGetJSON(joinURL(traceURL, "/api/v1/events?service="+logsService), &events); err != nil {
			return err
		}
		if len(events) == 0 {
			fmt.Printf("No recent events for %s\n", logsService)
			return nil
		}
		for _, event := range events {
			fmt.Printf("%s -> %s | %s | %s\n", event.SourceService, event.DestinationService, event.Leg, event.Verdict)
			if event.ErrorReason != "" {
				fmt.Printf("  reason: %s\n", event.ErrorReason)
			}
		}
		return nil
	},
}

func init() {
	logsCmd.Flags().StringVar(&logsService, "service", "", "Service name to filter recent events by")
}
