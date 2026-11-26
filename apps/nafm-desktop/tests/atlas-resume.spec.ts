import { expect, test, type Page } from "@playwright/test";
import type { StorageDirectoryAnchor, StorageViewSnapshot } from "../src/lib/types";

const studioWorkspace = "Studio workspace";
const fieldWorkspace = "Field notes";

function preferenceKey(scenario = "populated") {
  return "nafm.atlas-location:" + encodeURIComponent(`preview:${scenario}`) + ":" + encodeURIComponent(studioWorkspace);
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

function sites(page: Page) {
  return page.getByRole("complementary", { name: "Sites" });
}

async function openSite(page: Page, name: string) {
  await sites(page).getByRole("button", { name: `Open ${name} in Atlas`, exact: true }).click();
}

async function openFolder(page: Page, name: string) {
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: new RegExp(`^${name},`) }).press("Enter");
  await expect(currentFolder(page)).toHaveText(name);
}

async function expectFreshHistory(page: Page) {
  const path = page.getByRole("navigation", { name: "Folder path" });
  await expect(path.getByRole("button", { name: "Previous location", exact: true })).toBeDisabled();
  await expect(path.getByRole("button", { name: "Next location", exact: true })).toBeDisabled();
}

async function seedLocation(page: Page, siteId: string, nodeId: string, scenario?: string) {
  const preference = {
    active_site_id: siteId,
    site_folders: [{ site_id: siteId, node_id: nodeId }],
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: preferenceKey(scenario),
    value: JSON.stringify(preference),
  });
}

async function chooseScenario(page: Page, scenario: string) {
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByLabel("Scenario").selectOption(scenario);
  await expect(page).toHaveURL(new RegExp(`[?&]scenario=${scenario}(?:&|$)`));
}

test("reopening resumes the active site and each site's last folder with fresh history", async ({ page, context }) => {
  await page.goto("/mock/");
  await openFolder(page, "Projects");
  await openFolder(page, "Brand campaign");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await openSite(page, "Field drive");
  await expect(currentFolder(page)).toHaveText("Field drive");
  await openFolder(page, "Drone imagery");

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/mock/");
  await expect(currentFolder(reopened)).toHaveText("Drone imagery");
  await expectFreshHistory(reopened);

  await reopened.getByRole("button", { name: "Sites", exact: true }).click();
  await expect(sites(reopened).getByRole("button", { name: "Open Field drive in Atlas" }))
    .toHaveAttribute("aria-current", "true");
  await openSite(reopened, "Studio archive");
  await expect(currentFolder(reopened)).toHaveText("Brand campaign");
  await reopened.getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(reopened)).toHaveText("Drone imagery");
});

test("switching workspaces restores the independent folder in each workspace", async ({ page }) => {
  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true });
  await page.goto("/mock/");
  await openFolder(page, "Projects");
  await openFolder(page, "Brand campaign");

  await workspace.selectOption(fieldWorkspace);
  await expect(workspace).toHaveValue(fieldWorkspace);
  const map = page.getByRole("region", { name: "Circular storage map" });
  await expect(map.getByText("No source selected", { exact: true })).toBeVisible();
  await map.getByRole("button", { name: "Add site", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add site", exact: true });
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Notebook shelf");
  await dialog.getByRole("button", { name: "Browse…", exact: true }).click();
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await map.getByRole("button", { name: "Scan this site", exact: true }).click();
  await openFolder(page, "Drone imagery");

  await expect(workspace).toBeEnabled();
  await workspace.selectOption(studioWorkspace);
  await expect(workspace).toHaveValue(studioWorkspace);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expectFreshHistory(page);

  await workspace.selectOption(fieldWorkspace);
  await expect(workspace).toHaveValue(fieldWorkspace);
  await expect(currentFolder(page)).toHaveText("Drone imagery");
  await expectFreshHistory(page);
});

