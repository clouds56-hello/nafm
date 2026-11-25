import { expect, test, type Page } from "@playwright/test";

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
