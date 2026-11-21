import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { DirectoryTape } from "./atlas/DirectoryTape";
import { RadialAtlas } from "./atlas/RadialAtlas";
import { SourceLibrary } from "./atlas/SourceLibrary";
import { StorageDetails } from "./atlas/StorageDetails";
import { useAtlas } from "./atlas/useAtlas";
import { formatCount } from "./lib/format";
import type { ScanPhase } from "./lib/types";
import "./styles/atlas.css";

const phases: Record<ScanPhase, string> = {
  discovering: "Finding files",
  publishing_metadata: "Saving inventory",
  hashing: "Verifying files",
  finalizing: "Finishing scan",
};

function EmptyOrbit({ label }: { label: string }) {
  return (
    <div className="atlas-empty-orbit" role="status">
      <span>{label}</span>
    </div>
  );
}

export default function App() {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const atlas = useAtlas();
  const { catalog, site, selected, snapshot, liveProgress } = atlas;
  const folder = snapshot?.location.root;
  const breadcrumbs = snapshot?.location.breadcrumbs ?? [];
  const parent = breadcrumbs.at(-2);
  const scanning = site ? atlas.scanningIds.has(site.id) : false;
  const stopping = site?.scan_state === "cancelling";
  const progressLabel = stopping ? "Stopping scan" : liveProgress?.phase ? phases[liveProgress.phase] : "Scanning";
  const hasTrafficLights = isTauri() && /Mac/.test(navigator.platform);
  return (
    <div className="atlas-shell">
      <header className={`atlas-topbar${hasTrafficLights ? " atlas-native-inset" : ""}`} data-tauri-drag-region>
        <div className="atlas-brand" data-tauri-drag-region>
          <span className="atlas-brand-symbol" aria-hidden="true" />
          <span data-tauri-drag-region>NAFM</span>
        </div>
        <span className="atlas-topbar-rule" aria-hidden="true" />
        {catalog && <span className="atlas-workspace" title={catalog.workspace_name}>{catalog.workspace_name}</span>}
        <div className="atlas-drag-space" data-tauri-drag-region />
        <button
          className="atlas-sources-button"
          type="button"
          onClick={() => setSourcesOpen(true)}
          disabled={!catalog}
          aria-haspopup="dialog"
          aria-expanded={sourcesOpen}
        >
          <span className="atlas-source-glyph" aria-hidden="true"><i /><i /><i /></span>
          Sources
          {catalog && <span className="atlas-source-count">{formatCount(catalog.sites.length)}</span>}
        </button>
      </header>

      <main className="atlas-main">
        <div className="atlas-stage">
          <section className="atlas-heading" aria-labelledby="atlas-site-heading">
            <p className="atlas-kicker">Storage map</p>
            <h1 id="atlas-site-heading" title={site?.name}>{site?.name ?? "Explore your storage"}</h1>
            {site ? (
              <>
                <p className="atlas-site-path" title={site.location}>{site.location}</p>
                <div className="atlas-scan-controls">
                  <button className="atlas-text-button" type="button" onClick={() => atlas.scan(site.id)} disabled={scanning}>
                    <span className="atlas-scan-dot" data-active={scanning || undefined} aria-hidden="true" />
                    {scanning ? progressLabel : site.last_scanned_at ? "Scan again" : "Scan source"}
                  </button>
                  {scanning && !stopping && atlas.canCancel(site.id) && (
                    <button className="atlas-stop-button" type="button" onClick={() => atlas.stopScan(site.id)}>Cancel</button>
                  )}
                </div>
              </>
            ) : catalog ? (
              <>
                <p className="atlas-site-path">Add a folder or network share to map its files.</p>
                <button className="atlas-action" type="button" onClick={() => setSourcesOpen(true)}>Add a source</button>
              </>
            ) : atlas.catalogError ? (
              <>
                <p className="atlas-site-path" role="alert">{atlas.catalogError}</p>
                <button className="atlas-action" type="button" onClick={() => void atlas.refreshCatalog()}>Try again</button>
              </>
            ) : null}
          </section>

          <section className="atlas-visualization" aria-label="Circular storage map">
            {parent ? (
              <nav className="atlas-crumbs" aria-label="Folder path">
                <button className="atlas-up" type="button" aria-label={`Up to ${parent.name}`} onClick={() => atlas.selectNode(parent)}>↑</button>
                <ol>
                  {breadcrumbs.map((crumb, index) => (
                    <li key={crumb.id}>
                      {index > 0 && <span className="atlas-crumb-divider" aria-hidden="true">/</span>}
                      {index === breadcrumbs.length - 1 ? (
                        <span aria-current="location" title={crumb.name}>{crumb.name}</span>
                      ) : (
                        <button type="button" onClick={() => atlas.selectNode(crumb)} title={crumb.name}>{crumb.name}</button>
                      )}
                    </li>
                  ))}
                </ol>
              </nav>
            ) : folder && folder.file_count > 0 ? (
              <p className="atlas-map-guide">
                {folder.total_bytes > 0 ? "Arc length shows size." : "Arc length shows file count."} Each ring goes one level deeper.
              </p>
            ) : null}
            {folder ? (
              <RadialAtlas root={folder} selectedId={selected?.id ?? null} onSelect={atlas.selectNode} />
            ) : (
              <EmptyOrbit
                label={atlas.viewError || atlas.catalogError ? "Map unavailable" : !catalog || atlas.loading ? "Reading inventory" : "No source selected"}
              />
            )}
            {atlas.viewError && !folder && (
              <div className="atlas-view-error" role="alert">
                <span>{atlas.viewError}</span>
                <button className="atlas-text-button" type="button" onClick={atlas.retryView}>Retry</button>
              </div>
            )}
          </section>

          {snapshot && <StorageDetails snapshot={snapshot} selected={selected} />}
        </div>

        {folder && snapshot && (
          <DirectoryTape
            directory={folder}
            selection={selected}
            children={snapshot.page.children}
            offset={snapshot.page.offset}
            total={snapshot.page.total_children}
            loading={atlas.loading}
            error={atlas.viewError}
            onSelect={atlas.selectNode}
            onOffset={atlas.paginate}
            onRetry={atlas.retryView}
          />
        )}
      </main>

      {!sourcesOpen && (atlas.taskError || (catalog && atlas.catalogError)) && (
        <div className="atlas-alert" role="alert">
          <span>{atlas.taskError ?? atlas.catalogError}</span>
          <button
            className="atlas-text-button"
            type="button"
            onClick={atlas.taskError ? atlas.dismissTaskError : () => void atlas.refreshCatalog()}
          >
            {atlas.taskError ? "Dismiss" : "Retry"}
          </button>
        </div>
      )}

      {sourcesOpen && (
        <SourceLibrary
          sites={catalog?.sites ?? []}
          workspaceName={catalog?.workspace_name ?? null}
          activeId={site?.id ?? null}
          onSelect={(id) => { atlas.selectSite(id); setSourcesOpen(false); }}
          onClose={() => setSourcesOpen(false)}
          onChanges={() => void atlas.refreshCatalog()}
          scanningIds={atlas.scanningIds}
          onScan={atlas.scan}
          onCancelScan={atlas.stopScan}
          error={atlas.taskError ?? atlas.catalogError}
          errorAction={atlas.taskError
            ? { label: "Dismiss", run: atlas.dismissTaskError }
            : { label: "Retry", run: () => void atlas.refreshCatalog() }}
        />
      )}
    </div>
  );
}
