import { expect, test, type Page } from "@playwright/test";
import type { StorageViewSnapshot } from "../src/lib/types";

const readError = "The inventory could not be read.";
const projectsFailure = /Couldn[’']t open Projects/;
const teamFailure = /Couldn[’']t open Team share/;

function atlas(page: Page) {
  return page.getByRole("region", { name: "Circular storage map" });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

function back(page: Page) {
  return page.getByRole("button", { name: "Previous location", exact: true });
}

function holdFolderReply(page: Page, folder: string) {
  return page.evaluateHandle((name) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { pending: false, replied: false, release };
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "get_storage_view_snapshot" && !state.pending
        && (result as StorageViewSnapshot).location.root.name === name) {
        state.pending = true;
        await gate;
        state.replied = true;
      }
      return result;
    };
    return state;
  }, folder);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/?scenario=recovery");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

for (const action of ["Cancel opening", "Previous location"] as const) {
  test(`${action} supersedes a held folder read without losing filtered Contents`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto("/mock/?scenario=large");
    const map = atlas(page);
    await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const search = contents.getByLabel("Find in folder", { exact: true });
    const grid = contents.getByRole("grid");
    const row = (rank: number) => grid.locator(`[aria-rowindex="${rank}"] [data-entry-id]`);
    const query = "  HaRbOr SuRvEy  ";
    await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
    await search.fill(query);
    await expect(grid).toHaveAttribute("aria-rowcount", "666");
    const height = await grid.evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue("--directory-row-height")));
    await contents.evaluate((pane, top) => { pane.scrollTop = top; }, 436 * height);
    await expect(row(440)).toBeInViewport({ ratio: 0.99 });
    const scroll = await contents.evaluate((pane) => pane.scrollTop);
    const hold = await holdFolderReply(page, "Reference images");
    try {
      await map.getByRole("button", { name: /^Reference images,/ }).press("Enter");
      await expect.poll(() => hold.evaluate((state) => state.pending)).toBe(true);
      await expect(map.getByRole("status").filter({ hasText: "Opening Reference images…" })).toBeVisible();
      await expect(currentFolder(page)).toHaveText("Photo Library");
      await row(440).press("ArrowDown");
      await expect(row(441)).toBeFocused();

      if (action === "Cancel opening") {
        await map.getByRole("button", { name: action, exact: true }).click();
        await expect(row(441)).toBeFocused();
      } else {
        await expect(back(page)).toBeEnabled();
        await back(page).press("Enter");
        await expect(currentFolder(page)).toHaveText("Studio archive");
      }
    } finally {
      await hold.evaluate((state) => state.release());
    }
    await expect.poll(() => hold.evaluate((state) => state.replied)).toBe(true);
    await expect(map.getByRole("button", { name: "Cancel opening", exact: true })).toBeHidden();

    const next = page.getByRole("button", { name: "Next location", exact: true });
    if (action === "Previous location") {
      await expect(currentFolder(page)).toHaveText("Studio archive");
      await next.press("Enter");
    }
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(next).toBeDisabled();
    await expect(search).toHaveValue(query);
    await expect(row(441)).toBeInViewport({ ratio: 0.99 });
    await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBe(scroll);
  });
}

for (const source of ["Contents", "Atlas"] as const) {
  test(`compact ${source} shows Cancel opening on the initiating surface`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 620 });
    await page.goto("/mock/");
    const map = atlas(page);
    await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const surface = source === "Contents" ? contents : map;
    const folder = surface.getByRole("button", { name: source === "Contents" ? /^Brand campaign / : /^Brand campaign,/ });
    const hold = await holdFolderReply(page, "Brand campaign");
    try {
      await folder.scrollIntoViewIfNeeded();
      await folder.press("Enter");
      await expect.poll(() => hold.evaluate((state) => state.pending)).toBe(true);
      const status = surface.getByRole("status").filter({ hasText: "Opening Brand campaign…" });
      const cancel = surface.getByRole("button", { name: "Cancel opening", exact: true });
      await expect(status).toBeVisible();
      await expect(cancel).toBeInViewport({ ratio: 0.99 });
      await expect(page.getByRole("button", { name: "Cancel opening", exact: true })).toHaveCount(1);
      await cancel.press("Enter");
      await expect(folder).toBeFocused();
    } finally {
      await hold.evaluate((state) => state.release());
    }
    await expect.poll(() => hold.evaluate((state) => state.replied)).toBe(true);
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(surface.getByRole("button", { name: "Cancel opening", exact: true })).toBeHidden();
    await expect(folder).toBeFocused();
    await expect(folder).toBeInViewport({ ratio: 0.99 });
    await expect(contents).toBeVisible();
  });
}

