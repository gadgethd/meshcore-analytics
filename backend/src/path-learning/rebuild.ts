import { MIN_LINK_OBSERVATIONS, query } from '../db/index.js';

type LearningNode = {
  node_id: string;
  lat: number;
  lon: number;
  elevation_m: number | null;
  iata: string | null;
};

type LearningPacket = {
  rx_node_id: string;
  src_node_id: string | null;
  path_hashes: string[] | null;
};

type ResolvedHop = {
  prefix: string;
  node: LearningNode;
};

const MAX_TRAINING_PACKETS = 120_000;
const MAX_PREFIX_CHOICES_PER_GROUP = 3;
const MAX_TRANSITIONS_PER_GROUP = 5;

function linkKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function distKm(a: LearningNode, b: LearningNode): number {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * 111;
  const dLon = (a.lon - b.lon) * 111 * Math.cos(midLat);
  return Math.hypot(dLat, dLon);
}

function distancePrior(a: LearningNode, b: LearningNode): number {
  const d = distKm(a, b);
  const distScore = Math.exp(-d / 22);
  const elevA = a.elevation_m ?? 0;
  const elevB = b.elevation_m ?? 0;
  const elevScore = Math.min(1, Math.max(0, (Math.min(elevA, elevB) + 60) / 320));
  return 0.65 * distScore + 0.35 * elevScore;
}

