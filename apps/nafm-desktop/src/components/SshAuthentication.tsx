import { type FormEvent, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getSshPrompts, onSshPromptsChanged, replySshPrompt } from "../lib/tauri";
import type { SshPrompt } from "../lib/types";

export function SshAuthentication() {
  const [prompt, setPrompt] = useState<SshPrompt | null>(null);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let unlisten: UnlistenFn | undefined;
    async function refresh() {
      const current = ++revision;
      try {
        const prompts = await getSshPrompts();
        if (active && current === revision) setPrompt((previous) => prompts.find((value) => value.prompt_id === previous?.prompt_id) ?? prompts[0] ?? null);
      } catch {
        // No secret data in this query. The broker times out if the UI disconnects.
        if (active && current === revision) setPrompt(null);
      }
    }
    void onSshPromptsChanged(() => void refresh()).then((stop) => {
      if (!active) { stop(); return; }
      unlisten = stop;
      void refresh();
    }).catch(() => { /* The broker fails closed if events cannot be registered. */ });
    return () => { active = false; unlisten?.(); };
  }, []);
  return prompt ? <AuthenticationDialog key={prompt.prompt_id} prompt={prompt} /> : null;
}

function AuthenticationDialog({ prompt }: { prompt: SshPrompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [response, setResponse] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  async function answer(value: string | null) {
    setBusy(true);
    setResponse("");
    setError(null);
    try {
      await replySshPrompt({ prompt_id: prompt.prompt_id, response: value });
    } catch {
      setError("Unable to answer this SSH prompt. It may have expired; cancel and retry the operation.");
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!busy && (!prompt.host_key || verified)) void answer(prompt.host_key?.fingerprint ?? (prompt.confirmation ? "" : response));
  }

  return <dialog ref={dialog} className="ssh-auth-dialog" aria-labelledby="ssh-auth-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) void answer(null); }}
    onKeyDown={(event) => event.stopPropagation()}>
    <form onSubmit={submit} autoComplete="off">
      <h2 id="ssh-auth-title">{prompt.host_key ? "Verify SSH host fingerprint" : "SSH authentication"}</h2>
      <p>Connection: <strong>{prompt.ssh_target}</strong></p>
      {prompt.host_key ? <>
        <p>This host is not yet trusted. Verify its fingerprint using the server console or another trusted channel before continuing.</p>
        <dl className="ssh-host-key">
          <dt>Host</dt><dd>{prompt.host_key.host}</dd>
          <dt>Key type</dt><dd>{prompt.host_key.key_type}</dd>
          <dt>SHA256 fingerprint</dt><dd><code>{prompt.host_key.fingerprint}</code></dd>
        </dl>
        <details><summary>OpenSSH details</summary><p className="ssh-auth-prompt">{prompt.message}</p></details>
        <p>Trusting lets OpenSSH save this public host key in its configured known-hosts file. This is not a password prompt. Changed or revoked keys cannot be accepted here.</p>
        <label className="ssh-trust-confirm"><input type="checkbox" checked={verified} disabled={busy} onChange={(event) => setVerified(event.target.checked)} />I independently verified this fingerprint.</label>
      </> : <p className="ssh-auth-prompt">{prompt.message}</p>}
      {!prompt.host_key && !prompt.confirmation && <label className="management-field"><span>Password, key passphrase, or verification response</span>
        <input type="password" autoFocus autoComplete="off" spellCheck={false} maxLength={8192}
          value={response} disabled={busy} onChange={(event) => setResponse(event.target.value)} />
      </label>}
      <p>{prompt.host_key ? "Cancel leaves this host untrusted. " : "Requested by OpenSSH. Used for this authentication attempt only; never saved by NAFM. Cancel stops the attempt. "}Authentication times out after about three minutes.</p>
      {error && <p role="alert" className="management-form-error">{error}</p>}
      <div className="ssh-auth-actions">
        <button type="button" className="ghost-button" disabled={busy} onClick={() => void answer(null)}>Cancel connection</button>
        <button type="submit" className="primary-button" disabled={busy || (!!prompt.host_key && !verified)}>{busy ? "Sending…" : prompt.host_key ? "Trust fingerprint and connect" : "Continue"}</button>
      </div>
    </form>
  </dialog>;
}
