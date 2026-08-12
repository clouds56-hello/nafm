import { open } from "@tauri-apps/plugin-dialog";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  addSiteFolder,
  connectSmb,
  createSite,
  createWorkspace,
  matchSmbConnection,
  removeSite,
  removeSiteFolder,
  renameSite,
  switchWorkspace,
} from "../lib/tauri";
import type {
  HiddenPolicy,
  ManagedSite,
  ManagementMutationResult,
  ManagementSnapshot,
  SavedConnection,
  SiteKind,
} from "../lib/types";
import { formatBytes, formatCount, formatRelativeTime } from "../lib/format";
import {
  CheckIcon,
  CloseIcon,
  DriveIcon,
  NetworkIcon,
  PlusIcon,
  RefreshIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
  WorkspaceIcon,
} from "./Icons";

export type ManagementSection = "workspaces" | "sites" | "connections";

interface ManagementCenterProps {
  open: boolean;
  section: ManagementSection;
  selectedSiteId: string | null;
  snapshot: ManagementSnapshot | null;
  loading: boolean;
  error: string | null;
  activeTaskCount: number;
  onClose: () => void;
  onSectionChange: (section: ManagementSection) => void;
  onSelectedSiteChange: (siteId: string | null) => void;
  onBusyChange: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  onRetry: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="management-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
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
    if (!url.trim() || !username.trim() || !password) return;
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
  disabled: boolean;
  onKindChange: (kind: SiteKind) => void;
  onPathChange: (path: string) => void;
  onHiddenPolicyChange: (policy: HiddenPolicy) => void;
  onMutation: (result: ManagementMutationResult) => void;
  onConnected: (url: string) => Promise<SavedConnection | null>;
  onBusyChange: (busy: boolean) => void;
}

