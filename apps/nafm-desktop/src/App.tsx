import type { ReactNode } from "react";
import { WorkspaceAtlas } from "./atlas/WorkspaceAtlas";
import { useWorkspace } from "./hooks/useWorkspace";
import { ManagementCenter } from "./management/ManagementCenter";
import { SshAuthentication } from "./management/SshAuthentication";
import "./styles/atlas.css";

export default function App({ toolbarExtension }: { toolbarExtension?: ReactNode }) {
  const workspace = useWorkspace();
  return (
    <>
      <div
        inert={workspace.managementOpen || workspace.workspaceSwitching || undefined}
        aria-busy={workspace.workspaceSwitching || undefined}
      >
        <WorkspaceAtlas key={workspace.dashboardRevision} workspace={workspace} toolbarExtension={toolbarExtension} />
      </div>
      <ManagementCenter
        open={workspace.managementOpen}
        section={workspace.managementSection}
        selectedSiteId={workspace.selectedSiteId}
        snapshot={workspace.management}
        loading={workspace.managementLoading}
        error={workspace.managementError}
        activeTaskCount={workspace.activeTaskCount}
        onClose={() => { if (!workspace.managementBusy) workspace.setManagementOpen(false); }}
        onSectionChange={workspace.setManagementSection}
        onSelectedSiteChange={workspace.setSelectedSiteId}
        onBusyChange={workspace.setManagementBusy}
        onMutation={workspace.acceptMutation}
        onRetry={() => void workspace.refreshManagement()}
      />
      <SshAuthentication />
    </>
  );
}
