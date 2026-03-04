import { useState, useCallback } from 'react';

export interface NodeLink {
  node_a_id:        string;
  node_b_id:        string;
  observed_count:   number;
  last_observed?:   string;
  itm_path_loss_db?: number;
  itm_viable?:       boolean;
}

export function useLinks() {
  const [links, setLinks] = useState<NodeLink[]>([]);

  const handleLinkUpdate = useCallback((link: NodeLink) => {
    setLinks((prev) => {
      const idx = prev.findIndex(
        (l) =>
          (l.node_a_id === link.node_a_id && l.node_b_id === link.node_b_id) ||
          (l.node_a_id === link.node_b_id && l.node_b_id === link.node_a_id),
      );
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], ...link };
        return next;
      }
      return [...prev, link];
    });
  }, []);

  const handleInitialLinks = useCallback((initial: NodeLink[]) => {
    setLinks(initial);
  }, []);

  return { links, handleLinkUpdate, handleInitialLinks };
}
