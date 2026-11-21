import { useCallback, useEffect, useRef, useState } from "react";
import { cancelScan, getStorageViewSnapshot, loadDashboard, onScanTaskEvent, startScan } from "../lib/tauri";
import type { Dashboard, ScanTaskEvent, StorageNode, StorageViewSnapshot } from "../lib/types";
import { DIRECTORY_PAGE_SIZE } from "./DirectoryTape";

interface Destination {
  workspace: string;
  site: string;
  node: string;
  offset: number;
}

interface Inventory {
  destination: Destination;
  snapshot: StorageViewSnapshot;
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function matchesFolder(left: Destination | null, right: Destination | null) {
  return left && right && left.workspace === right.workspace && left.site === right.site && left.node === right.node;
}

function findNode(root: StorageNode, id: string): StorageNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findNode(child, id);
    if (match) return match;
  }
  return null;
}

export function useAtlas() {
  const [catalog, setCatalog] = useState<Dashboard | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [siteChoice, setSiteChoice] = useState<string | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [viewError, setViewError] = useState<{ destination: Destination; message: string } | null>(null);
  const [inventoryVersion, setInventoryVersion] = useState(0);
  const [selected, setSelected] = useState<StorageNode | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<ReadonlyMap<string, ScanTaskEvent>>(new Map());
  const [taskError, setTaskError] = useState<string | null>(null);
  const catalogRequest = useRef(0);
  const actionLocks = useRef(new Set<string>());
  const hadActiveScans = useRef(false);

  const site = catalog?.sites.find(({ id }) => id === siteChoice) ?? catalog?.sites[0] ?? null;
  const workspace = catalog?.workspace_name ?? null;
  const siteId = site?.id ?? null;
  const requestedNode = workspace === destination?.workspace && siteId === destination?.site
    ? destination.node
    : null;
  const nodeId = requestedNode ?? (siteId && `site:${siteId}`);
  const offset = requestedNode === null ? 0 : destination?.offset ?? 0;
  const current = workspace && siteId && nodeId ? { workspace, site: siteId, node: nodeId, offset } : null;
  const currentInventory = matchesFolder(inventory?.destination ?? null, current) ? inventory : null;
  const currentError = matchesFolder(viewError?.destination ?? null, current) && viewError?.destination.offset === offset
    ? viewError.message
    : null;
  const snapshot = currentInventory?.snapshot ?? null;
  const loading = Boolean(current && !currentError && (
    !currentInventory || currentInventory.destination.offset !== offset
  ));

  const refreshCatalog = useCallback(async () => {
    const request = ++catalogRequest.current;
    setCatalogError(null);
    try {
      const loaded = await loadDashboard();
      if (request === catalogRequest.current) setCatalog(loaded);
    } catch (error) {
      if (request === catalogRequest.current) setCatalogError(describeError(error));
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
    return () => { catalogRequest.current += 1; };
  }, [refreshCatalog]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void onScanTaskEvent((event) => {
      if (!active) return;
      const terminal = event.scope === "task" && ["completed", "failed", "cancelled"].includes(event.kind);
      if (event.kind === "started" || event.kind === "cancelling" || terminal) {
        void refreshCatalog();
      }
      if (terminal) {
        setProgress((previous) => new Map([...previous].filter(([, value]) => value.request_id !== event.request_id)));
        if (event.kind === "failed" && event.message) setTaskError(event.message);
        setInventoryVersion((version) => version + 1);
      } else {
        const id = event.site_id;
        if (id) setProgress((previous) => new Map(previous).set(id, event));
      }
    }).then((unsubscribe) => {
      if (active) stop = unsubscribe;
      else unsubscribe();
    }).catch(() => {
      // Active scans also refresh through the dashboard snapshot.
    });
    return () => { active = false; stop?.(); };
  }, [refreshCatalog]);

  const scansActive = Boolean(catalog?.active_tasks.length);
  useEffect(() => {
    if (!scansActive && hadActiveScans.current) setInventoryVersion((version) => version + 1);
    hadActiveScans.current = scansActive;
    if (!scansActive) return;
    const timer = window.setInterval(() => void refreshCatalog(), 3000);
    return () => window.clearInterval(timer);
  }, [refreshCatalog, scansActive]);

  useEffect(() => {
    if (!workspace || !siteId || !nodeId) return;
    let active = true;
    const lookup = { workspace, site: siteId, node: nodeId, offset };
    setViewError(null);
    void getStorageViewSnapshot(workspace, siteId, nodeId, offset, DIRECTORY_PAGE_SIZE)
      .then((result) => {
        if (!active) return;
        setInventory({ destination: lookup, snapshot: result });
        setSelected((node) => {
          if (!node) return null;
          return result.page.children.find(({ id }) => id === node.id)
            ?? findNode(result.location.root, node.id);
        });
      })
      .catch((error) => {
        if (!active) return;
        const message = describeError(error);
        if (requestedNode && requestedNode !== `site:${siteId}` && message.startsWith("storage node not found:")) {
          setDestination(null);
          setSelected(null);
        } else {
          setViewError({ destination: lookup, message });
        }
      });
    return () => { active = false; };
  }, [inventoryVersion, nodeId, offset, requestedNode, siteId, workspace]);

  const taskBySite = new Map<string, number>();
  for (const task of catalog?.active_tasks ?? []) {
    for (const member of task.site_states) {
      if (member.status !== "completed" || !task.selector.all) taskBySite.set(member.site_id, task.request_id);
    }
  }
  const scanningIds = new Set([...taskBySite.keys(), ...pending]);
  const liveProgress = siteId ? progress.get(siteId) ?? null : null;

  function selectSite(id: string) {
    if (siteId === id) return;
    setSiteChoice(id);
    setDestination(null);
    setSelected(null);
    setTaskError(null);
  }

  function navigate(node: string, nextOffset = 0) {
    if (!current) return;
    setSelected(null);
    setDestination({ ...current, node, offset: nextOffset });
  }

  function selectNode(node: StorageNode) {
    if (node.kind === "file") {
      setSelected((previous) => previous?.id === node.id ? null : node);
      return;
    }
    if (node.kind === "smaller_items") {
      const group = /^smaller_items:(\d+):(.+)$/.exec(node.id);
      if (group) navigate(group[2], Number(group[1]));
      return;
    }
    navigate(node.id);
  }

  async function runTask(id: string, action: () => Promise<unknown>) {
    if (actionLocks.current.has(id)) return;
    actionLocks.current.add(id);
    setPending((previous) => new Set(previous).add(id));
    setTaskError(null);
    try {
      await action();
      await refreshCatalog();
    } catch (error) {
      setTaskError(describeError(error));
    } finally {
      actionLocks.current.delete(id);
      setPending((previous) => new Set([...previous].filter((key) => key !== id)));
    }
  }

  function scan(id: string) {
    if (!workspace || scanningIds.has(id)) return;
    void runTask(id, () => startScan(id, workspace));
  }

  function stopScan(id: string) {
    const task = taskBySite.get(id);
    if (task !== undefined) void runTask(id, () => cancelScan(task));
  }

  return {
    catalog, catalogError, site, snapshot, selected, loading, viewError: currentError, scanningIds, liveProgress,
    taskError, selectSite, selectNode, scan, stopScan, refreshCatalog,
    canCancel: (id: string) => taskBySite.has(id) && !pending.has(id),
    dismissTaskError: () => setTaskError(null),
    retryView: () => setInventoryVersion((version) => version + 1),
    paginate: (nextOffset: number) => { if (current) navigate(current.node, nextOffset); },
  };
}
