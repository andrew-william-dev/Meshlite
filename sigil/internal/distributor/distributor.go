// Package distributor implements the Sigil gRPC server that agents connect to.
// It maintains one server-streaming connection per Kprobe agent and pushes
// CertBundles and PolicyBundles as they change.
package distributor

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sync"

	sigilv1 "github.com/meshlite/sigil/internal/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"
)

// CertProvider is the interface the distributor uses to fetch certificates.
// Implemented by ca.CA.
type CertProvider interface {
	// Issue issues or re-issues a cert for serviceID/clusterID/namespace.
	Issue(serviceID, clusterID, namespace string) (CertBundle, error)
	// RootCAPEM returns the PEM-encoded root CA cert.
	RootCAPEM() []byte
}

// CertBundle is the internal representation returned by CertProvider.Issue.
// It maps directly onto the proto CertBundle fields.
type CertBundle struct {
	ServiceID      string
	ServiceCertPEM []byte
	RootCAPEM      []byte
	ExpiresAtUnix  int64
	RotateAtUnix   int64
	KeyPEM         []byte // PKCS#8 private key PEM for the leaf cert
}

// PolicySnapshot is the current policy state, ready to push.
type PolicySnapshot struct {
	Rules        []*sigilv1.AllowRule
	DefaultAllow bool
	MTLSMode     string
}

// Distributor is the gRPC SigilAgent server implementation.
type Distributor struct {
	sigilv1.UnimplementedSigilAgentServer

	mu        sync.RWMutex
	streams   map[string]*agentStream // key: nodeID
	logger    *slog.Logger
	OnConnect func(hello *sigilv1.AgentHello) // called after stream registered; nil = no-op
}

type agentStream struct {
	nodeID  string
	send    chan *sigilv1.AgentPush
	cancel  context.CancelFunc
}

// New creates a Distributor.
func New(logger *slog.Logger) *Distributor {
	if logger == nil {
		logger = slog.Default()
	}
	return &Distributor{
		streams: make(map[string]*agentStream),
		logger:  logger,
	}
}

// ListenAndServe starts the gRPC server on addr (e.g. ":8443").
// It blocks until ctx is cancelled or a fatal error occurs.
// Extra grpc.ServerOption values (e.g. TLS credentials) may be passed via opts.
func (d *Distributor) ListenAndServe(ctx context.Context, addr string, opts ...grpc.ServerOption) error {
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("distributor: listen %s: %w", addr, err)
	}

	srvOpts := append([]grpc.ServerOption{
		grpc.KeepaliveParams(keepalive.ServerParameters{
			MaxConnectionIdle: 5 * 60, // 5 minutes
		}),
	}, opts...)
	srv := grpc.NewServer(srvOpts...)
	sigilv1.RegisterSigilAgentServer(srv, d)

	go func() {
		<-ctx.Done()
		srv.GracefulStop()
	}()

	d.logger.Info("gRPC server listening", "addr", addr)
	return srv.Serve(lis)
}

// Subscribe implements sigilv1.SigilAgentServer.
// Each agent opens this stream on startup and holds it open indefinitely.
func (d *Distributor) Subscribe(hello *sigilv1.AgentHello, stream sigilv1.SigilAgent_SubscribeServer) error {
	if hello.GetNodeId() == "" {
		return status.Error(codes.InvalidArgument, "node_id is required")
	}

	ctx, cancel := context.WithCancel(stream.Context())
	sends := make(chan *sigilv1.AgentPush, 64)

	as := &agentStream{
		nodeID: hello.GetNodeId(),
		send:   sends,
		cancel: cancel,
	}

	d.mu.Lock()
	// If an old stream exists for this node, cancel it.
	if old, exists := d.streams[hello.GetNodeId()]; exists {
		old.cancel()
	}
	d.streams[hello.GetNodeId()] = as
	d.mu.Unlock()

	d.logger.Info("agent connected", "node", hello.GetNodeId(), "cluster", hello.GetClusterId())

	// Fire the connect callback asynchronously so it can call PushCert / BroadcastPolicy
	// without deadlocking on the subscribe loop below.
	if d.OnConnect != nil {
		go d.OnConnect(hello)
	}

	defer func() {
		d.mu.Lock()
		if current := d.streams[hello.GetNodeId()]; current == as {
			delete(d.streams, hello.GetNodeId())
		}
		d.mu.Unlock()
		cancel()
		d.logger.Info("agent disconnected", "node", hello.GetNodeId())
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case push, ok := <-sends:
			if !ok {
				return nil
			}
			if err := stream.Send(push); err != nil {
				return err
			}
		}
	}
}

// Ack implements sigilv1.SigilAgentServer.
func (d *Distributor) Ack(_ context.Context, req *sigilv1.AgentAck) (*sigilv1.AckResponse, error) {
	d.logger.Debug("ack received", "stream_id", req.GetStreamId())
	return &sigilv1.AckResponse{Ok: true}, nil
}

// PushCert pushes a CertBundle to the agent on the given node.
// If no agent is connected on that node the push is silently dropped —
// the agent will receive the cert on the next Subscribe.
func (d *Distributor) PushCert(nodeID string, cb CertBundle) {
	push := &sigilv1.AgentPush{
		Payload: &sigilv1.AgentPush_Cert{
			Cert: &sigilv1.CertBundle{
				ServiceId:      cb.ServiceID,
				ServiceCertPem: cb.ServiceCertPEM,
				RootCaPem:      cb.RootCAPEM,
				ExpiresAtUnix:  cb.ExpiresAtUnix,
				RotateAtUnix:   cb.RotateAtUnix,
				KeyPem:         cb.KeyPEM,
			},
		},
	}
	d.send(nodeID, push)
}

// PushPolicy sends a PolicyBundle to a single agent by nodeID.
// Use BroadcastPolicy to send to all connected agents.
func (d *Distributor) PushPolicy(nodeID string, snap PolicySnapshot) {
	push := &sigilv1.AgentPush{
		Payload: &sigilv1.AgentPush_Policy{
			Policy: &sigilv1.PolicyBundle{
				Rules:        snap.Rules,
				DefaultAllow: snap.DefaultAllow,
				MtlsMode:     snap.MTLSMode,
			},
		},
	}
	d.send(nodeID, push)
}

// BroadcastPolicy sends an updated PolicyBundle to every connected agent.
func (d *Distributor) BroadcastPolicy(snap PolicySnapshot) {
	push := &sigilv1.AgentPush{
		Payload: &sigilv1.AgentPush_Policy{
			Policy: &sigilv1.PolicyBundle{
				Rules:        snap.Rules,
				DefaultAllow: snap.DefaultAllow,
				MtlsMode:     snap.MTLSMode,
			},
		},
	}
	d.mu.RLock()
	nodeIDs := make([]string, 0, len(d.streams))
	for id := range d.streams {
		nodeIDs = append(nodeIDs, id)
	}
	d.mu.RUnlock()

	for _, nodeID := range nodeIDs {
		d.send(nodeID, push)
	}
}

// ConnectedAgents returns the node IDs of currently connected agents.
func (d *Distributor) ConnectedAgents() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	ids := make([]string, 0, len(d.streams))
	for id := range d.streams {
		ids = append(ids, id)
	}
	return ids
}

// send delivers a push to a single node's send channel, non-blocking.
func (d *Distributor) send(nodeID string, push *sigilv1.AgentPush) {
	d.mu.RLock()
	as, ok := d.streams[nodeID]
	d.mu.RUnlock()
	if !ok {
		return
	}
	select {
	case as.send <- push:
	default:
		d.logger.Warn("send channel full, dropping push", "node", nodeID)
	}
}
