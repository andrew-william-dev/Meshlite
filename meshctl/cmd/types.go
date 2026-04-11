package cmd

type certItem struct {
	ServiceID string `json:"service_id"`
	ExpiresAt int64  `json:"expires_at"`
}

type allowRule struct {
	From string   `json:"from"`
	To   []string `json:"to"`
}

type policyResponse struct {
	MTLSMode     string      `json:"mtls_mode"`
	DefaultAllow bool        `json:"default_allow"`
	Rules        []allowRule `json:"rules"`
}

type traceSummary struct {
	TotalRequests  int64 `json:"total_requests"`
	Allowed        int64 `json:"allowed"`
	Denied         int64 `json:"denied"`
	TLSFailures    int64 `json:"tls_failures"`
	Errors         int64 `json:"errors"`
	ActiveEdges    int   `json:"active_edges"`
	ActiveServices int   `json:"active_services"`
}

type eventItem struct {
	SourceService      string `json:"source_service"`
	DestinationService string `json:"destination_service"`
	Leg                string `json:"leg"`
	Verdict            string `json:"verdict"`
	ErrorReason        string `json:"error_reason"`
}

func isAllowed(policy policyResponse, from, to string) bool {
	for _, rule := range policy.Rules {
		if rule.From != from {
			continue
		}
		for _, dst := range rule.To {
			if dst == to {
				return true
			}
		}
		return false
	}
	return policy.DefaultAllow
}
