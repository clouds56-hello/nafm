import { type FormEvent, type MouseEvent, useEffect, useState } from "react";
import { addSiteFolder, removeSite, removeSiteFolder, renameSite } from "../lib/tauri";
import type { ManagedSite, ManagementMutationResult, ManagementSnapshot, RemotePathMapping } from "../lib/types";
import { formatBytes, formatCount, formatRelativeTime } from "../lib/format";
import { useAddedSiteRow } from "../atlas/useAddedSiteRow";
import { errorMessage, Field } from "./Field";
import { CloseIcon, DriveIcon, NetworkIcon, PlusIcon, TrashIcon } from "./Icons";
import { SiteRootFields, useSiteRoot } from "./SiteRootFields";
import { resolveAddedSite, type SiteAddition } from "./siteAddition";

function AddRootForm({ site, workspaceName, remotePathMappings, busy, setBusy, onMutation, onCancel }: {
  site: ManagedSite;
  workspaceName: string;
  remotePathMappings: RemotePathMapping[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  onCancel: () => void;
}) {
  const root = useSiteRoot(remotePathMappings);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !root.ready) return;
    setBusy(true);
    setError(null);
    try {
      onMutation(await addSiteFolder(
        workspaceName,
        site.id,
        root.path.trim(),
        root.hiddenPolicy,
      ), true);
      onCancel();
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="management-form-card nested-form" onSubmit={submit}>
      <header><div><span className="eyebrow">NEW ROOT</span><h3>Add to {site.name}</h3></div><button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="Close add root form"><CloseIcon /></button></header>
      <SiteRootFields root={root} disabled={busy} onBusyChange={setBusy} onMutation={(result) => onMutation(result, false)} />
      {error && <p className="management-form-error" role="alert">{error}</p>}
      <button className="primary-button full-width" type="submit" disabled={busy || !root.ready}><PlusIcon />{busy ? "Adding…" : "Add root"}</button>
    </form>
  );
}