test("retry opens the failed folder without adding a failed visit to Atlas history", async ({ page }) => {
  const map = atlas(page);
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");

  const failure = map.getByRole("alert").filter({ hasText: projectsFailure });
  await expect(failure).toContainText(readError);
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back(page)).toBeDisabled();
  await expect(map.getByRole("button", { name: /^Photo Library,/ })).toBeVisible();

  await map.getByRole("button", { name: "Retry", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await expect(failure).toBeHidden();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeFocused();
  await back(page).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back(page)).toBeDisabled();
});

test("retrying a failed source switch opens the intended site and closes Sources", async ({ page }) => {
  const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
  await actions.click();
  await page.getByRole("button", { name: /^Sources\b/ }).click();
  const sources = page.getByRole("dialog", { name: "Sources", exact: true });
  const team = sources.getByRole("button", { name: "Open Team share in Atlas", exact: true });
  await team.click();

  const failure = sources.getByRole("alert").filter({ hasText: teamFailure });
  await expect(failure).toContainText(readError);
  await expect(team).toBeEnabled();
  await expect(sources.getByRole("status", { name: "Opening Team share in Atlas…", exact: true })).toHaveCount(0);
  await expect(sources.getByRole("button", { name: "Open Studio archive in Atlas", exact: true }))
    .toHaveAttribute("aria-current", "true");

  await sources.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(sources).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Team share");
  await expect(actions).toBeFocused();
  await back(page).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back(page)).toBeDisabled();
});

test.describe("compact persistent Sites", () => {
  test.use({ viewport: { width: 390, height: 480 }, hasTouch: true });

  async function openPanels(page: Page) {
    await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    const rail = page.getByRole("complementary", { name: "Sites", exact: true });
    const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
    const studio = rail.getByRole("button", { name: "Open Studio archive in Atlas", exact: true });
    const team = rail.getByRole("button", { name: "Open Team share in Atlas", exact: true });
    await expect(studio).toBeFocused();
    await page.keyboard.press("End");
    await expect(team).toBeFocused();
    await expect(team).toBeInViewport({ ratio: 0.99 });
    return { rail, contents, studio, team };
  }

  for (const input of ["keyboard", "touch"] as const) {
    test(`site switch recovery stays in its row for ${input}`, async ({ page }) => {
      const { rail, contents, studio, team } = await openPanels(page);
      if (input === "keyboard") await page.keyboard.press("Enter");
      else await team.tap();

      const failedSite = rail.getByRole("listitem").filter({
        has: page.getByRole("button", { name: "Open Team share in Atlas", exact: true }),
      });
      const error = failedSite.getByRole("alert").filter({ hasText: teamFailure });
      const retry = failedSite.getByRole("button", { name: "Retry", exact: true });
      await expect(error).toContainText(readError);
      await expect(retry).toBeFocused();
      await expect(retry).toBeInViewport({ ratio: 0.99 });
      await expect(studio).toHaveAttribute("aria-current", "true");
      await expect(contents.getByRole("heading", { name: "Studio archive", exact: true })).toBeVisible();

      if (input === "keyboard") {
        await page.keyboard.press("Enter");
        await expect(currentFolder(page)).toHaveText("Team share");
        await expect(team).toHaveAttribute("aria-current", "true");
        await expect(contents.getByRole("heading", { name: "Team share", exact: true })).toBeVisible();
      } else {
        await failedSite.getByRole("button", { name: "Dismiss", exact: true }).tap();
        await expect(currentFolder(page)).toHaveText("Studio archive");
        await expect(studio).toHaveAttribute("aria-current", "true");
      }
      await expect(error).toBeHidden();
      await expect(team).toBeFocused();
      await expect(team).toBeInViewport({ ratio: 0.99 });
      await expect(rail).toBeVisible();
      await expect(contents).toBeVisible();
      await page.keyboard.press("ArrowUp");
      await expect(rail.getByRole("button", { name: "Open Field drive in Atlas", exact: true })).toBeFocused();
    });
  }

  test("a held site switch failure preserves a newer Contents focus", async ({ page }) => {
    const { rail, contents, studio } = await openPanels(page);
    const failure = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { siteId?: string }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { pending: false, release };
      bridge.invoke = async (command, args) => {
        try {
          return await invoke(command, args);
        } catch (error) {
          if (command === "get_storage_view_snapshot" && args.siteId === "team-share") {
            state.pending = true;
            await gate;
          }
          throw error;
        }
      };
      return state;
    });
    const row = contents.getByRole("button", { name: /^Photo Library/ });
    try {
      await page.keyboard.press("Enter");
      await expect.poll(() => failure.evaluate((state) => state.pending)).toBe(true);
      await row.scrollIntoViewIfNeeded();
      await row.focus();
      await expect(row).toBeFocused();
      await expect(row).toBeInViewport({ ratio: 0.99 });
    } finally {
      await failure.evaluate((state) => state.release());
    }
    await expect(rail.getByRole("alert").filter({ hasText: teamFailure })).toContainText(readError);
    await expect(studio).toHaveAttribute("aria-current", "true");
    await expect(row).toBeFocused();
    await expect(row).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press("ArrowDown");
    await expect(contents.locator('[aria-rowindex="3"] [data-entry-id]')).toBeFocused();
  });
});

