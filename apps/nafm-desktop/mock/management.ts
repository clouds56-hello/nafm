import { emit } from "@tauri-apps/api/event";
import { parseSmbLocation, smbRootContains } from "../src/lib/smb";
import type {
  HiddenPolicy, InstallAgentProgress, ManagedSiteFolder, ManagementMutationResult, ManagementSnapshot,
  MappingPreview, PathCompletion, PreflightReport, RemoteMachine, SavedConnection, SetupCheck, SiteOverview, SshPrompt,
  WorkspaceSummary,
} from "../src/lib/types";
import { buildFolder, PREVIEW_WORKSPACE, type PreviewScenario } from "./fixtures";
import { checkWorkspace, getSite, getTree, makeWorkspace, setTree, stringArg, type CommandArgs } from "./workspace";

const AGENT_TARGET = "x86_64-unknown-linux-musl";
const DEMO_SHARE = "smb://media.example.test/Studio";

function pause() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 180));
}

function successfulCheck(stage: string, message: string): SetupCheck {
  return { stage, status: "passed", message, remedy: null };
}

function previewLocalPath(path: string) {
  const root = path.replaceAll("\\", "/");
  const parts: string[] = [];
  for (const part of root.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return (root.startsWith("/") ? "/" : "") + parts.join("/");
}

function localRootContains(parent: string, child: string) {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

export function createManagementApi(scenario: PreviewScenario, scanning: () => boolean) {
  const startsEmpty = scenario === "empty" || scenario === "first-inventory";
  let active = makeWorkspace(PREVIEW_WORKSPACE, startsEmpty ? "empty" : scenario);
  const archive = makeWorkspace("Field notes", "empty");
  const workspaces = new Map([[active.name, active], [archive.name, archive]]);
  const connections = new Map<string, SavedConnection>();
  if (!startsEmpty) {
    connections.set(DEMO_SHARE, { url: DEMO_SHARE, username: "sample-reader" });
    active.machines.set("sample-studio-agent", {
      id: "sample-studio-agent", name: "Studio server", ssh_target: "studio.example.test",
      added_at: "2025-11-04T10:15:00.000Z", agent_installation: null,
    });
  }
  const trusted = new Set<string>();
  const prompts = new Map<string, { prompt: SshPrompt; finish(accepted: boolean): void }>();
  let nextId = 1;

  function workspace(args: CommandArgs) {
    checkWorkspace(active, args.workspaceName ?? args.workspace_name);
  }

  function requireIdle() {
    if (scanning()) throw new Error("Finish all active scans before changing the workspace or its sources.");
  }

  function workspaceSummary(name: string): WorkspaceSummary {
    return { name, path: `/demo/Workspaces/${name}/storage.db`, active: name === active.name };
  }

  function load(): ManagementSnapshot {
    return {
      active_workspace: workspaceSummary(active.name),
      workspaces: [...workspaces.keys()].map(workspaceSummary),
      sites: [...active.sites.values()].map((site) => ({
        ...site,
        added_at: site.latest_inventory_at ?? "2025-11-04T10:15:00.000Z",
        folders: [...active.folders.values()].filter((folder) => folder.site_id === site.id),
      })),
      connections: [...connections.values()],
      remote_machines: [...active.machines.values()],
      remote_path_mappings: [...active.mappings.values()],
    };
  }

  function mutation(): ManagementMutationResult {
    const snapshot = load();
    return { snapshot, active_workspace: snapshot.active_workspace, refresh_error: null };
  }

  function switchWorkspace(name: string, create = false) {
    requireIdle();
    const existing = workspaces.get(name);
    if (create) {
      if (existing) throw new Error(`Workspace already exists: ${name}`);
      active = makeWorkspace(name, "empty");
      workspaces.set(name, active);
    } else {
      if (!existing) throw new Error(`Workspace not found: ${name}`);
      active = existing;
    }
    return mutation();
  }

  function matchingConnection(url: string) {
    const location = parseSmbLocation(url);
    return [...connections.values()]
      .filter((connection) => smbRootContains(connection.url, location))
      .sort((a, b) => b.url.split("/").length - a.url.split("/").length)[0] ?? null;
  }

  function folderInput(input: string) {
    const remote = /^smb:\/\//i.test(input);
    if (!remote) return { path: input, kind: "local" as const };
    const location = parseSmbLocation(input);
    const mapped = [...active.mappings.values()].some((mapping) => smbRootContains(mapping.smb_root, location));
    if (!mapped && !matchingConnection(input)) throw new Error(`no saved credentials for SMB location: ${location.normalized_url}`);
    return { path: location.normalized_url, kind: "smb" as const };
  }

  function checkFolder(folder: ReturnType<typeof folderInput>, siteId?: string) {
    const remote = folder.kind === "smb" ? parseSmbLocation(folder.path) : null;
    const localPath = remote ? null : previewLocalPath(folder.path);
    for (const existing of active.folders.values()) {
      if (existing.kind !== folder.kind) continue;
      if (existing.site_id === siteId) {
        if (existing.path === folder.path) throw new Error("This folder is already tracked.");
        continue;
      }
      const overlaps = remote
        ? smbRootContains(existing.path, remote) || smbRootContains(folder.path, parseSmbLocation(existing.path))
        : localPath !== null && (localRootContains(previewLocalPath(existing.path), localPath)
          || localRootContains(localPath, previewLocalPath(existing.path)));
      if (overlaps) {
        const owner = getSite(active, existing.site_id);
        throw new Error(`Cannot add ${folder.path} because it overlaps ${existing.path} in site ${owner.name}.`);
      }
    }
  }

  function addFolder(site: SiteOverview, folder: ReturnType<typeof folderInput>, hidden: unknown) {
    const hiddenPolicy: HiddenPolicy = hidden === "skip" ? "skip" : "include";
    const folderId = `preview-folder-${nextId++}`;
    const managed: ManagedSiteFolder = {
      ...folder, id: folderId, site_id: site.id, hidden_policy: hiddenPolicy, added_at: new Date().toISOString(),
    };
    const name = folder.path.replace(/[/\\]+$/, "").split(/[/\\]/).at(-1) || folder.path;
    const root = buildFolder(folderId, name, folder.path, folder.kind === "smb" ? "smb_root" : "local_root", []);
    const roots = [...getTree(active, site.id).children, root];
    active.folders.set(folderId, managed);
    setTree(active, {
      ...site, kind: roots.length === 1 ? folder.kind : site.kind,
      location: roots.length === 1 ? folder.path : site.location, hash_status: "unscanned",
    }, roots);
  }

  function createSite(args: CommandArgs) {
    workspace(args);
    requireIdle();
    const name = stringArg(args.name, "source name");
    if ([...active.sites.values()].some((site) => site.name === name)) throw new Error(`Site already exists: ${name}`);
    const folder = typeof args.folderPath === "string" && args.folderPath.trim() ? folderInput(args.folderPath.trim()) : null;
    if (folder) checkFolder(folder);
    const site: SiteOverview = {
      id: `sample-source-${nextId++}`, name, location: "No folders", kind: "local",
      connection_state: "unknown", scan_state: "idle", hash_status: "unscanned",
      latest_inventory_at: null, last_scanned_at: null, total_files: 0, total_bytes: 0,
      verified_file_count: 0, verified_bytes: 0, pending_hash_count: 0, duplicate_files: 0, duplicate_bytes: 0,
    };
    active.sites.set(site.id, site);
    if (folder) addFolder(site, folder, args.hiddenPolicy);
    return mutation();
  }

  function removeFolder(id: string) {
    const folder = active.folders.get(id);
    if (!folder) throw new Error("Folder is no longer tracked.");
    const site = getSite(active, folder.site_id);
    const roots = getTree(active, site.id).children.filter((root) => root.id !== id);
    const first = roots[0];
    active.folders.delete(id);
    for (const [id, file] of active.staged) {
      if (file.site_folder_id === folder.id) active.staged.delete(id);
    }
    setTree(active, {
      ...site, location: first?.path ?? "No folders", kind: first?.kind === "smb_root" ? "smb" : "local",
    }, roots);
    return mutation();
  }

  function getMachine(args: CommandArgs) {
    workspace(args);
    const id = stringArg(args.machineId ?? args.machine_id, "remote machine ID");
    const machine = active.machines.get(id);
    if (!machine) throw new Error("The remote machine is no longer registered.");
    return machine;
  }

  async function verifyHost(machine: RemoteMachine) {
    if (trusted.has(machine.ssh_target)) return;
    const id = `preview-prompt-${nextId++}`;
    const host = machine.ssh_target.split("@").at(-1) ?? machine.ssh_target;
    const accepted = await new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => finish(false), 60_000);
      function finish(accepted: boolean) {
        window.clearTimeout(timeout);
        prompts.delete(id);
        void emit("ssh://prompts-changed");
        resolve(accepted);
      }
      prompts.set(id, {
        finish,
        prompt: {
          prompt_id: id, ssh_target: machine.ssh_target, confirmation: true,
          message: "The preview host has not been trusted in this session.",
          host_key: { host, key_type: "ED25519", fingerprint: "SHA256:sample-preview-host-fingerprint" },
        },
      });
      void emit("ssh://prompts-changed");
    });
    if (!accepted) throw new Error("SSH connection cancelled.");
    trusted.add(machine.ssh_target);
  }

  async function preflight(args: CommandArgs): Promise<PreflightReport> {
    const machine = getMachine(args);
    const requestId = stringArg(args.request_id, "request ID");
    const progress: InstallAgentProgress = { request_id: requestId, machine_id: machine.id, message: "Checking preview SSH connection" };
    void emit("agent://setup-progress", progress);
    await pause();
    await verifyHost(machine);
    return {
      machine_id: machine.id, ssh_target: machine.ssh_target, checked_at: new Date().toISOString(),
      checks: [
        successfulCheck("local_ssh", "Preview SSH client is ready."),
        successfulCheck("host_key", "Preview fingerprint confirmed."),
        successfulCheck("platform", "Linux · x86-64"),
        successfulCheck("bundle", "Preview agent bundle is available."),
        machine.agent_installation
          ? successfulCheck("agent", "Preview agent installed and verified.")
          : { stage: "agent", status: "warning", message: "A preview agent has not been installed.", remedy: null },
      ],
      target: AGENT_TARGET, can_install: true, agent_ready: Boolean(machine.agent_installation),
    };
  }

  async function install(args: CommandArgs) {
    requireIdle();
    const machine = getMachine(args);
    const requestId = stringArg(args.request_id, "request ID");
    await verifyHost(machine);
    for (const message of ["Preparing preview agent", "Copying preview bundle", "Verifying preview agent"]) {
      void emit<InstallAgentProgress>("agent://install-progress", { request_id: requestId, machine_id: machine.id, message });
      await pause();
    }
    workspace(args);
    active.machines.set(machine.id, {
      ...machine,
      agent_installation: {
        target: AGENT_TARGET, agent_version: "0.1.1-preview",
        executable_path: "/demo/agents/nafm-agent", executable_hash: "sample-agent-digest",
      },
    });
    return mutation();
  }

  async function previewMapping(args: CommandArgs): Promise<MappingPreview> {
    const machine = getMachine(args);
    const smbRoot = parseSmbLocation(stringArg(args.smb_root, "SMB root")).normalized_url;
    const remoteRoot = stringArg(args.remote_root, "remote path");
    if (!/^\/|^[A-Za-z]:[/\\]/.test(remoteRoot)) throw new Error("Enter an absolute remote path.");
    await verifyHost(machine);
    await pause();
    return {
      smb_root: smbRoot, remote_root: remoteRoot, checked_at: new Date().toISOString(),
      check: successfulCheck("remote_path", "The preview directory and sample files are readable."),
      files: [{ relative_path: "Projects/README.txt", size_bytes: 2_048, modified_unix_nanos: 0 }], truncated: false,
    };
  }

  async function completePath(args: CommandArgs): Promise<PathCompletion> {
    const machine = getMachine(args);
    if (args.interactive === true) await verifyHost(machine);
    const prefix = typeof args.path === "string" ? args.path : "";
    const paths = ["/srv/media/", "/srv/media/Studio/", "/srv/media/Studio/Projects/", "/srv/media/Archive/", "/mnt/team/"];
    return { paths: paths.filter((path) => path.startsWith(prefix) && path !== prefix), truncated: false };
  }

  if (scenario === "first-inventory") {
    createSite({ workspaceName: PREVIEW_WORKSPACE, name: "Survey archive", folderPath: "/demo/Survey archive" });
  }

  return {
    current: () => active,
    load, createSite, preflight, install, previewMapping, completePath,
    createWorkspace: (args: CommandArgs) => switchWorkspace(stringArg(args.name, "workspace name"), true),
    switchWorkspace: (args: CommandArgs) => switchWorkspace(stringArg(args.name, "workspace name")),
    renameSite(args: CommandArgs) {
      workspace(args);
      requireIdle();
      const site = getSite(active, stringArg(args.siteId, "site ID"));
      const name = stringArg(args.name, "site name");
      if ([...active.sites.values()].some((other) => other.id !== site.id && other.name === name)) {
        throw new Error(`Site already exists: ${name}`);
      }
      setTree(active, { ...site, name }, getTree(active, site.id).children);
      return mutation();
    },
    removeSite(args: CommandArgs) {
      workspace(args);
      requireIdle();
      const site = getSite(active, stringArg(args.siteId, "site ID"));
      for (const [id, folder] of active.folders) if (folder.site_id === site.id) active.folders.delete(id);
      for (const [id, file] of active.staged) if (file.site_id === site.id) active.staged.delete(id);
      active.trees.delete(site.id);
      active.sites.delete(site.id);
      return mutation();
    },
    addFolder(args: CommandArgs) {
      workspace(args);
      requireIdle();
      const site = getSite(active, stringArg(args.siteId, "site ID"));
      const folder = folderInput(stringArg(args.path, "folder path"));
      checkFolder(folder, site.id);
      addFolder(site, folder, args.hiddenPolicy);
      return mutation();
    },
    removeFolder(args: CommandArgs) {
      workspace(args);
      requireIdle();
      return removeFolder(stringArg(args.folderId, "folder ID"));
    },
    connectSmb(args: CommandArgs) {
      const url = parseSmbLocation(stringArg(args.url, "SMB URL")).normalized_url;
      const username = stringArg(args.username, "SMB username");
      stringArg(args.password, "SMB password");
      connections.set(url, { url, username });
      return mutation();
    },
    matchSmb: (args: CommandArgs) => matchingConnection(stringArg(args.url, "SMB URL")),
    addMachine(args: CommandArgs) {
      workspace(args);
      requireIdle();
      const id = `preview-machine-${nextId++}`;
      active.machines.set(id, {
        id, name: stringArg(args.name, "remote machine name"), ssh_target: stringArg(args.sshTarget, "SSH target"),
        added_at: new Date().toISOString(), agent_installation: null,
      });
      return mutation();
    },
    removeMachine(args: CommandArgs) {
      requireIdle();
      const machine = getMachine(args);
      for (const [id, mapping] of active.mappings) {
        if (mapping.remote_machine_id === machine.id) active.mappings.delete(id);
      }
      active.machines.delete(machine.id);
      return mutation();
    },
    probeMachine: (args: CommandArgs) => verifyHost(getMachine(args)),
    async addMapping(args: CommandArgs) {
      requireIdle();
      const machine = getMachine(args);
      const preview = await previewMapping({
        workspace_name: args.workspaceName, machine_id: args.machineId, smb_root: args.smbRoot, remote_root: args.remoteRoot,
      });
      workspace(args);
      const id = `preview-mapping-${nextId++}`;
      active.mappings.set(id, {
        id, remote_machine_id: machine.id, smb_root: preview.smb_root,
        remote_root: preview.remote_root, added_at: new Date().toISOString(),
      });
      return mutation();
    },
    removeMapping(args: CommandArgs) {
      workspace(args);
      requireIdle();
      active.mappings.delete(stringArg(args.mappingId, "mapping ID"));
      return mutation();
    },
    listPrompts: () => [...prompts.values()].map(({ prompt }) => prompt),
    replyPrompt(args: CommandArgs) {
      const prompt = prompts.get(stringArg(args.prompt_id, "prompt ID"));
      if (!prompt) throw new Error("The SSH prompt has expired.");
      prompt.finish(args.response === prompt.prompt.host_key?.fingerprint);
    },
  };
}
