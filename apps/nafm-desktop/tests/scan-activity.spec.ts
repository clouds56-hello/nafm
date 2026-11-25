import { expect, test, type Page } from "@playwright/test";

const studio = "Studio archive";
const field = "Field drive";
const survey = "Field survey";

function activityTrigger(page: Page) {
  return page.getByRole("button", { name: "Scan activity", exact: true });
}

function activityPanel(page: Page) {
  return page.getByRole("group", { name: "Scan activity", exact: true });
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

async function openProjects(page: Page) {
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
}

async function openMock(page: Page, scenario = "") {
  // Advance background scans explicitly so they cannot finish during assertions about active requests.
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await page.goto(scenario ? `/mock/?scenario=${scenario}` : "/mock/");
  await expect(currentFolder(page)).toHaveText(studio);
}

async function addSurveySite(page: Page) {
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const sites = page.getByRole("complementary", { name: "Sites", exact: true });
  await sites.getByRole("button", { name: "Add site", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add site", exact: true });
  await dialog.getByRole("textbox", { name: "Site name" }).fill(survey);
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Survey");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await sites.getByRole("button", { name: `Open ${survey} in Atlas`, exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText(survey);
  return sites;
}

test("a first scan stopped before saving inventory can be restarted from another site", async ({ page }) => {
  await openMock(page);
  await openProjects(page);
  const sites = await addSurveySite(page);
  const figure = page.getByRole("figure");
  await figure.getByRole("button", { name: "Scan this site", exact: true }).press("Enter");
  await expect(figure.getByText("Finding files", { exact: true })).toBeVisible();
  await sites.getByRole("button", { name: `Open ${studio} in Atlas`, exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");

  const activity = activityPanel(page);
  await activityTrigger(page).press("Enter");
  await activity.getByRole("button", { name: `Stop scan of ${survey}`, exact: true }).press("Enter");
  await page.clock.runFor(550);
  const latest = activity.getByRole("region", { name: "Latest scan result" });
  await expect(latest.getByText("Scan stopped", { exact: true })).toBeVisible();
  await expect(latest.getByText("Inventory wasn’t saved", { exact: true })).toBeVisible();
  await expect(latest.getByRole("button", { name: `Restart scan of ${survey}`, exact: true })).toBeVisible();
  await expect(page.getByText("Scan stopped. Indexed files remain available.", { exact: true })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await sites.getByRole("button", { name: `Open ${survey} in Atlas`, exact: true }).press("Enter");
  await expect(figure.getByText("Scan stopped", { exact: true })).toBeVisible();
  await expect(figure.getByRole("button", { name: /^Restart scan\b/ })).toBeEnabled();

  await sites.getByRole("button", { name: `Open ${studio} in Atlas`, exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");
  await sites.getByRole("button", { name: `Scan ${field}`, exact: true }).press("Enter");
  await activityTrigger(page).press("Enter");
  await expect(activity.getByRole("button", { name: `Stop scan of ${field}`, exact: true })).toBeEnabled();
  await page.clock.runFor(5_700);
  await expect(latest.getByText("Scan finished", { exact: true })).toBeVisible();
  const interrupted = activity.getByRole("region", { name: "Interrupted scans" });
  const restart = interrupted.getByRole("button", { name: `Restart scan of ${survey}`, exact: true });
  await restart.press("Enter");
  await expect(activity.getByRole("region", { name: survey, exact: true })).toBeFocused();
  await expect(activity.getByRole("button", { name: `Stop scan of ${survey}`, exact: true })).toBeEnabled();
  await expect(currentFolder(page)).toHaveText("Projects");
});

test("first-scan failure remains visible after the dashboard refresh and can be retried", async ({ page }) => {
  await openMock(page);
  await addSurveySite(page);
  await page.evaluate(() => {
    type PreviewCall = { event?: string; payload?: { request_id: number; kind: string; message: string | null } };
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: PreviewCall | { requestId: number }) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let failedRequest: number | undefined;
    bridge.invoke = async (command, args) => {
      if (command === "plugin:event|emit" && args && "payload" in args && args.event === "task://scan/events"
        && args.payload && args.payload.request_id === failedRequest && args.payload.kind === "cancelled") {
        // Use the mock's normal terminal cleanup while substituting a discovery error.
        return invoke(command, {
          ...args, payload: { ...args.payload, kind: "failed", message: "Couldn’t read the survey folder." },
        });
      }
      const response = await invoke(command, args);
      if (command === "start_scan" && failedRequest === undefined) {
        const { request_id } = response as { request_id: number };
        failedRequest = request_id;
        window.setTimeout(() => void invoke("cancel_scan", { requestId: request_id }), 60);
      }
      return response;
    };
  });

  const figure = page.getByRole("figure");
  await figure.getByRole("button", { name: "Scan this site", exact: true }).press("Enter");
  await expect(figure.getByText("Finding files", { exact: true })).toBeVisible();
  await page.clock.runFor(600);
  await expect(figure.getByText("Scan failed", { exact: true })).toBeVisible();
  await expect(figure.getByRole("button", { name: /^Retry scan\b/ })).toBeEnabled();
  await activityTrigger(page).press("Enter");
  const activity = activityPanel(page);
  const latest = activity.getByRole("region", { name: "Latest scan result" });
  await expect(latest.getByText("Couldn’t read the survey folder.", { exact: true })).toBeVisible();
  await latest.getByRole("button", { name: `Retry scan of ${survey}`, exact: true }).press("Enter");
  await expect(activity.getByRole("button", { name: `Stop scan of ${survey}`, exact: true })).toBeEnabled();
  await expect(currentFolder(page)).toHaveText(survey);
});

test("stopping the first verification keeps its inventory browsable", async ({ page }) => {
  await openMock(page);
  await addSurveySite(page);
  const figure = page.getByRole("figure");
  await figure.getByRole("button", { name: "Scan this site", exact: true }).press("Enter");
  await expect(figure.getByText("Finding files", { exact: true })).toBeVisible();
  await page.clock.runFor(2_800);
  await figure.getByRole("button", { name: /^Drone imagery,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Drone imagery");

  await activityTrigger(page).press("Enter");
  const activity = activityPanel(page);
  await activity.getByRole("button", { name: `Stop scan of ${survey}`, exact: true }).press("Enter");
  await page.clock.runFor(550);
  const latest = activity.getByRole("region", { name: "Latest scan result" });
  await expect(latest.getByText("Scan stopped", { exact: true })).toBeVisible();
  await expect(latest.getByText(/\d+ files awaiting verification/)).toBeVisible();
  await expect(latest.getByRole("button", { name: `Restart scan of ${survey}`, exact: true })).toHaveCount(0);
  await expect(currentFolder(page)).toHaveText("Drone imagery");
  await expect(figure.getByRole("button", { name: /^Headland survey\.dng,/ })).toBeVisible();
  await latest.getByRole("button", { name: `Resume verification of ${survey}`, exact: true }).press("Enter");
  await expect(activity.getByRole("button", { name: `Stop scan of ${survey}`, exact: true })).toBeEnabled();
  await expect(currentFolder(page)).toHaveText("Drone imagery");
});

test.describe("compact scan activity", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 640 } });

  test("stopping and resuming verification keeps the same folder open", async ({ page }) => {
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
    const progress = activity.getByRole("progressbar", { name: `Scan progress for ${studio}` });
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute("value", "127");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.keyboard.press("Escape");
    await expect(activity).toBeHidden();
    await expect(trigger).toBeFocused();

    await openProjects(page);

    await trigger.tap();
    await page.clock.runFor(5_000);
    await expect(progress).toHaveAttribute("value", "142");
    await activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true }).tap();
    await page.clock.runFor(350);
    const result = activity.getByRole("region", { name: "Latest scan result" });
    await expect(result.getByText("Scan stopped", { exact: true })).toBeVisible();
    await expect(result.getByText("14 files awaiting verification", { exact: true })).toBeVisible();
    await expect(currentFolder(page)).toHaveText("Projects");

    const resume = activity.getByRole("button", { name: `Resume verification of ${studio}`, exact: true });
    await expect(resume).toBeInViewport({ ratio: 1 });
    await resume.tap();
    await expect(activity.getByRole("region", { name: studio, exact: true })).toBeFocused();
    await expect(activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true })).toBeEnabled();
    await page.clock.runFor(2_800);
    await expect(progress).toHaveAttribute("value", "146");
    await expect(progress).toHaveAttribute("max", "156");

    await page.clock.runFor(3_000);
    await expect(result.getByText("Scan finished", { exact: true })).toBeVisible();
    await expect(result.getByText("156 files verified", { exact: true })).toBeVisible();
    await expect(resume).toHaveCount(0);
    await expect(currentFolder(page)).toHaveText("Projects");
    await expect(sites).toBeHidden();
    await expect(inspector).toBeHidden();
  });
});

test("reopening shows pending verification for just the affected site", async ({ page }) => {
  await openMock(page, "partial");
  await openProjects(page);
  await page.reload();
  await expect(currentFolder(page)).toHaveText("Projects");

  const activity = activityPanel(page);
  await activityTrigger(page).press("Enter");
  await expect(activity.getByRole("region", { name: "Latest scan result" })).toHaveCount(0);
  const pending = activity.getByRole("region", { name: "Verification pending" });
  await expect(pending.getByText("39 files awaiting verification", { exact: true })).toBeVisible();
  const resume = pending.getByRole("button", { name: `Resume verification of ${studio}`, exact: true });
  await expect(pending.getByRole("button")).toHaveCount(1);
  await expect(resume).toBeFocused();
  await resume.press("Enter");
  await expect(activity.getByRole("region", { name: studio, exact: true })).toBeFocused();
  await expect(activity.getByRole("button", { name: /^Stop / })).toHaveCount(1);
  await expect(activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true })).toBeEnabled();
  await expect(currentFolder(page)).toHaveText("Projects");
});