test("compact Sources returns focus to Workspace actions and preserves the Contents viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 620 });
  await page.goto("/mock/");
  await atlas(page).getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");

  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const january = contents.getByRole("button", { name: /^2024 January/ });
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(january).toBeInViewport();
  const scrollTop = await contents.evaluate((pane) => pane.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
  const sources = page.getByRole("dialog", { name: "Sources", exact: true });

  await actions.press("Enter");
  await page.getByRole("button", { name: /^Sources\b/ }).press("Enter");
  await expect(sources.getByRole("heading", { name: "Sources", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sources).toBeHidden();
  await expect(actions).toBeFocused();
  await expect(actions).toBeInViewport({ ratio: 0.99 });
  await expect(sites).toBeVisible();
  await expect(january).toBeInViewport();
  expect(await contents.evaluate((pane) => pane.scrollTop)).toBe(scrollTop);

  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /^Sources\b/ }).press("Enter");
  await sources.getByRole("button", { name: "Open Field drive in Atlas", exact: true }).press("Enter");
  await expect(sources).toBeHidden();
  await expect(actions).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Field drive");
  await expect(sites).toBeVisible();
  await expect(contents).toBeVisible();
});

test.describe("starting a scan from a compact source row", () => {
  test.use({ viewport: { width: 390, height: 480 }, hasTouch: true });

  for (const surface of ["Sites", "Sources"] as const) {
    test(`${surface} shows a pending scan on its own row without starting it twice`, async ({ page }) => {
      await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
      await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
      const rail = page.getByRole("complementary", { name: "Sites", exact: true });
      const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
      if (surface === "Sources") {
        await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
        await page.getByRole("button", { name: /^Sources\b/ }).press("Enter");
      }
      const chooser = surface === "Sites" ? rail : page.getByRole("dialog", { name: "Sources", exact: true });
      const scan = chooser.getByRole("button", { name: "Scan Field drive", exact: true });
      const otherScan = chooser.getByRole("button", { name: "Scan Studio archive", exact: true });
      const row = chooser.getByRole("listitem").filter({
        has: page.getByRole("button", { name: "Open Field drive in Atlas", exact: true }),
      });
      const starting = row.getByText("Starting scan…", { exact: true });

      const request = await page.evaluateHandle(() => {
        const { __TAURI_INTERNALS__: bridge } = window as unknown as {
          __TAURI_INTERNALS__: { invoke: (command: string, args: { selector?: { site_id?: string } }) => Promise<unknown> };
        };
        const invoke = bridge.invoke.bind(bridge);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const state = { calls: 0, pending: false, release };
        bridge.invoke = async (command, args) => {
          if (command !== "start_scan" || args.selector?.site_id !== "field-drive") return invoke(command, args);
          state.calls += 1;
          const reply = await invoke(command, args);
          state.pending = true;
          await gate;
          return reply;
        };
        return state;
      });
      try {
        if (surface === "Sites") await scan.press("Enter");
        else await scan.tap();
        await expect.poll(() => request.evaluate((state) => state.pending)).toBe(true);
        await expect(starting).toBeInViewport();
        await expect(scan).toBeInViewport();
        await expect(scan).toBeDisabled();
        await expect(scan).toBeFocused();
        await expect(scan).toHaveAttribute("aria-busy", "true");
        await expect(otherScan).toBeEnabled();

        if (surface === "Sites") await page.keyboard.press("Enter");
        else {
          // Send the tap even though the control is marked aria-disabled.
          const bounds = (await scan.boundingBox())!;
          await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        }
        expect(await request.evaluate((state) => state.calls)).toBe(1);
        await expect(scan).toBeFocused();
      } finally {
        await request.evaluate((state) => state.release());
      }
      const stop = chooser.getByRole("button", { name: "Stop scan of Field drive", exact: true });
      await expect(stop).toBeEnabled();
      await expect(stop).toBeFocused();
      await expect(starting).toBeHidden();
      await expect(currentFolder(page)).toHaveText("Studio archive");
      if (surface === "Sources") await page.keyboard.press("Escape");
      await expect(rail).toBeVisible();
      await expect(contents).toBeVisible();
      await expect(page.getByText("A scan is already running for this selection.")).toBeHidden();
    });
  }
});

