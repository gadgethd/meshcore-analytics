import React from 'react';
import { getCurrentSite } from '../config/site.js';
import { SiteLayout } from './shared/SiteLayout.js';

export const Layout: React.FC = () => {
  const site = getCurrentSite();
  return (
    <SiteLayout
      brandName={site.displayName}
      footerName={site.footerName}
      appUrl={site.appUrl}
      showPackets
      showStats
    />
  );
};
