import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { MapView } from './components/Map/MapView.js';
import { FilterPanel, type Filters } from './components/FilterPanel/FilterPanel.js';
import { PacketFeed } from './components/PacketFeed.js';
import { DisclaimerModal } from './components/app/DisclaimerModal.js';
import { AppTopBar } from './components/app/AppTopBar.js';
import { MobileControls } from './components/app/MobileControls.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useNodes } from './hooks/useNodes.js';
import { useCoverage } from './hooks/useCoverage.js';
import { useDashboardStats } from './hooks/useDashboardStats.js';
import { useLinkState } from './hooks/useLinkState.js';
import { usePacketPathOverlay } from './hooks/usePacketPathOverlay.js';
import { useAppMessageHandler } from './hooks/useAppMessageHandler.js';
import { getCurrentSite } from './config/site.js';
import { hasCoords } from './utils/pathing.js';

const DEFAULT_FILTERS: Filters = {
  livePackets: true,
  coverage: false,
  clientNodes: false,
  packetPaths: false,
  betaPaths: false,
  betaPathThreshold: 0.5,
  links: false,
};

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const DISCLAIMER_KEY = 'meshcore-disclaimer-dismissed';

export const App: React.FC = () => {
  const site = getCurrentSite();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [map, setMap] = useState<LeafletMap | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(() => !localStorage.getItem(DISCLAIMER_KEY));

  const {
    nodes,
    packets,
    arcs,
    activeNodes,
    handleInitialState,
    handlePacket,
    handleNodeUpdate,
    handleNodeUpsert,
  } = useNodes();

  // 'ukmesh' build sees all data; teesside/default build filters to its own network
  const networkFilter = import.meta.env['VITE_NETWORK'] === 'ukmesh' ? undefined : site.network;

  const { coverage, handleCoverageUpdate } = useCoverage(networkFilter);
  const stats = useDashboardStats(networkFilter);

  const {
    linkPairs,
    linkMetrics,
    viablePairsArr,
    applyInitialViablePairs,
    applyLinkUpdate,
  } = useLinkState();

  const {
    packetPath,
    betaPacketPath,
    pathOpacity,
    pinnedPacketId,
    handlePacketPin,
  } = usePacketPathOverlay({
    packets,
    nodes,
    coverage,
    linkPairs,
    linkMetrics,
    filters,
  });

  const mapNodes = useMemo(() => Array.from(nodes.values()).filter(
    (node) => hasCoords(node)
      && Date.now() - new Date(node.last_seen).getTime() < FOURTEEN_DAYS_MS
      && !node.name?.includes('🚫')
      && (node.role === undefined || node.role === 2),
  ).length, [nodes]);

  const totalDevices = useMemo(() => Array.from(nodes.values()).filter(
    (node) => !node.name?.includes('🚫') && node.role !== 4,
  ).length, [nodes]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  const dismissDisclaimer = useCallback(() => {
    localStorage.setItem(DISCLAIMER_KEY, '1');
    setShowDisclaimer(false);
  }, []);

  const handleMessage = useAppMessageHandler({
    handleInitialState,
    handlePacket,
    handleNodeUpdate,
    handleNodeUpsert,
    handleCoverageUpdate,
    applyInitialViablePairs,
    applyLinkUpdate,
  });

  const wsState = useWebSocket(handleMessage, networkFilter);

  return (
    <div className="app-shell">
      <AppTopBar
        homeUrl={site.appHomeUrl}
        wsState={wsState}
        onShowDisclaimer={() => setShowDisclaimer(true)}
        stats={stats}
        mapNodes={mapNodes}
        totalDevices={totalDevices}
      />

      <MobileControls
        map={map}
        nodes={nodes}
        filters={filters}
        onFiltersChange={setFilters}
      />

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
        linkMetrics={linkMetrics}
        packetPath={packetPath}
        betaPath={betaPacketPath}
        showBetaPaths={filters.betaPaths || pinnedPacketId !== null}
        pathOpacity={pathOpacity}
        onMapReady={setMap}
      />

      <FilterPanel filters={filters} onChange={setFilters} />

      {filters.livePackets && (
        <PacketFeed
          packets={packets}
          nodes={nodes}
          onPacketClick={handlePacketPin}
          pinnedPacketId={pinnedPacketId}
        />
      )}

      {showDisclaimer && <DisclaimerModal onClose={dismissDisclaimer} />}
    </div>
  );
};