test("a failed scan can be retried without leaving the current folder", async ({ page }) => {
  await openMock(page, "scan-failed");
  await openProjects(page);

  const activity = activityPanel(page);
  await activityTrigger(page).click();
  await page.clock.runFor(4_100);
  const result = activity.getByRole("region", { name: "Latest scan result" });
  await expect(result.getByText("Scan failed", { exact: true })).toBeVisible();
  await expect(result.getByText("Couldn’t read a folder in Studio archive.", { exact: true })).toBeVisible();
  await expect(result.getByRole("button", { name: /^Resume verification/ })).toHaveCount(0);

  const retry = result.getByRole("button", { name: `Retry scan of ${studio}`, exact: true });
  await retry.press("Enter");
  await expect(activity.getByRole("region", { name: studio, exact: true })).toBeFocused();
  await expect(activity.getByRole("button", { name: /^Stop / })).toHaveCount(1);
  await expect(activity.getByRole("button", { name: `Stop scan of ${studio}`, exact: true })).toBeEnabled();

  await page.clock.runFor(5_600);
  await expect(result.getByText("Scan finished", { exact: true })).toBeVisible();
  await expect(result.getByText("156 files verified", { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(currentFolder(page)).toHaveText("Projects");
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
  await expect(trigger).toBeVisible();

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
  await expect(activity.getByRole("button", { name: `Resume verification of ${studio}`, exact: true })).toHaveCount(0);

  await page.clock.runFor(2_300);
  await expect(activity.getByText("Verifying files", { exact: true })).toBeVisible();
  const progress = activity.getByRole("progressbar", { name: `Scan progress for ${studio}` });
  await expect(progress).toHaveAttribute("value", /\d/);

  await page.clock.runFor(3_000);
  await expect(activity.getByText("Scan finished", { exact: true })).toBeVisible();
  await expect(activity).toContainText(/\d[\d,]* files verified/i);
  await expect(stopStudio).toHaveCount(0);
});
