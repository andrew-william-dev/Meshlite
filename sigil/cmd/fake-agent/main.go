// fake-agent simulates a Kprobe agent connecting to Sigil.
// Used in Tests 2.C and 2.D of the Phase 2 runbook.
//
// Usage (from sigil/ directory):
//
//	go run ./cmd/fake-agent/main.go --sigil localhost:8443
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	sigilv1 "github.com/meshlite/sigil/internal/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	sigilAddr := flag.String("sigil", "localhost:8443", "Sigil gRPC address")
	nodeID := flag.String("node", "fake-node-1", "Node ID to advertise")
	clusterID := flag.String("cluster", "dev", "Cluster ID to advertise")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	conn, err := grpc.NewClient(*sigilAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		log.Fatalf("dial %s: %v", *sigilAddr, err)
	}
	defer conn.Close()

	client := sigilv1.NewSigilAgentClient(conn)

	log.Printf("Connecting to Sigil at %s (node=%s, cluster=%s)", *sigilAddr, *nodeID, *clusterID)

	stream, err := client.Subscribe(ctx, &sigilv1.AgentHello{
		NodeId:    *nodeID,
		ClusterId: *clusterID,
		PodServiceIds: []string{"service-alpha", "service-beta"},
	})
	if err != nil {
		log.Fatalf("Subscribe: %v", err)
	}

	log.Printf("Connected to Sigil at %s", *sigilAddr)

	certSeen := make(map[string]bool) // tracks which service IDs have already had their first push
	for {
		push, err := stream.Recv()
		if err == io.EOF {
			log.Println("stream closed by server")
			return
		}
		if err != nil {
			if ctx.Err() != nil {
				return // normal shutdown
			}
			log.Printf("stream error: %v", err)
			return
		}

		switch p := push.Payload.(type) {
		case *sigilv1.AgentPush_Cert:
			cb := p.Cert
			expiresAt := time.Unix(cb.ExpiresAtUnix, 0).UTC().Format(time.RFC3339)
			rotateAt := time.Unix(cb.RotateAtUnix, 0).UTC().Format(time.RFC3339)

			label := "[PUSH]"
			if certSeen[cb.ServiceId] {
				label = "[ROTATION]"
			}
			fmt.Fprintf(os.Stdout, "%s CertBundle: service_id=%s expires_at=%s rotate_at=%s\n",
				label, cb.ServiceId, expiresAt, rotateAt)
			certSeen[cb.ServiceId] = true

			// Acknowledge receipt
			_, ackErr := client.Ack(ctx, &sigilv1.AgentAck{
				StreamId:   *nodeID,
				ReceivedAt: time.Now().Unix(),
			})
			if ackErr != nil {
				log.Printf("ack error: %v", ackErr)
			}

		case *sigilv1.AgentPush_Policy:
			pb := p.Policy
			fmt.Fprintf(os.Stdout, "[PUSH] PolicyBundle: rules=%d default_allow=%v mtls_mode=%s\n",
				len(pb.Rules), pb.DefaultAllow, pb.MtlsMode)
		}
	}
}
