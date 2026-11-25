import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { parseSmbLocation, smbRootContains } from "../lib/smb";
import { connectSmb, matchSmbConnection } from "../lib/tauri";
import type { HiddenPolicy, ManagementMutationResult, RemotePathMapping, SavedConnection, SiteKind } from "../lib/types";
import { errorMessage, Field } from "./Field";
import { CheckIcon, DriveIcon, NetworkIcon, WarningIcon } from "./Icons";

function smbLocation(path: string) {
  try {
    return parseSmbLocation(path);
  } catch {
    return null;
  }
}

export function useSiteRoot(mappings: RemotePathMapping[]) {
  const [kind, setKind] = useState<SiteKind>("local");
  const [localPath, setLocalPath] = useState("");
  const [smbPath, setSmbPath] = useState("");
  const path = kind === "local" ? localPath : smbPath;
  const [hiddenPolicy, setHiddenPolicy] = useState<HiddenPolicy>("include");
  const [match, setMatch] = useState<{ url: string; connection: SavedConnection | null } | null>(null);
  const location = path.trim();
  const smbPrefix = /^smb:\/\//i.test(location);
  const smb = kind === "smb" ? smbLocation(location) : null;
  const remoteMappingAvailable = smb !== null && mappings.some((mapping) => smbRootContains(mapping.smb_root, smb));
  const needsMatch = smb !== null && !remoteMappingAvailable;
  const savedConnection = needsMatch && match?.url === location ? match.connection : null;
  const checkingConnection = needsMatch && match?.url !== location;

  useEffect(() => {
    setMatch(null);
    if (!needsMatch) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      const connection = await matchSmbConnection(location).catch(() => null);
      if (active) setMatch({ url: location, connection });
    }, 140);
    return () => {
      window.clearTimeout(timer);
      active = false;
    };
  }, [needsMatch, location]);

  function chooseKind(next: SiteKind) {
    if (next === "smb" && kind === "local" && smbPrefix) {
      setSmbPath(location);
      setLocalPath("");
    }
    setKind(next);
  }

  let pathHint: string | null = null;
  if (kind === "local" && location.includes("://")) {
    pathHint = smbPrefix ? "Choose SMB share for a network URL." : "Enter a folder path or choose SMB share for an smb:// address.";
  } else if (kind === "smb" && location && !smb) {
    pathHint = "Enter an SMB URL in the form smb://server/share.";
  }

  return {
    kind, path, hiddenPolicy, setPath: kind === "local" ? setLocalPath : setSmbPath, setHiddenPolicy,
    setKind: chooseKind, validSmbUrl: smb !== null, remoteMappingAvailable, savedConnection, checkingConnection, pathHint,
    rememberConnection: (username: string) => {
      if (smb) setMatch({ url: location, connection: { url: smb.normalized_url, username } });
    },
    ready: Boolean(location && !pathHint && (kind === "local" || remoteMappingAvailable || savedConnection)),
  };
}

interface SmbConnectionFieldsProps {
  url: string;
  saved: SavedConnection | null;
  checking: boolean;
  disabled: boolean;
  username: string;
  onUsernameChange: (username: string | null) => void;
  onConnected: (result: ManagementMutationResult, username: string) => void;
  onConnectionReady: () => void;
  onBusyChange: (busy: boolean) => void;
}

function SmbConnectionFields({
  url,
  saved,
  checking,
  disabled,
  username,
  onUsernameChange,
  onConnected,
  onConnectionReady,
  onBusyChange,
}: SmbConnectionFieldsProps) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorId = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const focusAfterSubmit = useRef(false);

  useLayoutEffect(() => {
    if (editing) passwordRef.current?.focus();
  }, [editing]);

  useLayoutEffect(() => {
    if (!focusAfterSubmit.current || disabled || busy) return;
    focusAfterSubmit.current = false;
    if (error) passwordRef.current?.focus();
    else onConnectionReady();
  }, [busy, disabled, error, editing, onConnectionReady]);

  async function submit() {
    if (disabled || busy || !url.trim() || !username.trim() || !password) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const next = await connectSmb(url.trim(), username.trim(), password);
      setPassword("");
      setEditing(false);
      onConnected(next, username.trim());
    } catch (connectionError) {
      setError(errorMessage(connectionError));
    } finally {
      focusAfterSubmit.current = true;
      setBusy(false);
      onBusyChange(false);
    }
  }

  if (checking && !saved && !editing) {
    return (
      <div className="connection-available" role="status">
        <span className="mini-spinner" />
        <div><strong>Checking saved connections…</strong><small>Looking for access to this SMB location</small></div>
      </div>
    );
  }

  if (saved && !editing) {
    return (
      <div className="connection-available" role="status">
        <span><CheckIcon /></span>
        <div><strong>Saved connection available</strong><small>{saved.username} · {saved.url}</small></div>
        <button type="button" onClick={() => setEditing(true)} disabled={disabled}>Reconnect</button>
      </div>
    );
  }

  return (
    <div
      className="inline-connection-form"
      onChange={() => setError(null)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="management-inline-note">
        <NetworkIcon />
        <span>{saved ? "Update the saved connection for this share." : "Connect to verify and save access to this share."}</span>
      </div>
      <div className="management-form-grid two-columns">
        <Field label="Username">
          <input value={username} onChange={(event) => onUsernameChange(event.target.value)} autoComplete="username" disabled={disabled || busy} />
        </Field>
        <Field label="Password">
          <input ref={passwordRef} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" aria-describedby={error ? errorId : undefined} disabled={disabled || busy} />
        </Field>
      </div>
      {error && <p id={errorId} className="management-form-error" role="alert">{error}</p>}
      <div className="management-form-actions compact-actions">
        {saved && <button className="ghost-button" type="button" onClick={() => {
          setPassword("");
          setError(null);
          onUsernameChange(null);
          focusAfterSubmit.current = true;
          setEditing(false);
        }} disabled={disabled || busy}>Keep saved connection</button>}
        <button
          className="secondary-button"
          type="button"
          onClick={() => void submit()}
          disabled={disabled || busy || !url.trim() || !username.trim() || !password}
        >
          <NetworkIcon />{busy ? "Connecting…" : "Connect"}
        </button>
      </div>
    </div>
  );
}

