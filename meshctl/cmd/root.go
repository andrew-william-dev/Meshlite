package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

var (
	sigilURL string
	traceURL string
	version  = "v0.5.0-mvp"
)

var rootCmd = &cobra.Command{
	Use:   "meshctl",
	Short: "MeshLite operator CLI",
}

func Execute() {
	rootCmd.PersistentFlags().StringVar(&sigilURL, "sigil-url", "http://127.0.0.1:8080", "Sigil base URL")
	rootCmd.PersistentFlags().StringVar(&traceURL, "trace-url", "http://127.0.0.1:3000", "Trace base URL")
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(applyCmd, statusCmd, verifyCmd, logsCmd, rotateCmd, versionCmd)
}

func joinURL(base, path string) string {
	return strings.TrimRight(base, "/") + path
}

func httpGetJSON(url string, out any) error {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GET %s failed: %s - %s", url, resp.Status, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func httpPost(url, contentType string, body []byte) ([]byte, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(url, contentType, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("POST %s failed: %s - %s", url, resp.Status, strings.TrimSpace(string(payload)))
	}
	return payload, nil
}
