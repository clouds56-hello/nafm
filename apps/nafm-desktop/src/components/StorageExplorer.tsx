import { useCallback, useEffect, useRef, useState } from "react";
import { formatHealth, healthColor } from "../lib/format";
import { getStorageChildren } from "../lib/tauri";
import type {
  HealthMetric,
  SiteOverview,
  StorageChildrenPage,
  StorageLocation,
  StorageNode,
  StorageTree,
} from "../lib/types";
import { HealthControls } from "./HealthControls";
import { InspectorPanel } from "./InspectorPanel";
import { SunburstMap } from "./SunburstMap";

interface StorageExplorerProps {
  sites: SiteOverview[];
  source: SiteOverview;
  target: SiteOverview | null;
  tree: StorageTree;
  location: StorageLocation;
  node: StorageNode;
  metric: HealthMetric;
  staged: boolean;
  stagingBusy: boolean;
  childrenPage: StorageChildrenPage | null;
  childrenLoading: boolean;
  childrenError: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  childrenRangeStart: number;
  childrenRangeEnd: number;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
  onScanTarget: () => void;
  onSelectNode: (node: StorageNode) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onNavigateBreadcrumb: (node: StorageNode) => void;
  onRetryChildren: () => void;
  onLoadPreviousChildren: () => void;
  onLoadNextChildren: () => void;
  onStage: () => void;
  onUnstage: () => void;
}

interface PreviewPageState {
  page: StorageChildrenPage | null;
  loading: boolean;
  error: string | null;
}

const PREVIEW_PAGE_SIZE = 6;
const PREVIEW_RESTORE_DELAY_MS = 100;
const PREVIEW_CACHE_LIMIT = 128;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unable to load preview contents.";
}

function previewKey(
  sourceSiteId: string,
  targetSiteId: string | null,
  nodeId: string,
  offset: number,
): string {
  return `${sourceSiteId}\u0000${targetSiteId ?? ""}\u0000${nodeId}\u0000${offset}`;
}

