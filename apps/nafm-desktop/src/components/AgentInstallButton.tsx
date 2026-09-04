import { useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { installRemoteAgent, onAgentInstallProgress } from "../lib/tauri";
import type { ManagementMutationResult, RemoteMachine } from "../lib/types";

interface Props {
  machine: RemoteMachine;
  workspaceName: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  target: string;
  onInstalled: () => void;
}

export function AgentInstallButton({ machine, workspaceName, busy, setBusy, onMutation, target, onInstalled }: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function install() {
    const request_id = crypto.randomUUID();
    setBusy(true);
    setError(null);
    setProgress("Preparing installation…");
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await onAgentInstallProgress((event) => {
        if (event.request_id === request_id && event.machine_id === machine.id) {
          setProgress(event.message);
        }
      });
      const result = await installRemoteAgent({
        workspace_name: workspaceName,
        machine_id: machine.id,
        request_id,
      });
      setProgress("Installed and verified.");
      onMutation(result, false);
      onInstalled();
    } catch (error) {
      setProgress(null);
      setError(typeof error === "string" ? error : error instanceof Error ? error.message : "Installation failed.");
    } finally {
      unlisten?.();
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="ghost-button" onClick={() => setConfirming(true)} disabled={busy}
        title="Copies a bundled executable to this SSH user's private directory. No sudo or service.">
        {machine.agent_installation ? "Update agent" : "Install agent"}
      </button>
      {confirming && <div className="agent-install-confirmation">
        <p>Copy the bundled {target} agent to {target.includes("windows")
          ? "%LOCALAPPDATA%\\nafm\\agents\\<unique-id>\\nafm-agent.exe"
          : "$HOME/.local/share/nafm/agents/<unique-id>/nafm-agent"} on {machine.ssh_target}?</p>
        <p>No service or administrator access. The new binary is selected only after its checksum and protocol are verified. Failed uploads may leave an unselected file.</p>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void install()}>Confirm installation</button>
        <button type="button" className="ghost-button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {progress && <small role="status">{progress}</small>}
      {error && <small className="management-form-error" role="alert">{error} Previous selection is unchanged; retry when resolved.</small>}
    </>
  );
}
