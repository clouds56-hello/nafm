import { useCallback, useEffect, useRef, useState } from "react";
import { type ManagementSection } from "../management/ManagementCenter";
import { loadManagement, switchWorkspace } from "../lib/tauri";
import type { ManagementMutationResult, ManagementSnapshot } from "../lib/types";

export interface WorkspaceSwitchFailure {
  name: string;
  message: string;
}

export type AtlasToolbarFocus = "workspace" | "actions";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

export function useWorkspace() {
  const [management, setManagement] = useState<ManagementSnapshot | null>(null);
  const [managementLoading, setManagementLoading] = useState(true);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementBusy, setManagementBusy] = useState(false);
  const [managementSection, setManagementSection] = useState<ManagementSection>("workspaces");
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [pendingWorkspaceName, setPendingWorkspaceName] = useState<string | null>(null);
  const [workspaceSwitchFailure, setWorkspaceSwitchFailure] = useState<WorkspaceSwitchFailure | null>(null);
  const [atlasToolbarFocus, setAtlasToolbarFocus] = useState<AtlasToolbarFocus | null>(null);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [siteListRevision, setSiteListRevision] = useState(0);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const managementRef = useRef<ManagementSnapshot | null>(null);
  const managementRequestRef = useRef(0);
  const previousActiveTaskCountRef = useRef(0);
  const workspaceSwitchingRef = useRef(false);
  const managementOpener = useRef<{ element: HTMLElement | SVGElement | null; siteId: string | null } | null>(null);

  const updateDashboard = useCallback((workspaceChanged: boolean, siteListChanged = false) => {
    if (workspaceChanged) {
      previousActiveTaskCountRef.current = 0;
      setActiveTaskCount(0);
      setWorkspaceSwitchFailure(null);
      setAtlasToolbarFocus(null);
      setWorkspaceRevision((current) => current + 1);
    } else if (siteListChanged) {
      setSiteListRevision((current) => current + 1);
    }
  }, []);

  const acceptSnapshot = useCallback((next: ManagementSnapshot, dashboardChanged: boolean) => {
    managementRequestRef.current += 1;
    const previous = managementRef.current;
    const workspaceChanged = previous !== null
      && previous.active_workspace.name !== next.active_workspace.name;
    managementRef.current = next;
    setManagement(next);
    setManagementLoading(false);
    setManagementError(null);
    setSelectedSiteId((current) => (
      current && !next.sites.some((site) => site.id === current) ? null : current
    ));
    updateDashboard(workspaceChanged, dashboardChanged);
  }, [updateDashboard]);

  const refreshManagement = useCallback(async (
    background = false,
    changeAlreadyApplied = false,
  ) => {
    const requestId = managementRequestRef.current + 1;
    managementRequestRef.current = requestId;
    const showLoading = !background || managementRef.current === null;
    if (showLoading) setManagementLoading(true);
    if (!background) setManagementError(null);
    try {
      const next = await loadManagement();
      if (managementRequestRef.current !== requestId) return;
      const previous = managementRef.current;
      const workspaceChanged = previous !== null
        && previous.active_workspace.name !== next.active_workspace.name;
      managementRef.current = next;
      setManagement(next);
      setManagementError(null);
      setSelectedSiteId((current) => (
        current && !next.sites.some((site) => site.id === current) ? null : current
      ));
      updateDashboard(workspaceChanged);
    } catch (error) {
      if (managementRequestRef.current === requestId) {
        const message = errorMessage(error);
        setManagementError(changeAlreadyApplied
          ? `The change was saved, but management data still could not be refreshed: ${message}`
          : message);
      }
    } finally {
      if (managementRequestRef.current === requestId) setManagementLoading(false);
    }
  }, [updateDashboard]);

  const acceptMutation = useCallback((
    result: ManagementMutationResult,
    dashboardChanged: boolean,
  ) => {
    const previous = managementRef.current;
    const workspaceChanged = previous !== null
      && previous.active_workspace.name !== result.active_workspace.name;

    if (result.snapshot) {
      acceptSnapshot(result.snapshot, dashboardChanged);
    } else {
      managementRequestRef.current += 1;
      if (previous) {
        const next: ManagementSnapshot = {
          ...previous,
          active_workspace: result.active_workspace,
          workspaces: previous.workspaces.some(
            (workspace) => workspace.name === result.active_workspace.name,
          )
            ? previous.workspaces.map((workspace) => ({
                ...workspace,
                active: workspace.name === result.active_workspace.name,
              }))
            : [
                ...previous.workspaces.map((workspace) => ({ ...workspace, active: false })),
                result.active_workspace,
              ],
          sites: workspaceChanged ? [] : previous.sites,
        };
        managementRef.current = next;
        setManagement(next);
      }
      if (workspaceChanged) setSelectedSiteId(null);
      setManagementLoading(false);
      updateDashboard(workspaceChanged, dashboardChanged);
    }

    setManagementError(result.refresh_error
      ? `The change was saved, but management data could not be refreshed: ${result.refresh_error}`
      : null);
    if (!result.snapshot) void refreshManagement(true, true);
  }, [acceptSnapshot, refreshManagement, updateDashboard]);

  useEffect(() => {
    void refreshManagement();
  }, [refreshManagement]);

  useEffect(() => {
    if (managementOpen) void refreshManagement(true);
  }, [managementOpen, refreshManagement]);

  useEffect(() => {
    if (managementOpen) return;
    const opener = managementOpener.current;
    managementOpener.current = null;
    if (!opener || document.activeElement !== document.body) return;
    const siteRemoved = opener.siteId !== null && managementRef.current?.sites.every((site) => site.id !== opener.siteId);
    if (!siteRemoved && opener.element?.isConnected && opener.element.getClientRects().length) {
      opener.element.focus({ preventScroll: true });
    }
    if (document.activeElement === document.body) setAtlasToolbarFocus("actions");
  }, [managementOpen]);

  const openManagement = useCallback((
    section: ManagementSection,
    siteId: string | null = null,
  ) => {
    if (managementOpen && managementBusy) return;
    if (!managementOpen) {
      const active = document.activeElement;
      managementOpener.current = {
        element: (active instanceof HTMLElement || active instanceof SVGElement) && active !== document.body ? active : null,
        siteId,
      };
    }
    setManagementSection(section);
    setSelectedSiteId(siteId);
    setManagementOpen(true);
  }, [managementBusy, managementOpen]);

  useEffect(() => {
    function openManagementShortcut(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key !== ",") return;
      event.preventDefault();
      if (!workspaceSwitchingRef.current) openManagement("workspaces");
    }
    document.addEventListener("keydown", openManagementShortcut);
    return () => document.removeEventListener("keydown", openManagementShortcut);
  }, [openManagement]);

  const handleActiveTaskCountChange = useCallback((count: number) => {
    const previous = previousActiveTaskCountRef.current;
    previousActiveTaskCountRef.current = count;
    setActiveTaskCount(count);
    if (previous > 0 && count === 0) void refreshManagement(true);
  }, [refreshManagement]);

  const quickSwitchWorkspace = useCallback(async (name: string) => {
    if (workspaceSwitchingRef.current || activeTaskCount > 0 || name === managementRef.current?.active_workspace.name) return;
    workspaceSwitchingRef.current = true;
    setPendingWorkspaceName(name);
    setWorkspaceSwitchFailure((current) => current?.name === name ? current : null);
    try {
      acceptMutation(await switchWorkspace(name), true);
      setAtlasToolbarFocus("workspace");
    } catch (error) {
      setWorkspaceSwitchFailure({ name, message: errorMessage(error) });
    } finally {
      workspaceSwitchingRef.current = false;
      setPendingWorkspaceName(null);
    }
  }, [acceptMutation, activeTaskCount]);

  const dismissWorkspaceSwitchFailure = useCallback(() => {
    setWorkspaceSwitchFailure(null);
    setAtlasToolbarFocus("workspace");
  }, []);
  const finishAtlasToolbarFocus = useCallback(() => setAtlasToolbarFocus(null), []);

  return {
    management, managementLoading, managementError, managementOpen, managementBusy, managementSection,
    selectedSiteId, pendingWorkspaceName, workspaceSwitching: pendingWorkspaceName !== null,
    workspaceRevision, siteListRevision, activeTaskCount,
    workspaceSwitchFailure, atlasToolbarFocus, dismissWorkspaceSwitchFailure, finishAtlasToolbarFocus,
    openManagement, setManagementOpen, setManagementSection, setManagementBusy, setSelectedSiteId,
    acceptMutation, refreshManagement, quickSwitchWorkspace, handleActiveTaskCountChange,
  };
}
