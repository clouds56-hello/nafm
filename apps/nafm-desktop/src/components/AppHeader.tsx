import { LayersIcon, ScanIcon } from "./Icons";

interface AppHeaderProps {
  stagedCount: number;
  activeTaskCount: number;
  onScanAll: () => void;
  onOpenReview: () => void;
}

export function AppHeader({ stagedCount, activeTaskCount, onScanAll, onOpenReview }: AppHeaderProps) {
  const scanning = activeTaskCount > 0;
  return (
    <header className="app-header">
      <div className="brand" aria-label="NAFM home">
        <span className="brand-mark"><span /></span>
        <span>NAFM</span>
      </div>
      <nav className="header-actions" aria-label="Workspace actions">
        <button className="ghost-button review-button" type="button" onClick={onOpenReview}>
          <LayersIcon />
          Review
          {stagedCount > 0 && <span className="count-pill">{stagedCount}</span>}
        </button>
        <button className="primary-button" type="button" onClick={onScanAll} disabled={scanning}>
          <ScanIcon />
          {scanning ? `Scanning ${activeTaskCount}` : "Scan all"}
        </button>
      </nav>
    </header>
  );
}
