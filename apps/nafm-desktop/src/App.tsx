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
  const [siteListRevision, setSiteListRevision] = useState(0);
  const addition = siteAddition?.dashboardRevision === workspace.dashboardRevision ? siteAddition : undefined;

  function openAddSite(event: MouseEvent<HTMLButtonElement>, workspaceName: string, origin: AddSiteOrigin) {
    // WebKit doesn't focus a button on pointer activation. Give the dialog a return target.
    const opener = event.currentTarget;
    opener.focus({ preventScroll: true });
    setSiteAddition(undefined);
    setAddingSite({ opener, origin, workspaceName, dashboardRevision: workspace.dashboardRevision });
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
          siteAddition={addition}
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
            workspace.acceptMutation(result, false);
            if (createdSiteName === undefined) return;
            setSiteListRevision((revision) => revision + 1);
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