async function openFilteredLibrary(page: Page) {
  await page.goto("/mock/?scenario=large");
  await openFolder(page, "Photo Library");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.press("Enter");
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(sort).toHaveAttribute("title", "Name, ascending");
  const query = "  hArBoR SuRvEy  ";
  const search = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  await search.fill(query);
  const grid = contents.getByRole("grid");
  await expect(grid).toHaveAttribute("aria-rowcount", "666");
  const index = 440;
  const row = grid.locator(`[aria-rowindex="${index}"] [data-entry-id]`);
  const height = await grid.evaluate((list) => Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
  await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (index - 4) * height);
  await expect(row).toBeInViewport({ ratio: 0.99 });
  await row.focus();
  const entryId = (await row.getAttribute("data-entry-id"))!;
  const name = (await row.locator(".atlas-directory-identity > span").first().textContent())!;
  const scroll = await contents.evaluate((pane) => pane.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  return { inspector, contents, sort, query, search, row, entryId, name, scroll };
}

async function switchWorkspace(page: Page, name: string, compact = false) {
  const picker = page.getByRole("combobox", { name: "Workspace", exact: true });
  if (compact) await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
  await picker.focus();
  await picker.selectOption(name);
}

for (const layout of ["desktop", "compact"] as const) {
  test(`${layout} workspace return keeps the Contents position and file Details`, async ({ page }) => {
    const compact = layout === "compact";
    await page.setViewportSize(compact ? { width: 390, height: 740 } : { width: 1280, height: 820 });
    const { inspector, contents, sort, query, search, row, entryId, name, scroll } = await openFilteredLibrary(page);
    const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
    const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
    const switcher = compact ? actions : page.getByRole("combobox", { name: "Workspace", exact: true });

    async function roundTrip() {
      await switchWorkspace(page, fieldWorkspace, compact);
      await expect(page.getByText("No source selected", { exact: true })).toBeVisible();
      await expect(sites(page)).toBeHidden();
      await expect(inspector).toBeHidden();
      await switchWorkspace(page, studioWorkspace, compact);
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await expect(sites(page)).toBeVisible();
      await expect(switcher).toBeFocused();
      await expect(switcher).toBeInViewport({ ratio: 0.99 });
    }

    async function expectContentsPosition() {
      await expect(search).toHaveValue(query);
      await expect(sort).toHaveAttribute("title", "Name, ascending");
      await expect(row).toHaveAttribute("data-entry-id", entryId);
      await expect(row).toHaveAttribute("tabindex", "0");
      await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
    }

    if (!compact) {
      await roundTrip();
      await expectContentsPosition();
      await expect(row).toBeInViewport({ ratio: 0.99 });
      await expectFreshHistory(page);
    }

    await row.press("Enter");
    const heading = inspector.getByRole("heading", { name, exact: true });
    await expect(heading).toBeVisible();
    const inspections = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { anchor?: StorageDirectoryAnchor }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const files: string[] = [];
      bridge.invoke = (command, args) => {
        const inspected = args.anchor?.inspected_file_id;
        if (command === "get_storage_view_snapshot" && inspected) files.push(inspected);
        return invoke(command, args);
      };
      return files;
    });

    await roundTrip();
    await expect(heading).toBeVisible();
    await expect(back).toBeVisible();
    expect(await inspections.jsonValue()).toEqual([entryId]);
    await back.press("Enter");
    await expectContentsPosition();
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport({ ratio: 0.99 });
    await expect(page.getByRole("button", { name: "Previous location", exact: true })).toBeDisabled();
  });
}

test("returning to a workspace opens Contents when its inspected file is no longer indexed", async ({ page }) => {
  const { inspector, search, row, entryId, name, query, sort } = await openFilteredLibrary(page);
  await row.press("Enter");
  const heading = inspector.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible();
  await switchWorkspace(page, fieldWorkspace);
  await expect(page.getByText("No source selected", { exact: true })).toBeVisible();
  await page.evaluate((removedId) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { anchor?: StorageDirectoryAnchor }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command !== "get_storage_view_snapshot" || args.anchor?.inspected_file_id !== removedId) return response;
      const snapshot = response as StorageViewSnapshot;
      return {
        ...snapshot, inspected_file: null,
        page: { ...snapshot.page, children: snapshot.page.children.filter(({ id }) => id !== removedId) },
      };
    };
  }, entryId);
  await switchWorkspace(page, studioWorkspace);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(query);
  await expect(sort).toHaveAttribute("title", "Name, ascending");
  await expect(heading).toBeHidden();
  await expect(inspector.getByRole("button", { name: "Back to Contents", exact: true })).toBeHidden();
  await expectFreshHistory(page);
});

