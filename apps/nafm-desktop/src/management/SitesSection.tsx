import { open } from "@tauri-apps/plugin-dialog";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { addSiteFolder, connectSmb, createSite, matchSmbConnection, removeSite, removeSiteFolder, renameSite } from "../lib/tauri";
import type { HiddenPolicy, ManagedSite, ManagementMutationResult, ManagementSnapshot, RemotePathMapping, SavedConnection, SiteKind } from "../lib/types";
import { formatBytes, formatCount, formatRelativeTime } from "../lib/format";
import { errorMessage, Field } from "./Field";
import { CheckIcon, CloseIcon, DriveIcon, NetworkIcon, PlusIcon, TrashIcon, WarningIcon } from "./Icons";

function hasRemoteMapping(path: string, mappings: RemotePathMapping[]): boolean {
  function normalize(value: string): string {
    try {
      const url = new URL(value.trim());
      return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return value.trim().replace(/\/+$/, "");
    }
  }
  const value = normalize(path);
  return mappings.some((mapping) => {
    const root = normalize(mapping.smb_root);
    return value === root || value.startsWith(`${root}/`);
  });
}

interface SmbMatch {
  connection: SavedConnection | null;
  checking: boolean;
}

function useSmbConnectionMatch(url: string, enabled: boolean) {
  const [match, setMatch] = useState<SmbMatch>({ connection: null, checking: false });
  const requestRef = useRef(0);

  const check = useCallback(async (candidate: string) => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const value = candidate.trim();
    if (!enabled || !value.toLowerCase().startsWith("smb://")) {
      setMatch({ connection: null, checking: false });
      return null;
    }

    setMatch({ connection: null, checking: true });
    try {
      const connection = await matchSmbConnection(value);
      if (requestRef.current === requestId) {
        setMatch({ connection, checking: false });
      }
      return connection;
    } catch {
      if (requestRef.current === requestId) {
        setMatch({ connection: null, checking: false });
      }
      return null;
    }
  }, [enabled]);

  useEffect(() => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const candidate = url.trim();
    if (!enabled || !candidate.toLowerCase().startsWith("smb://")) {
      setMatch({ connection: null, checking: false });
      return;
    }

    setMatch({ connection: null, checking: true });
    const timer = window.setTimeout(() => {
      void matchSmbConnection(candidate)
        .then((connection) => {
          if (requestRef.current === requestId) {
            setMatch({ connection, checking: false });
          }
        })
        .catch(() => {
          if (requestRef.current === requestId) {
            setMatch({ connection: null, checking: false });
          }
        });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [enabled, url]);

  return { ...match, check };
}

interface SmbConnectionFieldsProps {
  url: string;
  saved: SavedConnection | null;
  checking: boolean;
  disabled: boolean;
  onMutation: (result: ManagementMutationResult) => void;
  onConnected: (url: string) => Promise<SavedConnection | null>;
  onBusyChange: (busy: boolean) => void;
}

function SmbConnectionFields({
  url,
  saved,
  checking,
  disabled,
  onMutation,
  onConnected,
  onBusyChange,
}: SmbConnectionFieldsProps) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setUsername(saved?.username ?? "");
    setPassword("");
    setError(null);
  }, [saved?.url, saved?.username, url]);

  async function submit() {
    if (disabled || busy || !url.trim() || !username.trim() || !password) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const next = await connectSmb(url.trim(), username.trim(), password);
      setPassword("");
      setEditing(false);
      onMutation(next);
      await onConnected(url);
    } catch (connectionError) {
      setError(errorMessage(connectionError));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  if (checking && !saved && !editing) {
    return (
      <div className="connection-available" role="status">
        <span className="mini-spinner" />
        <div><strong>Checking saved connections…</strong><small>Looking for access to this SMB location</small></div>
      </div>
    );
  }

  if (saved && !editing) {
    return (
      <div className="connection-available" role="status">
        <span><CheckIcon /></span>
        <div><strong>Saved connection available</strong><small>{saved.username} · {saved.url}</small></div>
        <button type="button" onClick={() => setEditing(true)} disabled={disabled}>Reconnect</button>
      </div>
    );
  }

  return (
    <div
      className="inline-connection-form"
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="management-inline-note">
        <NetworkIcon />
        <span>{saved ? "Update the saved connection for this share." : "Connect once to verify and save credentials before adding this root."}</span>
      </div>
      <div className="management-form-grid two-columns">
        <Field label="Username">
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" disabled={disabled || busy} />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={disabled || busy} />
        </Field>
      </div>
      {error && <p className="management-form-error" role="alert">{error}</p>}
      <div className="management-form-actions compact-actions">
        {saved && <button className="ghost-button" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>}
        <button
          className="secondary-button"
          type="button"
          onClick={() => void submit()}
          disabled={disabled || busy || !url.trim() || !username.trim() || !password}
        >
          <NetworkIcon />{busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}

interface RootFieldsProps {
  kind: SiteKind;
  path: string;
  hiddenPolicy: HiddenPolicy;
  savedConnection: SavedConnection | null;
  checkingConnection: boolean;
  remoteMappingAvailable: boolean;
  disabled: boolean;
  onKindChange: (kind: SiteKind) => void;
  onPathChange: (path: string) => void;
  onHiddenPolicyChange: (policy: HiddenPolicy) => void;
  onMutation: (result: ManagementMutationResult) => void;
  onConnected: (url: string) => Promise<SavedConnection | null>;
  onBusyChange: (busy: boolean) => void;
}

function RootFields(props: RootFieldsProps) {
  const folderInputId = useId();
  const [pickerError, setPickerError] = useState<string | null>(null);

  async function chooseDirectory() {
    if (props.disabled) return;
    setPickerError(null);
    props.onBusyChange(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") props.onPathChange(selected);
    } catch (pickerFailure) {
      setPickerError(errorMessage(pickerFailure));
    } finally {
      props.onBusyChange(false);
    }
  }

  return (
    <>
      <fieldset className="root-kind-picker" disabled={props.disabled}>
        <legend>Root type</legend>
        <label className={props.kind === "local" ? "is-active" : ""}>
          <input className="sr-only" type="radio" name="root-kind" checked={props.kind === "local"} onChange={() => { props.onKindChange("local"); props.onPathChange(""); }} />
          <DriveIcon /><span><strong>Local folder</strong></span>
        </label>
        <label className={props.kind === "smb" ? "is-active" : ""}>
          <input className="sr-only" type="radio" name="root-kind" checked={props.kind === "smb"} onChange={() => { props.onKindChange("smb"); props.onPathChange(""); }} />
          <NetworkIcon /><span><strong>SMB share</strong></span>
        </label>
      </fieldset>
      {props.kind === "local" ? (
        <div className="management-field">
          <label htmlFor={folderInputId}>Folder</label>
          <div className="path-picker">
            <input id={folderInputId} value={props.path} readOnly placeholder="Choose a folder…" />
            <button className="secondary-button" type="button" onClick={() => void chooseDirectory()} disabled={props.disabled}>Choose</button>
          </div>
        </div>
      ) : (
        <>
          <Field label="SMB URL">
            <input type="url" value={props.path} onChange={(event) => props.onPathChange(event.target.value)} placeholder="smb://server/share" spellCheck={false} disabled={props.disabled} />
          </Field>
          {props.remoteMappingAvailable ? (
            <div className="connection-available" role="status">
              <span><CheckIcon /></span>
              <div><strong>Remote agent mapping available</strong><small>This root will be read through SSH.</small></div>
            </div>
          ) : (
            <SmbConnectionFields
              url={props.path}
              saved={props.savedConnection}
              checking={props.checkingConnection}
              disabled={props.disabled}
              onMutation={props.onMutation}
              onConnected={props.onConnected}
              onBusyChange={props.onBusyChange}
            />
          )}
        </>
      )}
      <Field label="Hidden files">
        <select value={props.hiddenPolicy} onChange={(event) => props.onHiddenPolicyChange(event.target.value as HiddenPolicy)} disabled={props.disabled}>
          <option value="include">Include hidden files</option>
          <option value="skip">Skip hidden files</option>
        </select>
      </Field>
      {pickerError && <p className="management-form-error" role="alert">{pickerError}</p>}
    </>
  );
}

function AddSiteForm({ snapshot, busy, setBusy, onMutation, onDone }: {
  snapshot: ManagementSnapshot;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  onDone: (siteId: string) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SiteKind>("local");
  const [path, setPath] = useState("");
  const [hiddenPolicy, setHiddenPolicy] = useState<HiddenPolicy>("include");
  const [error, setError] = useState<string | null>(null);
  const smbMatch = useSmbConnectionMatch(path, kind === "smb");
  const remoteMappingAvailable = kind === "smb" && hasRemoteMapping(path, snapshot.remote_path_mappings);
  const smbReady = kind === "local" || remoteMappingAvailable || Boolean(smbMatch.connection);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !path.trim() || !smbReady) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createSite(
        snapshot.active_workspace.name,
        name.trim(),
        path.trim(),
        hiddenPolicy,
      );
      const created = result.snapshot?.sites.find(
        (site) => !snapshot.sites.some((oldSite) => oldSite.id === site.id),
      );
      onMutation(result, true);
      onDone(created?.id ?? result.snapshot?.sites.at(-1)?.id ?? "");
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="management-form-card add-site-card" onSubmit={submit}>
      <span className="eyebrow">NEW SITE</span>
      <h3>Add a storage site</h3>
      <p>Group folders that should be scanned together.</p>
      <Field label="Site name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Camera media" autoComplete="off" disabled={busy} autoFocus /></Field>
      <RootFields
        kind={kind}
        path={path}
        hiddenPolicy={hiddenPolicy}
        savedConnection={smbMatch.connection}
        checkingConnection={smbMatch.checking}
        remoteMappingAvailable={remoteMappingAvailable}
        disabled={busy}
        onKindChange={setKind}
        onPathChange={setPath}
        onHiddenPolicyChange={setHiddenPolicy}
        onMutation={(result) => onMutation(result, false)}
        onConnected={smbMatch.check}
        onBusyChange={setBusy}
      />
      {kind === "smb" && path && !smbReady && !smbMatch.checking && <p className="management-form-warning"><WarningIcon />Connect this SMB location before adding it.</p>}
      {error && <p className="management-form-error" role="alert">{error}</p>}
      <button className="primary-button full-width" type="submit" disabled={busy || !name.trim() || !path.trim() || !smbReady}><PlusIcon />{busy ? "Adding…" : "Add site"}</button>
    </form>
  );
}

function AddRootForm({ site, workspaceName, remotePathMappings, busy, setBusy, onMutation, onCancel }: {
  site: ManagedSite;
  workspaceName: string;
  remotePathMappings: RemotePathMapping[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<SiteKind>("local");
  const [path, setPath] = useState("");
  const [hiddenPolicy, setHiddenPolicy] = useState<HiddenPolicy>("include");
  const [error, setError] = useState<string | null>(null);
  const smbMatch = useSmbConnectionMatch(path, kind === "smb");
  const remoteMappingAvailable = kind === "smb" && hasRemoteMapping(path, remotePathMappings);
  const smbReady = kind === "local" || remoteMappingAvailable || Boolean(smbMatch.connection);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !path.trim() || !smbReady) return;
    setBusy(true);
    setError(null);
    try {
      onMutation(await addSiteFolder(
        workspaceName,
        site.id,
        path.trim(),
        hiddenPolicy,
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
      <RootFields
        kind={kind}
        path={path}
        hiddenPolicy={hiddenPolicy}
        savedConnection={smbMatch.connection}
        checkingConnection={smbMatch.checking}
        remoteMappingAvailable={remoteMappingAvailable}
        disabled={busy}
        onKindChange={setKind}
        onPathChange={setPath}
        onHiddenPolicyChange={setHiddenPolicy}
        onMutation={(result) => onMutation(result, false)}
        onConnected={smbMatch.check}
        onBusyChange={setBusy}
      />
      {kind === "smb" && path && !smbReady && !smbMatch.checking && <p className="management-form-warning"><WarningIcon />Connect this SMB location before adding it.</p>}
      {error && <p className="management-form-error" role="alert">{error}</p>}
      <button className="primary-button full-width" type="submit" disabled={busy || !path.trim() || !smbReady}><PlusIcon />{busy ? "Adding…" : "Add root"}</button>
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

export function SitesSection({ snapshot, selectedSiteId, busy, setBusy, onSelectedSiteChange, onMutation }: {
  snapshot: ManagementSnapshot;
  selectedSiteId: string | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSelectedSiteChange: (siteId: string | null) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const selected = snapshot.sites.find((site) => site.id === selectedSiteId) ?? null;
  const adding = selectedSiteId === null;
  return (
    <section className="management-section management-sites" aria-labelledby="site-management-title">
      <header className="management-section-heading">
        <h2 id="site-management-title">Storage sites</h2>
        <button className="primary-button" type="button" onClick={() => onSelectedSiteChange(null)} disabled={busy}><PlusIcon />Add site</button>
      </header>
      <div className="site-management-grid">
        <div className="management-list site-management-list" aria-label="Configured sites">
          {snapshot.sites.length === 0 ? (
            <div className="management-empty compact"><DriveIcon /><p>No sites in this workspace.</p></div>
          ) : snapshot.sites.map((site) => (
            <button key={site.id} type="button" className={selected?.id === site.id ? "is-active" : ""} onClick={() => onSelectedSiteChange(site.id)} disabled={busy}>
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
        {adding ? (
          <AddSiteForm snapshot={snapshot} busy={busy} setBusy={setBusy} onMutation={onMutation} onDone={(siteId) => onSelectedSiteChange(siteId || (snapshot.sites[0]?.id ?? null))} />
        ) : selected ? (
          <SiteDetail site={selected} workspaceName={snapshot.active_workspace.name} remotePathMappings={snapshot.remote_path_mappings} busy={busy} setBusy={setBusy} onMutation={onMutation} />
        ) : (
          <div className="management-empty"><DriveIcon /><h3>Select a site</h3><p>Choose a site to edit its name and roots.</p></div>
        )}
      </div>
    </section>
  );
}