function SiteDetail({ site, workspaceName, remotePathMappings, busy, setBusy, onMutation }: {
  site: ManagedSite;
  workspaceName: string;
  remotePathMappings: RemotePathMapping[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const [name, setName] = useState(site.name);
  const [addingRoot, setAddingRoot] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(site.name);
    setAddingRoot(false);
    setConfirming(null);
    setError(null);
  }, [site.id, site.name]);

  async function rename(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || name.trim() === site.name) return;
    setBusy(true);
    setError(null);
    try {
      onMutation(await renameSite(workspaceName, site.id, name.trim()), true);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  async function removeFolder(folderId: string) {
    if (confirming !== folderId) {
      setConfirming(folderId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onMutation(await removeSiteFolder(workspaceName, folderId), true);
      setConfirming(null);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  async function unregisterSite() {
    if (confirming !== site.id) {
      setConfirming(site.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onMutation(await removeSite(workspaceName, site.id), true);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  if (addingRoot) {
    return <AddRootForm site={site} workspaceName={workspaceName} remotePathMappings={remotePathMappings} busy={busy} setBusy={setBusy} onMutation={onMutation} onCancel={() => setAddingRoot(false)} />;
  }

  return (
    <div className="site-detail">
      <header className="site-detail-heading">
        <span className={`management-site-icon ${site.folders.some((folder) => folder.kind === "smb") ? "smb" : ""}`}>
          {site.folders.some((folder) => folder.kind === "smb") ? <NetworkIcon /> : <DriveIcon />}
        </span>
        <div>
          <span className="eyebrow">SITE DETAILS</span>
          <h3>{site.name}</h3>
          <p>
            {formatCount(site.total_files)} files · {formatBytes(site.total_bytes)} · {site.hash_status === "ready"
              ? formatRelativeTime(site.last_scanned_at)
              : site.pending_hash_count > 0
                ? `${formatCount(site.pending_hash_count)} hashes pending`
                : site.latest_inventory_at ? `Indexed ${formatRelativeTime(site.latest_inventory_at)}` : "Not indexed"}
          </p>
        </div>
      </header>
      <form className="inline-rename-form" onSubmit={rename}>
        <Field label="Display name"><input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></Field>
        <button className="secondary-button" type="submit" disabled={busy || !name.trim() || name.trim() === site.name}>Save</button>
      </form>
      <section className="roots-section" aria-labelledby="site-roots-title">
        <header><div><span className="eyebrow">ROOTS</span><h4 id="site-roots-title">Folders in this site</h4></div><button className="secondary-button" type="button" onClick={() => setAddingRoot(true)} disabled={busy}><PlusIcon />Add root</button></header>
        {site.folders.length === 0 ? (
          <div className="management-empty compact"><DriveIcon /><p>This site has no roots yet.</p></div>
        ) : (
          <ul className="root-list">
            {site.folders.map((folder) => (
              <li key={folder.id}>
                <span className={`root-kind-icon ${folder.kind}`}>
                  {folder.kind === "smb" ? <NetworkIcon /> : <DriveIcon />}
                </span>
                <span><strong title={folder.path}>{folder.path}</strong><small>{folder.kind.toUpperCase()} · {folder.hidden_policy === "skip" ? "Hidden skipped" : "Hidden included"}</small></span>
                <button className={confirming === folder.id ? "danger-button is-confirming" : "remove-button"} type="button" onClick={() => void removeFolder(folder.id)} disabled={busy} aria-label={confirming === folder.id ? `Confirm removal of ${folder.path}` : `Remove ${folder.path}`}>
                  <TrashIcon />{confirming === folder.id && "Confirm"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="management-form-error" role="alert">{error}</p>}
      <footer className="danger-zone">
        <div><strong>Unregister site</strong><small>Removes this site from the index.</small></div>
        <button className={`danger-button ${confirming === site.id ? "is-confirming" : ""}`} type="button" onClick={() => void unregisterSite()} disabled={busy}><TrashIcon />{confirming === site.id ? "Confirm unregister" : "Unregister"}</button>
      </footer>
    </div>
  );
}

export function SitesSection({ snapshot, selectedSiteId, siteAddition, busy, setBusy, onAddSite, onSelectedSiteChange, onMutation }: {
  snapshot: ManagementSnapshot;
  selectedSiteId: string | null;
  siteAddition?: SiteAddition;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string) => void;
  onSelectedSiteChange: (siteId: string | null) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const selected = snapshot.sites.find((site) => site.id === selectedSiteId) ?? null;
  const addedSite = resolveAddedSite(siteAddition, snapshot.active_workspace.name, snapshot.sites);
  const addedButton = useAddedSiteRow(busy ? undefined : addedSite, onSelectedSiteChange);
  return (
    <section className="management-section management-sites" aria-labelledby="site-management-title">
      <header className="management-section-heading">
        <h2 id="site-management-title">Storage sites</h2>
        <button className="primary-button" type="button" aria-haspopup="dialog" onClick={(event) => onAddSite(event, snapshot.active_workspace.name)} disabled={busy}><PlusIcon />Add site</button>
      </header>
      <div className="site-management-grid">
        <div className="management-list site-management-list" aria-label="Configured sites">
          {snapshot.sites.length === 0 ? (
            <div className="management-empty compact"><DriveIcon /><p>No sites in this workspace.</p></div>
          ) : snapshot.sites.map((site) => (
            <button
              key={site.id} ref={addedSite?.id === site.id ? addedButton : undefined}
              type="button" className={selected?.id === site.id ? "is-active" : ""} aria-current={selected?.id === site.id || undefined}
              onClick={() => onSelectedSiteChange(site.id)} disabled={busy}
            >
              <span className={`management-list-icon ${site.folders.some((folder) => folder.kind === "smb") ? "smb" : ""}`}>{site.folders.some((folder) => folder.kind === "smb") ? <NetworkIcon /> : <DriveIcon />}</span>
              <span>
                <strong>{site.name}</strong>
                <small>
                  {site.folders.length} {site.folders.length === 1 ? "root" : "roots"} · {formatCount(site.total_files)} files
                  {site.pending_hash_count > 0 ? ` · ${formatCount(site.pending_hash_count)} pending` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
        {selected ? (
          <SiteDetail site={selected} workspaceName={snapshot.active_workspace.name} remotePathMappings={snapshot.remote_path_mappings} busy={busy} setBusy={setBusy} onMutation={onMutation} />
        ) : snapshot.sites.length > 0 ? (
          <div className="management-empty"><DriveIcon /><h3>Select a site</h3><p>Choose a site to edit its name and roots.</p></div>
        ) : null}
      </div>
    </section>
  );
}
