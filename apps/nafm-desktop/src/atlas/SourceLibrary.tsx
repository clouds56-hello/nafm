import { open } from "@tauri-apps/plugin-dialog";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { formatBytes, formatCount } from "../lib/format";
import { connectSmb, createSite } from "../lib/tauri";
import type { SiteKind, SiteOverview } from "../lib/types";
import "./sources.css";

interface SourceLibraryProps {
  sites: SiteOverview[];
  workspaceName: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onChanges: () => void;
  onScan: (site_id: string) => void;
  scanningIds: ReadonlySet<string>;
  onCancelScan: (site_id: string) => void;
  error?: string | null;
  errorAction?: { label: string; run: () => void };
}

function inventoryLabel(site: SiteOverview, scanning: boolean): string {
  if (site.scan_state === "cancelling") return "Stopping";
  if (scanning) return "Scanning";
  if (site.connection_state === "offline") return "Offline";
  if (site.scan_state === "failed") return "Scan failed";
  if (site.hash_status === "pending") return "Hashes pending";
  if (site.hash_status === "ready") return "Indexed";
  return "Awaiting scan";
}

export function SourceLibrary({ sites, workspaceName, activeId, onSelect, onClose, onChanges, onScan, scanningIds, onCancelScan, error, errorAction }: SourceLibraryProps) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    headingRef.current?.focus();
    return () => dialog.close();
  }, []);

  function finishAdding() {
    setAdding(false);
    requestAnimationFrame(() => addRef.current?.focus());
  }

  return (
    <dialog className="source-library" ref={dialogRef} aria-labelledby="source-library-title" onCancel={(event) => {
      event.preventDefault();
      if (busy) return;
      if (adding) finishAdding();
      else onClose();
    }}>
      <div className="source-window-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="source-layout">
        <div className="source-route">
          <button type="button" className="source-back" disabled={busy} onClick={onClose}><span aria-hidden="true">←</span> Atlas</button>
          {workspaceName && <span className="source-workspace" title={workspaceName}>{workspaceName}</span>}
        </div>
        <header className="source-header">
          <h1 id="source-library-title" ref={headingRef} tabIndex={-1}>Sources</h1>
          <button
            ref={addRef}
            type="button"
            className="source-primary"
            disabled={adding || !workspaceName || scanningIds.size > 0}
            onClick={() => setAdding(true)}
          >
            <span aria-hidden="true">+</span> Add source
          </button>
        </header>
        {error && (
          <div className="source-alert" role="alert">
            <p className="source-error">{error}</p>
            {errorAction && <button type="button" className="source-action" disabled={busy} onClick={errorAction.run}>{errorAction.label}</button>}
          </div>
        )}
        {adding && workspaceName && (
          <AddSource
            workspaceName={workspaceName}
            busy={busy}
            blocked={scanningIds.size > 0}
            setBusy={setBusy}
            onCancel={finishAdding}
            onAdd={() => {
              finishAdding();
              onChanges();
            }}
          />
        )}
        {scanningIds.size > 0 && <p className="source-scan-note" role="status">You can add sources when all scans finish.</p>}
        {sites.length > 0 ? (
          <section className="source-directory" aria-label="Storage sources">
            <div className="source-column-labels" aria-hidden="true">
              <span>Source</span>
              <span>Inventory</span>
              <span>Size</span>
              <span>Scan</span>
            </div>
            <ul className="source-list">
              {sites.map((site) => {
                const scanning = scanningIds.has(site.id);
                const stopping = site.scan_state === "cancelling";
                return (
                  <li key={site.id} className="source-row">
                    <button
                      type="button"
                      className="source-open"
                      aria-current={activeId === site.id ? "true" : undefined}
                      aria-label={`Open ${site.name} in Atlas`}
                      aria-describedby={`source-location-${site.id} source-inventory-${site.id}`}
                      disabled={busy}
                      onClick={() => onSelect(site.id)}
                    >
                      <span className="source-identity">
                        <span className="source-shape" data-kind={site.kind} aria-hidden="true" />
                        <span className="source-identifiers">
                          <strong title={site.name}>{site.name}</strong>
                          <small id={`source-location-${site.id}`} title={site.location}>{site.location}</small>
                        </span>
                      </span>
                      <span id={`source-inventory-${site.id}`} className="source-inventory" data-scanning={scanning}>
                        <span>{inventoryLabel(site, scanning)}</span>
                        {(site.latest_inventory_at || site.total_files > 0) && <small>{formatCount(site.total_files)} files</small>}
                      </span>
                      <span className="source-size">{site.latest_inventory_at || site.total_files > 0 ? formatBytes(site.total_bytes) : "—"}</span>
                    </button>
                    {scanning ? (
                      <button className="source-action" type="button" aria-label={stopping ? "Scan is stopping" : `Stop scan of ${site.name}`} disabled={busy || stopping} onClick={() => onCancelScan(site.id)}>
                        {stopping ? "Stopping…" : "Stop scan"}
                      </button>
                    ) : (
                      <button className="source-action" type="button" aria-label={`Scan ${site.name}`} disabled={busy} onClick={() => onScan(site.id)}>
                        {site.latest_inventory_at ? "Rescan" : "Scan"}<span aria-hidden="true">↗</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : !adding ? (
          <div className="source-empty">
            <h2>{workspaceName ? "No sources yet" : "Workspace unavailable"}</h2>
            <p>{workspaceName ? "Add a local folder or an SMB share to start mapping its storage." : "Atlas needs an active workspace to load sources."}</p>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

interface AddSourceProps {
  workspaceName: string;
  busy: boolean;
  blocked: boolean;
  setBusy: (value: boolean) => void;
  onCancel: () => void;
  onAdd: () => void;
}

const missingSmbAccess = "no saved credentials for SMB location:";

function AddSource({ workspaceName, busy, blocked, setBusy, onCancel, onAdd }: AddSourceProps) {
  const [kind, setKind] = useState<SiteKind>("local");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [credentialsNeeded, setCredentialsNeeded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const path = location.trim();
  const allowsSubmit = Boolean(name.trim() && path && (!credentialsNeeded || (username.trim() && password)));

  useEffect(() => nameRef.current?.focus(), []);

  useEffect(() => {
    if (credentialsNeeded && !busy) userRef.current?.focus();
  }, [busy, credentialsNeeded]);

  function changeLocation(next: string) {
    setLocation(next);
    setCredentialsNeeded(false);
    setUsername("");
    setPassword("");
    setMessage(null);
  }

  function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "Could not add the source.";
  }

  async function browse() {
    if (busy || blocked) return;
    setBusy(true);
    setMessage(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") changeLocation(selected);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || blocked || !allowsSubmit) return;
    if (kind === "smb" && !path.toLowerCase().startsWith("smb://")) {
      setMessage("Enter an SMB URL beginning with smb://.");
      return;
    }
    if (kind === "local" && path.includes("://")) {
      setMessage("Choose SMB share for a network URL.");
      return;
    }

    setBusy(true);
    setSaving(true);
    setMessage(null);
    try {
      if (credentialsNeeded) {
        await connectSmb(path, username.trim(), password);
        setPassword("");
        setCredentialsNeeded(false);
      }
      await createSite(workspaceName, name.trim(), path);
      onAdd();
    } catch (error) {
      const message = errorMessage(error);
      if (kind === "smb" && message.startsWith(missingSmbAccess)) {
        setCredentialsNeeded(true);
      } else {
        setMessage(message);
      }
    } finally {
      setBusy(false);
      setSaving(false);
    }
  }

  return (
    <form className="source-form" onSubmit={(event) => void add(event)} aria-labelledby="source-form-title">
      <div className="source-form-heading">
        <h2 id="source-form-title">Add a source</h2>
        <div className="source-type" role="group" aria-label="Source type">
          <button type="button" aria-pressed={kind === "local"} disabled={busy || blocked} onClick={() => { setKind("local"); changeLocation(""); }}>Local folder</button>
          <button type="button" aria-pressed={kind === "smb"} disabled={busy || blocked} onClick={() => { setKind("smb"); changeLocation(""); }}>SMB share</button>
        </div>
      </div>
      <div className="source-form-fields">
        <label className="source-field">
          <span>Name</span>
          <input ref={nameRef} value={name} disabled={busy || blocked} onChange={(event) => setName(event.target.value)} autoComplete="off" />
        </label>
        <div className="source-path-field">
          <label className="source-field">
            <span>{kind === "local" ? "Folder path" : "SMB URL"}</span>
            <input
              type={kind === "smb" ? "url" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={kind === "local" ? "/path/to/folder" : "smb://server/share"}
              value={location}
              disabled={busy || blocked}
              onChange={(event) => changeLocation(event.target.value)}
            />
          </label>
          {kind === "local" && <button className="source-action" type="button" disabled={busy || blocked} onClick={() => void browse()}>Browse…</button>}
        </div>
      </div>
      {credentialsNeeded && (
        <div className="source-credentials">
          <p role="status">This SMB share needs credentials. Atlas verifies them before adding the source.</p>
          <div className="source-form-fields">
            <label className="source-field">
              <span>SMB username</span>
              <input ref={userRef} value={username} disabled={busy || blocked} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label className="source-field">
              <span>SMB password</span>
              <input type="password" value={password} disabled={busy || blocked} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
          </div>
        </div>
      )}
      {message && <p className="source-error" role="alert">{message}</p>}
      <div className="source-form-actions">
        <button type="button" className="source-action" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="source-primary" disabled={busy || blocked || !allowsSubmit}>{saving ? "Adding…" : credentialsNeeded ? "Verify and add" : "Add source"}</button>
      </div>
    </form>
  );
}
