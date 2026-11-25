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

test.beforeEach(async ({ page }) => {
  await page.goto("/mock/?scenario=recovery");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

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
  await page.getByRole("button", { name: "Workspace actions" }).click();
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
  await back(page).click();
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await expect(back(page)).toBeDisabled();
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
