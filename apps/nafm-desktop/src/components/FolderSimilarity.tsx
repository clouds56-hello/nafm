import { useCallback, useEffect, useRef, useState } from "react";
import { findSimilarFolders } from "../lib/tauri";
import { formatBytes, formatCount, formatHealth } from "../lib/format";
import type { FolderSimilarityMatch, FolderSimilarityPage } from "../lib/types";

interface Props {
  workspaceName: string;
  siteId: string;
  nodeId: string;
}

export function FolderSimilarity({ workspaceName, siteId, nodeId }: Props) {
  const [page, setPage] = useState<FolderSimilarityPage | null>(null);
  const [selected, setSelected] = useState<FolderSimilarityMatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestVersion = useRef(0);

  const search = useCallback(async (offset = 0) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const result = await findSimilarFolders({ workspace_name: workspaceName, site_id: siteId, node_id: nodeId, offset, limit: 10 });
      if (mounted.current && requestVersion.current === version) setPage(result);
    } catch (error) {
      if (mounted.current && requestVersion.current === version) { setPage(null); setError(String(error)); }
    } finally {
      if (mounted.current && requestVersion.current === version) setLoading(false);
    }
  }, [workspaceName, siteId, nodeId]);
  useEffect(() => {
    mounted.current = true;
    // Defer once so StrictMode's setup/cleanup check cannot launch duplicate work.
    const timer = window.setTimeout(() => void search(), 0);
    return () => { mounted.current = false; requestVersion.current += 1; window.clearTimeout(timer); };
  }, [search]);

  return <section className="folder-similarity" aria-label="Similar folders" aria-busy={loading}>
    <button type="button" className="secondary-button" disabled={loading} onClick={() => void search()}>
      {loading ? "Comparing indexed contents…" : page ? "Refresh similar folders" : "Find similar folders"}
    </button>
    <p className="folder-similarity-hint">Recursive content only. Names and layout are ignored. No network reads.</p>
    {error && <p role="alert" className="management-form-error">{error}</p>}
    {page && <>
      <p className="folder-similarity-hint">{formatCount(page.source.verified_file_count)} / {formatCount(page.source.file_count)} source files verified · {formatCount(page.source.distinct_content_count)} distinct contents · {formatCount(page.source.extra_copy_count)} extra copies.</p>
      {(page.workspace_pending_hash_count > 0 || page.workspace_incomplete_site_count > 0) && <p role="status" className="folder-similarity-warning">Partial index: {formatCount(page.workspace_pending_hash_count)} pending hashes; {formatCount(page.workspace_incomplete_site_count)} sites without a complete inventory. Matches may be missing and scores may change. Stale hashes are excluded.</p>}
      {page.total_matches === 0 ? <p role="status">{page.source.distinct_content_count === 0 ? "No verified source content to compare. Scan and hash this folder first." : "No other indexed folders share verified content. The selected folder and its same-site ancestors/descendants are excluded."}</p> : <>
        <p className="folder-similarity-hint">Byte-weighted shared / union content. Copy counts do not affect the score.</p>
        <ul className="folder-similarity-list">{page.matches.map((match) => <li key={`${match.folder.site_id}:${match.folder.node_id}`}>
          <button type="button" aria-pressed={selected === match} onClick={() => setSelected(match)}>
            <span><strong>{match.folder.site_name}</strong><small>{match.folder.path}</small></span>
            <span><strong>{formatHealth(match.similarity)}</strong><small>{match.partial ? "Partial" : match.identical_content ? "Same content" : "Similarity"}</small></span>
          </button>
        </li>)}</ul>
        <div className="folder-similarity-pagination">
          <button type="button" className="ghost-button" disabled={loading || page.offset === 0} onClick={() => void search(Math.max(0, page.offset - page.limit))}>Previous</button>
          <small>{page.offset + 1}–{page.offset + page.matches.length} of {formatCount(page.total_matches)}</small>
          <button type="button" className="ghost-button" disabled={loading || page.offset + page.matches.length >= page.total_matches} onClick={() => void search(page.offset + page.limit)}>Next</button>
        </div>
      </>}
      {selected && <div className="folder-similarity-detail" aria-label="Folder comparison details">
        <h4>{selected.folder.site_name}: {selected.folder.path}</h4>
        <dl>
          <dt>Selected folder covered by match</dt><dd>{formatHealth(selected.source_coverage)}</dd>
          <dt>Match covered by selected folder</dt><dd>{formatHealth(selected.target_coverage)}</dd>
          <dt>Shared distinct content</dt><dd>{formatCount(selected.shared_content_count)} · {formatBytes(selected.shared_bytes)}</dd>
          <dt>Only in selected folder</dt><dd>{formatCount(selected.source_only_count)} · {formatBytes(selected.source_only_bytes)}</dd>
          <dt>Only in match</dt><dd>{formatCount(selected.target_only_count)} · {formatBytes(selected.target_only_bytes)}</dd>
          <dt>Match verified / total files</dt><dd>{formatCount(selected.folder.verified_file_count)} / {formatCount(selected.folder.file_count)}</dd>
          <dt>Match extra copies</dt><dd>{formatCount(selected.folder.extra_copy_count)}</dd>
        </dl>
        {selected.partial && <p className="folder-similarity-warning">These figures compare verified contents only, not the complete folders.</p>}
        <p className="folder-similarity-hint">Distinct contents count once. Empty-file-only comparisons use content counts. Similarity is not permission to delete files.</p>
      </div>}
      <small className="folder-similarity-hint">Snapshot: {new Date(page.generated_at).toLocaleString()}</small>
    </>}
  </section>;
}
