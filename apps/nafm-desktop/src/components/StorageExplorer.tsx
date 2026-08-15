import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { metricAnalysisAvailability, siteAnalysisReady } from "../lib/analysis";
import { formatCount, formatHealth } from "../lib/format";
import {
  formatCompleteness,
  nodeCompleteness,
  nodeHealthPresentation,
  siteCompleteness,
} from "../lib/health";
import { getFileContentMatches, getStorageChildren } from "../lib/tauri";
import type {
  FileContentMatch,
  FileContentMatchesPage,
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
  workspaceName: string;
  contentRevision: number;
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
  onJumpDuplicate: (match: FileContentMatch) => void;
  focusSelectedFileRevision: number;
  onStage: () => void;
  onUnstage: () => void;
}

interface PreviewPageState {
  page: StorageChildrenPage | null;
  loading: boolean;
  error: string | null;
}

interface DuplicatePageState {
  owner_key: string | null;
  requested_offset: number;
  page: FileContentMatchesPage | null;
  loading: boolean;
  error: string | null;
}

interface DuplicateFileIdentity {
  owner_key: string;
  path: string;
}

const PREVIEW_PAGE_SIZE = 6;
const DUPLICATE_PAGE_SIZE = 6;
const PREVIEW_RESTORE_DELAY_MS = 100;
const PREVIEW_CACHE_LIMIT = 128;
const DUPLICATE_CACHE_LIMIT = 128;

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
  contentRevision: number,
): string {
  return `${contentRevision}\u0000${sourceSiteId}\u0000${targetSiteId ?? ""}\u0000${nodeId}\u0000${offset}`;
}

function duplicateFileIdentity(
  workspaceName: string,
  sourceSiteId: string,
  node: StorageNode | null,
): DuplicateFileIdentity | null {
  if (node?.kind !== "file" || !node.path) return null;
  return {
    owner_key: `${workspaceName}\u0000${sourceSiteId}\u0000${node.path}`,
    path: node.path,
  };
}

function duplicatePageKey(identity: DuplicateFileIdentity, offset: number): string {
  return `${identity.owner_key}\u0000${offset}`;
}

function emptyDuplicatePageState(): DuplicatePageState {
  return {
    owner_key: null,
    requested_offset: 0,
    page: null,
    loading: false,
    error: null,
  };
}

function duplicateErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unable to load duplicates.";
}

function verifiedFilesCopy(site: SiteOverview): string {
  return `${formatCount(site.verified_file_count)} of ${formatCount(site.total_files)} verified`;
}

function findStorageNode(root: StorageNode, nodeId: string): StorageNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children) {
    const match = findStorageNode(child, nodeId);
    if (match) return match;
  }
  return null;
}

