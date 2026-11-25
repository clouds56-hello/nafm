import { useCallback, useEffect, useRef, useState } from "react";
import { type ManagementSection } from "../management/ManagementCenter";
import { loadManagement, switchWorkspace } from "../lib/tauri";
import type { ManagementMutationResult, ManagementSnapshot } from "../lib/types";

export interface WorkspaceSwitchFailure {
  name: string;
  message: string;
}

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
  const [workspaceSwitchFocus, setWorkspaceSwitchFocus] = useState(false);
  const [dashboardRevision, setDashboardRevision] = useState(0);
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const managementRef = useRef<ManagementSnapshot | null>(null);
  const managementRequestRef = useRef(0);
  const previousActiveTaskCountRef = useRef(0);
  const workspaceSwitchingRef = useRef(false);

  const remountDashboard = useCallback(() => {
    previousActiveTaskCountRef.current = 0;
    setActiveTaskCount(0);
    setWorkspaceSwitchFailure(null);
    setWorkspaceSwitchFocus(false);
    setDashboardRevision((current) => current + 1);
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
    if (dashboardChanged || workspaceChanged) {
      remountDashboard();
    }
  }, [remountDashboard]);

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
      if (workspaceChanged) remountDashboard();
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
  }, [remountDashboard]);

  const acceptMutation = useCallback((
    result: ManagementMutationResult,
    dashboardChanged: boolean,
  ) => {
    const previous = managementRef.current;
    const workspaceChanged = previous !== null
      && previous.active_workspace.name !== result.active_workspace.name;

    if (result.snapshot) {
      acceptSnapshot(result.snapshot, dashboardChanged || workspaceChanged);
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
      if (dashboardChanged || workspaceChanged) {
        remountDashboard();
      }
    }

    setManagementError(result.refresh_error
      ? `The change was saved, but management data could not be refreshed: ${result.refresh_error}`
      : null);
    if (!result.snapshot) void refreshManagement(true, true);
  }, [acceptSnapshot, refreshManagement, remountDashboard]);

  useEffect(() => {
    void refreshManagement();
  }, [refreshManagement]);

  useEffect(() => {
    if (managementOpen) void refreshManagement(true);
  }, [managementOpen, refreshManagement]);

  const openManagement = useCallback((
    section: ManagementSection,
    siteId: string | null = null,
  ) => {
    if (managementOpen && managementBusy) return;
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
      setWorkspaceSwitchFocus(true);
    } catch (error) {
      setWorkspaceSwitchFailure({ name, message: errorMessage(error) });
    } finally {
      workspaceSwitchingRef.current = false;
      setPendingWorkspaceName(null);
    }
  }, [acceptMutation, activeTaskCount]);

  const dismissWorkspaceSwitchFailure = useCallback(() => {
    setWorkspaceSwitchFailure(null);
    setWorkspaceSwitchFocus(true);
  }, []);
  const finishWorkspaceSwitchFocus = useCallback(() => setWorkspaceSwitchFocus(false), []);

  return {
    management, managementLoading, managementError, managementOpen, managementBusy, managementSection,
    selectedSiteId, pendingWorkspaceName, workspaceSwitching: pendingWorkspaceName !== null, dashboardRevision, activeTaskCount,
    workspaceSwitchFailure, workspaceSwitchFocus, dismissWorkspaceSwitchFailure, finishWorkspaceSwitchFocus,
    openManagement, setManagementOpen, setManagementSection, setManagementBusy, setSelectedSiteId,
    acceptMutation, refreshManagement, quickSwitchWorkspace, handleActiveTaskCountChange,
  };
}
