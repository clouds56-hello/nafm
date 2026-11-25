import type { AddedSiteRow } from "../atlas/useAddedSiteRow";

export type AddSiteOrigin = "atlas" | "sites" | "sources" | "coverage" | "settings";

export interface AddSiteRequest {
  workspaceName: string;
  workspaceRevision: number;
  opener: HTMLButtonElement;
  origin: AddSiteOrigin;
}

export interface SiteAddition extends AddSiteRequest {
  name: string;
  siteId?: string;
}

export function resolveAddedSite(
  addition: SiteAddition | undefined,
  workspaceName: string | undefined,
  sites: readonly { id: string; name: string }[],
): AddedSiteRow | undefined {
  if (!addition || addition.workspaceName !== workspaceName) return;
  const site = sites.find((site) => addition.siteId ? site.id === addition.siteId : site.name === addition.name);
  return site ? { id: site.id, opener: addition.opener } : undefined;
}
