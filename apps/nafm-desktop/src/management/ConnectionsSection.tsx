import { type FormEvent, useState } from "react";
import { addRemoteMachine, connectSmb, removeRemoteMachine, removeRemotePathMapping } from "../lib/tauri";
import type { ManagementMutationResult, ManagementSnapshot } from "../lib/types";
import { errorMessage, Field } from "./Field";
import { CheckIcon, NetworkIcon, TrashIcon } from "./Icons";
import { RemoteMachineSetup } from "./RemoteMachineSetup";
import { RemotePathMappingForm } from "./RemotePathMappingForm";

export function ConnectionsSection({ snapshot, busy, scansActive, setBusy, onMutation }: {
  snapshot: ManagementSnapshot;
  busy: boolean;
  scansActive: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}) {
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [remoteName, setRemoteName] = useState("");
  const [sshTarget, setSshTarget] = useState("");
  const [remoteError, setRemoteError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !url.trim() || !username.trim() || !password) return;
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

  async function submitRemoteMachine(event: FormEvent) {
    event.preventDefault();
    if (busy || scansActive || !remoteName.trim() || !sshTarget.trim()) return;
    setBusy(true);
    setRemoteError(null);
    try {
      const result = await addRemoteMachine(
        snapshot.active_workspace.name,
        remoteName.trim(),
        sshTarget.trim(),
      );
      setRemoteName("");
      setSshTarget("");
      onMutation(result, false);
    } catch (mutationError) {
      setRemoteError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMachine(machineId: string) {
    if (busy || scansActive) return;
    setBusy(true);
    setRemoteError(null);
    try {
      onMutation(
        await removeRemoteMachine(snapshot.active_workspace.name, machineId),
        false,
      );
    } catch (mutationError) {
      setRemoteError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMapping(mappingId: string) {
    if (busy || scansActive) return;
    setBusy(true);
    setRemoteError(null);
    try {
      onMutation(
        await removeRemotePathMapping(snapshot.active_workspace.name, mappingId),
        false,
      );
    } catch (mutationError) {
      setRemoteError(errorMessage(mutationError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="management-section" aria-labelledby="connection-management-title">
      <header className="management-section-heading">
        <h2 id="connection-management-title">Saved SMB access</h2>
        <p>Saved connections are shared across workspaces.</p>
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
          <p>Verify access and save the credentials on this device.</p>
          <Field label="SMB URL"><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="smb://server/share" spellCheck={false} disabled={busy} /></Field>
          <Field label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" disabled={busy} /></Field>
          <Field label="Password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={busy} /></Field>
          {error && <p className="management-form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={busy || !url.trim() || !username.trim() || !password}><NetworkIcon />{busy ? "Connecting…" : "Connect and save"}</button>
        </form>
      </div>
      <header className="management-section-heading">
        <h2>SSH agents and path mappings</h2>
        <p>{scansActive
          ? "Finish active scans to change remote settings."
          : "Check SSH access, install an agent, and map the share to the path on the remote machine."}</p>
      </header>
      <div className="connection-management-grid">
        <div className="management-list connection-list">
          {snapshot.remote_machines.length === 0 ? (
            <div className="management-empty"><NetworkIcon /><h3>No remote machines</h3><p>Register an SSH target, install its agent, then map a native path.</p></div>
          ) : snapshot.remote_machines.map((machine) => (
            <div className="saved-connection remote-machine-card" key={machine.id}>
              <span className="management-list-icon smb"><NetworkIcon /></span>
              <span>
                <strong>{machine.name}</strong>
                <small>{machine.ssh_target}</small>
                <small>{machine.agent_installation
                  ? `${machine.agent_installation.target} · v${machine.agent_installation.agent_version}`
                  : "Manual agent on PATH, or install the bundled agent"}</small>
                {machine.agent_installation && <small>{machine.agent_installation.executable_path}</small>}
                {snapshot.remote_path_mappings
                  .filter((mapping) => mapping.remote_machine_id === machine.id)
                  .map((mapping) => (
                    <small key={mapping.id}>
                      {mapping.smb_root} → {mapping.remote_root}{" "}
                      <button type="button" className="ghost-button" onClick={() => void deleteMapping(mapping.id)} disabled={busy || scansActive}>Remove</button>
                    </small>
                  ))}
              </span>
              <div>
                <RemoteMachineSetup key={`${snapshot.active_workspace.name}:${machine.id}`} machine={machine} workspaceName={snapshot.active_workspace.name} busy={busy} scansActive={scansActive} setBusy={setBusy} onMutation={onMutation} />
                <button type="button" className="ghost-button" onClick={() => void deleteMachine(machine.id)} aria-label={`Remove ${machine.name}`} disabled={busy || scansActive}><TrashIcon /></button>
              </div>
            </div>
          ))}
        </div>
        <div>
          <form className="management-form-card" onSubmit={submitRemoteMachine}>
            <span className="eyebrow">REMOTE MACHINE</span>
            <h3>Register an SSH target</h3>
            <Field label="Name"><input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} placeholder="NAS" disabled={busy} /></Field>
            <Field label="SSH target" hint="An alias from ~/.ssh/config or user@host"><input value={sshTarget} onChange={(event) => setSshTarget(event.target.value)} placeholder="nas" spellCheck={false} disabled={busy} /></Field>
            <button className="primary-button full-width" type="submit" disabled={busy || scansActive || !remoteName.trim() || !sshTarget.trim()}><NetworkIcon />Register machine</button>
          </form>
          <RemotePathMappingForm key={snapshot.active_workspace.name} machines={snapshot.remote_machines} connections={snapshot.connections} workspaceName={snapshot.active_workspace.name} busy={busy} scansActive={scansActive} setBusy={setBusy} onMutation={onMutation} />
        </div>
      </div>
      {remoteError && <p className="management-form-error" role="alert">{remoteError}</p>}
    </section>
  );
}