interface SiteRootFieldsProps {
  root: ReturnType<typeof useSiteRoot>;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult) => void;
  onConnectionReady: () => void;
}

export function SiteRootFields({ root, disabled, onBusyChange, onMutation, onConnectionReady }: SiteRootFieldsProps) {
  const folderInputId = useId();
  const hintId = useId();
  const [checkedPath, setCheckedPath] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [userDraft, setUserDraft] = useState<{ url: string; username: string } | null>(null);
  const url = root.path.trim();
  const pathHint = checkedPath === root.path ? root.pathHint : null;
  const locationInput = {
    value: root.path,
    disabled,
    spellCheck: false,
    autoComplete: "off",
    "aria-invalid": pathHint ? true : undefined,
    "aria-describedby": pathHint ? hintId : undefined,
    onBlur: () => setCheckedPath(root.path),
  };

  async function chooseDirectory() {
    if (disabled) return;
    setPickerError(null);
    onBusyChange(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") root.setPath(selected);
    } catch (pickerFailure) {
      setPickerError(errorMessage(pickerFailure));
    } finally {
      onBusyChange(false);
    }
  }

  return (
    <>
      <fieldset className="root-kind-picker" disabled={disabled}>
        <legend>Location type</legend>
        <label className={root.kind === "local" ? "is-active" : ""}>
          <input className="sr-only" type="radio" name="root-kind" checked={root.kind === "local"} onChange={() => root.setKind("local")} />
          <DriveIcon /><span><strong>Local folder</strong></span>
        </label>
        <label className={root.kind === "smb" ? "is-active" : ""}>
          <input className="sr-only" type="radio" name="root-kind" checked={root.kind === "smb"} onChange={() => root.setKind("smb")} />
          <NetworkIcon /><span><strong>SMB share</strong></span>
        </label>
      </fieldset>
      {root.kind === "local" ? (
        <div className="management-field">
          <label htmlFor={folderInputId}>Folder path</label>
          <div className="path-picker">
            <input {...locationInput} id={folderInputId} onChange={(event) => root.setPath(event.target.value)} placeholder="Choose or enter a path" />
            <button className="secondary-button" type="button" onClick={() => void chooseDirectory()} disabled={disabled}>Browse…</button>
          </div>
        </div>
      ) : (
        <>
          <Field label="SMB URL">
            <input {...locationInput} type="url" onChange={(event) => root.setPath(event.target.value)} placeholder="smb://server/share" />
          </Field>
          {root.remoteMappingAvailable ? (
            <div className="connection-available" role="status">
              <span><CheckIcon /></span>
              <div><strong>Remote agent mapping available</strong><small>This root will be read through SSH.</small></div>
            </div>
          ) : root.validSmbUrl ? (
            <SmbConnectionFields
              key={url}
              url={url}
              username={userDraft?.url === url ? userDraft.username : root.savedConnection?.username ?? ""}
              onUsernameChange={(username) => setUserDraft(username === null ? null : { url, username })}
              saved={root.savedConnection}
              checking={root.checkingConnection}
              disabled={disabled}
              onConnected={(result, username) => {
                root.rememberConnection(username);
                setUserDraft(null);
                onMutation(result);
              }}
              onConnectionReady={onConnectionReady}
              onBusyChange={onBusyChange}
            />
          ) : null}
        </>
      )}
      {pathHint && <p id={hintId} className="management-form-warning"><WarningIcon />{pathHint}</p>}
      <label className="root-hidden-policy">
        <input
          type="checkbox"
          checked={root.hiddenPolicy === "include"}
          disabled={disabled}
          onChange={(event) => root.setHiddenPolicy(event.target.checked ? "include" : "skip")}
        />
        Include hidden files
      </label>
      {pickerError && <p className="management-form-error" role="alert">{pickerError}</p>}
    </>
  );
}
