import type {
  CleanupPreview, DuplicateFile, FileContentMatchesPage, FolderContentSummary, FolderSimilarityMatch, FolderSimilarityPage,
  SiteKind, SiteOverview, StageAddReport, StageRemoveReport, StageWarning, StorageChildrenPage,
  StorageFileReveal, StorageLocation, StorageNode, StorageTree, StorageViewSnapshot,
} from "../src/lib/types";
import { buildFolder, INVENTORY_DATE } from "./fixtures";
import { checkWorkspace, compareText, getSite, getTree, numberArg, stringArg, type CommandArgs, type PreviewWorkspace } from "./workspace";

interface IndexedFile extends DuplicateFile {
  content: string;
  kind: SiteKind;
  verified: boolean;
}

function contentKey(node: StorageNode) {
  return `${node.name}\u0000${node.total_bytes}`;
}

function indexedFiles(workspace: PreviewWorkspace) {
  const files: IndexedFile[] = [];

  function visit(node: StorageNode, site: SiteOverview, root: StorageNode) {
    if (node.kind === "file" && node.path) {
      files.push({
        file_id: node.id, path: node.path, site_id: site.id, site_folder_id: root.id,
        size_bytes: node.total_bytes, modified_unix_nanos: 0, content: contentKey(node),
        kind: root.kind === "smb_root" ? "smb" : "local", verified: node.verified_file_count > 0,
      });
    }
    node.children.forEach((child) => visit(child, site, root));
  }

  for (const site of workspace.sites.values()) {
    getTree(workspace, site.id).children.forEach((root) => visit(root, site, root));
  }
  return files;
}

function byContent(files: IndexedFile[]) {
  const groups = new Map<string, IndexedFile[]>();
  for (const file of files) {
    if (!file.verified) continue;
    const group = groups.get(file.content) ?? [];
    group.push(file);
    groups.set(file.content, group);
  }
  return groups;
}

function orderedChildren(node: StorageNode) {
  return [...node.children].sort((a, b) => b.total_bytes - a.total_bytes || compareText(a.name, b.name) || compareText(a.id, b.id));
}

function findPath(node: StorageNode, id: string): StorageNode[] | undefined {
  if (node.id === id) return [node];
  for (const child of node.children) {
    const ancestors = findPath(child, id);
    if (ancestors) return [node, ...ancestors];
  }
}

function siteRecord(site: SiteOverview) {
  return { id: site.id, name: site.name, added_at: INVENTORY_DATE };
}

function ratio(numerator: number, denominator: number) {
  return denominator ? Math.max(0, Math.min(1, numerator / denominator)) : 0;
}

