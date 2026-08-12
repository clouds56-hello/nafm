import { DriveIcon, RefreshIcon, ScanIcon, WarningIcon } from "./Icons";

export function DashboardSkeleton() {
  return (
    <main className="page-shell" aria-label="Loading workspace">
      <div className="skeleton-line title" />
      <div className="skeleton-grid"><div className="skeleton-card" /><div className="skeleton-card" /><div className="skeleton-card" /></div>
      <div className="skeleton-map"><span /></div>
    </main>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="full-state error-state">
      <span className="state-icon"><WarningIcon /></span>
      <h1>Workspace unavailable</h1>
      <p>{message}</p>
      <button className="primary-button" type="button" onClick={onRetry}><RefreshIcon />Try again</button>
    </div>
  );
}

export function EmptyWorkspace() {
  return (
    <div className="full-state empty-workspace">
      <span className="state-icon"><DriveIcon /></span>
      <span className="eyebrow">EMPTY WORKSPACE</span>
      <h1>Add your first storage site</h1>
      <p>Use the NAFM CLI to add a local folder or SMB share. It will appear here automatically.</p>
      <code>nafm site add photos ~/Pictures</code>
    </div>
  );
}

export function EmptyMap({ siteName, onScan }: { siteName: string; onScan: () => void }) {
  return (
    <section className="empty-map">
      <span className="state-icon"><ScanIcon /></span>
      <h2>Map {siteName}</h2>
      <p>Scan this site to calculate space health and reveal its folder hierarchy.</p>
      <button className="primary-button" type="button" onClick={onScan}><ScanIcon />Start scan</button>
    </section>
  );
}

export function MapError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="empty-map map-error" role="alert">
      <span className="state-icon"><WarningIcon /></span>
      <h2>Health map unavailable</h2>
      <p>{message}</p>
      <button className="secondary-button" type="button" onClick={onRetry}><RefreshIcon />Try map again</button>
    </section>
  );
}
