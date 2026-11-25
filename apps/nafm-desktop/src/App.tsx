import { useState, type MouseEvent } from "react";
import type { AtlasToolbarExtension } from "./atlas/AtlasToolbar";
import { WorkspaceAtlas } from "./atlas/WorkspaceAtlas";
import { useWorkspace } from "./hooks/useWorkspace";
import { AddSiteDialog } from "./management/AddSiteDialog";
import { ManagementCenter } from "./management/ManagementCenter";
import { SshAuthentication } from "./management/SshAuthentication";
import "./styles/atlas.css";

export interface AppProps {
  toolbarExtension?: AtlasToolbarExtension;
  browsingScope?: string;
}

export default function App({ toolbarExtension, browsingScope = "desktop" }: AppProps) {
  const workspace = useWorkspace();
  const [addingToWorkspace, setAddingToWorkspace] = useState<string | null>(null);
  const [siteListRevision, setSiteListRevision] = useState(0);

  function openAddSite(event: MouseEvent<HTMLButtonElement>, workspaceName: string) {
    // WebKit doesn't focus a button on pointer activation. Give the dialog a return target.
    event.currentTarget.focus({ preventScroll: true });
    setAddingToWorkspace(workspaceName);
  }

  return (
    <>
      <div
        inert={workspace.managementOpen || workspace.workspaceSwitching || undefined}
        aria-busy={workspace.workspaceSwitching || undefined}
      >
        <WorkspaceAtlas
          key={workspace.dashboardRevision}
          workspace={workspace}
          siteListRevision={siteListRevision}
          onAddSite={openAddSite}
          toolbarExtension={toolbarExtension}
          browsingScope={browsingScope}
        />
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
        onAddSite={openAddSite}
        onBusyChange={workspace.setManagementBusy}
        onMutation={workspace.acceptMutation}
        onRetry={() => void workspace.refreshManagement()}
      />
      {addingToWorkspace !== null && (
        <AddSiteDialog
          workspaceName={addingToWorkspace}
          remotePathMappings={workspace.management?.active_workspace.name === addingToWorkspace
            ? workspace.management.remote_path_mappings : []}
          blocked={workspace.activeTaskCount > 0}
          onClose={() => setAddingToWorkspace(null)}
          onMutation={(result, createdSiteName) => {
            workspace.acceptMutation(result, false);
            if (createdSiteName === undefined) return;
            setSiteListRevision((revision) => revision + 1);
            if (workspace.managementOpen && workspace.managementSection === "sites") {
              const created = result.snapshot?.sites.find((site) => site.name === createdSiteName);
              if (created) workspace.setSelectedSiteId(created.id);
            }
          }}
        />
      )}
      <SshAuthentication />
    </>
  );
}
