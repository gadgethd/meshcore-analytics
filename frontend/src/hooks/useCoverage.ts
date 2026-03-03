import { useState, useCallback, useEffect } from 'react';

export interface NodeCoverage {
  node_id:          string;
  geom:             { type: string; coordinates: unknown };
  antenna_height_m?: number;
  radius_m?:        number;
  calculated_at?:   string;
}

export function useCoverage() {
  const [coverage, setCoverage] = useState<NodeCoverage[]>([]);

  // Fetch all stored polygons on mount
  useEffect(() => {
    fetch('/api/coverage')
      .then((r) => r.json())
      .then((data: NodeCoverage[]) => setCoverage(data))
      .catch(() => { /* non-fatal */ });
  }, []);

  // Called when a coverage_update WS message arrives
  const handleCoverageUpdate = useCallback((update: { node_id: string; geom: NodeCoverage['geom'] }) => {
    setCoverage((prev) => {
      const filtered = prev.filter((c) => c.node_id !== update.node_id);
      return [...filtered, { node_id: update.node_id, geom: update.geom }];
    });
  }, []);

  return { coverage, handleCoverageUpdate };
}
