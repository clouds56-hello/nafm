import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Dashboard, ScanPhase, ScanTaskEvent, SiteOverview, StorageNode, StorageViewSnapshot } from "../src/lib/types";
import { createFixtures, createSampleTree, PREVIEW_WORKSPACE, type PreviewScenario } from "./fixtures";

const SCAN_EVENT = "task://scan/events";
const SCAN_STEPS: ReadonlyArray<readonly [ScanPhase, number]> = [
  ["discovering", 0],
  ["discovering", 0.35],
  ["publishing_metadata", 1],
  ["hashing", 0.2],
  ["hashing", 0.75],
  ["finalizing", 1],
];

interface PreviewScan {
  request_id: number;
  site_id: string;
  phase: ScanPhase;
  status: "running" | "cancelling";
  step: number;
  timer: number | undefined;
  inventory: StorageNode;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error("Invalid preview command arguments.");
  }
  return value as Record<string, unknown>;
}

function stringArg(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}.`);
  return value.trim();
}

function numberArg(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function checkWorkspace(value: unknown) {
  if (value !== PREVIEW_WORKSPACE) throw new Error("The preview workspace changed. Reload and try again.");
}

function smbPath(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SMB URL. Use smb://server/share.");
  }
  if (url.protocol !== "smb:" || !url.hostname || !url.pathname.split("/").some(Boolean)) {
    throw new Error("Invalid SMB URL. Use smb://server/share.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("SMB URLs cannot include credentials, a query, or a fragment.");
  }
  url.hostname = url.hostname.toLowerCase();
  return url.href.replace(/\/+$/, "");
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedChildren(node: StorageNode) {
  return [...node.children].sort((left, right) => (
    right.total_bytes - left.total_bytes || compareText(left.name, right.name) || compareText(left.id, right.id)
  ));
}

function findPath(node: StorageNode, id: string): StorageNode[] | undefined {
  if (node.id === id) return [node];
  for (const child of node.children) {
    const path = findPath(child, id);
    if (path) return [node, ...path];
  }
}

function summary(node: StorageNode): StorageNode {
  return { ...node, children: [] };
}

function boundedNode(node: StorageNode, depth: number, limit: number): StorageNode {
  if (depth === 0 || limit === 0) return summary(node);
  const children = orderedChildren(node);
  if (children.length <= limit) {
    return { ...node, children: children.map((child) => boundedNode(child, depth - 1, limit)) };
  }

  const kept = limit - 1;
  const remaining = children.slice(kept);
  const group: StorageNode = {
    id: `smaller_items:${kept}:${node.id}`,
    name: "Smaller items",
    path: null,
    kind: "smaller_items",
    total_bytes: remaining.reduce((total, child) => total + child.total_bytes, 0),
    file_count: remaining.reduce((total, child) => total + child.file_count, 0),
    verified_file_count: remaining.reduce((total, child) => total + child.verified_file_count, 0),
    pending_hash_count: remaining.reduce((total, child) => total + child.pending_hash_count, 0),
    children: [],
  };
  return {
    ...node,
    children: [...children.slice(0, kept).map((child) => boundedNode(child, depth - 1, limit)), group],
  };
}

function emptyTree(tree: StorageNode): StorageNode {
  const empty = (node: StorageNode): StorageNode => ({
    ...summary(node),
    total_bytes: 0,
    file_count: 0,
    verified_file_count: 0,
    pending_hash_count: 0,
  });
  return { ...empty(tree), children: tree.children.map(empty) };
}

function verifiedTree(node: StorageNode): StorageNode {
  if (node.pending_hash_count === 0) return node;
  return {
    ...node,
    verified_file_count: node.file_count,
    pending_hash_count: 0,
    children: node.children.map(verifiedTree),
  };
}

function scanTask(scan: PreviewScan) {
  return {
    request_id: scan.request_id,
    selector: { site_id: scan.site_id, all: false },
    site_states: [{ site_id: scan.site_id, status: "running" as const }],
    status: scan.status,
  };
}

function registerPreviewIpc(handler: Parameters<typeof mockIPC>[0]) {
  mockIPC(handler, { shouldMockEvents: true });
  const bridge = (window as Window & {
    __TAURI_INTERNALS__?: {
      invoke: (command: string, payload?: InvokeArgs, options?: InvokeOptions) => Promise<unknown>;
    };
  }).__TAURI_INTERNALS__;
  if (!bridge) throw new Error("Preview IPC failed to initialize.");
  const invoke = bridge.invoke;
  // Tauri's mock listener registry reads id, while the public unlisten API sends eventId.
  bridge.invoke = (command, payload, options) => {
    if (command !== "plugin:event|unlisten") return invoke(command, payload, options);
    const args = record(payload);
    return invoke(command, { ...args, id: args.eventId }, options);
  };
}

export function installPreviewBackend(scenario: PreviewScenario) {
  const { sites: seedSites, trees } = createFixtures(scenario);
  const sites = new Map(seedSites.map((site) => [site.id, site]));
  const knownShares = new Set(seedSites.filter((site) => site.kind === "smb").map((site) => smbPath(site.location)));
  const scans = new Map<number, PreviewScan>();
  let nextRequest = 1;
  let nextSource = 1;

  function getSite(id: string) {
    const site = sites.get(id);
    if (!site) throw new Error(`Site not found: ${id}`);
    return site;
  }

  function notify(
    scan: PreviewScan,
    scope: ScanTaskEvent["scope"],
    kind: ScanTaskEvent["kind"],
  ) {
    const siteEvent = scope === "site";
    const totalFiles = scan.inventory.file_count;
    void emit<ScanTaskEvent>(SCAN_EVENT, {
      request_id: scan.request_id,
      scope,
      site_id: siteEvent ? scan.site_id : null,
      kind,
      phase: siteEvent ? scan.phase : null,
      processed_files: siteEvent ? Math.round(totalFiles * SCAN_STEPS[scan.step][1]) : null,
      total_files: siteEvent ? totalFiles : null,
      message: null,
    });
  }

  function startScan(site: SiteOverview, stepTime = 900) {
    if ([...scans.values()].some((scan) => scan.site_id === site.id)) {
      throw new Error("A scan is already running for this source.");
    }
    const inventory = trees.get(site.id);
    const scan: PreviewScan = {
      request_id: nextRequest++,
      site_id: site.id,
      phase: SCAN_STEPS[0][0],
      status: "running",
      step: 0,
      timer: undefined,
      inventory: inventory?.file_count ? verifiedTree(inventory) : createSampleTree(site),
    };
    scans.set(scan.request_id, scan);
    notify(scan, "site", "started");
    scan.timer = window.setInterval(() => {
      scan.step += 1;
      const nextStep = SCAN_STEPS[scan.step];
      if (nextStep) {
        scan.phase = nextStep[0];
        notify(scan, "site", "progress");
        return;
      }
      window.clearInterval(scan.timer);
      scans.delete(scan.request_id);
      trees.set(site.id, scan.inventory);
      const now = new Date().toISOString();
      sites.set(site.id, {
        ...site,
        hash_status: "ready",
        scan_state: "done",
        latest_inventory_at: now,
        last_scanned_at: now,
        total_files: scan.inventory.file_count,
        total_bytes: scan.inventory.total_bytes,
      });
      notify(scan, "task", "completed");
    }, stepTime);
    return scanTask(scan);
  }

  function cancelScan(id: number) {
    const scan = scans.get(id);
    if (!scan) return { request_id: id, outcome: "not_found", status: null, effective_mode: null };
    const result = { request_id: id, status: "cancelling", effective_mode: "graceful" };
    if (scan.status === "cancelling") return { ...result, outcome: "already_requested" };
    scan.status = "cancelling";
    window.clearInterval(scan.timer);
    notify(scan, "task", "cancelling");
    window.setTimeout(() => {
      scans.delete(id);
      notify(scan, "task", "cancelled");
    }, 350);
    return { ...result, outcome: "requested" };
  }

  function loadDashboard(): Dashboard {
    const active = [...scans.values()];
    return {
      workspace_name: PREVIEW_WORKSPACE,
      sites: [...sites.values()].map((site) => {
        const scan = active.find((task) => task.site_id === site.id);
        if (!scan) return site;
        return { ...site, scan_state: scan.status === "cancelling" ? scan.status : scan.phase };
      }),
      active_tasks: active.map(scanTask),
    };
  }

  function getSnapshot(args: Record<string, unknown>): StorageViewSnapshot {
    checkWorkspace(args.expectedWorkspace);
    const site = getSite(stringArg(args.siteId, "source ID"));
    const nodeId = stringArg(args.nodeId, "storage node");
    const root = trees.get(site.id);
    const breadcrumbs = root && findPath(root, nodeId);
    const selected = breadcrumbs?.at(-1);
    if (!breadcrumbs || !selected) throw new Error(`storage node not found: ${nodeId}`);
    if (selected.kind === "file" || selected.kind === "smaller_items") {
      throw new Error(`storage node is not navigable: ${nodeId}`);
    }
    const depth = numberArg(args.maxDepth, "map depth");
    const width = numberArg(args.maxChildren, "map branch limit");
    const pageLimit = Math.min(200, Math.max(1, numberArg(args.limit, "page limit")));
    const requestedOffset = numberArg(args.offset, "page offset");
    const children = orderedChildren(selected);
    const lastPage = Math.max(0, Math.floor((children.length - 1) / pageLimit) * pageLimit);
    const offset = requestedOffset >= children.length ? lastPage : requestedOffset;
    return {
      location: { root: boundedNode(selected, depth, width), breadcrumbs: breadcrumbs.map(summary) },
      page: {
        children: children.slice(offset, offset + pageLimit).map(summary),
        total_children: children.length,
        offset,
      },
    };
  }

  function addSource(args: Record<string, unknown>) {
    checkWorkspace(args.workspaceName);
    if (scans.size > 0) throw new Error("Finish all active scans before adding a source.");
    const name = stringArg(args.name, "source name");
    const path = stringArg(args.folderPath, "folder path");
    if ([...sites.values()].some((site) => site.name === name)) throw new Error(`site already exists: ${name}`);
    const kind = /^smb:\/\//i.test(path) ? "smb" : "local";
    const location = kind === "smb" ? smbPath(path) : path;
    if (kind === "smb" && ![...knownShares].some((url) => url === location || location.startsWith(`${url}/`))) {
      throw new Error(`no saved credentials for SMB location: ${location}`);
    }
    const site: SiteOverview = {
      id: `sample-source-${nextSource++}`,
      name,
      location,
      kind,
      connection_state: "connected",
      scan_state: "idle",
      hash_status: "unscanned",
      latest_inventory_at: null,
      last_scanned_at: null,
      total_files: 0,
      total_bytes: 0,
    };
    trees.set(site.id, emptyTree(createSampleTree(site)));
    sites.set(site.id, site);
    return null;
  }

  function invoke(command: string, payload?: InvokeArgs) {
    if (command === "load_dashboard") return loadDashboard();
    if (command === "plugin:dialog|open") return "/demo/Sample Folder";

    const args = payload === undefined ? {} : record(payload);
    switch (command) {
      case "get_storage_view_snapshot":
        return getSnapshot(args);
      case "create_site":
        return addSource(args);
      case "connect_smb":
        stringArg(args.username, "SMB username");
        stringArg(args.password, "SMB password");
        knownShares.add(smbPath(stringArg(args.url, "SMB URL")));
        return null;
      case "start_scan":
        checkWorkspace(args.expectedWorkspace);
        return startScan(getSite(stringArg(record(args.selector).site_id, "source ID")));
      case "cancel_scan":
        return cancelScan(numberArg(args.requestId, "scan ID"));
      default:
        throw new Error(`Unsupported preview command: ${command}`);
    }
  }

  registerPreviewIpc(invoke);
  const first = seedSites[0];
  if (scenario === "scanning" && first) startScan(first, 5000);
}