for (const surface of ["Sites", "Sources"] as const) {
  test(`${surface} shows which site is opening and lets another site supersede it`, async ({ page }) => {
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    if (surface === "Sites") {
      await page.getByRole("button", { name: "Sites", exact: true }).press("Enter");
    } else {
      await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
      await page.getByRole("button", { name: /^Sources\b/ }).press("Enter");
    }
    const chooser = page.getByRole(surface === "Sites" ? "complementary" : "dialog", { name: surface, exact: true });
    const studio = chooser.getByRole("button", { name: "Open Studio archive in Atlas", exact: true });
    const field = chooser.getByRole("button", { name: "Open Field drive in Atlas", exact: true });
    const team = chooser.getByRole("button", { name: "Open Team share in Atlas", exact: true });
    const openingField = chooser.getByRole("status", { name: "Opening Field drive in Atlas…", exact: true });
    const openingTeam = chooser.getByRole("status", { name: "Opening Team share in Atlas…", exact: true });

    const reads = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: { siteId?: string }) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const attempts = ["field-drive", "team-share"].map((site_id) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        return { site_id, count: 0, pending: false, replied: false, gate, release };
      });
      bridge.invoke = async (command, args) => {
        const attempt = command === "get_storage_view_snapshot" ? attempts.find(({ site_id }) => site_id === args.siteId) : undefined;
        if (!attempt) return invoke(command, args);
        attempt.count += 1;
        const response = await invoke(command, args);
        attempt.pending = true;
        await attempt.gate;
        requestAnimationFrame(() => requestAnimationFrame(() => { attempt.replied = true; }));
        return response;
      };
      return attempts;
    });

    try {
      await field.press("Enter");
      await expect(openingField).toHaveText("Opening in Atlas…");
      await expect(field).toBeDisabled();
      await expect(field).toHaveAttribute("aria-busy", "true");
      await expect(field).toBeFocused();
      await expect(studio).toHaveAttribute("aria-current", "true");
      await expect(chooser.getByRole("listitem").filter({ hasText: "Field drive" }).getByText("Indexed", { exact: true })).toBeVisible();
      await expect.poll(() => reads.evaluate(([field]) => field.pending)).toBe(true);
      await field.press("Enter");
      expect(await reads.evaluate(([field]) => field.count)).toBe(1);

      await team.press("Enter");
      await expect(openingField).toHaveCount(0);
      await expect(field).toBeEnabled();
      await expect(openingTeam).toHaveText("Opening in Atlas…");
      await expect(team).toBeDisabled();
      await expect(team).toBeFocused();
      await expect(studio).toHaveAttribute("aria-current", "true");
      await expect.poll(() => reads.evaluate(([, team]) => team.pending)).toBe(true);
      if (surface === "Sites") {
        await reads.evaluate(([field]) => field.release());
        await expect.poll(() => reads.evaluate(([field]) => field.replied)).toBe(true);
        await expect(openingTeam).toHaveText("Opening in Atlas…");
        await expect(team).toBeDisabled();
        await expect(studio).toHaveAttribute("aria-current", "true");
      }
      await reads.evaluate(([, team]) => team.release());
      await expect(currentFolder(page)).toHaveText("Team share");
      if (surface === "Sites") {
        await expect(team).toHaveAttribute("aria-current", "true");
        await expect(team).toBeEnabled();
        await expect(team).toBeFocused();
        await expect(openingTeam).toHaveCount(0);
      } else {
        await expect(chooser).toBeHidden();
      }
    } finally {
      await reads.evaluate((attempts) => attempts.forEach(({ release }) => release()));
    }

    await expect.poll(() => reads.evaluate((attempts) => attempts.every(({ replied }) => replied))).toBe(true);
    await expect(currentFolder(page)).toHaveText("Team share");
    expect(await reads.evaluate((attempts) => attempts.map(({ count }) => count))).toEqual([1, 1]);
    await back(page).press("Enter");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(back(page)).toBeDisabled();
  });
}