test("a workspace return keeps the paused search and viewport of a Finder reveal", async ({ page }) => {
  const { inspector, contents, search, query } = await openFilteredLibrary(page);
  await page.getByRole("button", { name: "Find files", exact: true }).press("Enter");
  const finder = page.getByRole("dialog", { name: "Find files", exact: true });
  await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("Proof 096");
  await finder.getByRole("button", { name: /^Proof 096\.jpg/ }).press("Enter");
  await expect(finder).toBeHidden();
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
  const proof = contents.getByRole("grid").getByRole("button", { name: /^Proof 096\.jpg/ });
  await expect(proof).toBeFocused();
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  const scroll = await contents.evaluate((pane) => pane.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  const restore = contents.getByRole("button", { name: "Restore search", exact: true });
  await expect(restore).toBeVisible();

  await switchWorkspace(page, fieldWorkspace);
  await expect(page.getByText("No source selected", { exact: true })).toBeVisible();
  await switchWorkspace(page, studioWorkspace);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(restore).toBeVisible();
  await expect(search).toBeHidden();
  await expect(proof).toHaveAttribute("tabindex", "0");
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
  await expectFreshHistory(page);
  await restore.press("Enter");
  await expect(search).toHaveValue(query);
  await expect(search).toBeFocused();
});

test("a closed Atlas reveal keeps its paused search and cursor when its workspace returns", async ({ page }) => {
  await page.goto("/mock/");
  await openFolder(page, "Photo Library");
  const opener = page.getByRole("button", { name: "Contents & details", exact: true });
  await opener.press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const query = "  PrOoF 01  ";
  const filter = contents.getByLabel("Find in folder", { exact: true });
  await contents.getByRole("button", { name: "Search this folder" }).press("Enter");
  await filter.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await page.getByRole("figure").getByRole("button", { name: /^Proof 001\.jpg,/ }).press("Enter");
  await inspector.getByRole("button", { name: "Show in Contents" }).press("Enter");
  await expect(grid.getByRole("button", { name: /^Proof 001\.jpg/ })).toBeFocused();
  const restore = contents.getByRole("button", { name: "Restore search" });
  await expect(restore).toBeVisible();

  await page.keyboard.press("End");
  const cursor = grid.locator('[aria-rowindex="100"] [data-entry-id]');
  await expect(cursor).toBeFocused();
  const scroll = await contents.evaluate((pane) => pane.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await inspector.getByRole("button", { name: "Close inspector" }).press("Enter");
  await switchWorkspace(page, fieldWorkspace);
  await expect(page.getByText("No source selected", { exact: true })).toBeVisible();
  await switchWorkspace(page, studioWorkspace);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(inspector).toBeHidden();
  await expect(opener).toHaveAttribute("aria-expanded", "false");

  await opener.press("Enter");
  await expect(restore).toBeVisible();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(cursor).toBeFocused();
  await expect(cursor).toBeInViewport({ ratio: 0.99 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
  await restore.press("Enter");
  await expect(filter).toHaveValue(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
});

test("a failed quick workspace switch keeps Atlas open and retries the intended workspace", async ({ page }) => {
  await page.goto("/mock/?scenario=workspace-recovery");
  await openFolder(page, "Projects");
  await openFolder(page, "Brand campaign");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const camera = grid.getByRole("button", { name: /^Camera originals\.mxf/ });
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  const search = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
  const query = "  cAmErA  ";
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(camera).toBeVisible();

  const attempts = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { name?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const names: Array<string | undefined> = [];
    bridge.invoke = (command, args) => {
      if (command === "switch_workspace") names.push(args.name);
      return invoke(command, args);
    };
    return names;
  });

  const workspace = page.getByRole("combobox", { name: "Workspace", exact: true });
  await workspace.focus();
  await workspace.selectOption(fieldWorkspace);
  const feedback = page.getByRole("alert").filter({ hasText: "Couldn’t switch to Field notes" });
  await expect(feedback.getByText("Couldn’t switch to Field notes", { exact: true })).toBeVisible();
  await expect(feedback.getByText("The workspace folder is unavailable. Reconnect its drive and try again.", { exact: true })).toBeVisible();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeHidden();
  await expect(workspace).toHaveValue(studioWorkspace);
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(sites(page)).toBeVisible();
  await expect(contents).toBeVisible();
  await expect(search).toHaveValue(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(camera).toBeVisible();
  expect(await attempts.jsonValue()).toEqual([fieldWorkspace]);

  await page.getByRole("button", { name: "Retry", exact: true }).press("Enter");
  await expect(workspace).toHaveValue(fieldWorkspace);
  await expect(page.getByRole("region", { name: "Circular storage map" })
    .getByText("No source selected", { exact: true })).toBeVisible();
  await expect(feedback).toBeHidden();
  await expect(settings).toBeHidden();
  await expect(workspace).toBeFocused();
  expect(await attempts.jsonValue()).toEqual([fieldWorkspace, fieldWorkspace]);
});

for (const entry of ["compact Sites", "desktop Actions"] as const) {
  test.describe(entry, () => {
    const compact = entry === "compact Sites";
    test.use({ viewport: compact ? { width: 390, height: 620 } : { width: 1100, height: 740 }, hasTouch: compact });

    test("Settings returns to its opener and a same-workspace rename preserves Atlas browsing", async ({ page }) => {
      await page.goto("/mock/?scenario=large");
      await openFolder(page, "Photo Library");
      await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
      await page.getByRole("button", { name: "Contents & details", exact: true }).click();

      const rail = sites(page);
      const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
      const entries = contents.getByRole("region", { name: "Directory entries", exact: true });
      const grid = entries.getByRole("grid");
      const proof = grid.getByRole("button", { name: /^Proof 095\.jpg/ });
      const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
      const query = "  pRoOf  ";
      await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
      await filter.fill(query);
      await expect(grid).toHaveAttribute("aria-rowcount", "96");
      await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
      await expect(proof).toBeInViewport();
      const scrollPosition = await contents.evaluate((pane) => pane.scrollTop);
      expect(scrollPosition).toBeGreaterThan(0);

      const previous = page.getByRole("navigation", { name: "Folder path" })
        .getByRole("button", { name: "Previous location", exact: true });
      const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const manageSite = (name: string) => rail.getByRole("button", { name: `Manage ${name}`, exact: true });

      async function openSettings() {
        if (compact) {
          await manageSite("Field drive").tap();
        } else {
          await actions.press("Enter");
          await page.getByRole("group", { name: "Workspace actions", exact: true })
            .getByRole("button", { name: "Settings", exact: true }).press("Enter");
          await settings.getByRole("button", { name: "Sites", exact: true }).press("Enter");
          await settings.getByRole("button", { name: /^Field drive/ }).press("Enter");
        }
        await expect(settings.getByRole("heading", { name: "Field drive", exact: true })).toBeVisible();
      }

      async function dismissSettings(site: string) {
        await page.keyboard.press("Escape");
        await expect(settings).toBeHidden();
        const opener = compact ? manageSite(site) : actions;
        await expect(opener).toBeFocused();
        await expect(opener).toBeInViewport({ ratio: 0.99 });
        await expect(currentFolder(page)).toHaveText("Photo Library");
        await expect(rail).toBeVisible();
        await expect(contents).toBeVisible();
        await expect(filter).toHaveValue(query);
        await expect(proof).toBeVisible();
        await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scrollPosition);
        await expect(previous).toBeEnabled();
      }

      await openSettings();
      await dismissSettings("Field drive");

      await openSettings();
      await settings.getByRole("textbox", { name: "Display name", exact: true }).fill("Field archive");
      await settings.getByRole("button", { name: "Save", exact: true }).press("Enter");
      await expect(settings.getByRole("heading", { name: "Field archive", exact: true })).toBeVisible();
      await dismissSettings("Field archive");
      await expect(rail.getByRole("button", { name: "Open Field archive in Atlas", exact: true })).toBeVisible();
      await expect(entries).not.toHaveAttribute("aria-busy", "true");

      await proof.press("ArrowDown");
      await expect(grid.getByRole("button", { name: /^Proof 096\.jpg/ })).toBeFocused();
      await previous.press("Enter");
      await expect(currentFolder(page)).toHaveText("Studio archive");
      await expect(rail).toBeVisible();
      await expect(contents).toBeVisible();
    });
  });
}

function holdAtlasRead(page: Page, command: "load_dashboard" | "get_storage_view_snapshot", folder?: string) {
  return page.evaluateHandle(({ command, folder }) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { held: false, replied: false, release };
    bridge.invoke = async (name, args) => {
      const response = await invoke(name, args);
      if (!state.held && name === command && (!folder || args.nodeId?.endsWith(`/${folder}`))) {
        state.held = true;
        await gate;
        state.replied = true;
      }
      return response;
    };
    return state;
  }, { command, folder });
}

test("Back keeps working while Atlas refreshes after a Settings edit", async ({ page }) => {
  await page.goto("/mock/");
  await openFolder(page, "Projects");
  await openFolder(page, "Brand campaign");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  await sites(page).getByRole("button", { name: "Manage Field drive", exact: true }).press("Enter");

  const refresh = await holdAtlasRead(page, "get_storage_view_snapshot", "Brand campaign");
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  try {
    await settings.getByRole("textbox", { name: "Display name", exact: true }).fill("Field archive");
    await settings.getByRole("button", { name: "Save", exact: true }).press("Enter");
    await expect.poll(() => refresh.evaluate((state) => state.held)).toBe(true);
    await settings.getByRole("button", { name: "Close settings", exact: true }).press("Enter");
    await expect(sites(page).getByRole("button", { name: "Manage Field archive", exact: true })).toBeFocused();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(currentFolder(page)).toHaveText("Projects");
  } finally {
    await refresh.evaluate((state) => state.release());
  }

  await expect.poll(() => refresh.evaluate((state) => state.replied)).toBe(true);
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(page.getByRole("tabpanel", { name: "Contents", exact: true })).toBeVisible();
});

test("closing Settings after unregistering its site focuses Workspace actions before Atlas refreshes", async ({ page }) => {
  await page.goto("/mock/");
  await openFolder(page, "Photo Library");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();
  const rail = sites(page);
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const opener = rail.getByRole("button", { name: "Manage Field drive", exact: true });
  const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
  await opener.press("Enter");

  const refresh = await holdAtlasRead(page, "load_dashboard");

  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  try {
    await settings.getByRole("button", { name: "Unregister", exact: true }).click();
    await settings.getByRole("button", { name: "Confirm unregister", exact: true }).click();
    await expect.poll(() => refresh.evaluate((state) => state.held)).toBe(true);
    await settings.getByRole("button", { name: "Close settings", exact: true }).press("Enter");
    await expect(settings).toBeHidden();
    await expect(opener).toBeVisible();
    await expect(actions).toBeFocused();
    await expect(actions).toBeInViewport({ ratio: 0.99 });
  } finally {
    await refresh.evaluate((state) => state.release());
  }

  await expect(opener).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(rail).toBeVisible();
  await expect(contents.getByRole("heading", { name: "Photo Library", exact: true })).toBeVisible();
  await expect(actions).toBeFocused();
});

test("compact history restores a filtered file inspection after leaving its folder or site", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto("/mock/?scenario=large");
  await openFolder(page, "Photo Library");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();

  const rail = sites(page);
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const proof = grid.getByRole("button", { name: /^Proof 096\.jpg/ });
  const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
  const heading = inspector.getByRole("heading", { name: "Proof 096.jpg", exact: true });
  const query = "  pRoOf  ";
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  await contents.getByRole("searchbox", { name: "Find in folder", exact: true }).fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(proof).toBeInViewport();
  const scrollPosition = await contents.evaluate((pane) => pane.scrollTop);
  expect(scrollPosition).toBeGreaterThan(0);
  await proof.press("Enter");
  await expect(back).toBeFocused();

  await page.keyboard.press("Alt+ArrowUp");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(contents.getByRole("heading", { name: "Studio archive", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(heading).toBeVisible();
  await expect(back).toBeFocused();
  await expect(back).toBeInViewport({ ratio: 0.99 });

  await back.press("Alt+ArrowUp");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const replay = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, release };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (!read.pending && command === "get_storage_view_snapshot" && args.nodeId === "site_folder:studio-archive:1") {
        read.pending = true;
        await gate;
      }
      return response;
    };
    return read;
  });
  const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
  try {
    await page.keyboard.press("Alt+ArrowLeft");
    await expect.poll(() => replay.evaluate((read) => read.pending)).toBe(true);
    await actions.focus();
  } finally {
    await replay.evaluate((read) => read.release());
  }
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(heading).toBeVisible();
  await expect(actions).toBeFocused();

  const field = rail.getByRole("button", { name: "Open Field drive in Atlas", exact: true });
  await field.press("Enter");
  await expect(currentFolder(page)).toHaveText("Field drive");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(heading).toBeVisible();
  await expect(field).toBeFocused();

  await back.press("ArrowLeft");
  await expect(contents.getByRole("searchbox", { name: "Find in folder", exact: true })).toHaveValue(query);
  await expect(proof).toBeFocused();
  await expect(proof).toBeInViewport();
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scrollPosition);
  await expect(rail).toBeVisible();
});

