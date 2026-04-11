#!/bin/bash
# Test 4.F — Latency benchmark for Conduit cross-cluster path
# Usage: bash /tmp/bench.sh [EGRESS_IP] [N]
EGRESS_IP="${1:-10.96.192.102}"
N="${2:-50}"

times=()
for i in $(seq 1 $N); do
  t=$(curl -s -o /dev/null -w '%{time_total}' --header 'Host: service-beta' "http://${EGRESS_IP}:9090/")
  times+=("$t")
  echo "req $i: ${t}s"
done

# Print summary — sort and pick p50, p99
echo ""
echo "--- Summary (${N} requests) ---"
sorted=($(for t in "${times[@]}"; do echo "$t"; done | sort -n))
p50_idx=$(( N / 2 ))
p99_idx=$(( N * 99 / 100 ))
echo "p50: ${sorted[$p50_idx]}s"
echo "p99: ${sorted[$p99_idx]}s"
echo "min: ${sorted[0]}s"
echo "max: ${sorted[$((N-1))]}s"
