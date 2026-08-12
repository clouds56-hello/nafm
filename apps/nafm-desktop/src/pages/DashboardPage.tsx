import { AppHeader } from "../components/AppHeader";
import { ReviewDrawer } from "../components/ReviewDrawer";
import { SiteGrid } from "../components/SiteGrid";
import { DashboardSkeleton, EmptyMap, EmptyWorkspace, ErrorState } from "../components/States";
import { StorageExplorer } from "../components/StorageExplorer";
import { useDashboard } from "../hooks/useDashboard";
import { CloseIcon } from "../components/Icons";

export function DashboardPage() {
  const state = useDashboard();

  if (state.loading) return <DashboardSkeleton />;
  if (state.error) return <ErrorState message={state.error} onRetry={() => void state.refresh()} />;
  if (!state.dashboard || state.dashboard.sites.length === 0) return <EmptyWorkspace />;

  return (
    <div className="app-frame">
      <AppHeader
        stagedCount={state.dashboard.staged.length}
        activeTaskCount={state.activeTaskCount}
        onScanAll={() => void state.scan()}
        onOpenReview={() => state.setReviewOpen(true)}
      />
      <main className="page-shell">
        {state.notice && (
          <div className="toast" role="status">
            <span>{state.notice}</span>
            <button type="button" onClick={state.clearNotice} aria-label="Dismiss"><CloseIcon /></button>
          </div>
        )}
        <SiteGrid
          sites={state.dashboard.sites}
          activeSiteId={state.activeSiteId}
          progressBySite={state.progressBySite}
          onSelect={(siteId) => void state.selectSite(siteId)}
          onScan={(siteId) => void state.scan(siteId)}
          onCancel={(requestId) => void state.cancel(requestId)}
        />
        {state.treeLoading ? (
          <div className="map-loading"><div className="skeleton-map"><span /></div></div>
        ) : state.activeSite && state.activeTree && state.selectedNode && (state.activeTree.root.file_count > 0 || state.activeTree.root.children.length > 0) ? (
          <StorageExplorer
            siteName={state.activeSite.name}
            tree={state.activeTree}
            node={state.selectedNode}
            staged={state.isSelectedStaged}
            stagingBusy={state.stagingBusy}
            onSelectNode={state.selectNode}
            onStage={() => void state.stageSelected()}
            onUnstage={() => state.selectedNode?.path && void state.removeStaged(state.selectedNode.path)}
          />
        ) : state.activeSite ? (
          <EmptyMap siteName={state.activeSite.name} onScan={() => void state.scan(state.activeSite!.id)} />
        ) : null}
      </main>
      <ReviewDrawer
        open={state.reviewOpen}
        staged={state.dashboard.staged}
        preview={state.preview}
        loadingPreview={state.previewLoading}
        error={state.reviewError}
        onClose={() => state.setReviewOpen(false)}
        onPreview={() => void state.runPreview()}
        onRemove={(path) => void state.removeStaged(path)}
      />
    </div>
  );
}
