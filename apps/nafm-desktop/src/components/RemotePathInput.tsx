import { useEffect, useId, useRef, useState } from "react";
import { completeRemotePath } from "../lib/tauri";
import type { PathCompletion } from "../lib/types";

interface Props {
  workspaceName: string;
  machineId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  setBusy: (value: boolean) => void;
}

export function RemotePathInput({ workspaceName, machineId, value, disabled, onChange, setBusy }: Props) {
  const listId = useId();
  const [enabled, setEnabled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PathCompletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Serialize requests; obsolete queued prefixes never reach SSH.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let current = true;
    setResult(null);
    if (!enabled || disabled) { setLoading(false); return; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      queue.current = queue.current.then(async () => {
        if (!current) return;
        try {
          const next = await completeRemotePath({ workspace_name: workspaceName, machine_id: machineId, path: value, interactive: false });
          if (current) { setResult(next); setError(null); }
        } catch (error) {
          if (current) setError(String(error));
        } finally {
          if (current) setLoading(false);
        }
      });
    }, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [workspaceName, machineId, value, enabled, disabled]);

  async function connect() {
    setBusy(true);
    setConnecting(true);
    setError(null);
    try {
      await queue.current;
      await completeRemotePath({ workspace_name: workspaceName, machine_id: machineId, path: value, interactive: true });
      if (mounted.current) setEnabled(true);
    } catch (error) {
      if (mounted.current) setError(String(error));
    } finally {
      setBusy(false);
      if (mounted.current) setConnecting(false);
    }
  }

  return <>
    <label className="management-field"><span>Native remote root</span>
      <input value={value} list={listId} disabled={disabled || connecting} spellCheck={false} autoComplete="off" placeholder="/volume1/Media or C:\\Media" onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>{result?.paths.map((path) => <option key={path} value={path} />)}</datalist>
    </label>
    {(!enabled || error) && <button type="button" className="ghost-button" disabled={disabled || connecting || !machineId} onClick={() => void connect()}>{connecting ? "Connecting…" : "Connect for suggestions"}</button>}
    {loading && <small role="status">Loading directories…</small>}
    {result && !loading && <small role="status">{result.truncated ? "Partial list; type a more specific path. " : result.paths.length === 0 ? "No matching directories. " : ""}Directories only; append a separator to browse inside.</small>}
    {error && <p className="management-form-error" role="alert">{error} Manual entry is still available.</p>}
  </>;
}
