import { useState, type MouseEvent } from "react";
import type { AtlasToolbarExtension } from "./atlas/AtlasToolbar";
import { WorkspaceAtlas } from "./atlas/WorkspaceAtlas";
import { useWorkspace } from "./hooks/useWorkspace";
import { AddSiteDialog } from "./management/AddSiteDialog";
import { ManagementCenter } from "./management/ManagementCenter";
import { SshAuthentication } from "./management/SshAuthentication";
import type { AddSiteOrigin, AddSiteRequest, SiteAddition } from "./management/siteAddition";
import "./styles/atlas.css";

export interface AppProps {
  toolbarExtension?: AtlasToolbarExtension;
  browsingScope?: string;
}

export default function App({ toolbarExtension, browsingScope = "desktop" }: AppProps) {
  const workspace = useWorkspace();
  const [addingSite, setAddingSite] = useState<AddSiteRequest | null>(null);
  const [siteAddition, setSiteAddition] = useState<SiteAddition>();
  const addition = siteAddition?.workspaceRevision === workspace.workspaceRevision ? siteAddition : undefined;

  function openAddSite(event: MouseEvent<HTMLButtonElement>, workspaceName: string, origin: AddSiteOrigin) {
    // WebKit doesn't focus a button on pointer activation. Give the dialog a return target.
    const opener = event.currentTarget;
    opener.focus({ preventScroll: true });
    setSiteAddition(undefined);
    setAddingSite({ opener, origin, workspaceName, workspaceRevision: workspace.workspaceRevision });
  }

  return (
    <>
      <div
        inert={workspace.managementOpen || workspace.workspaceSwitching || undefined}
        aria-busy={workspace.workspaceSwitching || undefined}
      >
        <WorkspaceAtlas
          key={workspace.workspaceRevision}
          workspace={workspace}
          siteAddition={addition}
          onAddSite={openAddSite}
          toolbarExtension={toolbarExtension}
          browsingScope={browsingScope}
        />
      </div>
      {workspace.pendingWorkspaceName && (
        <div className="atlas-alert" role="status">Switching to {workspace.pendingWorkspaceName}…</div>
      )}
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
        onAddSite={(event, workspaceName) => openAddSite(event, workspaceName, "settings")}
        siteAddition={addition?.origin === "settings" ? addition : undefined}
        onBusyChange={workspace.setManagementBusy}
        onMutation={workspace.acceptMutation}
        onRetry={() => void workspace.refreshManagement()}
      />
      {addingSite && (
        <AddSiteDialog
          workspaceName={addingSite.workspaceName}
          remotePathMappings={workspace.management?.active_workspace.name === addingSite.workspaceName
            ? workspace.management.remote_path_mappings : []}
          blocked={workspace.activeTaskCount > 0}
          onClose={() => setAddingSite(null)}
          onMutation={(result, createdSiteName) => {
            workspace.acceptMutation(result, createdSiteName !== undefined);
            if (createdSiteName === undefined) return;
            if (result.active_workspace.name !== addingSite.workspaceName) return;
            const created = result.snapshot?.sites.find((site) => site.name === createdSiteName);
            setSiteAddition({ ...addingSite, name: createdSiteName, siteId: created?.id });
          }}
        />
      )}
      <SshAuthentication />
    </>
  );
}
