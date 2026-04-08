// Package registry watches the Kubernetes API for pod lifecycle events and
// maintains a map of service identities to the nodes they run on.
// It calls the provided callbacks so the distributor can push certs and policy.
package registry

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

// ServiceEvent describes a pod lifecycle event relevant to the mesh.
type ServiceEvent struct {
	// ServiceID is derived from the pod's app label (label key: app).
	ServiceID string
	// NodeName is the Kubernetes node the pod is (or was) running on.
	NodeName string
	// Namespace is the pod's namespace.
	Namespace string
	// ClusterID is set from the MeshConfig at registry creation time.
	ClusterID string
	// Deleted is true when the pod was removed.
	Deleted bool
}

// EventHandler is called for each relevant pod event.
// Implementations must be non-blocking; spawn goroutines as needed.
type EventHandler func(event ServiceEvent)

// Registry watches for pod changes and fires callbacks.
type Registry struct {
	mgr       manager.Manager
	clusterID string
	handler   EventHandler
}

// New creates a Registry that uses the in-cluster kubeconfig (or the provided
// restCfg if non-nil — useful in tests with envtest).
func New(clusterID string, handler EventHandler, restCfg *rest.Config) (*Registry, error) {
	if restCfg == nil {
		var err error
		restCfg, err = ctrl.GetConfig()
		if err != nil {
			return nil, fmt.Errorf("registry: get kubeconfig: %w", err)
		}
	}

	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		return nil, fmt.Errorf("registry: add core scheme: %w", err)
	}

	mgr, err := ctrl.NewManager(restCfg, ctrl.Options{
		Scheme: scheme,
		// Disable the controller-runtime metrics server — it defaults to :8080
		// which conflicts with Sigil's own REST API port.
		Metrics: metricsserver.Options{BindAddress: "0"},
	})
	if err != nil {
		return nil, fmt.Errorf("registry: create manager: %w", err)
	}

	r := &Registry{
		mgr:       mgr,
		clusterID: clusterID,
		handler:   handler,
	}

	if err := ctrl.NewControllerManagedBy(mgr).
		For(&corev1.Pod{}).
		Complete(r); err != nil {
		return nil, fmt.Errorf("registry: register controller: %w", err)
	}

	return r, nil
}

// Start begins watching the Kubernetes API. It blocks until ctx is cancelled.
func (r *Registry) Start(ctx context.Context) error {
	return r.mgr.Start(ctx)
}

// Reconcile is called by controller-runtime whenever a pod changes.
// It implements reconcile.Reconciler.
func (r *Registry) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var pod corev1.Pod
	err := r.mgr.GetClient().Get(ctx, req.NamespacedName, &pod)
	if err != nil {
		if client.IgnoreNotFound(err) == nil {
			// Pod was deleted — fire a delete event.
			// We only have the name/namespace from the request at this point.
			r.handler(ServiceEvent{
				ServiceID: req.Name, // best effort; callers should use the app label
				NodeName:  "",
				Namespace: req.Namespace,
				ClusterID: r.clusterID,
				Deleted:   true,
			})
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, fmt.Errorf("registry: get pod: %w", err)
	}

	serviceID := pod.Labels["app"]
	if serviceID == "" {
		// Pod has no app label — not managed by the mesh.
		return ctrl.Result{}, nil
	}

	// Only act on Running pods with an assigned node.
	if pod.Status.Phase != corev1.PodRunning || pod.Spec.NodeName == "" {
		return ctrl.Result{}, nil
	}

	r.handler(ServiceEvent{
		ServiceID: serviceID,
		NodeName:  pod.Spec.NodeName,
		Namespace: pod.Namespace,
		ClusterID: r.clusterID,
		Deleted:   false,
	})

	return ctrl.Result{}, nil
}
