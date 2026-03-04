import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { MapView } from './components/Map/MapView.js';
import { NodeSearch } from './components/Map/NodeSearch.js';
import { FilterPanel, FILTER_ROWS, type Filters } from './components/FilterPanel/FilterPanel.js';
import { StatsPanel } from './components/StatsPanel/StatsPanel.js';
import { PacketFeed } from './components/PacketFeed.js';
import { useWebSocket, type WSMessage, type WSReadyState } from './hooks/useWebSocket.js';
import { useNodes, type LivePacketData, type MeshNode, type AggregatedPacket } from './hooks/useNodes.js';
import { useCoverage } from './hooks/useCoverage.js';
import {
  hasCoords,
  linkKey,
  MIN_LINK_OBSERVATIONS,
  resolveBetaPath,
  resolvePathWaypoints,
  type LinkMetrics,
} from './utils/pathing.js';

const DEFAULT_FILTERS: Filters = {
  livePackets:       true,
  coverage:          false,
  clientNodes:       false,
  packetPaths:       false,
  betaPaths:         false,
  betaPathThreshold: 0.5,
  links:             false,
};

// Connectivity indicator
const ConnIndicator: React.FC<{ state: WSReadyState }> = ({ state }) => (
  <div className="conn-indicator">
    <span className={`conn-dot ${state === 'connected' ? 'conn-dot--connected' : ''}`} />
    <span style={{ color: state === 'connected' ? 'var(--online)' : 'var(--text-muted)' }}>
      {state === 'connected' ? 'LIVE' : state === 'connecting' ? 'CONNECTING' : 'OFFLINE'}
    </span>
  </div>
);

// SVG logo icon
const MeshIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="10" cy="4"  r="2" fill="currentColor" />
    <circle cx="3"  cy="16" r="2" fill="currentColor" />
    <circle cx="17" cy="16" r="2" fill="currentColor" />
    <line x1="10" y1="6" x2="3"  y2="14" stroke="currentColor" strokeWidth="1.2" />
    <line x1="10" y1="6" x2="17" y2="14" stroke="currentColor" strokeWidth="1.2" />
    <line x1="3"  y1="16" x2="17" y2="16" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="10" cy="10" r="1.5" fill="currentColor" opacity="0.6" />
  </svg>
);

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const PATH_TTL = 5_000; // ms to display packet path before auto-clearing

const DISCLAIMER_KEY = 'meshcore-disclaimer-dismissed';

const DisclaimerModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="disclaimer-overlay" role="dialog" aria-modal="true" aria-label="Data disclaimer">
    <div className="disclaimer-modal">
      <h2 className="disclaimer-modal__title">Data disclaimer</h2>
      <div className="disclaimer-modal__body">
        <section>
          <h3>Packet paths</h3>
          <p>
            The relay paths shown on this dashboard are a best estimate. MeshCore packets include
            only the first 2 hex characters of each relay node's ID, so when resolving a path we
            match those 2 characters against known nodes. If multiple nodes share the same prefix
            the closest candidate is chosen, but the actual path the packet took may have been
            different.
          </p>
        </section>
        <section>
          <h3>Coverage map</h3>
          <p>
            The green coverage layer is a radio horizon estimate computed from SRTM terrain data.
            It assumes each repeater antenna is mounted <strong>5 metres above ground level</strong>.
            Actual coverage will vary with antenna height, local obstacles, foliage, and radio
            conditions. Treat it as a rough guide, not a guarantee of connectivity.
          </p>
        </section>
      </div>
      <button className="disclaimer-modal__close" onClick={onClose}>Got it</button>
    </div>
  </div>
);

