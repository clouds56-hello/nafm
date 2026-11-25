import { expect, test, type Page } from "@playwright/test";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator(".atlas-toolbar-current");
}

function coverage(page: Page) {
  return page.getByRole("region", { name: "Coverage comparison" });
}

function target(page: Page) {
  return coverage(page).getByRole("combobox", { name: "Comparison target" });
}

async function addSite(page: Page, name: string, path: string) {
  const dialog = page.getByRole("dialog", { name: "Add site", exact: true });
  await dialog.getByRole("textbox", { name: "Site name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(path);
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function showCoverage(page: Page) {
  const mapOptions = page.getByRole("button", { name: "Map options" });
  await mapOptions.click();
  await page.getByRole("button", { name: "Coverage", exact: true }).click();
  if ((await mapOptions.getAttribute("aria-expanded")) === "true") {
    await page.keyboard.press("Escape");
  }
  await expect(coverage(page)).toBeVisible();
}

async function openPartialCoverage(page: Page) {
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.goto("/mock/?scenario=partial");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await showCoverage(page);
}

test("changing the target keeps the folder, and Back restores the direction after a swap", async ({ page }) => {
  await page.goto("/mock/");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  const map = page.getByRole("figure");
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await showCoverage(page);

  await expect(coverage(page).getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("field-drive");
  await expect(map.locator(".radial-atlas__size")).toContainText("0/100");
  await target(page).selectOption("team-share");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(target(page)).toHaveValue("team-share");
  await expect(map.locator(".radial-atlas__size")).toContainText("89/100");
  await expect(coverage(page).getByText("Coverage ready", { exact: true })).toBeVisible();

  await coverage(page).getByRole("button", { name: "Swap source and target" }).click();
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(coverage(page).getByText("Team share", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("studio-archive");

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(coverage(page).getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveValue("team-share");
  await expect(map.locator(".radial-atlas__size")).toContainText("89/100");
});

for (const view of ["all entries", "filtered matches"] as const) {
  test(`changing Coverage target keeps the same Contents position with ${view}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/mock/?scenario=large");
    await page.getByRole("figure").getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    await showCoverage(page);
    await expect(target(page)).toHaveValue("field-drive");

    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const results = contents.getByRole("region", { name: "Directory entries" });
    const grid = contents.getByRole("grid");
    const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
    await sort.click();
    await page.getByRole("radio", { name: "Name", exact: true }).click();
    await page.getByRole("radio", { name: "Ascending", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(sort).toHaveAttribute("title", "Name, ascending");

    const search = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
      .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
    const query = "  hArBoR SuRvEy  ";
    const filtered = view === "filtered matches";
    if (filtered) {
      await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
      await search.fill(query);
    }
    const total = filtered ? "666" : "4096";
    const rank = filtered ? 440 : 1188;
    const row = grid.locator(`[aria-rowindex="${rank}"] [data-entry-id]`);
    await expect(grid).toHaveAttribute("aria-rowcount", total);
    await expect(results).not.toHaveAttribute("aria-busy", "true");
    const height = await grid.evaluate((list) => Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
    await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (rank - 4) * height);
    await expect(row).toBeInViewport({ ratio: 0.99 });
    const fileId = (await row.getAttribute("data-entry-id"))!;
    const scroll = await contents.evaluate((pane) => pane.scrollTop);
    expect(scroll).toBeGreaterThan(0);

    const replies = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { targetSiteId?: string }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const targets: string[] = [];
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        if (command === "get_storage_view_snapshot" && args.targetSiteId) targets.push(args.targetSiteId);
        return response;
      };
      return targets;
    });

    async function expectPosition(comparison: string) {
      await expect(target(page)).toHaveValue(comparison);
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await expect(sites).toBeVisible();
      await expect(results).not.toHaveAttribute("aria-busy", "true");
      await expect(sort).toHaveAttribute("title", "Name, ascending");
      await expect(grid).toHaveAttribute("aria-rowcount", total);
      if (filtered) await expect(search).toHaveValue(query);
      else await expect(search).toBeHidden();
      await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
      await expect(row).toHaveAttribute("data-entry-id", fileId);
      await expect(row).toBeInViewport({ ratio: 0.99 });
    }

    await target(page).selectOption("team-share");
    await expect.poll(() => replies.evaluate((targets) => targets.includes("team-share"))).toBe(true);
    await expectPosition("team-share");
    await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
    await expectPosition("field-drive");
    await folderPath(page).getByRole("button", { name: "Next location", exact: true }).press("Enter");
    await expectPosition("team-share");

    if (filtered) {
      const fileName = (await row.locator(".atlas-directory-identity > span").first().textContent())!;
      await row.press("Enter");
      const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
      const fileDetails = inspector.getByRole("heading", { name: fileName, exact: true });
      const back = inspector.getByRole("button", { name: "Back to Contents", exact: true });
      await expect(fileDetails).toBeVisible();
      await expect(back).toBeVisible();

      const before = await replies.evaluate((targets) => targets.length);
      await target(page).selectOption("field-drive");
      await expect.poll(() => replies.evaluate((targets, start) => targets.slice(start).includes("field-drive"), before)).toBe(true);
      await expect(target(page)).toHaveValue("field-drive");
      await expect(fileDetails).toBeVisible();
      await expect(back).toBeVisible();
      await back.press("Enter");
      await expectPosition("field-drive");
      await expect(row).toBeFocused();
    }
  });
}

for (const handoff of ["a Coverage target change", "a Sites round trip", "an inventory refresh"] as const) {
  test(`Show in Contents keeps its paused search and viewport through ${handoff}`, async ({ page }) => {
    const fromFinder = handoff !== "a Sites round trip";
    const changesTarget = handoff === "a Coverage target change";
    const fileName = fromFinder ? "Proof 096.jpg" : "Proof 001.jpg";
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto(fromFinder ? "/mock/?scenario=large" : "/mock/");
    const map = page.getByRole("figure");
    await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    if (!changesTarget) await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");

    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
    const grid = contents.getByRole("grid");
    const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true })
      .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
    const restoreSearch = contents.getByRole("button", { name: "Restore search", exact: true });
    const paused = contents.getByText("Search paused", { exact: true });
    const query = "  PrOoF 01  ";
    await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
    await filter.fill(query);
    await expect(grid).toHaveAttribute("aria-rowcount", "10");

    if (fromFinder) {
      await page.getByRole("button", { name: "Find files", exact: true }).click();
      const finder = page.getByRole("dialog", { name: "Find files", exact: true });
      await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("Proof 096");
      await finder.getByRole("button", { name: /^Proof 096\.jpg/ }).press("Enter");
      await expect(finder).toBeHidden();
    } else {
      await map.getByRole("button", { name: /^Proof 001\.jpg,/ }).press("Enter");
    }
    await expect(inspector.getByRole("heading", { name: fileName, exact: true })).toBeVisible();
    await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
    const revealed = grid.getByRole("button", { name: fromFinder ? /^Proof 096\.jpg/ : /^Proof 001\.jpg/ });
    const count = fromFinder ? "4096" : "100";
    await expect(paused).toBeVisible();
    await expect(grid).toHaveAttribute("aria-rowcount", count);
    await expect(revealed).toBeFocused();

    if (changesTarget) {
      await showCoverage(page);
      await expect(target(page)).toHaveAttribute("title", "Field drive");
    }
    const rank = fromFinder ? 1188 : 64;
    const height = await grid.evaluate((list) => Number.parseFloat(getComputedStyle(list).getPropertyValue("--directory-row-height")));
    await contents.evaluate((pane, top) => { pane.scrollTop = top; }, (rank - 4) * height);
    const row = grid.locator(`[aria-rowindex="${rank}"] [data-entry-id]`);
    await expect(row).toBeInViewport({ ratio: 0.99 });
    await expect(revealed).toHaveCount(0);
    const fileId = (await row.getAttribute("data-entry-id"))!;
    const comparisonRow = changesTarget ? await row.elementHandle() : null;
    const scroll = await contents.evaluate((pane) => pane.scrollTop);
    expect(scroll).toBeGreaterThan(0);

    async function expectPausedPosition() {
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await expect(paused).toBeVisible();
      await expect(filter).toBeHidden();
      await expect(grid).toHaveAttribute("aria-rowcount", count);
      await expect(row).toHaveAttribute("data-entry-id", fileId);
      await expect(row).toBeInViewport({ ratio: 0.99 });
      await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
      if (comparisonRow) expect(await row.evaluate((current, initial) => current === initial, comparisonRow)).toBe(true);
    }

    if (changesTarget) {
      await target(page).selectOption("team-share");
      await expect(target(page)).toHaveAttribute("title", "Team share");
      await expect(target(page)).toHaveValue("team-share");
      await expect(coverage(page).getByText("Studio archive", { exact: true })).toBeVisible();
      await expectPausedPosition();

      await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
      await expect(target(page)).toHaveAttribute("title", "Field drive");
      await expectPausedPosition();
      await folderPath(page).getByRole("button", { name: "Next location", exact: true }).press("Enter");
      await expect(target(page)).toHaveAttribute("title", "Team share");
    } else if (handoff === "a Sites round trip") {
      const sites = page.getByRole("complementary", { name: "Sites", exact: true });
      const field = sites.getByRole("button", { name: "Open Field drive in Atlas", exact: true });
      const studio = sites.getByRole("button", { name: "Open Studio archive in Atlas", exact: true });
      await field.press("Enter");
      await expect(currentFolder(page)).toHaveText("Field drive");
      await expect(field).toHaveAttribute("aria-current", "true");
      await studio.press("Enter");
      await expect(studio).toHaveAttribute("aria-current", "true");
      await expect(studio).toBeFocused();
    } else {
      const scan = await page.evaluateHandle(() => {
        const { __TAURI_INTERNALS__: bridge } = window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
        };
        const invoke = bridge.invoke.bind(bridge);
        let publish!: () => void;
        const publication = new Promise<void>((resolve) => { publish = resolve; });
        const state = { publish, published: false, refreshed: false };
        bridge.invoke = async (command, args) => {
          if (command === "plugin:event|emit" && args.event === "task://scan/events") {
            const event = args.payload as { site_id: string | null; kind: string; phase: string | null };
            if (event.site_id === "studio-archive" && event.kind === "progress"
              && (event.phase === "hashing" || event.phase === "finalizing")) {
              await publication;
              state.published = true;
            }
          }
          const response = await invoke(command, args);
          if (state.published && command === "get_storage_view_snapshot" && args.nodeId === "site_folder:studio-archive:1") {
            requestAnimationFrame(() => requestAnimationFrame(() => { state.refreshed = true; }));
          }
          return response;
        };
        return state;
      });
      const results = contents.getByRole("region", { name: "Directory entries" });
      await expect(results).not.toHaveAttribute("aria-busy", "true");
      const sites = page.getByRole("complementary", { name: "Sites", exact: true });
      await sites.getByRole("button", { name: "Scan Studio archive", exact: true }).click();
      try {
        await row.evaluate((element) => element.focus({ preventScroll: true }));
        await expect(row).toBeFocused();
        await scan.evaluate((state) => state.publish());
        await expect.poll(() => scan.evaluate((state) => state.refreshed), { timeout: 15_000 }).toBe(true);
        await expectPausedPosition();
        await expect(row).toBeFocused();
      } finally {
        await scan.evaluate((state) => state.publish());
      }
    }

    await expectPausedPosition();
    await restoreSearch.press("Enter");
    await expect(paused).toBeHidden();
    await expect(filter).toHaveValue(query);
    await expect(filter).toBeFocused();
    await expect(grid).toHaveAttribute("aria-rowcount", "10");
    await expect(grid.getByRole("button", { name: /^Proof 010\.jpg/ })).toBeVisible();
  });
}

test("a pending target reports estimated coverage and can finish verification", async ({ page }) => {
  await page.goto("/mock/?scenario=partial");
  await showCoverage(page);
  await target(page).selectOption("team-share");
  await expect(target(page)).toHaveValue("team-share");
  await coverage(page).getByRole("button", { name: "Swap source and target" }).click();
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(target(page)).toHaveValue("studio-archive");
  await expect(coverage(page).getByText("Estimated coverage", { exact: true })).toBeVisible();
  await expect(target(page)).toHaveAccessibleDescription("39 hashes pending");
  await expect(page.getByRole("figure").locator(".radial-atlas__size")).toContainText("≈");
  await expect(page.getByRole("figure").locator(".radial-atlas__detail")).toHaveText("Verified content only");

  const resume = coverage(page).getByRole("button", { name: "Resume target scan", exact: true });
  await resume.click();
  await expect(resume).toBeHidden();
  await expect(coverage(page).getByText("Coverage ready", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("figure").locator(".radial-atlas__size")).not.toContainText("≈");
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(target(page)).toHaveValue("studio-archive");
});

test("source verification updates coverage without changing the comparison or folder history", async ({ page }) => {
  await openPartialCoverage(page);
  await target(page).selectOption("team-share");
  await expect(target(page)).toHaveValue("team-share");
  const map = page.getByRole("figure");
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await map.getByRole("button", { name: /^Brand campaign,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Brand campaign");

  const comparison = coverage(page);
  await expect(comparison.getByText("Estimated coverage", { exact: true })).toBeVisible();
  await expect(map.locator(".radial-atlas__size")).toContainText("≈");
  await comparison.getByRole("button", { name: "Resume source scan", exact: true }).press("Enter");
  await expect(comparison.getByRole("button", { name: "Scanning source…", exact: true })).toBeDisabled();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(target(page)).toHaveValue("team-share");

  await page.clock.runFor(5_700);
  await expect(comparison.getByText("Coverage ready", { exact: true })).toBeVisible();
  await expect(map.locator(".radial-atlas__size")).toHaveText("89/100");
  await expect(comparison.getByText("Studio archive", { exact: true })).toBeVisible();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(target(page)).toHaveValue("team-share");
  await expect(target(page)).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(target(page)).toHaveValue("team-share");
});

test("a workspace with one site can add a comparison target from Coverage", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  const addDialog = page.getByRole("dialog", { name: "Add site", exact: true });
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await addSite(page, "First archive", "/demo/Archive");
  await expect(currentFolder(page)).toHaveText("First archive");

  await showCoverage(page);
  await expect(coverage(page).getByText("Coverage unavailable", { exact: true })).toBeVisible();
  const addTarget = coverage(page).getByRole("button", { name: /Add (another )?site/ });
  await addTarget.click();
  await expect(addDialog).toBeVisible();
  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(addTarget).toBeFocused();

  await addTarget.press("Enter");
  await addSite(page, "Backup archive", "/demo/Backup");
  await expect(target(page).locator("option:checked")).toHaveText("Backup archive");
  await expect(target(page)).toBeFocused();
  await expect(currentFolder(page)).toHaveText("First archive");
});

test("adding the first comparison target does not interrupt a newer folder drill", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  await addSite(page, "First archive", "/demo/Archive");
  await page.getByRole("button", { name: "Scan this site", exact: true }).press("Enter");
  const folder = page.getByRole("figure").getByRole("button", { name: /^Drone imagery,/ });
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await showCoverage(page);
  await coverage(page).getByRole("button", { name: "Add site", exact: true }).click();

  const reads = await page.evaluateHandle((folderId) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    const held = { dashboard: false, folder: false };
    let releaseDashboard = () => {};
    let releaseFolder = () => {};
    const dashboardGate = new Promise<void>((resolve) => { releaseDashboard = resolve; });
    const folderGate = new Promise<void>((resolve) => { releaseFolder = resolve; });
    bridge.invoke = async (command, args) => {
      if (command === "load_dashboard" && !held.dashboard) {
        held.dashboard = true;
        await dashboardGate;
      }
      if (command === "get_storage_view_snapshot" && args.nodeId === folderId) {
        held.folder = true;
        await folderGate;
      }
      return invoke(command, args);
    };
    return { held, releaseDashboard, releaseFolder };
  }, await folder.getAttribute("data-node-id"));

  await addSite(page, "Backup archive", "/demo/Backup");
  await expect.poll(() => reads.evaluate(({ held }) => held.dashboard)).toBe(true);
  await folder.press("Enter");
  await expect.poll(() => reads.evaluate(({ held }) => held.folder)).toBe(true);
  await reads.evaluate(({ releaseDashboard }) => releaseDashboard());
  await expect(target(page).getByRole("option", { name: "Backup archive" })).toHaveCount(1);
  await expect(target(page)).not.toBeFocused();
  await reads.evaluate(({ releaseFolder }) => releaseFolder());
  await expect(currentFolder(page)).toHaveText("Drone imagery");
});

test.describe("compact Coverage options", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  async function coverWithPanels(page: Page) {
    await openPartialCoverage(page);
    await page.getByRole("figure").getByRole("button", { name: /^Projects,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    await expect(sites).toBeVisible();
    await expect(contents).toBeVisible();
    return { sites, contents };
  }

  async function holdComparisons(page: Page, pairs: string[]) {
    return page.evaluateHandle((pairs) => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { siteId?: string; targetSiteId?: string }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const calls: string[] = [];
      const released: string[] = [];
      const gates = new Map(pairs.map((pair) => {
        let release = () => {};
        const reply = new Promise<void>((resolve) => { release = resolve; });
        return [pair, { release, reply }] as const;
      }));
      bridge.invoke = async (command, args) => {
        const response = await invoke(command, args);
        const pair = `${args?.siteId}:${args?.targetSiteId}`;
        const gate = command === "get_storage_view_snapshot" ? gates.get(pair) : undefined;
        if (gate) {
          calls.push(pair);
          await gate.reply;
          released.push(pair);
        }
        return response;
      };
      return { calls, released, release: (pair: string) => gates.get(pair)?.release() };
    }, pairs);
  }

  test("a pending target keeps picker focus and Escape closes only Map options", async ({ page }) => {
    const { sites, contents } = await coverWithPanels(page);
    await contents.locator('[aria-rowindex="1"] [data-entry-id]').press("Home");
    const preview = page.getByRole("tooltip");
    await expect(preview).toBeVisible();
    await sites.getByRole("button", { name: "Add site", exact: true }).tap({ timeout: 2_000 });
    await expect(preview).toBeHidden();
    await addSite(page, "Backup archive", "/demo/Backup");

    const trigger = page.getByRole("button", { name: "Map options", exact: true });
    await trigger.press("Enter");
    const options = page.getByRole("group", { name: "Map options", exact: true });
    const picker = options.getByRole("combobox", { name: "Compare with", exact: true });
    const backupId = (await picker.getByRole("option", { name: "Backup archive", exact: true }).getAttribute("value"))!;
    const team = "studio-archive:team-share";
    const backup = `studio-archive:${backupId}`;
    const reads = await holdComparisons(page, [team, backup]);

    await picker.focus();
    await picker.selectOption("team-share");
    await expect.poll(() => reads.evaluate(({ calls }) => calls)).toEqual([team]);
    await expect(picker).toBeFocused();
    await expect(picker).toBeEnabled();
    await expect(picker).toHaveValue("field-drive");
    await expect(target(page)).toHaveValue("field-drive");
    await expect(options.getByText("Comparing with Team share…", { exact: true })).toBeVisible();
    await expect(coverage(page).getByRole("status")).toHaveText("Comparing with Team share…");

    await picker.selectOption(backupId);
    await expect.poll(() => reads.evaluate(({ calls }) => calls)).toEqual([team, backup]);
    await reads.evaluate(({ release }, pair) => release(pair), team);
    await expect.poll(() => reads.evaluate(({ released }) => released)).toEqual([team]);
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue("field-drive");
    await expect(options.getByText("Comparing with Backup archive…", { exact: true })).toBeVisible();
    await expect(coverage(page).getByRole("status")).toHaveText("Comparing with Backup archive…");

    await page.keyboard.press("Escape");
    await expect(options).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(sites).toBeVisible();
    await expect(contents).toBeVisible();
    await reads.evaluate(({ release }, pair) => release(pair), backup);
    await expect(target(page)).toHaveValue(backupId);
    await expect(coverage(page).getByRole("status")).toContainText("Coverage unavailable");
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(trigger).toBeFocused();
    await expect(sites).toBeVisible();
    await expect(contents).toBeVisible();
  });

  test("a pending swap retains focus while the confirmed comparison stays visible", async ({ page }) => {
    const { sites, contents } = await coverWithPanels(page);
    const trigger = page.getByRole("button", { name: "Map options", exact: true });
    await trigger.press("Enter");
    const options = page.getByRole("group", { name: "Map options", exact: true });
    const swap = options.getByRole("button", { name: "Swap source and target", exact: true });
    const swapped = "field-drive:studio-archive";
    const reads = await holdComparisons(page, [swapped]);

    await swap.press("Enter");
    await expect.poll(() => reads.evaluate(({ calls }) => calls)).toEqual([swapped]);
    await expect(swap).toBeDisabled();
    await expect(swap).toBeFocused();
    await expect(target(page)).toHaveValue("field-drive");
    await expect(options.getByText("Opening Field drive…", { exact: true })).toBeVisible();
    await expect(coverage(page).getByRole("status")).toHaveText("Opening Field drive…");
    await page.keyboard.press("Enter");
    await reads.evaluate(({ release }, pair) => release(pair), swapped);
    await expect(currentFolder(page)).toHaveText("Field drive");
    await expect(target(page)).toHaveValue("studio-archive");
    await expect(swap).toBeEnabled();
    await expect(swap).toBeFocused();
    expect(await reads.evaluate(({ calls }) => calls)).toEqual([swapped]);

    await page.keyboard.press("Escape");
    await expect(options).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(sites).toBeVisible();
    await expect(contents).toBeVisible();
  });

  test("Map options can verify both sites independently without leaving the comparison", async ({ page }) => {
    await openPartialCoverage(page);
    const map = page.getByRole("figure");
    await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");
    await page.getByRole("button", { name: "Sites", exact: true }).tap();
    const sites = page.getByRole("complementary", { name: "Sites" });
    await sites.getByRole("button", { name: "Add site", exact: true }).tap();
    await addSite(page, "Backup archive", "/demo/Backup");
    await sites.getByRole("button", { name: "Open Backup archive in Atlas", exact: true }).waitFor();
    await sites.getByRole("button", { name: "Close sites", exact: true }).tap();

    const optionsButton = page.getByRole("button", { name: "Map options", exact: true });
    await optionsButton.tap();
    const mapOptions = page.getByRole("group", { name: "Map options", exact: true });
    const picker = mapOptions.getByRole("combobox", { name: "Compare with" });
    await picker.selectOption({ label: "Backup archive" });
    await expect(target(page).locator("option:checked")).toHaveText("Backup archive");
    await expect(coverage(page).getByText("Coverage unavailable", { exact: true })).toBeVisible();
    await expect(coverage(page).getByText("Both sites need verification.", { exact: true })).toBeVisible();

    const resumeSource = mapOptions.getByRole("button", { name: "Resume source scan", exact: true });
    const scanTarget = mapOptions.getByRole("button", { name: "Scan target", exact: true });
    await expect(resumeSource).toBeInViewport();
    await expect(scanTarget).toBeInViewport();
    await scanTarget.tap();
    await expect(mapOptions.getByRole("button", { name: "Scanning target…", exact: true })).toBeDisabled();
    await expect(resumeSource).toBeEnabled();
    await resumeSource.tap();
    await expect(mapOptions.getByRole("button", { name: "Scanning source…", exact: true })).toBeDisabled();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(picker.locator("option:checked")).toHaveText("Backup archive");

    await page.clock.runFor(5_700);
    await expect(coverage(page).getByText("Coverage ready", { exact: true })).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(target(page).locator("option:checked")).toHaveText("Backup archive");
  });

  test("Map options still changes the target while Contents is open", async ({ page }) => {
    await page.goto("/mock/");
    await showCoverage(page);
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const contents = page.getByRole("tabpanel", { name: "Contents" });
    await expect(contents).toBeVisible();

    await page.getByRole("button", { name: "Map options" }).tap();
    const mapOptions = page.getByRole("group", { name: "Map options", exact: true });
    const picker = mapOptions.getByRole("combobox", { name: "Compare with" });
    await expect(picker).toBeInViewport();
    await picker.selectOption("team-share");
    await expect(picker).toHaveValue("team-share");
    await page.keyboard.press("Escape");
    await expect(mapOptions).toBeHidden();
    await expect(contents).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(target(page)).toHaveValue("team-share");
  });
});
