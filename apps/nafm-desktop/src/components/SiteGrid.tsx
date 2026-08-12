import type { ScanProgressView, SiteOverview } from "../lib/types";
import { SiteCard } from "./SiteCard";

interface SiteGridProps {
  sites: SiteOverview[];
  activeSiteId: string | null;
  progressBySite: Map<string, ScanProgressView>;
  onSelect: (siteId: string) => void;
  onScan: (siteId: string) => void;
  onCancel: (requestId: number) => void;
  onAdd: () => void;
  onManage: (siteId: string) => void;
}

export function SiteGrid({ sites, activeSiteId, progressBySite, onSelect, onScan, onCancel, onAdd, onManage }: SiteGridProps) {
  return (
    <aside className="sites-section" aria-labelledby="sites-title">
      <header className="site-rail-heading">
        <div><span className="eyebrow">WORKSPACE</span><h1 id="sites-title">Sites</h1></div>
        <span className="site-heading-actions"><span className="site-count">{sites.length}</span><button className="site-add-button" type="button" onClick={onAdd} aria-label="Add site">+</button></span>
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
            onManage={() => onManage(site.id)}
          />
        ))}
      </div>
    </aside>
  );
}
