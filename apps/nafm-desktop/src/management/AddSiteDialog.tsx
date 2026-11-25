import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { createSite } from "../lib/tauri";
import type { ManagementMutationResult, RemotePathMapping } from "../lib/types";
import { errorMessage, Field } from "./Field";
import { CloseIcon } from "./Icons";
import { SiteRootFields, useSiteRoot } from "./SiteRootFields";

interface AddSiteDialogProps {
  workspaceName: string;
  remotePathMappings: RemotePathMapping[];
  blocked: boolean;
  onMutation: (result: ManagementMutationResult, createdSiteName?: string) => void;
  onClose: () => void;
}

export function AddSiteDialog({ workspaceName, remotePathMappings, blocked, onMutation, onClose }: AddSiteDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [choosingOrConnecting, setChoosingOrConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useSiteRoot(remotePathMappings);
  const busy = saving || choosingOrConnecting;
  const disabled = busy || blocked;
  const ready = !disabled && Boolean(name.trim()) && root.ready;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    nameRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useLayoutEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createSite(workspaceName, name.trim(), root.path.trim(), root.hiddenPolicy);
      onMutation(result, name.trim());
      onClose();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="add-site-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === ",") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <form className="add-site-form" onSubmit={submit} onChange={() => setError(null)} aria-busy={busy || undefined}>
        <header className="add-site-header">
          <h2 id={titleId}>Add site</h2>
          <button className="icon-button" type="button" aria-label="Close add site" disabled={busy} onClick={onClose}><CloseIcon /></button>
        </header>
        <div className="add-site-fields">
          <Field label="Site name">
            <input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" disabled={disabled} />
          </Field>
          <SiteRootFields
            root={root}
            disabled={disabled}
            onBusyChange={setChoosingOrConnecting}
            onMutation={(result) => onMutation(result)}
            onConnectionReady={() => (name.trim() ? addRef : nameRef).current?.focus()}
          />
          {blocked && <p className="management-form-warning" role="status">Finish active scans to add a site.</p>}
          {error && <p ref={errorRef} className="management-form-error" role="alert" tabIndex={-1}>{error}</p>}
        </div>
        <footer className="add-site-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button ref={addRef} type="submit" className="primary-button" disabled={!ready}>{saving ? "Adding…" : "Add site"}</button>
        </footer>
      </form>
    </dialog>
  );
}
