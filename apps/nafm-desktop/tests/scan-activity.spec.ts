import { expect, test, type Page } from "@playwright/test";

const studio = "Studio archive";
const field = "Field drive";

function activityTrigger(page: Page) {
  return page.getByRole("button", { name: "Scan activity", exact: true });
}

function activityPanel(page: Page) {
  return page.getByRole("group", { name: "Scan activity", exact: true });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

async function openMock(page: Page, scenario = "") {
  // Advance background scans explicitly so they cannot finish during assertions about active requests.
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.goto(scenario ? `/mock/?scenario=${scenario}` : "/mock/");
  await expect(currentFolder(page)).toHaveText(studio);
}

test.describe("compact scan activity", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 640 } });

  test("scan activity stays available while browsing with both panels closed", async ({ page }) => {
    await openMock(page, "scanning");
    const trigger = activityTrigger(page);
    const activity = activityPanel(page);
    const sites = page.getByRole("complementary", { name: "Sites", exact: true });
    const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
    await expect(sites).toBeHidden();
    await expect(inspector).toBeHidden();
    await expect(trigger).toBeInViewport({ ratio: 1 });

    await trigger.tap();
    await expect(activity.getByText(studio, { exact: true })).toBeVisible();
    await expect(activity.getByText("Verifying files", { exact: true })).toBeVisible();
    await expect(activity.getByRole("progressbar", { name: `Scan progress for ${studio}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(activity).toBeHidden();
    await expect(trigger).toBeFocused();

    const map = page.getByRole("region", { name: "Circular storage map" });
    await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
    await expect(currentFolder(page)).toHaveText("Projects");

    await trigger.tap();
    await activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true }).tap();
    await page.clock.runFor(1_000);
    const result = activity.getByRole("region", { name: "Latest scan result" });
    await expect(result.getByText("Scan stopped", { exact: true })).toBeVisible();
    await expect(result.getByText("29 files awaiting verification", { exact: true })).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(sites).toBeHidden();
    await expect(inspector).toBeHidden();
  });
});

test("Scan all shows one Stop action for its sites and retains the result", async ({ page }) => {
  await openMock(page);
  const trigger = activityTrigger(page);
  const activity = activityPanel(page);
  await expect(trigger).toBeHidden();

  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: "Scan all", exact: true }).click();
  await trigger.click();
  await expect(activity.getByText("All sites", { exact: true })).toBeVisible();
  for (const site of [studio, field, "Team share"]) {
    await expect(activity.getByText(site, { exact: true })).toBeVisible();
  }

  const stopAll = activity.getByRole("button", { name: "Stop all scans", exact: true });
  await expect(activity.getByRole("button", { name: /^Stop / })).toHaveCount(1);
  await stopAll.press("Enter");
  await expect(stopAll).toBeDisabled();
  await expect(stopAll).toBeFocused();
  await page.clock.runFor(1_000);
  await expect(stopAll).toHaveCount(0);
  const result = activity.getByRole("region", { name: "Latest scan result" });
  await expect(result.getByText("Scan stopped", { exact: true })).toBeVisible();
  await expect(result).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(activity).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(activity.getByText("Scan stopped", { exact: true })).toBeVisible();
});

test("stopping one scan leaves the other running through verification", async ({ page }) => {
  await openMock(page, "partial");
  const trigger = activityTrigger(page);
  const activity = activityPanel(page);
  await expect(trigger).toBeHidden();

  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  await sites.getByRole("button", { name: `Scan ${studio}`, exact: true }).click();
  await sites.getByRole("button", { name: `Scan ${field}`, exact: true }).click();
  await sites.getByRole("button", { name: "Close sites" }).click();
  await trigger.click();

  const stopStudio = activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true });
  const stopField = activity.getByRole("button", { name: `Stop scan of ${field}`, exact: true });
  await expect(stopStudio).toBeEnabled();
  await stopField.click();
  await expect(stopField).toBeDisabled();
  await expect(stopStudio).toBeEnabled();
  await page.clock.runFor(500);
  await expect(stopField).toHaveCount(0);
  await expect(activity.getByText("Scan stopped", { exact: true })).toBeVisible();
  await expect(stopStudio).toBeEnabled();

  await page.clock.runFor(2_300);
  await expect(activity.getByText("Verifying files", { exact: true })).toBeVisible();
  const progress = activity.getByRole("progressbar", { name: `Scan progress for ${studio}` });
  await expect(progress).toHaveAttribute("value", /\d/);

  await page.clock.runFor(3_000);
  await expect(activity.getByText("Scan finished", { exact: true })).toBeVisible();
  await expect(activity).toContainText(/\d[\d,]* files verified/i);
  await expect(stopStudio).toHaveCount(0);
});
