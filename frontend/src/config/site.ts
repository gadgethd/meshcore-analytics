export type SiteId = 'teesside' | 'ukmesh';

type SiteConfig = {
  id: SiteId;
  displayName: string;
  footerName: string;
  network: SiteId;
  appUrl: string;
  appHomeUrl: string;
  mapHomeUrl: string;
};

const SITE_CONFIGS: Record<SiteId, SiteConfig> = {
  teesside: {
    id: 'teesside',
    displayName: 'Teesside Mesh',
    footerName: 'Teesside Mesh Network',
    network: 'teesside',
    appUrl: 'https://app.teessidemesh.com',
    appHomeUrl: 'https://www.teessidemesh.com',
    mapHomeUrl: 'https://app.teessidemesh.com',
  },
  ukmesh: {
    id: 'ukmesh',
    displayName: 'UK Mesh',
    footerName: 'UK Mesh Network',
    network: 'ukmesh',
    appUrl: 'https://app.ukmesh.com',
    appHomeUrl: 'https://www.ukmesh.com',
    mapHomeUrl: 'https://app.ukmesh.com',
  },
};

export function getCurrentSite(): SiteConfig {
  const site = import.meta.env['VITE_SITE'];
  return site === 'ukmesh' ? SITE_CONFIGS.ukmesh : SITE_CONFIGS.teesside;
}

