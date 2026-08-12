import type { ScanProgressView, SiteOverview } from "../lib/types";
import { SiteCard } from "./SiteCard";

interface SiteGridProps {
  sites: SiteOverview[];
  activeSiteId: string | null;
  progressBySite: Map<string, ScanProgressView>;
  onSelect: (siteId: string) => void;
  onScan: (siteId: string) => void;
  onCancel: (requestId: number) => void;
}

export function SiteGrid({ sites, activeSiteId, progressBySite, onSelect, onScan, onCancel }: SiteGridProps) {
  return (
    <aside className="sites-section" aria-labelledby="sites-title">
      <header className="site-rail-heading">
        <div><span className="eyebrow">WORKSPACE</span><h1 id="sites-title">Sites</h1></div>
        <span className="site-count">{sites.length}</span>
      </header>
      <div className="site-grid">
        {sites.map((site) => (
          <SiteCard
            key={site.id}
            site={site}
            progress={progressBySite.get(site.id)}
            active={site.id === activeSiteId}
            onSelect={() => onSelect(site.id)}
            onScan={() => onScan(site.id)}
            onCancel={onCancel}
          />
        ))}
      </div>
    </aside>
  );
}
