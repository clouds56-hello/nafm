import { useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onAgentSetupProgress, preflightRemoteMachine } from "../lib/tauri";
import type { ManagementMutationResult, PreflightReport, RemoteMachine } from "../lib/types";
import { AgentInstallButton } from "./AgentInstallButton";

interface Props {
  machine: RemoteMachine;
  workspaceName: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
}

const stageLabels: Record<string, string> = {
  local_ssh: "Local SSH", connectivity: "Connectivity", host_key: "Host-key trust",
  authentication: "Authentication", ssh_session: "SSH session", platform: "Remote OS / architecture",
  agent: "Selected agent", bundle: "Bundled binaries", session: "SSH session",
};

export function RemoteMachineSetup(props: Props) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    props.setBusy(true);
    setReport(null);
    setError(null);
    setProgress("Starting read-only checks…");
    const request_id = crypto.randomUUID();
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await onAgentSetupProgress((event) => {
        if (event.request_id === request_id && event.machine_id === props.machine.id) setProgress(event.message);
      });
      setReport(await preflightRemoteMachine({ workspace_name: props.workspaceName, machine_id: props.machine.id, request_id }));
    } catch (error) {
      setError(String(error));
    } finally {
      unlisten?.();
      setProgress(null);
      props.setBusy(false);
    }
  }

  return <div className="remote-machine-setup">
    <button type="button" className="ghost-button" disabled={props.busy} onClick={() => void check()}>Check connection</button>
    <small>Read-only checks. No installation or host-key acceptance.</small>
    {progress && <p role="status">{progress}</p>}
    {error && <p className="management-form-error" role="alert">{error}</p>}
    {report && <>
      <small>Checked {new Date(report.checked_at).toLocaleString()}. Results are a snapshot.</small>
      <ul className="agent-checks">{report.checks.map((check) => <li key={check.stage} data-status={check.status}>
        <strong>{stageLabels[check.stage] ?? check.stage}: {check.status}</strong>
        <small>{check.message}</small>
        {check.remedy && <small>{check.remedy}</small>}
      </li>)}</ul>
      {report.can_install && report.target && <AgentInstallButton {...props} target={report.target} onInstalled={() => {
        setReport(null);
        setProgress("Installation verified. Run Check connection again to refresh all checks.");
      }} />}
    </>}
  </div>;
}
