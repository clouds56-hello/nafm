import { type FormEvent, useState } from "react";
import { createWorkspace, switchWorkspace } from "../lib/tauri";
import type { ManagementMutationResult, ManagementSnapshot } from "../lib/types";
import { errorMessage, Field } from "./Field";
import { CheckIcon, PlusIcon, WorkspaceIcon } from "./Icons";

export function WorkspaceSection({ snapshot, busy, setBusy, onMutation }: {
  snapshot: ManagementSnapshot;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
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
    if (busy || nameToActivate === snapshot.active_workspace.name) return;
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
        <h2 id="workspace-management-title">Workspaces</h2>
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
          <p>Saved SMB connections are shared across workspaces.</p>
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
