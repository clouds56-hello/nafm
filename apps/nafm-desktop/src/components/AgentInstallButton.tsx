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
}

export function AgentInstallButton({ machine, workspaceName, busy, setBusy, onMutation }: Props) {
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <button type="button" className="ghost-button" onClick={() => void install()} disabled={busy}
        title="Copies a bundled executable to this SSH user's private directory. No sudo or service.">
        {machine.agent_installation ? "Update agent" : "Install agent"}
      </button>
      {progress && <small role="status">{progress}</small>}
      {error && <small className="management-form-error" role="alert">{error} Previous selection is unchanged; retry when resolved.</small>}
    </>
  );
}
