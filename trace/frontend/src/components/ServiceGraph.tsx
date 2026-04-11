import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react';
import type { Topology } from '../lib/api';

type Props = {
  topology: Topology;
  viewLabel: string;
  focusService?: string;
};

export function ServiceGraph({ topology, viewLabel, focusService }: Props) {
  if (topology.nodes.length === 0 || topology.edges.length === 0) {
    return (
      <div className="panel empty-state">
        <h3>Service graph</h3>
        <p>No service journeys match this view yet. Generate demo traffic to populate the topology.</p>
      </div>
    );
  }

  const clusters = [...new Set(topology.nodes.map((node) => node.cluster_id || 'shared'))];
  const clusterPositions = new Map(clusters.map((cluster, index) => [cluster, index]));
  const laneOffsets = new Map<string, number>();

  const nodes: Node[] = topology.nodes.map((node) => {
    const cluster = node.cluster_id || 'shared';
    const laneIndex = clusterPositions.get(cluster) ?? 0;
    const rowIndex = laneOffsets.get(cluster) ?? 0;
    laneOffsets.set(cluster, rowIndex + 1);

    const isFocused = focusService === node.id;
    return {
      id: node.id,
      position: {
        x: 120 + laneIndex * 320,
        y: 80 + rowIndex * 110,
      },
      data: {
        label: node.cluster_id ? `${node.label}\n${node.cluster_id}` : node.label,
      },
      style: {
        background: isFocused ? '#dbeafe' : '#fff',
        color: '#0f172a',
        border: isFocused ? '2px solid #2563eb' : '1px solid #cbd5e1',
        borderRadius: 16,
        padding: 12,
        minWidth: 180,
        fontWeight: 700,
        whiteSpace: 'pre-line',
        boxShadow: isFocused
          ? '0 10px 24px rgba(37, 99, 235, 0.18)'
          : '0 8px 20px rgba(15, 23, 42, 0.08)',
      },
    };
  });

  const edges: Edge[] = topology.edges.map((edge, index) => {
    const issueCount = edge.deny_count + edge.tls_rejects + edge.error_count;
    const color = issueCount === 0
      ? edge.leg === 'cross_cluster' ? '#2563eb' : '#16a34a'
      : edge.deny_count > 0 ? '#f59e0b' : '#ef4444';

    return {
      id: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      animated: edge.requests > 0,
      label: `${edge.requests} req · p95 ${edge.p95_ms.toFixed(1)} ms`,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color,
      },
      style: {
        stroke: color,
        strokeWidth: Math.min(6, Math.max(2.5, edge.requests / 12 + 2)),
      },
      labelStyle: {
        fill: '#0f172a',
        fontWeight: 700,
        fontSize: 12,
      },
    };
  });

  return (
    <div className="panel graph-panel">
      <div className="panel-header">
        <div>
          <h3>Service graph</h3>
          <p className="panel-copy">Grouped by cluster and trimmed to the journeys that matter for this view.</p>
        </div>
        <span className="panel-pill">{viewLabel}</span>
      </div>

      <div className="graph-legend">
        {clusters.map((cluster) => (
          <span className="legend-pill" key={cluster}>
            {cluster === 'shared' ? 'shared context' : cluster}
          </span>
        ))}
      </div>

      <div className="graph-frame">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
        >
          <MiniMap pannable zoomable />
          <Controls showInteractive={false} />
          <Background gap={20} size={1} />
        </ReactFlow>
      </div>
    </div>
  );
}