function projectSite(workspace: PreviewWorkspace, siteId: string, targetId: string | null) {
  const site = getSite(workspace, siteId);
  const target = targetId ? getSite(workspace, targetId) : null;
  const allFiles = indexedFiles(workspace);
  const files = allFiles.filter((file) => file.site_id === siteId).sort((a, b) => compareText(a.path, b.path));
  const groups = byContent(files);
  const targetKeys = new Set(allFiles.filter((file) => file.verified && file.site_id === targetId).map((file) => file.content));
  const fileById = new Map(files.map((file) => [file.file_id, file]));
  const coverageTarget = target ? siteRecord(target) : null;

  function project(node: StorageNode, visibleChildren: StorageNode[]): StorageNode {
    const selectedFiles: IndexedFile[] = [];
    function collect(current: StorageNode) {
      const file = fileById.get(current.id);
      if (file) selectedFiles.push(file);
      current.children.forEach(collect);
    }
    collect(node);
    const verified = selectedFiles.filter((file) => file.verified);
    const content = byContent(verified);
    const weightedBytes = verified.reduce((sum, file) => sum + file.size_bytes / groups.get(file.content)!.length, 0);
    const healthyFiles = verified.reduce((sum, file) => sum + 1 / groups.get(file.content)!.length, 0);
    const estimatedSpace = verified.length
      ? 100 * (node.total_bytes ? ratio(weightedBytes, node.total_bytes) : ratio(healthyFiles, node.file_count)) : null;
    const unique = [...content.values()].map((copies) => copies[0]);
    const covered = unique.filter((file) => targetKeys.has(file.content));
    const contentBytes = unique.reduce((sum, file) => sum + file.size_bytes, node.total_bytes - node.verified_bytes);
    const coveredBytes = covered.reduce((sum, file) => sum + file.size_bytes, 0);
    const estimatedCoverage = target && verified.length
      ? 100 * (contentBytes ? ratio(coveredBytes, contentBytes) : ratio(covered.length, unique.length + node.pending_hash_count)) : null;
    const duplicates = site.hash_status === "ready"
      ? verified.filter((file) => (groups.get(file.content)?.length ?? 0) > 1) : [];
    const reclaimable = duplicates.filter((file) => groups.get(file.content)![0].file_id !== file.file_id);
    return {
      ...node, children: visibleChildren, duplicate_file_count: duplicates.length,
      duplicate_bytes: reclaimable.reduce((sum, file) => sum + file.size_bytes, 0),
      space_health: site.hash_status === "ready" ? estimatedSpace : null,
      coverage_health: site.hash_status === "ready" && target?.hash_status === "ready" ? estimatedCoverage : null,
      estimated_space_health: estimatedSpace, estimated_coverage_health: estimatedCoverage,
      space_healthy_file_equivalents: healthyFiles, space_total_files: node.file_count,
      coverage_covered_files: covered.length, coverage_total_files: target ? unique.length : 0,
    };
  }

  function bounded(node: StorageNode, depth: number, width: number): StorageNode {
    if (depth === 0 || width === 0) return project(node, []);
    const children = orderedChildren(node);
    const kept = children.length > width ? width - 1 : children.length;
    const visible = children.slice(0, kept).map((child) => bounded(child, depth - 1, width));
    if (kept < children.length) {
      const group = buildFolder(`smaller_items:${kept}:${node.id}`, "Smaller items", null, "smaller_items", children.slice(kept));
      visible.push(project(group, []));
    }
    return project(node, visible);
  }

  return { root: getTree(workspace, siteId), project, bounded, coverageTarget, site };
}

function options(args: CommandArgs) {
  return {
    siteId: stringArg(args.siteId, "source ID"),
    targetId: args.targetSiteId == null ? null : stringArg(args.targetSiteId, "target ID"),
  };
}

function dimensions(args: CommandArgs) {
  return { depth: numberArg(args.maxDepth, "map depth"), width: numberArg(args.maxChildren, "map branch limit") };
}

function paging(args: CommandArgs) {
  return {
    offset: numberArg(args.offset, "page offset"),
    limit: Math.min(200, Math.max(1, numberArg(args.limit, "page limit"))),
  };
}

function pageOffset(total: number, offset: number, limit: number) {
  return offset < total ? offset : Math.max(0, Math.floor((total - 1) / limit) * limit);
}

function nodePath(root: StorageNode, args: CommandArgs) {
  const id = stringArg(args.nodeId, "storage node");
  const path = findPath(root, id);
  const node = path?.at(-1);
  if (!path || !node) throw new Error(`storage node not found: ${id}`);
  if (node.kind === "file") throw new Error(`storage node is not navigable: ${id}`);
  return { path, node };
}

function makeTree(model: ReturnType<typeof projectSite>, args: CommandArgs): StorageTree {
  const { depth, width } = dimensions(args);
  return { site_id: model.site.id, coverage_target: model.coverageTarget, root: model.bounded(model.root, depth, width) };
}

function makeLocation(model: ReturnType<typeof projectSite>, args: CommandArgs): StorageLocation {
  const { depth, width } = dimensions(args);
  const { path, node } = nodePath(model.root, args);
  return {
    site_id: model.site.id, coverage_target: model.coverageTarget,
    breadcrumbs: path.map((ancestor) => model.project(ancestor, [])),
    root: model.bounded(node, depth, width),
  };
}