test("retrying a failed Previous location read preserves the Next location step", async ({ page }) => {
  const map = atlas(page);
  await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.evaluate((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { nodeId?: string }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let failOnce = true;
    bridge.invoke = async (command, args) => {
      if (command === "get_storage_view_snapshot" && args.nodeId === "site:studio-archive" && failOnce) {
        failOnce = false;
        throw new Error(message);
      }
      return invoke(command, args);
    };
  }, readError);

  await back(page).click();
  const failure = map.getByRole("alert").filter({ hasText: /Couldn[’']t open the previous location/ });
  await expect(failure).toContainText(readError);
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(back(page)).toBeEnabled();
  const forward = page.getByRole("button", { name: "Next location", exact: true });
  await expect(forward).toBeDisabled();

  await map.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(failure).toBeHidden();
  await expect(back(page)).toBeDisabled();
  await forward.click();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(forward).toBeDisabled();
});

test("a late retry error cannot overwrite newer browsing", async ({ page }) => {
  const map = atlas(page);
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(map.getByRole("alert").filter({ hasText: projectsFailure })).toBeVisible();

  const retryError = "The previous read timed out.";
  const delayed = await page.evaluateHandle((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const attempt = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, ...args) => {
      const response = await invoke(command, ...args);
      if (command !== "get_storage_view_snapshot" || attempt.pending
        || (response as StorageViewSnapshot).location.root.name !== "Projects") return response;

      attempt.pending = true;
      await gate;
      attempt.replied = true;
      throw new Error(message);
    };
    return attempt;
  }, retryError);

  try {
    await map.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(() => delayed.evaluate((attempt) => attempt.pending)).toBe(true);
    await expect(map.getByRole("button", { name: "Retrying…", exact: true })).toBeDisabled();
    await map.getByRole("button", { name: /^Photo Library,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Photo Library");
    await expect(map.getByRole("alert").filter({ hasText: projectsFailure })).toBeHidden();
  } finally {
    await delayed.evaluate((attempt) => attempt.release());
  }

  await expect.poll(() => delayed.evaluate((attempt) => attempt.replied)).toBe(true);
  await expect(page.getByText(retryError, { exact: true })).toBeHidden();
  await expect(map.getByRole("alert").filter({ hasText: projectsFailure })).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await back(page).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back(page)).toBeDisabled();
});

test.describe("compact Atlas recovery", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 640 } });

  test("dismissing a failed Contents navigation leaves the original list usable", async ({ page }) => {
    await page.getByRole("button", { name: "Contents & details" }).tap();
    const inspector = page.getByRole("complementary", { name: "Inspector" });
    const projects = inspector.getByRole("grid").getByRole("button", { name: /^Projects\b/ });
    await projects.tap();

    const map = atlas(page);
    const failure = map.getByRole("alert").filter({ hasText: projectsFailure });
    await expect(failure).toContainText(readError);
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(projects).toBeVisible();

    const dismiss = map.getByRole("button", { name: /^Dismiss(?: location error)?$/ });
    await expect(dismiss).toBeInViewport();
    await dismiss.tap();
    await expect(failure).toBeHidden();
    await expect(currentFolder(page)).toHaveText("Studio archive");
    await expect(projects).toBeInViewport();
    await projects.tap();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(inspector.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });
});