export function StorageExplorer({
  workspaceName,
  contentRevision,
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
  onJumpDuplicate,
  focusSelectedFileRevision,
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
  const previewOffsetRef = useRef(0);
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewNodeRef = useRef<StorageNode | null>(null);
  const [selectedDuplicateState, setSelectedDuplicateState] = useState<DuplicatePageState>(emptyDuplicatePageState);
  const [previewDuplicateState, setPreviewDuplicateState] = useState<DuplicatePageState>(emptyDuplicatePageState);
  const duplicateCacheRef = useRef<Map<string, FileContentMatchesPage>>(new Map());
  const duplicateRequestsRef = useRef<Map<string, Promise<FileContentMatchesPage>>>(new Map());
  const duplicateGenerationRef = useRef(0);
  const selectedDuplicateRequestRef = useRef(0);
  const previewDuplicateRequestRef = useRef(0);
  const selectedDuplicateIdentityRef = useRef<DuplicateFileIdentity | null>(null);
  const previewDuplicateIdentityRef = useRef<DuplicateFileIdentity | null>(null);
  const sourceAnalysisReady = siteAnalysisReady(source);
  const analysisAvailability = metricAnalysisAvailability(metric, source, target);
  const targetCompleteness = siteCompleteness(target);
  const sourceCompleteness = nodeCompleteness(tree.root);
  const spacePresentation = nodeHealthPresentation(tree.root, "space_health");
  const coveragePresentation = nodeHealthPresentation(
    tree.root,
    "coverage_health",
    targetCompleteness,
  );
  const scorePresentation = metric === "space_health"
    ? spacePresentation
    : coveragePresentation;
  const verifiedButIncomparable = scorePresentation.state === "unavailable"
    && scorePresentation.completeness > 0;
  const coverageWithoutTarget = metric === "coverage_health" && !target;
  const coverageMissingVerifiedComparison = metric === "coverage_health"
    && Boolean(target)
    && scorePresentation.state === "unavailable"
    && !verifiedButIncomparable
    && (sourceCompleteness === 0 || targetCompleteness === 0);
  const estimatingDuringHashing = source.scan_state === "hashing"
    || (metric === "coverage_health" && target?.scan_state === "hashing");
  const scoreStatus = scorePresentation.state === "partial"
    ? `PARTIAL · ${formatCompleteness(scorePresentation.completeness)}`
    : scorePresentation.state === "exact"
      ? "EXACT"
      : tree.root.file_count === 0
        ? "NO CONTENT"
        : coverageWithoutTarget
          ? "NO TARGET"
          : coverageMissingVerifiedComparison
            ? "NO VERIFIED COMPARISON"
            : verifiedButIncomparable ? "NO COMPARABLE DATA" : "NO VERIFIED DATA";
  const estimateLabel = estimatingDuringHashing
    ? "Estimated while hashing"
    : "Estimated from verified content";
  const readinessCopy = scorePresentation.state === "partial"
    ? metric === "coverage_health" && target
      ? `${source.name} ${verifiedFilesCopy(source)} · ${target.name} ${verifiedFilesCopy(target)}`
      : verifiedFilesCopy(source)
    : verifiedButIncomparable
      ? "Verified content is present, but this index cannot produce a comparable health score."
      : analysisAvailability.message;
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
  const inspectedDuplicateState = previewing ? previewDuplicateState : selectedDuplicateState;
  const inspectedDuplicateIdentity = sourceAnalysisReady
    ? duplicateFileIdentity(workspaceName, source.id, inspectedNode)
    : null;
  const inspectedDuplicateStateMatches = inspectedDuplicateIdentity?.owner_key === inspectedDuplicateState.owner_key;
  const inspectedDuplicatePage = inspectedDuplicateStateMatches ? inspectedDuplicateState.page : null;
  const inspectedDuplicatesLoading = sourceAnalysisReady && inspectedNode.kind === "file"
    && (!inspectedDuplicateStateMatches || inspectedDuplicateState.loading);
  const inspectedDuplicatesError = inspectedDuplicateStateMatches ? inspectedDuplicateState.error : null;
  const duplicateRangeStart = inspectedDuplicatePage && inspectedDuplicatePage.total_matches > 0
    ? inspectedDuplicatePage.offset + 1
    : 0;
  const duplicateRangeEnd = inspectedDuplicatePage
    ? Math.min(
        inspectedDuplicatePage.offset + inspectedDuplicatePage.matches.length,
        inspectedDuplicatePage.total_matches,
      )
    : 0;
  const canLoadPreviousDuplicates = Boolean(
    inspectedNode.kind === "file"
    && inspectedDuplicatePage
    && !inspectedDuplicateState.loading
    && inspectedDuplicatePage.offset > 0,
  );
  const canLoadNextDuplicates = Boolean(
    inspectedNode.kind === "file"
    && inspectedDuplicatePage
    && !inspectedDuplicateState.loading
    && inspectedDuplicatePage.offset + inspectedDuplicatePage.limit < inspectedDuplicatePage.total_matches,
  );

  const cancelPreviewRestore = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current);
      restoreTimeoutRef.current = null;
    }
  }, []);

  const clearPreview = useCallback(() => {
    cancelPreviewRestore();
    previewRequestRef.current += 1;
    previewDuplicateRequestRef.current += 1;
    previewNodeRef.current = null;
    previewOffsetRef.current = 0;
    previewDuplicateIdentityRef.current = null;
    setPreviewNode(null);
    setPreviewOffset(0);
    setPreviewPageState({ page: null, loading: false, error: null });
    setPreviewDuplicateState(emptyDuplicatePageState());
  }, [cancelPreviewRestore]);

  const loadDuplicatePage = useCallback(async (
    owner: "selected" | "preview",
    identity: DuplicateFileIdentity,
    offset: number,
  ) => {
    if (!sourceAnalysisReady) return;
    const requestRef = owner === "selected" ? selectedDuplicateRequestRef : previewDuplicateRequestRef;
    const identityRef = owner === "selected" ? selectedDuplicateIdentityRef : previewDuplicateIdentityRef;
    const updateState = owner === "selected" ? setSelectedDuplicateState : setPreviewDuplicateState;
    const requestId = requestRef.current + 1;
    const generation = duplicateGenerationRef.current;
    const key = `${contentRevision}\u0000${duplicatePageKey(identity, offset)}`;
    requestRef.current = requestId;

    const cachedPage = duplicateCacheRef.current.get(key);
    if (cachedPage) {
      if (requestRef.current !== requestId || identityRef.current?.owner_key !== identity.owner_key) return;
      duplicateCacheRef.current.delete(key);
      duplicateCacheRef.current.set(key, cachedPage);
      updateState({
        owner_key: identity.owner_key,
        requested_offset: offset,
        page: cachedPage,
        loading: false,
        error: null,
      });
      return;
    }

    let request: Promise<FileContentMatchesPage> | undefined;
    request = duplicateRequestsRef.current.get(key);
    updateState((previous) => ({
      owner_key: identity.owner_key,
      requested_offset: offset,
      page: previous.owner_key === identity.owner_key ? previous.page : null,
      loading: true,
      error: null,
    }));
    try {
      if (!request) {
        request = getFileContentMatches(
          source.id,
          identity.path,
          offset,
          DUPLICATE_PAGE_SIZE,
          workspaceName,
        );
        duplicateRequestsRef.current.set(key, request);
      }
      const page = await request;
      if (duplicateRequestsRef.current.get(key) === request) duplicateRequestsRef.current.delete(key);
      if (duplicateGenerationRef.current !== generation) return;

      duplicateCacheRef.current.set(key, page);
      while (duplicateCacheRef.current.size > DUPLICATE_CACHE_LIMIT) {
        const oldestKey = duplicateCacheRef.current.keys().next().value;
        if (oldestKey === undefined) break;
        duplicateCacheRef.current.delete(oldestKey);
      }
      if (requestRef.current !== requestId || identityRef.current?.owner_key !== identity.owner_key) return;
      updateState({
        owner_key: identity.owner_key,
        requested_offset: offset,
        page,
        loading: false,
        error: null,
      });
    } catch (duplicateError) {
      if (request && duplicateRequestsRef.current.get(key) === request) duplicateRequestsRef.current.delete(key);
      if (duplicateGenerationRef.current !== generation) return;
      if (requestRef.current !== requestId || identityRef.current?.owner_key !== identity.owner_key) return;
      updateState((previous) => ({
        owner_key: identity.owner_key,
        requested_offset: offset,
        page: previous.owner_key === identity.owner_key ? previous.page : null,
        loading: false,
        error: duplicateErrorMessage(duplicateError),
      }));
    }
  }, [contentRevision, source.id, sourceAnalysisReady, workspaceName]);

  const loadPreviewPage = useCallback(async (
    previewedNode: StorageNode,
    offset: number,
    keepPage = false,
  ) => {
    const key = previewKey(
      source.id,
      target?.id ?? null,
      previewedNode.id,
      offset,
      contentRevision,
    );
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
    setPreviewPageState((current) => ({
      page: keepPage ? current.page : null,
      loading: true,
      error: null,
    }));
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
      setPreviewPageState((current) => ({
        page: keepPage ? current.page : null,
        loading: false,
        error: errorMessage(previewError),
      }));
    }
  }, [contentRevision, source.id, target?.id]);

  useLayoutEffect(() => {
    previewGenerationRef.current += 1;
    previewCacheRef.current.clear();
    previewRequestsRef.current.clear();
    clearPreview();
  }, [clearPreview, source.id, target?.id]);

  useLayoutEffect(() => {
    previewGenerationRef.current += 1;
    previewRequestRef.current += 1;
    previewCacheRef.current.clear();
    previewRequestsRef.current.clear();
    const current = previewNodeRef.current;
    if (!current) return;
    const rebound = findStorageNode(location.root, current.id);
    if (!rebound) {
      clearPreview();
      return;
    }
    previewNodeRef.current = rebound;
    setPreviewNode(rebound);
    if (rebound.kind !== "file" && rebound.kind !== "smaller_items") {
      void loadPreviewPage(rebound, previewOffsetRef.current, true);
    }
  }, [clearPreview, contentRevision, loadPreviewPage, location.root]);

  useEffect(() => {
    duplicateGenerationRef.current += 1;
    duplicateCacheRef.current.clear();
    duplicateRequestsRef.current.clear();
    selectedDuplicateRequestRef.current += 1;
    previewDuplicateRequestRef.current += 1;
    selectedDuplicateIdentityRef.current = null;
    previewDuplicateIdentityRef.current = null;
    setSelectedDuplicateState(emptyDuplicatePageState());
    const currentPreview = previewNodeRef.current;
    const previewIdentity = sourceAnalysisReady && currentPreview
      ? duplicateFileIdentity(workspaceName, source.id, currentPreview)
      : null;
    previewDuplicateIdentityRef.current = previewIdentity;
    setPreviewDuplicateState(previewIdentity
      ? {
          owner_key: previewIdentity.owner_key,
          requested_offset: 0,
          page: null,
          loading: true,
          error: null,
        }
      : emptyDuplicatePageState());
    if (previewIdentity) void loadDuplicatePage("preview", previewIdentity, 0);
  }, [contentRevision, loadDuplicatePage, source.id, sourceAnalysisReady, workspaceName]);

  useEffect(() => {
    const identity = sourceAnalysisReady
      ? duplicateFileIdentity(workspaceName, source.id, node)
      : null;
    selectedDuplicateIdentityRef.current = identity;
    if (!identity) {
      selectedDuplicateRequestRef.current += 1;
      setSelectedDuplicateState(emptyDuplicatePageState());
      return;
    }
    void loadDuplicatePage("selected", identity, 0);
  }, [
    contentRevision,
    loadDuplicatePage,
    node.id,
    node.kind,
    node.path,
    source.id,
    sourceAnalysisReady,
    workspaceName,
  ]);

  useEffect(() => clearPreview(), [clearPreview, node.id]);

  useEffect(() => clearPreview(), [clearPreview, location.root.id]);

  useEffect(() => () => {
    cancelPreviewRestore();
    previewGenerationRef.current += 1;
    previewRequestRef.current += 1;
    previewRequestsRef.current.clear();
    duplicateGenerationRef.current += 1;
    selectedDuplicateRequestRef.current += 1;
    previewDuplicateRequestRef.current += 1;
    duplicateRequestsRef.current.clear();
  }, [cancelPreviewRestore]);

  const preview = useCallback((next: StorageNode) => {
    cancelPreviewRestore();
    if (previewNodeRef.current?.id === next.id) {
      previewNodeRef.current = next;
      setPreviewNode(next);
      return;
    }
    previewNodeRef.current = next;
    setPreviewNode(next);
    previewOffsetRef.current = 0;
    setPreviewOffset(0);
    const duplicateIdentity = sourceAnalysisReady
      ? duplicateFileIdentity(workspaceName, source.id, next)
      : null;
    previewDuplicateRequestRef.current += 1;
    previewDuplicateIdentityRef.current = duplicateIdentity;
    setPreviewDuplicateState(duplicateIdentity
      ? {
          owner_key: duplicateIdentity.owner_key,
          requested_offset: 0,
          page: null,
          loading: true,
          error: null,
        }
      : emptyDuplicatePageState());
    if (next.kind === "file" || next.kind === "smaller_items") {
      previewRequestRef.current += 1;
      setPreviewPageState({ page: null, loading: false, error: null });
    } else {
      void loadPreviewPage(next, 0);
    }
    if (duplicateIdentity) void loadDuplicatePage("preview", duplicateIdentity, 0);
  }, [cancelPreviewRestore, loadDuplicatePage, loadPreviewPage, source.id, sourceAnalysisReady, workspaceName]);

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
    previewOffsetRef.current = previousOffset;
    setPreviewOffset(previousOffset);
    void loadPreviewPage(previewedNode, previousOffset);
  }, [loadPreviewPage, previewCanLoadPrevious, previewOffset]);

  const loadNextPreview = useCallback(() => {
    const previewedNode = previewNodeRef.current;
    if (!previewedNode || !previewCanLoadNext) return;
    const nextOffset = previewOffset + PREVIEW_PAGE_SIZE;
    previewOffsetRef.current = nextOffset;
    setPreviewOffset(nextOffset);
    void loadPreviewPage(previewedNode, nextOffset);
  }, [loadPreviewPage, previewCanLoadNext, previewOffset]);

  const activeDuplicateOwner = useCallback(() => {
    const identity = previewing ? previewDuplicateIdentityRef.current : selectedDuplicateIdentityRef.current;
    return identity ? { owner: previewing ? "preview" as const : "selected" as const, identity } : null;
  }, [previewing]);

  const retryDuplicates = useCallback(() => {
    const active = activeDuplicateOwner();
    if (!active) return;
    void loadDuplicatePage(active.owner, active.identity, inspectedDuplicateState.requested_offset);
  }, [activeDuplicateOwner, inspectedDuplicateState.requested_offset, loadDuplicatePage]);

  const loadPreviousDuplicates = useCallback(() => {
    const active = activeDuplicateOwner();
    if (!active || !canLoadPreviousDuplicates || !inspectedDuplicatePage) return;
    void loadDuplicatePage(
      active.owner,
      active.identity,
      Math.max(0, inspectedDuplicatePage.offset - DUPLICATE_PAGE_SIZE),
    );
  }, [activeDuplicateOwner, canLoadPreviousDuplicates, inspectedDuplicatePage, loadDuplicatePage]);

  const loadNextDuplicates = useCallback(() => {
    const active = activeDuplicateOwner();
    if (!active || !canLoadNextDuplicates || !inspectedDuplicatePage) return;
    void loadDuplicatePage(
      active.owner,
      active.identity,
      inspectedDuplicatePage.offset + DUPLICATE_PAGE_SIZE,
    );
  }, [activeDuplicateOwner, canLoadNextDuplicates, inspectedDuplicatePage, loadDuplicatePage]);

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

  const jumpDuplicate = useCallback((match: FileContentMatch) => {
    clearPreview();
    onJumpDuplicate(match);
  }, [clearPreview, onJumpDuplicate]);

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
        <div className={`health-toolbar-score is-${scorePresentation.state}`}>
          <span>{metric === "space_health" ? source.name : `${source.name} → ${target?.name ?? "No target"}`}</span>
          <strong style={{ color: scorePresentation.color }}>
            {formatHealth(scorePresentation.value)}
            {scorePresentation.state === "partial" && <em>EST</em>}
          </strong>
          <small>{scoreStatus}</small>
        </div>
        <HealthControls
          metric={metric}
          sites={sites}
          source={source}
          target={target}
          sourceHealth={spacePresentation}
          coverageHealth={coveragePresentation}
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
                coverageTargetCompleteness={targetCompleteness}
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
              {readinessCopy && (
                scorePresentation.state === "partial"
                || !analysisAvailability.available
                || verifiedButIncomparable
              ) && (
                <div
                  className={`coverage-freshness-note analysis-readiness-note is-${scorePresentation.state}`}
                  role={scorePresentation.state === "partial" ? undefined : "status"}
                >
                  <span>
                    <strong>
                      {scorePresentation.state === "partial"
                        ? estimateLabel
                        : "Analysis unavailable"}
                    </strong>
                    {scorePresentation.state === "partial" ? " · " : ". "}{readinessCopy}
                  </span>
                  {metric === "coverage_health" && target && target.hash_status === "unscanned" && (
                    <button className="secondary-button" type="button" onClick={onScanTarget}>Scan target</button>
                  )}
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
          coverageTargetCompleteness={targetCompleteness}
          sourceAnalysisReady={sourceAnalysisReady}
          analysisMessage={sourceAnalysisReady
            ? null
            : metricAnalysisAvailability("space_health", source, null).message}
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
          duplicatesPage={inspectedDuplicatePage}
          duplicatesLoading={inspectedDuplicatesLoading}
          duplicatesError={inspectedDuplicatesError}
          canLoadPreviousDuplicates={canLoadPreviousDuplicates}
          canLoadNextDuplicates={canLoadNextDuplicates}
          duplicateRangeStart={duplicateRangeStart}
          duplicateRangeEnd={duplicateRangeEnd}
          onBack={navigateBack}
          onSelect={selectNode}
          onRetry={previewing ? retryPreview : onRetryChildren}
          onPrevious={previewing ? loadPreviousPreview : onLoadPreviousChildren}
          onNext={previewing ? loadNextPreview : onLoadNextChildren}
          onRetryDuplicates={retryDuplicates}
          onPreviousDuplicates={loadPreviousDuplicates}
          onNextDuplicates={loadNextDuplicates}
          onJumpDuplicate={jumpDuplicate}
          focusSelectedFileRevision={focusSelectedFileRevision}
          onPointerEnter={cancelPreviewRestore}
          onPointerLeave={leavePreview}
          onStage={onStage}
          onUnstage={onUnstage}
        />
      </div>
    </section>
  );
}