function makeChildren(model: ReturnType<typeof projectSite>, args: CommandArgs): StorageChildrenPage {
  const { node } = nodePath(model.root, args);
  const { offset, limit } = paging(args);
  const children = orderedChildren(node);
  const start = pageOffset(children.length, offset, limit);
  return {
    site: siteRecord(model.site), coverage_target: model.coverageTarget, parent: model.project(node, []),
    children: children.slice(start, start + limit).map((child) => model.project(child, [])),
    total_children: children.length, offset: start, limit,
  };
}

function makeSnapshot(model: ReturnType<typeof projectSite>, args: CommandArgs): StorageViewSnapshot {
  return { tree: makeTree(model, args), location: makeLocation(model, args), page: makeChildren(model, args) };
}

function matchesPath(filePath: string, target: string) {
  const file = filePath.replace(/\\/g, "/");
  const directory = target.replace(/\\/g, "/").replace(/\/+$/, "");
  return file === directory || file.startsWith(`${directory}/`);
}

function duplicateFile(file: IndexedFile): DuplicateFile {
  return {
    file_id: file.file_id, site_id: file.site_id, site_folder_id: file.site_folder_id,
    path: file.path, size_bytes: file.size_bytes, modified_unix_nanos: file.modified_unix_nanos,
  };
}

function verification(workspace: PreviewWorkspace, inventoryOnly = false) {
  const sites = [...workspace.sites.values()];
  return {
    workspace_pending_hash_count: sites.reduce((total, site) => total + site.pending_hash_count, 0),
    workspace_incomplete_site_count: sites.filter((site) => inventoryOnly
      ? !site.latest_inventory_at
      : site.hash_status !== "ready" && [...workspace.folders.values()].some((folder) => folder.site_id === site.id)).length,
  };
}

function readyFiles(workspace: PreviewWorkspace, files: IndexedFile[]) {
  return files.filter((file) => workspace.sites.get(file.site_id)?.hash_status === "ready");
}

