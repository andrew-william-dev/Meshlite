import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { Topology } from '../lib/api';

type Props = {
  topology: Topology;
};

export function ServiceGraph({ topology }: Props) {
  if (topology.nodes.length === 0) {
    return (
      <div className="panel empty-state">
        <h3>Service graph</h3>
        <p>No telemetry has arrived yet. Generate traffic to populate the topology.</p>
      </div>
    );
  }

  const nodes: Node[] = topology.nodes.map((node, index) => ({
    id: node.id,
    position: {
      x: 80 + (index % 3) * 240,
      y: 60 + Math.floor(index / 3) * 140,
    },
    data: {
      label: `${node.label}${node.cluster_id ? ` (${node.cluster_id})` : ''}`,
    },
    style: {
      background: '#fff',
      color: '#11284b',
      border: '1px solid #cbd5e1',
      borderRadius: 12,
      padding: 8,
      minWidth: 150,
      fontWeight: 600,
      boxShadow: '0 4px 18px rgba(15, 23, 42, 0.08)',
    },
  }));

  const edges: Edge[] = topology.edges.map((edge, index) => {
    const isHealthy = edge.deny_count === 0 && edge.tls_rejects === 0 && edge.error_count === 0;
    const color = isHealthy ? '#22c55e' : edge.deny_count > 0 ? '#f59e0b' : '#ef4444';
    return {
      id: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      animated: edge.requests > 0,
      label: `${edge.leg} · ${edge.requests} req`,
      style: { stroke: color, strokeWidth: Math.min(6, Math.max(2, edge.requests / 10 + 2)) },
      labelStyle: { fill: '#334155', fontWeight: 600 },
    };
  });

  return (
    <div className="panel graph-panel">
      <div className="panel-header">
        <h3>Service graph</h3>
        <span className="panel-pill">Rancher-inspired topology view</span>
      </div>
      <div className="graph-frame">
        <ReactFlow nodes={nodes} edges={edges} fitView>
          <MiniMap pannable zoomable />
          <Controls />
          <Background gap={20} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}