export const App: React.FC = () => {
  const [filters, setFilters]       = useState<Filters>(DEFAULT_FILTERS);
  const [stats, setStats]           = useState({ mqttNodes: 0, staleNodes: 0, packetsDay: 0 });
  const [map, setMap]               = useState<LeafletMap | null>(null);
  const [linkPairs, setLinkPairs]       = useState<Set<string>>(new Set());
  const [linkMetrics, setLinkMetrics]   = useState<Map<string, LinkMetrics>>(new Map());
  const [viablePairsArr, setViablePairsArr] = useState<[string, string][]>([]);
  const [showDisclaimer, setShowDisclaimer] = useState(() => !localStorage.getItem(DISCLAIMER_KEY));
  const [packetPath, setPacketPath]         = useState<[number, number][] | null>(null);
  const [betaPacketPath, setBetaPacketPath] = useState<[number, number][] | null>(null);
  const [pinnedPacketId, setPinnedPacketId] = useState<string | null>(null);
  const pinnedTimerRef                      = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissDisclaimer = useCallback(() => {
    localStorage.setItem(DISCLAIMER_KEY, '1');
    setShowDisclaimer(false);
  }, []);
  const [pathOpacity, setPathOpacity] = useState(0.75);
  const pathTimerRef                = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathFadeRef                 = useRef<number | null>(null);
  const stopPathTimers = useCallback(() => {
    if (pathTimerRef.current) {
      clearTimeout(pathTimerRef.current);
      pathTimerRef.current = null;
    }
    if (pathFadeRef.current !== null) {
      cancelAnimationFrame(pathFadeRef.current);
      pathFadeRef.current = null;
    }
  }, []);
  const clearPathState = useCallback(() => {
    setPacketPath(null);
    setBetaPacketPath(null);
    setPathOpacity(0.75);
  }, []);

  const {
    nodes, packets, arcs, activeNodes,
    handleInitialState, handlePacket, handleNodeUpdate, handleNodeUpsert,
  } = useNodes();

  // 'ukmesh' build sees all data; teesside/default build filters to its own network
  const networkFilter = import.meta.env['VITE_NETWORK'] === 'ukmesh' ? undefined : 'teesside';

  const { coverage, handleCoverageUpdate } = useCoverage(networkFilter);

  const mapNodes = useMemo(() => Array.from(nodes.values()).filter(
    (n) => hasCoords(n)
      && Date.now() - new Date(n.last_seen).getTime() < FOURTEEN_DAYS_MS
      && !n.name?.includes('🚫')
      && (n.role === undefined || n.role === 2)
  ).length, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // All non-sensor, non-hidden nodes ever seen (no recency filter)
  const totalDevices = useMemo(() => Array.from(nodes.values()).filter(
    (n) => !n.name?.includes('🚫') && n.role !== 4
  ).length, [nodes]);

  // Register tile-caching service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Poll stats every 30s
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const statsUrl = networkFilter ? `/api/stats?network=${networkFilter}` : '/api/stats';
        const res = await fetch(statsUrl);
        if (res.ok) setStats(await res.json() as typeof stats);
      } catch { /* ignore */ }
    };
    fetchStats();
    const t = setInterval(fetchStats, 30_000);
    return () => clearInterval(t);
  }, []);

  // Compute dotted path lines from most-recent packet's source → observer.
  // Clears after PATH_TTL ms (with a 1s fade), or immediately when the next
  // distinct packet arrives. Skipped while a packet is pinned by the user.
  const latestId = packets[0]?.id;
  useEffect(() => {
    if (pinnedPacketId !== null) return;
    stopPathTimers();

    const latest = packets[0];
    const rx = latest?.rxNodeId ? nodes.get(latest.rxNodeId) : undefined;

    // ── Regular packet path ────────────────────────────────────────────────────
    if (filters.packetPaths && latest?.rxNodeId && (latest.path?.length || latest.srcNodeId) && hasCoords(rx)) {
      const src = latest.srcNodeId ? (nodes.get(latest.srcNodeId) ?? null) : null;
      const srcWithPos = hasCoords(src) ? src : null;
      const waypoints = latest.path?.length
        ? resolvePathWaypoints(latest.path, srcWithPos, rx, nodes)
        : [[srcWithPos!.lat!, srcWithPos!.lon!], [rx.lat, rx.lon]] as [number, number][];
      setPacketPath(waypoints.length >= 2 ? waypoints : null);
    } else {
      setPacketPath(null);
    }

    // ── Beta path (unambiguous hops + coverage validation) ────────────────────
    if (filters.betaPaths && latest?.rxNodeId && latest.path?.length && hasCoords(rx)) {
      const src    = latest.srcNodeId ? (nodes.get(latest.srcNodeId) ?? null) : null;
      const hops   = latest.hopCount != null ? latest.path.slice(0, latest.hopCount) : latest.path;
      const result = resolveBetaPath(
        hops,
        hasCoords(src) ? src : null,
        rx, nodes, coverage, linkPairs, linkMetrics,
      );
      setBetaPacketPath(result && result.confidence >= filters.betaPathThreshold ? result.path : null);
    } else {
      setBetaPacketPath(null);
    }

    if (!filters.packetPaths && !filters.betaPaths) { setPathOpacity(0.75); return; }
    if (!latest) { setPathOpacity(0.75); return; }

    setPathOpacity(0.75);
    pathTimerRef.current = setTimeout(() => {
      const FADE_MS = 1_000;
      const startTime = performance.now();
      const animate = (now: number) => {
        const t = Math.min(1, (now - startTime) / FADE_MS);
        setPathOpacity(0.75 * (1 - t));
        if (t < 1) {
          pathFadeRef.current = requestAnimationFrame(animate);
        } else {
          pathFadeRef.current = null;
          clearPathState();
        }
      };
      pathFadeRef.current = requestAnimationFrame(animate);
    }, PATH_TTL - 1_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId, filters.packetPaths, filters.betaPaths, pinnedPacketId, linkMetrics]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePacketPin = useCallback((packet: AggregatedPacket) => {
    // Toggle: clicking the already-pinned packet unpins it
    if (pinnedPacketId === packet.id) {
      setPinnedPacketId(null);
      if (pinnedTimerRef.current) { clearTimeout(pinnedTimerRef.current); pinnedTimerRef.current = null; }
      stopPathTimers();
      clearPathState();
      return;
    }

    // Clear any running auto timers
    stopPathTimers();
    if (pinnedTimerRef.current) { clearTimeout(pinnedTimerRef.current); pinnedTimerRef.current = null; }

    const rx = packet.rxNodeId ? nodes.get(packet.rxNodeId) : undefined;

    setPacketPath(null);

    if (packet.rxNodeId && packet.path?.length && hasCoords(rx)) {
      const src  = packet.srcNodeId ? (nodes.get(packet.srcNodeId) ?? null) : null;
      const hops = packet.hopCount != null ? packet.path.slice(0, packet.hopCount) : packet.path;
      const result = resolveBetaPath(
        hops, hasCoords(src) ? src : null, rx, nodes, coverage, linkPairs, linkMetrics,
      );
      setBetaPacketPath(result && result.confidence >= filters.betaPathThreshold ? result.path : null);
    } else {
      setBetaPacketPath(null);
    }

    setPathOpacity(0.75);
    setPinnedPacketId(packet.id);

    // Auto-release after 30s with a 1s fade
    pinnedTimerRef.current = setTimeout(() => {
      const FADE_MS   = 1_000;
      const startTime = performance.now();
      const animate   = (now: number) => {
        const t = Math.min(1, (now - startTime) / FADE_MS);
        setPathOpacity(0.75 * (1 - t));
        if (t < 1) {
          pathFadeRef.current = requestAnimationFrame(animate);
        } else {
          pathFadeRef.current = null;
          clearPathState();
          setPinnedPacketId(null);
          pinnedTimerRef.current = null;
        }
      };
      pathFadeRef.current = requestAnimationFrame(animate);
    }, 30_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedPacketId, nodes, coverage, linkPairs, linkMetrics, filters.betaPaths, filters.betaPathThreshold, stopPathTimers, clearPathState]);

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'initial_state') {
      const data = msg.data as Parameters<typeof handleInitialState>[0] & {
        viable_pairs?: [string, string][];
      };
      handleInitialState(data);
      const viablePairs = data.viable_pairs;
      if (viablePairs) {
        const nextPairs = new Set(viablePairs.map(([a, b]) => linkKey(a, b)));
        setLinkPairs(nextPairs);
        setLinkMetrics(() => {
          const metrics = new Map<string, LinkMetrics>();
          for (const [a, b] of viablePairs) {
            metrics.set(linkKey(a, b), {
              observed_count: MIN_LINK_OBSERVATIONS,
              itm_viable: true,
            });
          }
          return metrics;
        });
        setViablePairsArr(viablePairs);
      }
    } else if (msg.type === 'packet') {
      handlePacket(msg.data as LivePacketData);
    } else if (msg.type === 'node_update') {
      handleNodeUpdate(msg.data as { nodeId: string; ts: number });
    } else if (msg.type === 'node_upsert') {
      handleNodeUpsert(msg.data as Partial<MeshNode> & { node_id: string });
    } else if (msg.type === 'coverage_update') {
      handleCoverageUpdate(msg.data as { node_id: string; geom: { type: string; coordinates: unknown } });
    } else if (msg.type === 'link_update') {
      const d = msg.data as {
        node_a_id: string; node_b_id: string;
        observed_count: number; itm_viable: boolean | null;
        itm_path_loss_db?: number | null;
        count_a_to_b?: number;
        count_b_to_a?: number;
      };
      const key = linkKey(d.node_a_id, d.node_b_id);
      setLinkMetrics((prev) => {
        const next = new Map(prev);
        const existing = next.get(key);
        next.set(key, {
          observed_count: Math.max(existing?.observed_count ?? 0, d.observed_count ?? 0),
          itm_viable: d.itm_viable ?? existing?.itm_viable ?? null,
          itm_path_loss_db: d.itm_path_loss_db ?? existing?.itm_path_loss_db ?? null,
          count_a_to_b: d.count_a_to_b ?? existing?.count_a_to_b,
          count_b_to_a: d.count_b_to_a ?? existing?.count_b_to_a,
        });
        return next;
      });
      if (d.itm_viable && d.observed_count >= MIN_LINK_OBSERVATIONS) {
        setLinkPairs((prev) => {
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        setViablePairsArr((prev) => {
          if (prev.some(([a, b]) => linkKey(a, b) === key)) return prev;
          return [...prev, [d.node_a_id, d.node_b_id]];
        });
      }
    }
  }, [handleInitialState, handlePacket, handleNodeUpdate, handleNodeUpsert, handleCoverageUpdate]);

  const wsState = useWebSocket(handleMessage, networkFilter);

  return (
    <div className="app-shell">
      {/* ── Topbar ─────────────────────────────────────────────────────── */}
      <header className="topbar">
        <a href="https://www.teessidemesh.com" className="topbar__home-btn" title="Home">← Home</a>
        <div className="topbar__logo">
          <MeshIcon />
          MeshCore Analytics
        </div>
        <div className="topbar__divider" />
        <ConnIndicator state={wsState} />
        <button
          className="topbar__info-btn"
          onClick={() => setShowDisclaimer(true)}
          title="Data disclaimer"
          aria-label="Data disclaimer"
        >
          i
        </button>
        <StatsPanel
          mqttNodes={stats.mqttNodes}
          mapNodes={mapNodes}
          totalDevices={totalDevices}
          staleNodes={stats.staleNodes}
          packetsDay={stats.packetsDay}
        />
      </header>

      {/* ── Mobile controls: 2x2 filter grid + search (in grid flow, above map) ── */}
      <div className="mobile-controls">
        <div className="mobile-filter-grid">
          {FILTER_ROWS.map(({ key, label, color, hollow }) => (
            <div
              key={key}
              className={`filter-row${filters[key] ? ' filter-row--on' : ''}`}
              onClick={() => setFilters({ ...filters, [key]: !filters[key] })}
              role="button"
              aria-pressed={!!filters[key]}
            >
              <span className="filter-row__label">
                {hollow ? (
                  <span className="filter-dot filter-dot--hollow" style={{ borderColor: color, opacity: filters[key] ? 1 : 0.4 }} />
                ) : (
                  <span className="filter-dot" style={{ background: color, opacity: filters[key] ? 1 : 0.3 }} />
                )}
                {label}
              </span>
              <span
                className={`filter-toggle${filters[key] ? ' filter-toggle--on' : ''}`}
                style={filters[key] ? { background: `${color}22`, borderColor: color } : {}}
              />
            </div>
          ))}
        </div>
        <div className="mobile-search">
          <NodeSearch map={map} nodes={nodes} />
        </div>
      </div>

      {/* ── Map + Overlays ─────────────────────────────────────────────── */}
      <MapView
        nodes={nodes}
        arcs={arcs}
        activeNodes={activeNodes}
        coverage={coverage}
        showPackets={filters.livePackets}
        showCoverage={filters.coverage}
        showClientNodes={filters.clientNodes}
        showLinks={filters.links}
        viablePairsArr={viablePairsArr}
        packetPath={packetPath}
        betaPath={betaPacketPath}
        showBetaPaths={filters.betaPaths || pinnedPacketId !== null}
        pathOpacity={pathOpacity}
        onMapReady={setMap}
      />

      {/* ── Filter Panel (desktop only — absolute overlay) ──────────────── */}
      <FilterPanel filters={filters} onChange={setFilters} />

      {/* ── Live Packet Feed ───────────────────────────────────────────── */}
      {filters.livePackets && (
        <PacketFeed
          packets={packets}
          nodes={nodes}
          onPacketClick={handlePacketPin}
          pinnedPacketId={pinnedPacketId}
        />
      )}

      {/* ── Disclaimer modal ───────────────────────────────────────────── */}
      {showDisclaimer && <DisclaimerModal onClose={dismissDisclaimer} />}
    </div>
  );
};