test("an older file inspection keeps its Contents filter after a newer folder search", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/mock/?scenario=large");
  await openFolder(page, "Photo Library");
  const launcher = page.getByRole("button", { name: "Contents & details", exact: true });
  await launcher.press("Enter");

  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const search = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
  const grid = contents.getByRole("grid");
  const entry = (rank: number) => grid.locator(`[aria-rowindex="${rank}"] [data-entry-id]`);
  const path = page.getByRole("navigation", { name: "Folder path" });
  const previous = path.getByRole("button", { name: "Previous location", exact: true });
  const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
  const query = "  HaRbOr SuRvEy  ";
  const newerQuery = "  Glasshouse  ";
  const scrollTop = () => contents.evaluate((pane) => pane.scrollTop);

  async function openFreshPhotoLibrary() {
    await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await openFolder(page, "Photo Library");
  }

  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "666");
  const height = await grid.evaluate((list) => Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
  await contents.evaluate((pane, top) => { pane.scrollTop = top; }, 436 * height);
  await expect(entry(440)).toBeInViewport({ ratio: 0.99 });
  const nextFileId = await entry(441).getAttribute("data-entry-id");
  const nextFileName = await entry(441).locator(".atlas-directory-identity > span").first().textContent();
  const savedScroll = await scrollTop();
  await entry(440).press("Enter");
  const original = inspector.getByRole("heading", { name: "Harbor survey 2431.jpg", exact: true });
  await expect(original).toBeVisible();

  await openFreshPhotoLibrary();
  await search.fill(newerQuery);
  await expect(entry(1)).toHaveAccessibleName(/^Glasshouse /);
  await previous.press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await previous.press("Enter");
  await expect(original).toBeVisible();
  await expect(inspector.getByText("Match 440 of 666", { exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Next file", exact: true }).press("Enter");
  await expect(inspector.getByRole("heading", { name: nextFileName!, exact: true })).toBeVisible();
  await expect(inspector.getByText("Match 441 of 666", { exact: true })).toBeVisible();
  await back.press("Enter");

  async function expectOriginalResults() {
    await expect(search).toHaveValue(query);
    await expect(entry(441)).toHaveAttribute("data-entry-id", nextFileId!);
    await expect(entry(441)).toBeFocused();
    await expect(entry(441)).toBeInViewport({ ratio: 0.99 });
    await expect.poll(scrollTop).toBe(savedScroll);
  }

  await expectOriginalResults();
  await inspector.getByRole("button", { name: "Close inspector", exact: true }).press("Enter");
  await expect(contents).toBeHidden();
  await launcher.press("Enter");
  await expectOriginalResults();

  await openFreshPhotoLibrary();
  await expect(search).toHaveValue(newerQuery);
  await expect(entry(1)).toHaveAccessibleName(/^Glasshouse /);
});

test("a missing folder falls back to the remembered site's root", async ({ page }) => {
  await seedLocation(page, "field-drive", "site_folder:field-drive:0/No longer indexed");
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(page.getByRole("button", { name: /^Field Drive,/ })).toBeVisible();
  await expectFreshHistory(page);
});

test("retrying an interrupted startup opens the remembered folder", async ({ page }) => {
  await seedLocation(page, "studio-archive", "site_folder:studio-archive:0", "recovery");
  await page.goto("/mock/?scenario=recovery");
  await expect(page.getByRole("alert")).toContainText("The inventory could not be read.");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
  await expectFreshHistory(page);
});

test("a missing site falls back to the first available site", async ({ page }) => {
  await seedLocation(page, "removed-site", "site:removed-site");
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expectFreshHistory(page);
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!) as {
    active_site_id: string | null;
    site_folders: { site_id: string; node_id: string }[];
  }, preferenceKey())).toEqual({
    active_site_id: "studio-archive",
    site_folders: [{ site_id: "studio-archive", node_id: "site:studio-archive" }],
  });
});