function RootFields(props: RootFieldsProps) {
  const [pickerError, setPickerError] = useState<string | null>(null);

  async function chooseDirectory() {
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
          <DriveIcon /><span><strong>Local folder</strong><small>Choose a directory on this Mac</small></span>
        </label>
        <label className={props.kind === "smb" ? "is-active" : ""}>
          <input className="sr-only" type="radio" name="root-kind" checked={props.kind === "smb"} onChange={() => { props.onKindChange("smb"); props.onPathChange(""); }} />
          <NetworkIcon /><span><strong>SMB share</strong><small>Use a saved network connection</small></span>
        </label>
      </fieldset>
      {props.kind === "local" ? (
        <Field label="Folder" hint="NAFM reads this folder but never removes source files from management.">
          <span className="path-picker">
            <input value={props.path} readOnly placeholder="Choose a folder…" />
            <button className="secondary-button" type="button" onClick={() => void chooseDirectory()} disabled={props.disabled}>Choose</button>
          </span>
        </Field>
      ) : (
        <>
          <Field label="SMB URL" hint="For example: smb://server/share/folder">
            <input type="url" value={props.path} onChange={(event) => props.onPathChange(event.target.value)} placeholder="smb://server/share" spellCheck={false} disabled={props.disabled} />
          </Field>
          <SmbConnectionFields
            url={props.path}
            saved={props.savedConnection}
            checking={props.checkingConnection}
            disabled={props.disabled}
            onMutation={props.onMutation}
            onConnected={props.onConnected}
            onBusyChange={props.onBusyChange}
          />
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

function WorkspaceSection({ snapshot, busy, setBusy, onMutation }: {
  snapshot: ManagementSnapshot;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createWorkspace(name.trim());
      setName("");
      onMutation(result, true);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  async function activate(nameToActivate: string) {
    if (nameToActivate === snapshot.active_workspace.name) return;
    setBusy(true);
    setError(null);
    try {
      onMutation(await switchWorkspace(nameToActivate), true);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-section" aria-labelledby="workspace-management-title">
      <header className="management-section-heading">
        <div><span className="eyebrow">WORKSPACES</span><h2 id="workspace-management-title">Separate libraries, one app</h2></div>
        <p>Each workspace has its own sites, scans, and cleanup staging.</p>
      </header>
      <div className="workspace-management-grid">
        <div className="management-list" aria-label="Available workspaces">
          {snapshot.workspaces.map((workspace) => (
            <button key={workspace.name} type="button" className={workspace.active ? "is-active" : ""} onClick={() => void activate(workspace.name)} disabled={busy || workspace.active}>
              <span className="management-list-icon"><WorkspaceIcon /></span>
              <span><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small></span>
              {workspace.active ? <span className="active-label"><CheckIcon />Active</span> : <span className="switch-label">Switch</span>}
            </button>
          ))}
        </div>
        <form className="management-form-card" onSubmit={create}>
          <span className="eyebrow">NEW WORKSPACE</span>
          <h3>Create and switch</h3>
          <p>Start with an empty, isolated catalog. Your saved SMB connections remain available.</p>
          <Field label="Workspace name" hint="Use letters, numbers, dashes, or underscores.">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="camera-archive" autoComplete="off" disabled={busy} />
          </Field>
          {error && <p className="management-form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={busy || !name.trim()}><PlusIcon />{busy ? "Creating…" : "Create workspace"}</button>
        </form>
      </div>
    </section>
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
  const smbReady = kind === "local" || Boolean(smbMatch.connection);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !path.trim() || !smbReady) return;
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
      <h3>Add a comparison boundary</h3>
      <p>A site can contain multiple roots. Duplicates are measured within it; coverage is compared across sites.</p>
      <Field label="Site name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Camera media" autoComplete="off" disabled={busy} autoFocus /></Field>
      <RootFields
        kind={kind}
        path={path}
        hiddenPolicy={hiddenPolicy}
        savedConnection={smbMatch.connection}
        checkingConnection={smbMatch.checking}
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

function AddRootForm({ site, workspaceName, busy, setBusy, onMutation, onCancel }: {
  site: ManagedSite;
  workspaceName: string;
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
  const smbReady = kind === "local" || Boolean(smbMatch.connection);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim() || !smbReady) return;
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

function SiteDetail({ site, workspaceName, busy, setBusy, onMutation }: {
  site: ManagedSite;
  workspaceName: string;
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
    if (!name.trim() || name.trim() === site.name) return;
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
    return <AddRootForm site={site} workspaceName={workspaceName} busy={busy} setBusy={setBusy} onMutation={onMutation} onCancel={() => setAddingRoot(false)} />;
  }

  return (
    <div className="site-detail">
      <header className="site-detail-heading">
        <span className={`management-site-icon ${site.folders.some((folder) => folder.kind === "smb") ? "smb" : ""}`}>
          {site.folders.some((folder) => folder.kind === "smb") ? <NetworkIcon /> : <DriveIcon />}
        </span>
        <div><span className="eyebrow">SITE DETAILS</span><h3>{site.name}</h3><p>{formatCount(site.total_files)} files · {formatBytes(site.total_bytes)} · {formatRelativeTime(site.last_scanned_at)}</p></div>
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
        <div><strong>Unregister site</strong><small>Removes only NAFM's index and cache. Source files are never deleted.</small></div>
        <button className={`danger-button ${confirming === site.id ? "is-confirming" : ""}`} type="button" onClick={() => void unregisterSite()} disabled={busy}><TrashIcon />{confirming === site.id ? "Confirm unregister" : "Unregister"}</button>
      </footer>
    </div>
  );
}

function SitesSection({ snapshot, selectedSiteId, busy, setBusy, onSelectedSiteChange, onMutation }: {
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
        <div><span className="eyebrow">SITES</span><h2 id="site-management-title">Storage boundaries</h2></div>
        <button className="primary-button" type="button" onClick={() => onSelectedSiteChange(null)} disabled={busy}><PlusIcon />Add site</button>
      </header>
      <div className="site-management-grid">
        <div className="management-list site-management-list" aria-label="Configured sites">
          {snapshot.sites.length === 0 ? (
            <div className="management-empty compact"><DriveIcon /><p>No sites in this workspace.</p></div>
          ) : snapshot.sites.map((site) => (
            <button key={site.id} type="button" className={selected?.id === site.id ? "is-active" : ""} onClick={() => onSelectedSiteChange(site.id)} disabled={busy}>
              <span className={`management-list-icon ${site.folders.some((folder) => folder.kind === "smb") ? "smb" : ""}`}>{site.folders.some((folder) => folder.kind === "smb") ? <NetworkIcon /> : <DriveIcon />}</span>
              <span><strong>{site.name}</strong><small>{site.folders.length} {site.folders.length === 1 ? "root" : "roots"} · {formatCount(site.total_files)} files</small></span>
            </button>
          ))}
        </div>
        {adding ? (
          <AddSiteForm snapshot={snapshot} busy={busy} setBusy={setBusy} onMutation={onMutation} onDone={(siteId) => onSelectedSiteChange(siteId || (snapshot.sites[0]?.id ?? null))} />
        ) : selected ? (
          <SiteDetail site={selected} workspaceName={snapshot.active_workspace.name} busy={busy} setBusy={setBusy} onMutation={onMutation} />
        ) : (
          <div className="management-empty"><SettingsIcon /><h3>Select a site</h3><p>Choose a site to edit its name and roots.</p></div>
        )}
      </div>
    </section>
  );
}

function ConnectionsSection({ snapshot, busy, setBusy, onMutation }: {
  snapshot: ManagementSnapshot;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connectSmb(url.trim(), username.trim(), password);
      setPassword("");
      setUrl("");
      setUsername("");
      onMutation(result, false);
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-section" aria-labelledby="connection-management-title">
      <header className="management-section-heading">
        <div><span className="eyebrow">CONNECTIONS</span><h2 id="connection-management-title">Saved SMB access</h2></div>
        <p>Connections are available to every workspace. Passwords are never displayed.</p>
      </header>
      <div className="connection-management-grid">
        <div className="management-list connection-list">
          {snapshot.connections.length === 0 ? (
            <div className="management-empty"><NetworkIcon /><h3>No saved connections</h3><p>Connect to an SMB share to use it as a site root.</p></div>
          ) : snapshot.connections.map((connection) => (
            <div className="saved-connection" key={connection.url}>
              <span className="management-list-icon smb"><NetworkIcon /></span>
              <span><strong>{connection.url}</strong><small>{connection.username}</small></span>
              <span className="active-label"><CheckIcon />Saved</span>
            </div>
          ))}
        </div>
        <form className="management-form-card" onSubmit={submit}>
          <span className="eyebrow">CONNECT</span>
          <h3>Verify an SMB share</h3>
          <p>NAFM probes the share before storing the credential in your local credentials file.</p>
          <Field label="SMB URL"><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="smb://server/share" spellCheck={false} disabled={busy} /></Field>
          <Field label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" disabled={busy} /></Field>
          <Field label="Password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} /></Field>
          {error && <p className="management-form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={busy || !url.trim() || !username.trim() || !password}><NetworkIcon />{busy ? "Connecting…" : "Connect and save"}</button>
        </form>
      </div>
    </section>
  );
}

export function ManagementCenter(props: ManagementCenterProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(props.onClose);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    closeRef.current = props.onClose;
    busyRef.current = busy;
  }, [busy, props.onClose]);

  useEffect(() => {
    props.onBusyChange(props.open && busy);
  }, [busy, props.onBusyChange, props.open]);

  useEffect(() => {
    if (!props.open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    function containFocus(event: FocusEvent) {
      if (!dialogRef.current || dialogRef.current.contains(event.target as Node)) return;
      const fallback = dialogRef.current.querySelector<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      (fallback ?? closeButtonRef.current)?.focus();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", containFocus);
      previousFocus?.focus();
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) setBusy(false);
  }, [props.open]);

  if (!props.open) return null;
  const scansActive = props.activeTaskCount > 0;

  return (
    <div className="management-overlay">
      <div
        className="management-scrim"
        aria-hidden="true"
        onPointerDown={() => {
          if (!busy) props.onClose();
        }}
      />
      <div className="management-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header className="management-header">
          <div><span className="eyebrow">NAFM</span><h1 id="management-title">Management Center</h1></div>
          <div className="management-context"><span>Current workspace</span><strong>{props.snapshot?.active_workspace.name ?? "Unavailable"}</strong></div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} disabled={busy} aria-label="Close management center"><CloseIcon /></button>
        </header>
        <div className="management-body">
          <nav className="management-nav" aria-label="Management sections">
            <button type="button" className={props.section === "workspaces" ? "is-active" : ""} onClick={() => props.onSectionChange("workspaces")} disabled={busy}><WorkspaceIcon /><span><strong>Workspaces</strong><small>{props.snapshot?.workspaces.length ?? 0} available</small></span></button>
            <button type="button" className={props.section === "sites" ? "is-active" : ""} onClick={() => props.onSectionChange("sites")} disabled={busy}><DriveIcon /><span><strong>Sites</strong><small>{props.snapshot?.sites.length ?? 0} configured</small></span></button>
            <button type="button" className={props.section === "connections" ? "is-active" : ""} onClick={() => props.onSectionChange("connections")} disabled={busy}><NetworkIcon /><span><strong>Connections</strong><small>{props.snapshot?.connections.length ?? 0} saved</small></span></button>
            {scansActive && <div className="management-scan-note"><RefreshIcon /><span><strong>{props.activeTaskCount} scan {props.activeTaskCount === 1 ? "is" : "are"} active</strong><small>Workspace and site changes are available when scanning finishes.</small></span></div>}
          </nav>
          <div className="management-content" aria-live="polite">
            {props.loading && !props.snapshot ? (
              <div className="management-empty"><span className="mini-spinner" /><h3>Loading management data</h3></div>
            ) : props.error && !props.snapshot ? (
              <div className="management-empty is-error"><WarningIcon /><h3>Management unavailable</h3><p>{props.error}</p><button className="secondary-button" type="button" onClick={props.onRetry}><RefreshIcon />Try again</button></div>
            ) : props.snapshot ? (
              <>
                {props.error && <div className="management-banner" role="alert"><WarningIcon /><span>{props.error}</span><button type="button" onClick={props.onRetry}>Refresh</button></div>}
                {props.section === "workspaces" && <WorkspaceSection snapshot={props.snapshot} busy={busy || scansActive} setBusy={setBusy} onMutation={props.onMutation} />}
                {props.section === "sites" && <SitesSection snapshot={props.snapshot} selectedSiteId={props.selectedSiteId} busy={busy || scansActive} setBusy={setBusy} onSelectedSiteChange={props.onSelectedSiteChange} onMutation={props.onMutation} />}
                {props.section === "connections" && <ConnectionsSection snapshot={props.snapshot} busy={busy} setBusy={setBusy} onMutation={props.onMutation} />}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