export function StorageExplorer({
  sites,
  source,
  target,
  tree,
  location,
  node,
  metric,
  staged,
  stagingBusy,
  childrenPage,
  childrenLoading,
  childrenError,
  canGoBack,
  canGoForward,
  canGoUp,
  canLoadPrevious,
  canLoadNext,
  childrenRangeStart,
  childrenRangeEnd,
  onMetricChange,
  onTargetChange,
  onSwap,
  onScanTarget,
  onSelectNode,
  onBack,
  onForward,
  onUp,
  onNavigateBreadcrumb,
  onRetryChildren,
  onLoadPreviousChildren,
  onLoadNextChildren,
  onStage,
  onUnstage,
}: StorageExplorerProps) {
  const [previewNode, setPreviewNode] = useState<StorageNode | null>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [previewPageState, setPreviewPageState] = useState<PreviewPageState>({
    page: null,
    loading: false,
    error: null,
  });
  const previewCacheRef = useRef<Map<string, StorageChildrenPage>>(new Map());
  const previewRequestsRef = useRef<Map<string, Promise<StorageChildrenPage>>>(new Map());
  const previewGenerationRef = useRef(0);
  const previewRequestRef = useRef(0);
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewNodeRef = useRef<StorageNode | null>(null);
  const score = tree.root[metric];
  const coverageWithoutTarget = metric === "coverage_health" && !target;
  const previewing = previewNode !== null;
  const inspectedPage = previewing ? previewPageState.page : childrenPage;
  const inspectedNode = previewing ? inspectedPage?.parent ?? previewNode : node;
  const previewedNodeCanHaveChildren = inspectedNode.kind !== "file" && inspectedNode.kind !== "smaller_items";
  const inspectedLoading = previewing ? previewPageState.loading : childrenLoading;
  const inspectedError = previewing ? previewPageState.error : childrenError;
  const inspectedRangeStart = previewing && inspectedPage && inspectedPage.total_children > 0
    ? inspectedPage.offset + 1
    : previewing
      ? 0
      : childrenRangeStart;
  const inspectedRangeEnd = previewing && inspectedPage
    ? Math.min(inspectedPage.offset + inspectedPage.children.length, inspectedPage.total_children)
    : previewing
      ? 0
      : childrenRangeEnd;
  const previewCanLoadPrevious = Boolean(previewing && inspectedPage && !inspectedLoading && inspectedPage.offset > 0);
  const previewCanLoadNext = Boolean(previewing && inspectedPage && !inspectedLoading
    && inspectedPage.offset + inspectedPage.limit < inspectedPage.total_children);

  const cancelPreviewRestore = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current);
      restoreTimeoutRef.current = null;
    }
  }, []);

  const clearPreview = useCallback(() => {
    cancelPreviewRestore();
    previewRequestRef.current += 1;
    previewNodeRef.current = null;
    setPreviewNode(null);
    setPreviewOffset(0);
    setPreviewPageState({ page: null, loading: false, error: null });
  }, [cancelPreviewRestore]);

  const loadPreviewPage = useCallback(async (previewedNode: StorageNode, offset: number) => {
    const key = previewKey(source.id, target?.id ?? null, previewedNode.id, offset);
    const cachedPage = previewCacheRef.current.get(key);
    if (cachedPage) {
      previewRequestRef.current += 1;
      previewCacheRef.current.delete(key);
      previewCacheRef.current.set(key, cachedPage);
      setPreviewPageState({ page: cachedPage, loading: false, error: null });
      return;
    }

    const requestId = previewRequestRef.current + 1;
    const generation = previewGenerationRef.current;
    previewRequestRef.current = requestId;
    setPreviewPageState({ page: null, loading: true, error: null });
    let request: Promise<StorageChildrenPage> | undefined;
    try {
      request = previewRequestsRef.current.get(key);
      if (!request) {
        request = getStorageChildren(
          source.id,
          target?.id ?? null,
          previewedNode.id,
          offset,
          PREVIEW_PAGE_SIZE,
        );
        previewRequestsRef.current.set(key, request);
      }
      const page = await request;
      if (previewRequestsRef.current.get(key) === request) previewRequestsRef.current.delete(key);
      if (previewGenerationRef.current !== generation) return;
      previewCacheRef.current.set(key, page);
      while (previewCacheRef.current.size > PREVIEW_CACHE_LIMIT) {
        const oldestKey = previewCacheRef.current.keys().next().value;
        if (oldestKey === undefined) break;
        previewCacheRef.current.delete(oldestKey);
      }
      if (previewRequestRef.current !== requestId || previewNodeRef.current?.id !== previewedNode.id) return;
      setPreviewPageState({ page, loading: false, error: null });
    } catch (previewError) {
      if (request && previewRequestsRef.current.get(key) === request) previewRequestsRef.current.delete(key);
      if (previewGenerationRef.current !== generation) return;
      if (previewRequestRef.current !== requestId || previewNodeRef.current?.id !== previewedNode.id) return;
      setPreviewPageState({ page: null, loading: false, error: errorMessage(previewError) });
    }
  }, [source.id, target?.id]);

  useEffect(() => {
    previewGenerationRef.current += 1;
    previewCacheRef.current.clear();
    previewRequestsRef.current.clear();
    clearPreview();
  }, [clearPreview, source.id, target?.id, tree]);

  useEffect(() => clearPreview(), [clearPreview, node.id]);

  useEffect(() => clearPreview(), [clearPreview, location.root.id]);

  useEffect(() => () => {
    cancelPreviewRestore();
    previewGenerationRef.current += 1;
    previewRequestRef.current += 1;
    previewRequestsRef.current.clear();
  }, [cancelPreviewRestore]);

  const preview = useCallback((next: StorageNode) => {
    cancelPreviewRestore();
    if (previewNodeRef.current?.id === next.id) return;
    previewNodeRef.current = next;
    setPreviewNode(next);
    setPreviewOffset(0);
    if (next.kind === "file" || next.kind === "smaller_items") {
      previewRequestRef.current += 1;
      setPreviewPageState({ page: null, loading: false, error: null });
    } else {
      void loadPreviewPage(next, 0);
    }
  }, [cancelPreviewRestore, loadPreviewPage]);

  const leavePreview = useCallback(() => {
    if (!previewNodeRef.current || restoreTimeoutRef.current !== null) return;
    restoreTimeoutRef.current = setTimeout(clearPreview, PREVIEW_RESTORE_DELAY_MS);
  }, [clearPreview]);

  const retryPreview = useCallback(() => {
    if (previewNodeRef.current) void loadPreviewPage(previewNodeRef.current, previewOffset);
  }, [loadPreviewPage, previewOffset]);

  const loadPreviousPreview = useCallback(() => {
    const previewedNode = previewNodeRef.current;
    if (!previewedNode || !previewCanLoadPrevious) return;
    const previousOffset = Math.max(0, previewOffset - PREVIEW_PAGE_SIZE);
    setPreviewOffset(previousOffset);
    void loadPreviewPage(previewedNode, previousOffset);
  }, [loadPreviewPage, previewCanLoadPrevious, previewOffset]);

  const loadNextPreview = useCallback(() => {
    const previewedNode = previewNodeRef.current;
    if (!previewedNode || !previewCanLoadNext) return;
    const nextOffset = previewOffset + PREVIEW_PAGE_SIZE;
    setPreviewOffset(nextOffset);
    void loadPreviewPage(previewedNode, nextOffset);
  }, [loadPreviewPage, previewCanLoadNext, previewOffset]);

  const selectNode = useCallback((next: StorageNode) => {
    clearPreview();
    onSelectNode(next);
  }, [clearPreview, onSelectNode]);

  const navigateBack = useCallback(() => {
    clearPreview();
    onBack();
  }, [clearPreview, onBack]);

  const navigateForward = useCallback(() => {
    clearPreview();
    onForward();
  }, [clearPreview, onForward]);

  const navigateUp = useCallback(() => {
    clearPreview();
    onUp();
  }, [clearPreview, onUp]);

  const navigateBreadcrumb = useCallback((next: StorageNode) => {
    clearPreview();
    onNavigateBreadcrumb(next);
  }, [clearPreview, onNavigateBreadcrumb]);

  useEffect(() => {
    const handleNavigationShortcut = (event: KeyboardEvent) => {
      const targetElement = event.target;
      if (targetElement instanceof HTMLElement && (
        targetElement.isContentEditable
        || ["INPUT", "TEXTAREA", "SELECT"].includes(targetElement.tagName)
      )) return;

      const back = (event.altKey && event.key === "ArrowLeft")
        || (event.metaKey && event.key === "[");
      const forward = (event.altKey && event.key === "ArrowRight")
        || (event.metaKey && event.key === "]");
      const up = (event.altKey && event.key === "ArrowUp")
        || (event.metaKey && event.key === "ArrowUp");
      if (back && canGoBack) {
        event.preventDefault();
        navigateBack();
      } else if (forward && canGoForward) {
        event.preventDefault();
        navigateForward();
      } else if (up && canGoUp) {
        event.preventDefault();
        navigateUp();
      }
    };

    window.addEventListener("keydown", handleNavigationShortcut);
    return () => window.removeEventListener("keydown", handleNavigationShortcut);
  }, [canGoBack, canGoForward, canGoUp, navigateBack, navigateForward, navigateUp]);

  return (
    <section className="explorer-section" aria-label="Storage health workspace">
      <div className="health-toolbar">
        <div className="health-toolbar-score">
          <span>{metric === "space_health" ? source.name : `${source.name} → ${target?.name ?? "No target"}`}</span>
          <strong style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
        </div>
        <HealthControls
          metric={metric}
          sites={sites}
          source={source}
          target={target}
          onMetricChange={onMetricChange}
          onTargetChange={onTargetChange}
          onSwap={onSwap}
        />
      </div>

      <div className="explorer-workspace">
        <div className="map-pane">
          {coverageWithoutTarget ? (
            <div className="map-inline-state" role="status">
              <span className="state-score">—</span>
              <h3>Coverage needs a target</h3>
              <p>Add another site, scan it, then compare this source against it.</p>
              <button className="secondary-button" type="button" onClick={() => onMetricChange("space_health")}>
                View space health
              </button>
            </div>
          ) : (
            <>
              <SunburstMap
                root={location.root}
                breadcrumbs={location.breadcrumbs}
                metric={metric}
                selectedNodeId={node.id}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                canGoUp={canGoUp}
                onPreviewNode={preview}
                onPreviewLeave={leavePreview}
                onPreviewCancel={clearPreview}
                onSelectNode={selectNode}
                onBack={navigateBack}
                onForward={navigateForward}
                onUp={navigateUp}
                onNavigateBreadcrumb={navigateBreadcrumb}
              />
              {metric === "coverage_health" && target && !target.last_scanned_at && (
                <div className="coverage-freshness-note" role="status">
                  <span><strong>Coverage unknown.</strong> Scan {target.name} to calculate this map.</span>
                  <button className="secondary-button" type="button" onClick={onScanTarget}>Scan target</button>
                </div>
              )}
            </>
          )}
        </div>
        <InspectorPanel
          node={inspectedNode}
          previewing={previewing}
          metric={metric}
          coverageTargetName={target?.name ?? null}
          staged={staged}
          stagingBusy={stagingBusy}
          page={inspectedPage}
          loading={inspectedLoading}
          error={inspectedError}
          canHaveChildren={previewing ? previewedNodeCanHaveChildren : true}
          canGoBack={canGoBack}
          canLoadPrevious={previewing ? previewCanLoadPrevious : canLoadPrevious}
          canLoadNext={previewing ? previewCanLoadNext : canLoadNext}
          rangeStart={inspectedRangeStart}
          rangeEnd={inspectedRangeEnd}
          onBack={navigateBack}
          onSelect={selectNode}
          onRetry={previewing ? retryPreview : onRetryChildren}
          onPrevious={previewing ? loadPreviousPreview : onLoadPreviousChildren}
          onNext={previewing ? loadNextPreview : onLoadNextChildren}
          onPointerEnter={cancelPreviewRestore}
          onPointerLeave={leavePreview}
          onStage={onStage}
          onUnstage={onUnstage}
        />
      </div>
    </section>
  );
}