test("mock scenarios remember their own folders and Reset preserves the sort preference", async ({ page }) => {
  async function showSort() {
    await page.getByRole("button", { name: "Contents & details", exact: true }).click();
    await page.getByRole("tabpanel", { name: "Contents" }).getByRole("button", { name: "Sort contents" }).click();
  }

  await page.goto("/mock/");
  await openFolder(page, "Projects");
  await showSort();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.keyboard.press("Escape");
  await chooseScenario(page, "partial");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await openFolder(page, "Photo Library");

  await chooseScenario(page, "populated");
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await showSort();
  await expect(page.getByRole("radio", { name: "Name", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");

  await chooseScenario(page, "partial");
  await expect(currentFolder(page)).toHaveText("Photo Library");
});

test("Reset discards a folder read that finishes before the replacement document loads", async ({ page }) => {
  await page.goto("/mock/?scenario=populated");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const heldRead = await page.evaluateHandle(() => {
    const bridge = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, release };
    bridge.invoke = async (command, args) => {
      const response = await invoke(command, args);
      if (command === "get_storage_view_snapshot" && args.nodeId === "site_folder:studio-archive:0") {
        read.pending = true;
        await gate;
      }
      return response;
    };
    return read;
  });

  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect.poll(() => heldRead.evaluate((read) => read.pending)).toBe(true);

  let releaseDocument!: () => void;
  const pendingDocument = new Promise<void>((resolve) => { releaseDocument = resolve; });
  const resetUrl = (url: URL) => url.pathname === "/mock/" && url.searchParams.get("reset") === "1";
  await page.route(resetUrl, async (route) => {
    await pendingDocument;
    await route.continue();
  });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  try {
    const requested = page.waitForRequest((request) => resetUrl(new URL(request.url())));
    await Promise.all([
      requested,
      page.getByRole("button", { name: "Reset", exact: true }).click({ noWaitAfter: true }),
    ]);
    await heldRead.evaluate((read) => read.release());
    // The selectors wait for the pending document, so check the still-mounted page directly.
    await expect.poll(() => heldRead.evaluate(() =>
      document.querySelector('[aria-current="location"]')?.textContent)).toBe("Projects");
  } finally {
    releaseDocument();
  }

  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(page).toHaveURL(/\/mock\/\?scenario=populated$/);
});
