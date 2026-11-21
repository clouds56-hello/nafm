import type {
  DuplicateFile, ManagedSiteFolder, RemoteMachine, RemotePathMapping, SiteOverview, StorageNode,
} from "../src/lib/types";
import { buildFolder, createFixtures, INVENTORY_DATE, type PreviewScenario } from "./fixtures";

export interface PreviewWorkspace {
  name: string;
  sites: Map<string, SiteOverview>;
  trees: Map<string, StorageNode>;
  folders: Map<string, ManagedSiteFolder>;
  machines: Map<string, RemoteMachine>;
  mappings: Map<string, RemotePathMapping>;
  staged: Map<string, DuplicateFile>;
}

export function makeWorkspace(name: string, scenario: PreviewScenario): PreviewWorkspace {
  const { sites, trees } = createFixtures(scenario);
  const folders = new Map<string, ManagedSiteFolder>();
  for (const site of sites) {
    for (const root of trees.get(site.id)?.children ?? []) {
      folders.set(root.id, {
        id: root.id, site_id: site.id, kind: root.kind === "smb_root" ? "smb" : "local",
        path: root.path!, hidden_policy: "include", added_at: INVENTORY_DATE,
      });
    }
  }

  return {
    name, sites: new Map(sites.map((site) => [site.id, site])), trees, folders,
    machines: new Map(), mappings: new Map(), staged: new Map(),
  };
}

export function getSite(workspace: PreviewWorkspace, id: string) {
  const site = workspace.sites.get(id);
  if (!site) throw new Error(`Site not found: ${id}`);
  return site;
}

export function getTree(workspace: PreviewWorkspace, id: string) {
  const site = getSite(workspace, id);
  return workspace.trees.get(id) ?? buildFolder(`site:${id}`, site.name, null, "site", []);
}

export function setTree(workspace: PreviewWorkspace, site: SiteOverview, roots: StorageNode[]) {
  const tree = buildFolder(`site:${site.id}`, site.name, null, "site", roots);
  workspace.trees.set(site.id, tree);
  workspace.sites.set(site.id, {
    ...site, total_files: tree.file_count, total_bytes: tree.total_bytes,
    verified_file_count: tree.verified_file_count, verified_bytes: tree.verified_bytes,
    pending_hash_count: tree.pending_hash_count,
  });
}

export type CommandArgs = Record<string, unknown>;

export function record(value: unknown): CommandArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error("Invalid preview command arguments.");
  }
  return value as CommandArgs;
}

export function stringArg(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${label}.`);
  return value.trim();
}

export function numberArg(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

export function checkWorkspace(workspace: PreviewWorkspace, expected: unknown) {
  if (expected !== workspace.name) throw new Error("The preview workspace changed. Reload and try again.");
}

export function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