export function createStorageApi(current: () => PreviewWorkspace) {
  function model(args: CommandArgs) {
    const { siteId, targetId } = options(args);
    return projectSite(current(), siteId, targetId);
  }

  function snapshot(args: CommandArgs) {
    checkWorkspace(current(), args.expectedWorkspace);
    return makeSnapshot(model(args), args);
  }

  function reveal(args: CommandArgs): StorageFileReveal {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const id = stringArg(args.fileId, "file ID");
    const file = indexedFiles(workspace).find((entry) => entry.file_id === id);
    if (!file) throw new Error("The preview file is no longer tracked.");
    const source = model({ ...args, siteId: file.site_id });
    const path = findPath(source.root, id);
    const parent = path?.at(-2);
    const node = path?.at(-1);
    if (!parent || !node) throw new Error("The file directory was not found.");
    const { limit } = paging({ ...args, offset: 0 });
    const index = orderedChildren(parent).findIndex((child) => child.id === id);
    return {
      ...makeSnapshot(source, { ...args, nodeId: parent.id, offset: Math.floor(index / limit) * limit }),
      selected_file: source.project(node, []),
    };
  }

  function fileContentMatches(args: CommandArgs): FileContentMatchesPage {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const siteId = stringArg(args.siteId, "source ID");
    const path = stringArg(args.path, "file path");
    const { offset, limit } = paging(args);
    const files = indexedFiles(workspace);
    const file = files.find((entry) => entry.site_id === siteId && entry.path === path);
    if (!file) throw new Error("The preview file is no longer tracked.");
    const status = !file.verified ? "not_hashed" : getSite(workspace, siteId).hash_status === "ready" ? "ready" : "needs_verification";
    const group = status === "ready" ? byContent(readyFiles(workspace, files)).get(file.content) ?? [] : [file];
    const rank = (entry: IndexedFile) => entry.file_id === file.file_id ? 0 : entry.site_id === siteId ? 1 : 2;
    const ordered = [...group].sort((a, b) => rank(a) - rank(b) || compareText(a.path, b.path));
    return {
      status, ...verification(workspace), offset, limit,
      total_matches: ordered.length,
      matches: ordered.slice(offset, offset + limit).map((entry) => ({
        ...duplicateFile(entry), site_name: getSite(workspace, entry.site_id).name, site_folder_kind: entry.kind,
        is_current: entry.file_id === file.file_id,
      })),
    };
  }

  function similarFolders(args: CommandArgs): FolderSimilarityPage {
    const workspace = current();
    checkWorkspace(workspace, args.workspace_name);
    const siteId = stringArg(args.site_id, "source ID");
    const { node: source } = nodePath(getTree(workspace, siteId), { nodeId: args.node_id });
    const { offset, limit } = paging(args);
    const allFiles = indexedFiles(workspace);

    function summarize(site: SiteOverview, node: StorageNode) {
      const files = allFiles.filter((file) => file.site_id === site.id && (!node.path || matchesPath(file.path, node.path)));
      const content = byContent(files);
      const bytes = [...content.values()].reduce((size, files) => size + files[0].size_bytes, 0);
      const verified = files.filter((file) => file.verified).length;
      const summary: FolderContentSummary = {
        site_id: site.id, site_name: site.name, node_id: node.id, path: node.path ?? site.location,
        file_count: files.length, verified_file_count: verified, pending_hash_count: files.length - verified,
        distinct_content_count: content.size, distinct_bytes: bytes, extra_copy_count: verified - content.size,
        inventory_ready: Boolean(site.latest_inventory_at),
      };
      return { summary, content };
    }

    const original = summarize(getSite(workspace, siteId), source);
    const matches: FolderSimilarityMatch[] = [];
    function visit(site: SiteOverview, folder: StorageNode) {
      if (folder.kind === "file") return;
      folder.children.forEach((child) => visit(site, child));
      if (!folder.path || folder.id === source.id || site.id === siteId &&
        (!source.path || matchesPath(folder.path, source.path) || matchesPath(source.path, folder.path))) return;
      const target = summarize(site, folder);
      const shared = [...target.content.entries()].filter(([key]) => original.content.has(key));
      if (!shared.length) return;
      const sharedBytes = shared.reduce((bytes, [, files]) => bytes + files[0].size_bytes, 0);
      const unionBytes = original.summary.distinct_bytes + target.summary.distinct_bytes - sharedBytes;
      const partial = original.summary.pending_hash_count > 0 || target.summary.pending_hash_count > 0;
      matches.push({
        folder: target.summary,
        similarity: 100 * (unionBytes ? ratio(sharedBytes, unionBytes) : ratio(shared.length, original.content.size + target.content.size - shared.length)),
        source_coverage: 100 * (original.summary.distinct_bytes ? ratio(sharedBytes, original.summary.distinct_bytes) : ratio(shared.length, original.content.size)),
        target_coverage: 100 * (target.summary.distinct_bytes ? ratio(sharedBytes, target.summary.distinct_bytes) : ratio(shared.length, target.content.size)),
        shared_content_count: shared.length, shared_bytes: sharedBytes, partial,
        source_only_count: original.content.size - shared.length, target_only_count: target.content.size - shared.length,
        source_only_bytes: original.summary.distinct_bytes - sharedBytes, target_only_bytes: target.summary.distinct_bytes - sharedBytes,
        identical_content: !partial && original.content.size === shared.length && target.content.size === shared.length,
      });
    }

    for (const site of workspace.sites.values()) visit(site, getTree(workspace, site.id));
    matches.sort((a, b) => b.similarity - a.similarity || compareText(a.folder.path, b.folder.path));
    return {
      source: original.summary, matches: matches.slice(offset, offset + limit), total_matches: matches.length,
      offset, limit, ...verification(workspace, true), generated_at: new Date().toISOString(),
    };
  }

  function stage(args: CommandArgs): StageAddReport {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const path = stringArg(args.path, "file or folder path");
    const files = indexedFiles(workspace);
    const verified = readyFiles(workspace, files).filter((file) => file.verified);
    const groups = byContent(verified);
    const candidates = verified.filter((file) => matchesPath(file.path, path) && (groups.get(file.content)?.length ?? 0) > 1)
      .sort((a, b) => compareText(a.path, b.path));
    const staged: DuplicateFile[] = [];
    const warnings: StageWarning[] = [];
    if (!candidates.length && !files.some((file) => file.path === path)) throw new Error(`The path has no indexed duplicate files: ${path}`);
    for (const file of candidates) {
      const group = groups.get(file.content)!;
      if (workspace.staged.has(file.file_id)) warnings.push({ path: file.path, reason: "already_staged" });
      else if (group.every((copy) => copy.file_id === file.file_id || workspace.staged.has(copy.file_id))) {
        warnings.push({ path: file.path, reason: "would_remove_last_copy" });
      } else {
        const entry = duplicateFile(file);
        workspace.staged.set(entry.file_id, entry);
        staged.push(entry);
      }
    }
    return { staged_files: staged, warnings };
  }

  function unstage(args: CommandArgs): StageRemoveReport {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const path = stringArg(args.path, "file or folder path");
    const removed = [...workspace.staged.values()].filter((file) => matchesPath(file.path, path));
    removed.forEach((file) => workspace.staged.delete(file.file_id));
    return { removed_files: removed, warnings: removed.length ? [] : [{ path, reason: "not_staged" }] };
  }

  function cleanup(): CleanupPreview {
    const workspace = current();
    const files = indexedFiles(workspace);
    const duplicateGroups = (selected: IndexedFile[]) => [...byContent(readyFiles(workspace, selected)).values()].filter((group) => group.length > 1);
    const staged = [...workspace.staged.values()];
    const before = duplicateGroups(files);
    const duplicateIds = new Set(before.flat().map((file) => file.file_id));
    const fileById = new Map(files.map((file) => [file.file_id, file]));
    const warnings: StageWarning[] = [];
    let pending = 0;
    for (const file of staged) {
      if (fileById.get(file.file_id)?.verified === false) pending++;
      if (!duplicateIds.has(file.file_id)) warnings.push({ path: file.path, reason: "not_duplicate" });
    }
    for (const group of before) {
      if (group.every((file) => workspace.staged.has(file.file_id))) {
        warnings.push({ path: group[group.length - 1].path, reason: "would_remove_last_copy" });
      }
    }
    const ready = warnings.length === 0;
    const remaining = ready ? files.filter((file) => !workspace.staged.has(file.file_id)) : files;
    const after = duplicateGroups(remaining);
    return {
      staged_files: staged, hashes_pending: pending,
      cleanup_ready: ready, warnings,
      tracked_file_count_before: files.length, tracked_file_count_after: remaining.length,
      duplicate_group_count_before: before.length, duplicate_group_count_after: after.length,
      duplicate_file_count_before: before.reduce((total, group) => total + group.length, 0),
      duplicate_file_count_after: after.reduce((total, group) => total + group.length, 0),
      db_entry_count_stable: true,
      duplicate_groups_after: after.map((group) => ({
        group_id: group[0].file_id, size_bytes: group[0].size_bytes, files: group.map(duplicateFile),
      })),
    };
  }

  function siteInventory(site: SiteOverview): SiteOverview {
    const workspace = current();
    const model = projectSite(workspace, site.id, null);
    const root = model.project(model.root, []);
    return {
      ...site, verified_file_count: root.verified_file_count, verified_bytes: root.verified_bytes,
      pending_hash_count: root.pending_hash_count, total_files: root.file_count, total_bytes: root.total_bytes,
      duplicate_files: root.duplicate_file_count, duplicate_bytes: root.duplicate_bytes,
    };
  }

  return {
    tree: (args: CommandArgs) => makeTree(model(args), args),
    location: (args: CommandArgs) => makeLocation(model(args), args),
    children: (args: CommandArgs) => makeChildren(model(args), args),
    snapshot, reveal, fileContentMatches, similarFolders, stage, unstage, cleanup, siteInventory,
  };
}
