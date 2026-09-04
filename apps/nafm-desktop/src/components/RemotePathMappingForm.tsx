import { type FormEvent, useState } from "react";
import { addRemotePathMapping, previewRemotePathMapping } from "../lib/tauri";
import type { ManagementMutationResult, MappingPreview, RemoteMachine } from "../lib/types";
import { formatBytes } from "../lib/format";

interface Props {
  machines: RemoteMachine[];
  workspaceName: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}

export function RemotePathMappingForm({ machines, workspaceName, busy, setBusy, onMutation }: Props) {
  const [machineId, setMachineId] = useState("");
  const [smbRoot, setSmbRoot] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);

  function change(setter: (value: string) => void, value: string) {
    setter(value);
    setPreview(null);
    setError(null);
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setPreview(null);
    setError(null);
    setPhase("Checking remote directory and sampled reads…");
    try {
      setPreview(await previewRemotePathMapping({ workspace_name: workspaceName, machine_id: machineId, smb_root: smbRoot.trim(), remote_root: remoteRoot.trim() }));
    } catch (error) {
      setError(String(error));
    } finally {
      setPhase(null);
      setBusy(false);
    }
  }

  async function save() {
    if (preview?.check.status !== "passed") return;
    setBusy(true);
    setError(null);
    setPhase("Rechecking permissions and saving mapping…");
    try {
      onMutation(await addRemotePathMapping(workspaceName, machineId, preview.smb_root, preview.remote_root), false);
      setSmbRoot("");
      setRemoteRoot("");
      setPreview(null);
    } catch (error) {
      setPreview(null);
      setError(String(error));
    } finally {
      setPhase(null);
      setBusy(false);
    }
  }

  return <form className="management-form-card" onSubmit={(event) => void inspect(event)}>
    <span className="eyebrow">PATH MAPPING</span>
    <h3>Preview SMB → native path</h3>
    <label className="management-field"><span>Remote machine</span><select value={machineId} disabled={busy} onChange={(event) => change(setMachineId, event.target.value)}>
      <option value="">Select a machine</option>
      {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
    </select></label>
    <label className="management-field"><span>SMB root</span><input value={smbRoot} disabled={busy} spellCheck={false} placeholder="smb://nas/Media" onChange={(event) => change(setSmbRoot, event.target.value)} /></label>
    <label className="management-field"><span>Native remote root</span><input value={remoteRoot} disabled={busy} spellCheck={false} placeholder="/volume1/Media or C:\\Media" onChange={(event) => change(setRemoteRoot, event.target.value)} /></label>
    <button type="submit" className="ghost-button" disabled={busy || !machineId || !smbRoot.trim() || !remoteRoot.trim()}>Preview path (read only)</button>
    {phase && <p role="status">{phase}</p>}
    {error && <p role="alert" className="management-form-error">{error}</p>}
    {preview && <div className="path-preview">
      <p>{preview.smb_root} → {preview.remote_root}</p>
      <p>{preview.check.status}: {preview.check.message}</p>
      {preview.check.remedy && <p>{preview.check.remedy}</p>}
      {preview.check.status === "passed" && <>
        <small>Checked {new Date(preview.checked_at).toLocaleString()}</small>
        {preview.files.length === 0 ? <p>{preview.truncated ? "No regular files found within the traversal limit." : "No regular files found. File-read permission could not be sampled."}</p>
          : <ul>{preview.files.map((file) => <li key={file.relative_path}>{file.relative_path} · {formatBytes(file.size_bytes)}</li>)}</ul>}
        <p>{preview.truncated ? "Partial sample: " : "Sample: "}at most 5 files / 1,000 entries; one byte read per file. No file contents returned.</p>
        <p>This checks the native directory only. Confirm it corresponds to the SMB root; it does not prove they contain the same files or audit every permission.</p>
        <button type="button" className="primary-button full-width" disabled={busy} onClick={() => void save()}>Confirm and save mapping</button>
      </>}
    </div>}
  </form>;
}
