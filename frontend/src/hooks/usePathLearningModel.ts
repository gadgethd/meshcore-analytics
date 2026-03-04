import { useEffect, useState } from 'react';
import { withNetworkParam, uncachedEndpoint } from '../utils/api.js';
import type { PathLearningModel } from '../utils/pathing.js';

type PathLearningApiResponse = {
  calibration: {
    confidence_scale: number;
    recommended_threshold: number;
  };
  prefixPriors: Array<{
    prefix: string;
    receiver_region: string;
    prev_prefix: string | null;
    node_id: string;
    probability: number;
  }>;
  transitionPriors: Array<{
    from_node_id: string;
    to_node_id: string;
    receiver_region: string;
    probability: number;
  }>;
};

export function usePathLearningModel(network?: string): PathLearningModel | null {
  const [model, setModel] = useState<PathLearningModel | null>(null);

  useEffect(() => {
    const load = () => {
      const endpoint = withNetworkParam('/api/path-learning', network);
      fetch(uncachedEndpoint(endpoint), { cache: 'no-store' })
        .then((response) => response.json())
        .then((data: PathLearningApiResponse) => {
          const prefixProbabilities = new Map<string, number>();
          for (const row of data.prefixPriors) {
            const key = `${row.receiver_region}|${row.prefix}|${row.prev_prefix ?? ''}|${row.node_id}`;
            prefixProbabilities.set(key, Number(row.probability));
          }

          const transitionProbabilities = new Map<string, number>();
          for (const row of data.transitionPriors) {
            const key = `${row.receiver_region}|${row.from_node_id}|${row.to_node_id}`;
            transitionProbabilities.set(key, Number(row.probability));
          }

          setModel({
            prefixProbabilities,
            transitionProbabilities,
            confidenceScale: Number(data.calibration?.confidence_scale ?? 1),
            recommendedThreshold: Number(data.calibration?.recommended_threshold ?? 0.5),
          });
        })
        .catch(() => {});
    };

    load();
    const interval = setInterval(load, 5 * 60_000);
    return () => clearInterval(interval);
  }, [network]);

  return model;
}

