import { useEffect } from "react";
import { AppHeader } from "../components/AppHeader";
import { ReviewDrawer } from "../components/ReviewDrawer";
import { SiteGrid } from "../components/SiteGrid";
import { DashboardSkeleton, EmptyMap, EmptyWorkspace, ErrorState, MapError } from "../components/States";
import { StorageExplorer } from "../components/StorageExplorer";
import { useDashboard } from "../hooks/useDashboard";
import { CloseIcon } from "../components/Icons";
import type { WorkspaceSummary } from "../lib/types";
import type { ManagementSection } from "../components/ManagementCenter";

interface DashboardPageProps {
  workspaceName: string | null;
  workspaces: WorkspaceSummary[];
  managementLoading: boolean;
  workspaceSwitching: boolean;
  onSwitchWorkspace: (name: string) => void;
  onOpenManagement: (section: ManagementSection, siteId?: string | null) => void;
  onActiveTaskCountChange: (count: number) => void;
}

export function DashboardPage({
  workspaceName,
  workspaces,
  managementLoading,
  workspaceSwitching,
  onSwitchWorkspace,
  onOpenManagement,
  onActiveTaskCountChange,
}: DashboardPageProps) {
  const state = useDashboard(workspaceName);

  useEffect(() => {
    onActiveTaskCountChange(state.activeTaskCount);
  }, [onActiveTaskCountChange, state.activeTaskCount]);

  const stagedCount = state.dashboard?.staged.length ?? 0;

  return (
    <div className="app-frame">
      <AppHeader
        stagedCount={stagedCount}
        activeTaskCount={state.activeTaskCount}
        workspaceName={workspaceName}
        workspaces={workspaces}
        managementLoading={managementLoading}
        workspaceSwitching={workspaceSwitching}
        scanAvailable={Boolean(state.dashboard?.sites.length)}
        reviewAvailable={Boolean(state.dashboard)}
        onScanAll={() => void state.scan()}
        onOpenReview={() => state.setReviewOpen(true)}
        onSwitchWorkspace={onSwitchWorkspace}
        onOpenManagement={() => onOpenManagement("workspaces")}
        onCreateWorkspace={() => onOpenManagement("workspaces")}
      />
      {state.loading ? (
        <DashboardSkeleton embedded />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={() => void state.refresh()} embedded />
      ) : !state.dashboard || state.dashboard.sites.length === 0 ? (
        <EmptyWorkspace onAddSite={() => onOpenManagement("sites")} />
      ) : (
        <main className="workspace-shell">
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
          onAdd={() => onOpenManagement("sites")}
          onManage={(siteId) => onOpenManagement("sites", siteId)}
        />
        <div className="workspace-main">
          {state.treeLoading ? (
            <div className="map-loading"><div className="skeleton-map"><span /></div></div>
          ) : state.treeError ? (
            <MapError message={state.treeError} onRetry={() => void state.retryTree()} />
          ) : state.activeSite && state.activeTree && state.location && state.selectedNode && (state.activeTree.root.file_count > 0 || state.activeTree.root.children.length > 0) ? (
            <StorageExplorer
              workspaceName={state.dashboard.workspace_name}
              contentRevision={state.contentRevision}
              sites={state.dashboard.sites}
              source={state.activeSite}
              target={state.coverageTargetSite}
              tree={state.activeTree}
              location={state.location}
              node={state.selectedNode}
              metric={state.healthMetric}
              staged={state.isSelectedStaged}
              stagingBusy={state.stagingBusy}
              childrenPage={state.childrenPage}
              childrenLoading={state.childrenLoading}
              childrenError={state.childrenError}
              canGoBack={state.canGoBack}
              canGoForward={state.canGoForward}
              canGoUp={state.canGoUp}
              canLoadPrevious={state.canLoadPrevious}
              canLoadNext={state.canLoadNext}
              childrenRangeStart={state.childrenRangeStart}
              childrenRangeEnd={state.childrenRangeEnd}
              onMetricChange={state.setHealthMetric}
              onTargetChange={(siteId) => void state.selectCoverageTarget(siteId)}
              onSwap={() => void state.swapCoverageSites()}
              onScanTarget={() => state.coverageTargetSite && void state.scan(state.coverageTargetSite.id)}
              onSelectNode={state.selectNode}
              onBack={state.goBack}
              onForward={state.goForward}
              onUp={state.goUp}
              onNavigateBreadcrumb={state.navigateBreadcrumb}
              onRetryChildren={state.retryChildren}
              onLoadPreviousChildren={state.loadPreviousChildren}
              onLoadNextChildren={state.loadNextChildren}
              onStage={() => void state.stageSelected()}
              onUnstage={() => state.selectedNode?.path && void state.removeStaged(state.selectedNode.path)}
            />
          ) : state.activeSite ? (
            <EmptyMap siteName={state.activeSite.name} onScan={() => void state.scan(state.activeSite!.id)} />
          ) : null}
        </div>
        </main>
      )}
      {state.dashboard && (
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
      )}
    </div>
  );
}
