import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import type {
  CancelScanReport, Dashboard, ScanPhase, ScanSelector, ScanSummary, ScanTask, ScanTaskEvent, ScanTaskSiteState,
  SiteOverview, StorageNode,
} from "../src/lib/types";
import { buildFolder, createSampleTree, type PreviewScenario } from "./fixtures";
import { createManagementApi } from "./management";
import { createStorageApi } from "./storage";
import { checkWorkspace, getSite, getTree, numberArg, record, setTree, stringArg, type CommandArgs, type PreviewWorkspace } from "./workspace";

const SCAN_EVENT = "task://scan/events";
const SCAN_STEPS: ReadonlyArray<readonly [ScanPhase, number]> = [
  ["discovering", 0], ["discovering", 0.35], ["publishing_metadata", 1],
  ["hashing", 0.25], ["hashing", 0.65], ["finalizing", 1],
];

interface PreviewInventory {
  site: SiteOverview;
  tree: StorageNode;
}

interface PreviewScan {
  task: ScanTask;
  inventories: Map<string, PreviewInventory>;
  step: number;
  timer: number | undefined;
}

interface PreviewScanOptions {
  stepTime?: number;
  initialStep?: number;
  failureMessage?: string;
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

function verifiedInventory(root: StorageNode, count: number): StorageNode {
  let remaining = count;

  function visit(node: StorageNode): StorageNode {
    if (node.kind === "file") {
      const verified = remaining-- > 0;
      return {
        ...node, verified_file_count: verified ? 1 : 0, pending_hash_count: verified ? 0 : 1,
        verified_bytes: verified ? node.total_bytes : 0,
      };
    }
    return buildFolder(node.id, node.name, node.path, node.kind, node.children.map(visit));
  }

  return visit(root);
}

function usedInventory(workspace: PreviewWorkspace, site: SiteOverview) {
  const root = getTree(workspace, site.id);
  const roots = root.children.map((child) => {
    if (!child.path || workspace.inventoried_roots.has(child.id)) return child;
    return createSampleTree({
      ...site, location: child.path, kind: child.kind === "smb_root" ? "smb" : "local",
    }, child.id).children[0];
  });
  return buildFolder(root.id, root.name, root.path, root.kind, roots);
}

function notify(
  task: ScanTask,
  kind: ScanTaskEvent["kind"],
  state: ScanTaskSiteState | null = null,
  summary: ScanSummary | null = null,
  message: string | null = null,
) {
  void emit<ScanTaskEvent>(SCAN_EVENT, {
    request_id: task.request_id, scope: state ? "site" : "task", site_id: state?.site_id ?? null, kind,
    phase: state?.phase ?? null, processed_files: state?.processed_files ?? null,
    total_files: state?.total_files ?? null, hashed_files: state?.hashed_files ?? null,
    reused_files: state?.reused_files ?? null, hashes_pending: state?.hashes_pending ?? null,
    current_path: state?.current_path ?? null, site_states: state ? null : task.site_states,
    summary, message,
  });
}

export function installPreviewBackend(scenario: PreviewScenario) {
  const scans = new Map<number, PreviewScan>();
  let nextRequest = 1;
  const management = createManagementApi(scenario, () => scans.size > 0);
  const storage = createStorageApi(management.current);
  const slowInventorySite = scenario === "first-inventory" ? management.current().sites.keys().next().value : undefined;
  let inventoryVisibleAt: number | undefined;
  let firstSiteRead: Promise<void> | undefined;
  let interruptWorkspaceSwitch = scenario === "workspace-recovery";
  const interruptedReads = new Map<string, "interrupt" | "recover">(scenario === "recovery" ? [
    ["site_folder:studio-archive:0", "interrupt"],
    ["site:team-share", "interrupt"],
  ] : []);

  function startScan(selector: ScanSelector, { stepTime = 900, initialStep = 0, failureMessage }: PreviewScanOptions = {}): ScanTask {
    const workspace = management.current();
    const sites = selector.all ? [...workspace.sites.values()] : [getSite(workspace, selector.site_id!)];
    if (!sites.length) throw new Error("Add a source before scanning.");
    const activeIds = new Set([...scans.values()].flatMap((scan) => [...scan.inventories.keys()]));
    if (sites.some((site) => activeIds.has(site.id))) throw new Error("A scan is already running for this selection.");

    const inventories = new Map(sites.map((site) => [site.id, { site, tree: usedInventory(workspace, site) }]));
    const scan: PreviewScan = {
      inventories, step: initialStep, timer: undefined,
      task: {
        request_id: nextRequest++, selector, status: "running", created_at: new Date().toISOString(),
        site_states: sites.map((site) => ({
          site_id: site.id, status: "running", phase: "discovering", processed_files: 0, total_files: null,
          hashed_files: 0, reused_files: site.verified_file_count, hashes_pending: site.pending_hash_count,
          current_path: null,
        })),
      },
    };

    function updateProgress([phase, progress]: (typeof SCAN_STEPS)[number]) {
      scan.task.site_states = scan.task.site_states.map((state) => {
        const { site, tree } = scan.inventories.get(state.site_id)!;
        const known = phase === "hashing" || phase === "finalizing";
        const total = tree.file_count;
        const reused = Math.min(total, site.verified_file_count);
        const hashed = known ? Math.round((total - reused) * progress) : 0;
        const pending = total - reused - hashed;
        if (known) {
          setTree(workspace, {
            ...site, hash_status: "pending",
            latest_inventory_at: new Date().toISOString(),
          }, verifiedInventory(tree, reused + hashed).children);
        }
        return {
          ...state, phase, processed_files: known ? reused + hashed : Math.round(total * progress),
          total_files: total, hashed_files: hashed, reused_files: reused, hashes_pending: pending,
          current_path: phase === "finalizing" ? null : tree.children[0]?.path ?? null,
        };
      });
      scan.task.site_states.forEach((state) => notify(scan.task, "progress", state));
    }

    scans.set(scan.task.request_id, scan);
    scan.task.site_states.forEach((state) => notify(scan.task, "started", state));
    if (initialStep > 0) updateProgress(SCAN_STEPS[initialStep]);
    scan.timer = window.setInterval(() => {
      const step = failureMessage ? undefined : SCAN_STEPS[++scan.step];
      if (step) {
        updateProgress(step);
        return;
      }

      window.clearInterval(scan.timer);
      scans.delete(scan.task.request_id);
      if (failureMessage) {
        scan.task.status = "failed";
        notify(scan.task, "failed", null, null, failureMessage);
        return;
      }
      scan.task.status = "completed";
      scan.task.site_states = scan.task.site_states.map((state) => ({ ...state, status: "completed", current_path: null }));
      for (const state of scan.task.site_states) {
        const { site, tree } = scan.inventories.get(state.site_id)!;
        const now = new Date().toISOString();
        setTree(workspace, {
          ...site, scan_state: "done", hash_status: "ready", latest_inventory_at: now, last_scanned_at: now,
        }, verifiedInventory(tree, tree.file_count).children);
        const updated = storage.siteInventory(getSite(workspace, site.id));
        const summary: ScanSummary = {
          site_id: site.id, site_name: site.name, files_seen: tree.file_count,
          files_hashed: state.hashed_files, files_reused: state.reused_files, files_pending: 0, files_removed: 0,
          bytes_hashed: updated.verified_bytes, duplicate_files: updated.duplicate_files,
          duplicate_groups: storage.cleanup().duplicate_group_count_before,
        };
        notify(scan.task, "completed", state, summary);
      }
      notify(scan.task, "completed");
    }, stepTime);
    return { ...scan.task };
  }

  function cancelScan(id: number): CancelScanReport {
    const scan = scans.get(id);
    if (!scan) return { request_id: id, outcome: "not_found", status: null, effective_mode: null };
    if (scan.task.status === "cancelling") {
      return { request_id: id, outcome: "already_requested", status: "cancelling", effective_mode: "graceful" };
    }
    scan.task.status = "cancelling";
    notify(scan.task, "cancelling");
    const report: CancelScanReport = { request_id: id, outcome: "requested", status: "cancelling", effective_mode: "graceful" };
    // The published hashes become ready when atomic finalization finishes, even after a stop request.
    if (scan.task.site_states.every((state) => state.phase === "finalizing")) return report;

    window.clearInterval(scan.timer);
    window.setTimeout(() => {
      scans.delete(id);
      scan.task.status = "cancelled";
      for (const state of scan.task.site_states) notify(scan.task, "cancelled", state);
      notify(scan.task, "cancelled");
    }, 350);
    return report;
  }

  function loadDashboard(): Dashboard {
    const workspace = management.current();
    const active = [...scans.values()].map(({ task }) => task);
    const cleanup = storage.cleanup();
    return {
      workspace_name: workspace.name, workspace_path: management.load().active_workspace.path,
      sites: [...workspace.sites.values()].map((site) => {
        const current = storage.siteInventory(site);
        const task = active.find((scan) => scan.site_states.some((state) => state.site_id === site.id));
        const phase = task?.site_states.find((state) => state.site_id === site.id)?.phase;
        return {
          ...current,
          scan_state: task?.status === "cancelling" ? "cancelling" : phase ?? current.scan_state,
        };
      }),
      active_tasks: active.map((task) => ({ ...task })), staged: cleanup.staged_files,
      staged_hashes_pending: cleanup.hashes_pending, staged_cleanup_ready: cleanup.cleanup_ready,
      staged_verification_blockers: cleanup.verification_blockers,
      stage_history: cleanup.stage_history,
      staged_warnings: cleanup.warnings, last_updated_at: new Date().toISOString(),
    };
  }

  const handlers: Record<string, (args: CommandArgs) => unknown> = {
    "plugin:dialog|open": () => "/demo/Sample Folder",
    copy_text(args) {
      if (typeof args.text !== "string") throw new Error("Invalid clipboard text.");
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
      return navigator.clipboard.writeText(args.text);
    },
    load_dashboard: loadDashboard,
    load_management: management.load,
    create_workspace: management.createWorkspace,
    async switch_workspace(args) {
      if (interruptWorkspaceSwitch) {
        interruptWorkspaceSwitch = false;
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        throw new Error("The workspace folder is unavailable. Reconnect its drive and try again.");
      }
      return management.switchWorkspace(args);
    },
    create_site: management.createSite,
    rename_site: management.renameSite,
    remove_site: management.removeSite,
    add_site_folder: management.addFolder,
    remove_site_folder: management.removeFolder,
    connect_smb: management.connectSmb,
    match_smb_connection: management.matchSmb,
    add_remote_machine: management.addMachine,
    remove_remote_machine: management.removeMachine,
    probe_remote_machine: management.probeMachine,
    preflight_remote_machine: (args) => management.preflight(record(args.request)),
    install_remote_agent: (args) => management.install(record(args.request)),
    preview_remote_path_mapping: (args) => management.previewMapping(record(args.request)),
    complete_remote_path: (args) => management.completePath(record(args.request)),
    add_remote_path_mapping: management.addMapping,
    remove_remote_path_mapping: management.removeMapping,
    ssh_prompts: management.listPrompts,
    ssh_prompt_reply: (args) => management.replyPrompt(record(args.request)),
    get_storage_tree: storage.tree,
    get_storage_location: storage.location,
    get_storage_children: storage.children,
    get_adjacent_storage_file: storage.adjacentFile,
    async get_storage_view_snapshot(args) {
      const snapshot = storage.snapshot(args);
      if (snapshot.location.site_id === slowInventorySite && snapshot.tree.root.file_count > 0) {
        // Hold the first published rows through verification and the scan's completion.
        inventoryVisibleAt ??= Date.now() + 4_000;
        const remaining = inventoryVisibleAt - Date.now();
        if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      const folderId = snapshot.location.root.id;
      const read = interruptedReads.get(folderId);
      if (!read) return snapshot;
      if (read === "interrupt") interruptedReads.set(folderId, "recover");
      else interruptedReads.delete(folderId);
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      if (read === "interrupt") throw new Error("The inventory could not be read.");
      return snapshot;
    },
    search_indexed_files: storage.searchIndexedFiles,
    get_storage_file_reveal: storage.reveal,
    get_storage_node_reveal: storage.revealNode,
    open_folder_in: (args) => storage.openFolderIn(record(args.request)),
    get_file_content_matches: storage.fileContentMatches,
    find_similar_folders: (args) => storage.similarFolders(record(args.request)),
    stage_path: storage.stage,
    unstage_path: storage.unstage,
    move_stage_history: storage.moveStageHistory,
    preview_cleanup(args) {
      checkWorkspace(management.current(), args.expectedWorkspace);
      return storage.cleanup();
    },
    move_cleanup_to_trash(args) {
      checkWorkspace(management.current(), args.expectedWorkspace);
      if (scans.size) throw new Error("Finish the current scan, then preview cleanup again.");
      return storage.moveCleanupToTrash(args);
    },
    load_cleanup_activity(args) {
      const workspace = management.current();
      checkWorkspace(workspace, args.expectedWorkspace);
      return [...workspace.cleanup_operations.values()].at(-1) ?? null;
    },
    start_scan(args) {
      checkWorkspace(management.current(), args.expectedWorkspace);
      const selector = record(args.selector);
      return startScan(selector.all === true ? { all: true } : { site_id: stringArg(selector.site_id, "source ID") });
    },
    cancel_scan: (args) => cancelScan(numberArg(args.requestId, "scan ID")),
  };

  registerPreviewIpc(async (command, payload) => {
    if (!Object.hasOwn(handlers, command)) throw new Error(`Unsupported preview command: ${command}`);
    if (scenario === "slow-scan-start" && command === "start_scan") {
      await new Promise((resolve) => window.setTimeout(resolve, 2_500));
    }
    const response = await handlers[command](payload === undefined ? {} : record(payload));
    if (scenario === "slow-first-site" && command === "load_dashboard" && management.current().sites.size > 0) {
      firstSiteRead ??= new Promise<void>((resolve) => window.setTimeout(resolve, 2_500));
      await firstSiteRead;
    }
    if (scenario === "slow" && ["get_storage_view_snapshot", "get_storage_children", "get_storage_node_reveal", "search_indexed_files"].includes(command)) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
    return response;
  });

  const first = management.current().sites.values().next().value;
  if (scenario === "scanning" && first) {
    const hashingStep = SCAN_STEPS.findIndex(([phase]) => phase === "hashing");
    startScan({ site_id: first.id }, { stepTime: 5_000, initialStep: hashingStep });
  }
  if (scenario === "scan-failed" && first) {
    startScan({ site_id: first.id }, {
      stepTime: 4_000,
      failureMessage: `Couldn’t read a folder in ${first.name}.`,
    });
  }
}
