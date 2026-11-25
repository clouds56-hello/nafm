import type {
  CleanupPreview, DirectorySort, DuplicateFile, FileContentMatchesPage, FolderContentSummary, FolderSimilarityMatch, FolderSimilarityPage,
  IndexedFileSearchPage,
  SiteKind, SiteOverview, StageAddReport, StageHistoryState, StageRemoveReport, StageWarning, StorageChildrenPage,
  StorageDirectoryAnchor, StorageDirectoryFilter, StorageFileReveal, StorageLocation, StorageNode, StorageTree, StorageViewSnapshot,
} from "../src/lib/types";
import { DEFAULT_DIRECTORY_SORT } from "../src/lib/types";
import { buildFolder, INVENTORY_DATE } from "./fixtures";
import { checkWorkspace, compareText, getSite, getTree, numberArg, record, stringArg, type CommandArgs, type PreviewWorkspace } from "./workspace";

interface IndexedFile extends DuplicateFile {
  node_id: string;
  name: string;
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
        file_id: `tracked:${node.id}`, node_id: node.id, name: node.name, path: node.path, site_id: site.id, site_folder_id: root.id,
        size_bytes: node.total_bytes, modified_unix_nanos: (node.modified_unix_millis ?? 0) * 1_000_000, content: contentKey(node),
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

function stageHistory(workspace: PreviewWorkspace, indexed: ReadonlyMap<string, IndexedFile>): StageHistoryState {
  const { snapshots, current_index } = workspace.stage_history;
  const currentIds = new Set([...workspace.staged.keys()].filter((id) => indexed.has(id)));
  const differs = ({ file_ids }: (typeof snapshots)[number]) => {
    const liveIds = file_ids.filter((id) => indexed.has(id));
    return liveIds.length !== currentIds.size || liveIds.some((id) => !currentIds.has(id));
  };
  // Deleted files no longer distinguish historical copies from the current selection.
  const undo = snapshots.slice(0, current_index).reverse().find(differs);
  const redo = snapshots.slice(current_index + 1).find(differs);
  return { snapshot_id: snapshots[current_index].id, undo_snapshot_id: undo?.id ?? null, redo_snapshot_id: redo?.id ?? null };
}

function recordStageSnapshot(workspace: PreviewWorkspace) {
  const history = workspace.stage_history;
  const index = history.current_index + 1;
  history.snapshots.splice(index, history.snapshots.length - index, {
    id: String(history.next_id++), file_ids: [...workspace.staged.keys()],
  });
  history.current_index = index;
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

function directorySort(value: unknown): DirectorySort {
  if (value == null) return DEFAULT_DIRECTORY_SORT;
  const { field, direction } = record(value);
  if ((field !== "size" && field !== "name" && field !== "date") || (direction !== "asc" && direction !== "desc")) {
    throw new Error("Invalid directory ordering.");
  }
  return { field, direction };
}

function matchesDirectoryQuery(node: StorageNode, query: string) {
  return node.name.toLowerCase().includes(query);
}

function orderedChildren(node: StorageNode, sort = DEFAULT_DIRECTORY_SORT, query = "") {
  const entries = query ? node.children.filter((child) => matchesDirectoryQuery(child, query)) : [...node.children];
  return entries.sort((a, b) => {
    let order: number;
    if (sort.field === "date") {
      const missing = Number(a.modified_unix_millis === null) - Number(b.modified_unix_millis === null);
      if (missing) return missing;
      order = (a.modified_unix_millis ?? 0) - (b.modified_unix_millis ?? 0);
    } else if (sort.field === "name") order = compareText(a.name.toLowerCase(), b.name.toLowerCase());
    else order = a.total_bytes - b.total_bytes;
    return (sort.direction === "desc" ? -order : order) || compareText(a.name, b.name) || compareText(a.id, b.id);
  });
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
  const fileByNode = new Map(files.map((file) => [file.node_id, file]));
  const coverageTarget = target ? siteRecord(target) : null;

  function project(node: StorageNode, visibleChildren: StorageNode[]): StorageNode {
    const selectedFiles: IndexedFile[] = [];
    function collect(current: StorageNode) {
      const file = fileByNode.get(current.id);
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

function makeChildren(model: ReturnType<typeof projectSite>, args: CommandArgs, query = ""): StorageChildrenPage {
  const { node } = nodePath(model.root, args);
  const { offset, limit } = paging(args);
  const children = orderedChildren(node, directorySort(args.sort), query);
  const anchor = args.anchor;
  const index = anchor == null ? -1 : children.findIndex((child) => child.id === anchor);
  const lastPage = Math.floor(Math.max(0, children.length - 1) / limit) * limit;
  const start = anchor == null ? query ? offset : pageOffset(children.length, offset, limit)
    : index >= 0 ? Math.floor(index / limit) * limit : Math.min(offset, lastPage);
  return projectChildrenPage(model, node, children, start, limit);
}

function projectChildrenPage(
  model: ReturnType<typeof projectSite>,
  parent: StorageNode,
  children: StorageNode[],
  offset: number,
  limit: number,
): StorageChildrenPage {
  return {
    site: siteRecord(model.site), coverage_target: model.coverageTarget, parent: model.project(parent, []),
    children: children.slice(offset, offset + limit).map((child) => model.project(child, [])),
    total_children: children.length, offset, limit,
  };
}

function makeSnapshot(
  model: ReturnType<typeof projectSite>,
  args: CommandArgs,
  anchor?: StorageDirectoryAnchor,
): StorageViewSnapshot {
  const { node } = nodePath(model.root, args);
  const { offset, limit } = paging(args);
  const children = orderedChildren(node, directorySort(args.sort));
  const childIndex = anchor ? children.findIndex((child) => child.id === anchor.child_id) : -1;
  const start = childIndex >= 0 ? Math.floor(childIndex / limit) * limit : pageOffset(children.length, offset, limit);
  const inspected = anchor?.inspect_file
    ? children[childIndex] ?? findPath(node, anchor.child_id)?.at(-1)
    : undefined;
  const snapshot = {
    tree: makeTree(model, args), location: makeLocation(model, args),
    page: projectChildrenPage(model, node, children, start, limit),
    ...(inspected?.kind === "file" ? { inspected_file: model.project(inspected, []) } : {}),
  };

  const query = anchor?.query?.trim().toLowerCase();
  if (!query || childIndex < 0 || !matchesDirectoryQuery(children[childIndex], query)) return snapshot;
  const matches = children.filter((child) => matchesDirectoryQuery(child, query));
  const filteredIndex = matches.indexOf(children[childIndex]);
  return {
    ...snapshot,
    filtered_page: projectChildrenPage(model, node, matches, Math.floor(filteredIndex / limit) * limit, limit),
  };
}

function makeReveal(
  model: ReturnType<typeof projectSite>,
  args: CommandArgs,
  filter?: StorageDirectoryFilter,
): StorageFileReveal {
  const id = stringArg(args.nodeId, "storage node ID");
  const path = findPath(model.root, id);
  const parent = path?.at(-2);
  const node = path?.at(-1);
  if (!parent || node?.kind !== "file") throw new Error("The file is no longer available at this source.");
  const query = filter?.folder_id === parent.id ? filter.query : null;
  return {
    ...makeSnapshot(model, { ...args, nodeId: parent.id, offset: 0 }, { child_id: id, query }),
    selected_file: model.project(node, []),
  };
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
    if (args.anchor == null) return makeSnapshot(model(args), args);
    const { child_id, query, inspect_file } = record(args.anchor);
    if (typeof child_id !== "string" || (query != null && typeof query !== "string")
      || (inspect_file !== undefined && typeof inspect_file !== "boolean")) {
      throw new Error("Invalid directory anchor.");
    }
    return makeSnapshot(model(args), args, { child_id, query: query ?? null, inspect_file });
  }

  function children(args: CommandArgs) {
    const { query, anchor } = args;
    if (query != null && typeof query !== "string") throw new Error("Invalid directory search.");
    if (anchor != null && typeof anchor !== "string") throw new Error("Invalid directory anchor.");
    return makeChildren(model(args), args, query?.trim().toLowerCase());
  }

  function adjacentFile(args: CommandArgs) {
    const request = record(args.request);
    const workspace = current();
    checkWorkspace(workspace, request.workspace_name);
    const siteId = stringArg(request.site_id, "source ID");
    const targetId = request.target_site_id == null ? null : stringArg(request.target_site_id, "target ID");
    const childId = request.child_id;
    if (typeof childId !== "string" || !childId) throw new Error("Missing file ID.");
    if (request.query != null && typeof request.query !== "string") throw new Error("Invalid directory search.");
    const { direction } = request;
    if (direction !== "previous" && direction !== "next") throw new Error("Invalid file direction.");
    const { limit } = paging({ offset: 0, limit: args.limit });
    const site = projectSite(workspace, siteId, targetId);
    const { node } = nodePath(site.root, { nodeId: request.folder_id });
    const entries = orderedChildren(node, directorySort(request.sort), request.query?.trim().toLowerCase());
    const currentIndex = entries.findIndex((entry) => entry.id === childId && entry.kind === "file");
    if (currentIndex < 0) throw new Error("The selected file is no longer in these Contents results.");

    const step = direction === "previous" ? -1 : 1;
    for (let index = currentIndex + step; index >= 0 && index < entries.length; index += step) {
      if (entries[index].kind !== "file") continue;
      const offset = Math.floor(index / limit) * limit;
      return { index, page: projectChildrenPage(site, node, entries, offset, limit) };
    }
    return null;
  }

  function searchIndexedFiles(args: CommandArgs): IndexedFileSearchPage {
    const workspace = current();
    checkWorkspace(workspace, args.expected_workspace);
    const { offset, limit } = paging(args);
    if (typeof args.query !== "string") throw new Error("Invalid file search.");
    const anchor = args.anchor_file_id;
    if (anchor != null && typeof anchor !== "string") throw new Error("Invalid search file.");
    const direction = args.anchor_direction;
    if (direction != null && direction !== "previous" && direction !== "next") throw new Error("Invalid file direction.");
    const query = args.query.trim().toLowerCase();
    const matches = query ? indexedFiles(workspace)
      .filter((file) => file.name.toLowerCase().includes(query))
      .map((file) => ({
        file_id: file.file_id,
        site_id: file.site_id,
        site_name: getSite(workspace, file.site_id).name,
        name: file.name,
        path: file.path,
        size_bytes: file.size_bytes,
        verified: file.verified,
      })) : [];
    matches.sort((a, b) => compareText(a.site_name, b.site_name) || compareText(a.path, b.path) || compareText(a.file_id, b.file_id));
    const index = anchor == null ? -1 : matches.findIndex((file) => file.file_id === anchor);
    const candidate = index + (direction === "previous" ? -1 : 1);
    const neighbor = direction && index >= 0 && candidate >= 0 && candidate < matches.length ? candidate : undefined;
    const lastPage = Math.floor(Math.max(0, matches.length - 1) / limit) * limit;
    const start = index >= 0 ? Math.floor((neighbor ?? index) / limit) * limit
      : anchor == null ? offset : Math.min(offset, lastPage);
    return {
      matches: matches.slice(start, start + limit), offset: start, limit, total_matches: matches.length,
      ...(index >= 0 ? { anchor_index: index } : {}),
      ...(neighbor !== undefined ? { neighbor_index: neighbor } : {}),
    };
  }

  function openFolderIn(request: CommandArgs) {
    const workspace = current();
    checkWorkspace(workspace, request.workspace_name);
    const tree = getTree(workspace, stringArg(request.site_id, "source ID"));
    const node = findPath(tree, stringArg(request.node_id, "folder ID"))?.at(-1);
    if (!node?.path || (node.kind !== "directory" && node.kind !== "local_root" && node.kind !== "smb_root")) {
      throw new Error("The folder is no longer available.");
    }
    if (request.destination === "file_manager") return `Preview would open ${node.name} in the file manager.`;
    if (request.destination !== "terminal") throw new Error("Unknown folder destination.");
    if (/^smb:\/\//i.test(node.path)) throw new Error("Terminal requires a local folder.");
    return `Preview would open ${node.name} in the terminal.`;
  }

  function reveal(args: CommandArgs): StorageFileReveal {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const id = stringArg(args.fileId, "file ID");
    const file = indexedFiles(workspace).find((entry) => entry.file_id === id);
    if (!file) throw new Error("The preview file is no longer tracked.");
    return makeReveal(model({ ...args, siteId: file.site_id }), { ...args, nodeId: file.node_id });
  }

  function revealNode(args: CommandArgs): StorageFileReveal {
    checkWorkspace(current(), args.expectedWorkspace);
    if (args.filter == null) return makeReveal(model(args), args);
    const { folder_id, query } = record(args.filter);
    if (typeof folder_id !== "string" || typeof query !== "string") throw new Error("Invalid directory search.");
    return makeReveal(model(args), args, { folder_id, query });
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
    if (staged.length) recordStageSnapshot(workspace);
    return { staged_files: staged, warnings, stage_history: stageHistory(workspace, new Map(files.map((file) => [file.file_id, file]))) };
  }

  function unstage(args: CommandArgs): StageRemoveReport {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const path = stringArg(args.path, "file or folder path");
    const removed = [...workspace.staged.values()].filter((file) => matchesPath(file.path, path));
    removed.forEach((file) => workspace.staged.delete(file.file_id));
    if (removed.length) recordStageSnapshot(workspace);
    const indexed = new Map(indexedFiles(workspace).map((file) => [file.file_id, file]));
    return {
      removed_files: removed, warnings: removed.length ? [] : [{ path, reason: "not_staged" }], stage_history: stageHistory(workspace, indexed),
    };
  }

  function moveStageHistory(args: CommandArgs): CleanupPreview {
    const workspace = current();
    checkWorkspace(workspace, args.expectedWorkspace);
    const { direction, expected_snapshot_id, target_snapshot_id } = record(args.request);
    if ((direction !== "undo" && direction !== "redo") || typeof expected_snapshot_id !== "string" || typeof target_snapshot_id !== "string") {
      throw new Error("Invalid stage history request.");
    }
    const files = indexedFiles(workspace);
    const indexed = new Map(files.map((file) => [file.file_id, file]));
    const currentHistory = stageHistory(workspace, indexed);
    const target = direction === "undo" ? currentHistory.undo_snapshot_id : currentHistory.redo_snapshot_id;
    if (currentHistory.snapshot_id !== expected_snapshot_id || target !== target_snapshot_id) {
      throw new Error("The staged list changed. Review the updated list before using Undo or Redo.");
    }

    const history = workspace.stage_history;
    history.current_index = history.snapshots.findIndex(({ id }) => id === target);
    workspace.staged.clear();
    for (const id of history.snapshots[history.current_index].file_ids) {
      const file = indexed.get(id);
      if (file) workspace.staged.set(id, duplicateFile(file));
    }
    return cleanup(workspace, files);
  }

  function cleanup(workspace = current(), files = indexedFiles(workspace)): CleanupPreview {
    const duplicateGroups = (selected: IndexedFile[]) => [...byContent(readyFiles(workspace, selected)).values()].filter((group) => group.length > 1);
    const staged = [...workspace.staged.values()];
    const before = duplicateGroups(files);
    const duplicateIds = new Set(before.flat().map((file) => file.file_id));
    const fileById = new Map(files.map((file) => [file.file_id, file]));
    const knownCopies = byContent(files);
    const verificationBySite = new Map<string, Set<string>>();
    const warnings: StageWarning[] = [];
    let pending = 0;

    function needsVerification(file: IndexedFile) {
      return !file.verified || workspace.sites.get(file.site_id)?.hash_status !== "ready";
    }

    function recordBlocker(siteId: string, fileId: string) {
      const fileIds = verificationBySite.get(siteId) ?? new Set<string>();
      fileIds.add(fileId);
      verificationBySite.set(siteId, fileIds);
    }

    for (const file of staged) {
      const indexed = fileById.get(file.file_id);
      if (indexed?.verified === false) pending++;
      if (!duplicateIds.has(file.file_id)) warnings.push({ path: file.path, reason: "not_duplicate" });
      if (!indexed) continue;
      if (needsVerification(indexed)) {
        recordBlocker(indexed.site_id, indexed.file_id);
        continue;
      }
      // Check only known retained copies, including when every eligible copy is already staged.
      const retained = (knownCopies.get(indexed.content) ?? [])
        .filter((peer) => peer.verified && !workspace.staged.has(peer.file_id));
      if (retained.some((peer) => !needsVerification(peer))) continue;
      retained.forEach((peer) => recordBlocker(peer.site_id, indexed.file_id));
    }
    for (const group of before) {
      if (group.every((file) => workspace.staged.has(file.file_id))) {
        warnings.push({ path: group[group.length - 1].path, reason: "would_remove_last_copy" });
      }
    }
    const ready = warnings.length === 0;
    const remaining = ready ? files.filter((file) => !workspace.staged.has(file.file_id)) : files;
    const after = duplicateGroups(remaining);
    const reviewGroups = ready ? before.flatMap((group) => {
      const stagedFileIds = group.filter((file) => workspace.staged.has(file.file_id)).map((file) => file.file_id);
      if (!stagedFileIds.length) return [];
      return [{
        group_id: group[0].file_id,
        staged_file_ids: stagedFileIds,
        retained_files: group.filter((file) => !workspace.staged.has(file.file_id)).map(duplicateFile),
      }];
    }) : [];
    return {
      staged_files: staged, hashes_pending: pending,
      cleanup_ready: ready, warnings,
      stage_history: stageHistory(workspace, fileById),
      verification_blockers: [...verificationBySite].sort(([left], [right]) => compareText(left, right))
        .map(([site_id, fileIds]) => ({ site_id, staged_file_ids: [...fileIds].sort(compareText) })),
      tracked_file_count_before: files.length, tracked_file_count_after: remaining.length,
      duplicate_group_count_before: before.length, duplicate_group_count_after: after.length,
      duplicate_file_count_before: before.reduce((total, group) => total + group.length, 0),
      duplicate_file_count_after: after.reduce((total, group) => total + group.length, 0),
      db_entry_count_stable: true,
      duplicate_groups_after: after.map((group) => ({
        group_id: group[0].file_id, size_bytes: group[0].size_bytes, files: group.map(duplicateFile),
      })),
      review_groups: reviewGroups,
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
    children, adjacentFile, snapshot, searchIndexedFiles, openFolderIn, reveal, revealNode, fileContentMatches, similarFolders, stage, unstage, moveStageHistory, cleanup, siteInventory,
  };
}