function resolvePathForPacket(
  pathHashes: string[],
  srcNode: LearningNode | undefined,
  rxNode: LearningNode,
  prefixMap: Map<string, LearningNode[]>,
  confirmedLinks: Set<string>,
): ResolvedHop[] {
  const resolved: ResolvedHop[] = [];
  const visited = new Set<string>([rxNode.node_id]);
  let prev = rxNode;

  for (let i = pathHashes.length - 1; i >= 0; i--) {
    const prefix = pathHashes[i]!.slice(0, 2).toUpperCase();
    const candidates = (prefixMap.get(prefix) ?? []).filter((n) => !visited.has(n.node_id));
    if (candidates.length === 0) continue;

    let best: LearningNode | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const confirmed = confirmedLinks.has(linkKey(candidate.node_id, prev.node_id)) ? 1 : 0;
      const distanceScore = distancePrior(candidate, prev);
      const srcScore = srcNode ? (distKm(srcNode, prev) - distKm(srcNode, candidate)) / 100 : 0;
      const score = confirmed * 2.5 + distanceScore * 1.3 + srcScore;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best) {
      resolved.unshift({ prefix, node: best });
      visited.add(best.node_id);
      prev = best;
    }
  }

  return resolved;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function truncateBest(
  entries: Array<{ key: string; count: number }>,
  max: number,
): Array<{ key: string; count: number }> {
  return entries
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

export async function rebuildPathLearningModels(): Promise<void> {
  const networksResult = await query<{ network: string }>(
    `SELECT DISTINCT network
     FROM (
       SELECT network FROM packets
       UNION
       SELECT network FROM nodes
     ) t
     WHERE network IS NOT NULL`,
  );
  const networks = networksResult.rows.map((r) => r.network).filter(Boolean);
  if (networks.length === 0) return;

  for (const network of networks) {
    await rebuildNetwork(network, network);
  }
  await rebuildNetwork('all', undefined);
}

async function rebuildNetwork(modelNetwork: string, sourceNetwork: string | undefined): Promise<void> {
  const nodeNetworkFilter = sourceNetwork ? 'AND network = $1' : '';
  const packetNetworkFilter = sourceNetwork ? 'AND network = $1' : '';
  const linkNetworkFilter = sourceNetwork ? 'AND a.network = $1 AND b.network = $1' : '';
  const linkObsParam = sourceNetwork ? '$2' : '$1';
  const nodeParams: unknown[] = sourceNetwork ? [sourceNetwork] : [];
  const packetParams: unknown[] = sourceNetwork ? [sourceNetwork, MAX_TRAINING_PACKETS] : [MAX_TRAINING_PACKETS];
  const linkParams: unknown[] = sourceNetwork ? [sourceNetwork, MIN_LINK_OBSERVATIONS] : [MIN_LINK_OBSERVATIONS];

  const nodesResult = await query<LearningNode>(
    `SELECT node_id, lat, lon, elevation_m, iata
     FROM nodes
     WHERE lat IS NOT NULL
       AND lon IS NOT NULL
       AND (name IS NULL OR name NOT LIKE '%🚫%')
       AND (role IS NULL OR role = 2)
       ${nodeNetworkFilter}`,
    nodeParams,
  );
  const nodesById = new Map(nodesResult.rows.map((n) => [n.node_id, n]));
  const prefixMap = new Map<string, LearningNode[]>();
  for (const node of nodesResult.rows) {
    const prefix = node.node_id.slice(0, 2).toUpperCase();
    const existing = prefixMap.get(prefix);
    if (existing) existing.push(node);
    else prefixMap.set(prefix, [node]);
  }

  const linksResult = await query<{ node_a_id: string; node_b_id: string }>(
    `SELECT nl.node_a_id, nl.node_b_id
     FROM node_links nl
     JOIN nodes a ON a.node_id = nl.node_a_id
     JOIN nodes b ON b.node_id = nl.node_b_id
     WHERE (nl.itm_viable = true OR nl.force_viable = true)
       AND nl.observed_count >= ${linkObsParam}
       ${linkNetworkFilter}`,
    linkParams,
  );
  const confirmedLinks = new Set(linksResult.rows.map((r) => linkKey(r.node_a_id, r.node_b_id)));

  const packetsResult = await query<LearningPacket>(
    `SELECT rx_node_id, src_node_id, path_hashes
     FROM packets
     WHERE rx_node_id IS NOT NULL
       AND path_hashes IS NOT NULL
       AND cardinality(path_hashes) > 0
       AND time > NOW() - INTERVAL '120 days'
       ${packetNetworkFilter}
     ORDER BY time DESC
     LIMIT $${sourceNetwork ? 2 : 1}`,
    packetParams,
  );

  const prefixChoiceCounts = new Map<string, number>();
  const prefixGroupTotals = new Map<string, number>();
  const transitionCounts = new Map<string, number>();
  const transitionGroupTotals = new Map<string, number>();

  let evaluatedPackets = 0;
  let successPackets = 0;
  let confidenceSum = 0;

  for (const packet of packetsResult.rows) {
    const hashes = packet.path_hashes?.map((h) => h.slice(0, 2).toUpperCase()) ?? [];
    if (hashes.length === 0) continue;
    const rx = nodesById.get(packet.rx_node_id);
    if (!rx) continue;

    const src = packet.src_node_id ? nodesById.get(packet.src_node_id) : undefined;
    const region = rx.iata ?? 'unknown';
    const resolved = resolvePathForPacket(hashes, src, rx, prefixMap, confirmedLinks);
    if (resolved.length === 0) continue;

    evaluatedPackets++;

    const fullNodes = [...(src ? [src] : []), ...resolved.map((r) => r.node), rx];
    let successfulEdges = 0;
    let totalEdges = 0;
    for (let i = 0; i < fullNodes.length - 1; i++) {
      const from = fullNodes[i]!;
      const to = fullNodes[i + 1]!;
      totalEdges++;
      if (confirmedLinks.has(linkKey(from.node_id, to.node_id))) successfulEdges++;
    }
    const packetConfidence = totalEdges > 0 ? successfulEdges / totalEdges : 0;
    confidenceSum += packetConfidence;
    if (packetConfidence >= 0.6) successPackets++;

    for (let i = 0; i < resolved.length; i++) {
      const hop = resolved[i]!;
      const prevPrefix = i > 0 ? resolved[i - 1]!.prefix : '';
      const prefixGroup = `${hop.prefix}|${region}|${prevPrefix}`;
      const choiceKey = `${prefixGroup}|${hop.node.node_id}`;
      increment(prefixChoiceCounts, choiceKey);
      increment(prefixGroupTotals, prefixGroup);
    }

    for (let i = 0; i < fullNodes.length - 1; i++) {
      const from = fullNodes[i]!;
      const to = fullNodes[i + 1]!;
      const group = `${from.node_id}|${region}`;
      const edgeKey = `${group}|${to.node_id}`;
      increment(transitionCounts, edgeKey);
      increment(transitionGroupTotals, group);
    }
  }

  await query('DELETE FROM path_prefix_priors WHERE network = $1', [modelNetwork]);
  await query('DELETE FROM path_transition_priors WHERE network = $1', [modelNetwork]);

  const groupedPrefix = new Map<string, Array<{ nodeId: string; count: number }>>();
  for (const [key, count] of prefixChoiceCounts) {
    const [prefix, region, prevPrefix, nodeId] = key.split('|');
    const groupKey = `${prefix}|${region}|${prevPrefix}`;
    const row = groupedPrefix.get(groupKey) ?? [];
    row.push({ nodeId: nodeId!, count });
    groupedPrefix.set(groupKey, row);
  }

  for (const [groupKey, rows] of groupedPrefix) {
    const [prefix, region, prevPrefix] = groupKey.split('|');
    const total = prefixGroupTotals.get(groupKey) ?? 1;
    for (const row of truncateBest(rows.map((r) => ({ key: r.nodeId, count: r.count })), MAX_PREFIX_CHOICES_PER_GROUP)) {
      await query(
        `INSERT INTO path_prefix_priors
           (network, prefix, receiver_region, prev_prefix, node_id, count, probability, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (network, prefix, receiver_region, prev_prefix, node_id) DO UPDATE SET
           count = EXCLUDED.count,
           probability = EXCLUDED.probability,
           updated_at = NOW()`,
        [modelNetwork, prefix, region, prevPrefix || '', row.key, row.count, row.count / total],
      );
    }
  }

  const groupedTransitions = new Map<string, Array<{ toNodeId: string; count: number }>>();
  for (const [key, count] of transitionCounts) {
    const [fromNodeId, region, toNodeId] = key.split('|');
    const groupKey = `${fromNodeId}|${region}`;
    const row = groupedTransitions.get(groupKey) ?? [];
    row.push({ toNodeId: toNodeId!, count });
    groupedTransitions.set(groupKey, row);
  }

  for (const [groupKey, rows] of groupedTransitions) {
    const [fromNodeId, region] = groupKey.split('|');
    const total = transitionGroupTotals.get(groupKey) ?? 1;
    for (const row of truncateBest(rows.map((r) => ({ key: r.toNodeId, count: r.count })), MAX_TRANSITIONS_PER_GROUP)) {
      await query(
        `INSERT INTO path_transition_priors
           (network, from_node_id, to_node_id, receiver_region, count, probability, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (network, from_node_id, to_node_id, receiver_region) DO UPDATE SET
           count = EXCLUDED.count,
           probability = EXCLUDED.probability,
           updated_at = NOW()`,
        [modelNetwork, fromNodeId, row.key, region, row.count, row.count / total],
      );
    }
  }

  const top1Accuracy = evaluatedPackets > 0 ? successPackets / evaluatedPackets : 0;
  const meanPredConfidence = evaluatedPackets > 0 ? confidenceSum / evaluatedPackets : 0;
  const confidenceScale = meanPredConfidence > 0 ? Math.min(1.6, Math.max(0.65, top1Accuracy / meanPredConfidence)) : 1;
  const recommendedThreshold = Math.min(0.85, Math.max(0.35, 0.45 + (1 - top1Accuracy) * 0.2));

  await query(
    `INSERT INTO path_model_calibration
       (network, evaluated_packets, top1_accuracy, mean_pred_confidence, confidence_scale, recommended_threshold, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (network) DO UPDATE SET
       evaluated_packets = EXCLUDED.evaluated_packets,
       top1_accuracy = EXCLUDED.top1_accuracy,
       mean_pred_confidence = EXCLUDED.mean_pred_confidence,
       confidence_scale = EXCLUDED.confidence_scale,
       recommended_threshold = EXCLUDED.recommended_threshold,
       updated_at = NOW()`,
    [modelNetwork, evaluatedPackets, top1Accuracy, meanPredConfidence, confidenceScale, recommendedThreshold],
  );

  console.log(
    `[path-learning] model=${modelNetwork} source=${sourceNetwork ?? 'all'} packets=${evaluatedPackets} ` +
    `top1=${top1Accuracy.toFixed(3)} scale=${confidenceScale.toFixed(3)}`,
  );
}
