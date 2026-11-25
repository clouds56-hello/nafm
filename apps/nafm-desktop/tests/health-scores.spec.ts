import { expect, test, type Page } from "@playwright/test";
import { formatHealth, formatShare } from "../src/lib/format";
import { formatCompleteness, healthAriaDescription, healthPresentation, isPerfectHealth } from "../src/lib/health";

test("a rounded or estimated score cannot earn a perfect mark", () => {
  const perfect = healthPresentation(100, null, 1);
  expect(formatHealth(perfect.value)).toBe("100");
  expect(isPerfectHealth(perfect)).toBe(true);
  expect(healthAriaDescription(perfect, "space")).toBe("100 space health");

  for (const [value, label] of [[99.98, "99.98"], [99.9999, "<100"]] as const) {
    const near = healthPresentation(value, null, 1);
    expect(formatHealth(near.value)).toBe(label);
    expect(isPerfectHealth(near)).toBe(false);
  }
  expect(healthAriaDescription(healthPresentation(99.9999, null, 1), "space")).toContain("less than 100");
  expect(isPerfectHealth(healthPresentation(null, 100, 0.75))).toBe(false);
  expect(isPerfectHealth(healthPresentation(null, null, 0))).toBe(false);
});

test("parent shares and verification reserve 100% for a full ratio", () => {
  for (const [amount, label] of [[1_000_000, "100%"], [999_800, "99.98%"], [999_999, "<100%"]] as const) {
    expect(formatShare(amount, 1_000_000)).toBe(label);
    expect(formatCompleteness(amount / 1_000_000)).toBe(label);
  }
});

async function openSpaceHealth(page: Page, scenario = "populated") {
  await page.goto(`/mock/?scenario=${scenario}`);
  await page.getByRole("button", { name: "Map options" }).click();
  await page.getByRole("button", { name: "Space health", exact: true }).click();
}

async function openPartialSpaceHealth(page: Page) {
  await page.clock.install({ time: new Date("2025-11-04T12:00:00Z") });
  await page.clock.pauseAt(new Date("2025-11-04T12:10:00Z"));
  await openSpaceHealth(page, "partial");
}

function openFolder(page: Page, name: string) {
  return page.getByRole("figure").getByRole("button", { name: new RegExp(`^${name},`) }).press("Enter");
}

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

async function inspectPendingTrailer(page: Page) {
  await openFolder(page, "Projects");
  await expect(currentFolder(page)).toHaveText("Projects");
  await openFolder(page, "Brand campaign");
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await page.getByRole("figure").getByRole("button", { name: /^Trailer master\.mov,/ }).press("Enter");
  const details = page.getByRole("region", { name: "Storage details", exact: true });
  await expect(details.getByRole("heading", { name: "Trailer master.mov", exact: true })).toBeVisible();
  await expect(details.getByText("Hash pending", { exact: true })).toBeVisible();
  return details;
}

test("Contents previews, atlas readings and Details distinguish near-perfect from perfect", async ({ page }) => {
  await openSpaceHealth(page);
  const map = page.getByRole("figure");
  const photos = map.getByRole("button", { name: /^Photo Library,/ });
  await expect(photos).toHaveAccessibleName(/99\.98 space health/);
  await expect(photos.locator(".radial-atlas__label-value")).toContainText("99.98/100");

  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  const photoRow = contents.getByRole("button", { name: /^Photo Library/ });
  const tip = page.getByRole("tooltip");
  await photoRow.hover();
  await expect(tip).toContainText("99.98 space health");
  await expect(tip.locator(".atlas-score-check")).toHaveCount(0);
  await contents.getByRole("button", { name: /^Deliverables/ }).hover();
  await expect(tip.getByText("100 space health", { exact: true })).toBeVisible();
  await expect(tip.locator(".atlas-score-check")).toBeVisible();

  await photoRow.click();
  const reading = map.locator(".radial-atlas__size");
  await expect(reading).toHaveText("99.98/100");
  await expect(reading.locator(".atlas-score-check")).toHaveCount(0);
  await page.getByRole("tab", { name: "Details" }).click();
  const details = page.getByRole("tabpanel", { name: "Details" });
  const space = details.locator(".atlas-detail-health").filter({ hasText: "Space health" });
  await expect(space).toContainText("99.98/100");
  await expect(space.getByRole("img", { name: "Perfect score" })).toHaveCount(0);

  await page.getByRole("button", { name: "Previous location", exact: true }).click();
  await map.getByRole("button", { name: /^Deliverables,/ }).press("Enter");
  await expect(reading).toContainText("100/100");
  await expect(reading.locator(".atlas-score-check")).toBeVisible();
  await expect(map.getByRole("button", { name: /^Exhibition playback,/ }).locator(".radial-atlas__label-value"))
    .toContainText("100/100 ✓");
  await expect(space.getByRole("img", { name: "Perfect score" })).toBeVisible();
});

test("an estimated 100 stays visibly estimated", async ({ page }) => {
  await openSpaceHealth(page, "partial");
  const map = page.getByRole("figure");
  await map.getByRole("button", { name: /^Deliverables,/ }).press("Enter");
  const review = map.getByRole("button", { name: /^Client review,/ });
  await expect(review).toHaveAccessibleName(/estimated 100 space health/);
  await review.press("Enter");
  const reading = map.locator(".radial-atlas__size");
  await expect(reading).toHaveText("≈100/100");
  await expect(reading.locator(".atlas-score-check")).toHaveCount(0);
  await page.getByRole("button", { name: "Contents & details" }).click();
  await page.getByRole("tab", { name: "Details" }).click();
  const space = page.getByRole("tabpanel", { name: "Details" }).locator(".atlas-detail-health").filter({ hasText: "Space health" });
  await expect(space).toContainText("≈100/100");
  await expect(space.getByRole("img", { name: "Perfect score" })).toHaveCount(0);
});

test("resuming verification from the Space health footer updates the open folder in place", async ({ page }) => {
  await openPartialSpaceHealth(page);
  await openFolder(page, "Deliverables");
  await expect(currentFolder(page)).toHaveText("Deliverables");
  await openFolder(page, "Client review");
  await expect(currentFolder(page)).toHaveText("Client review");

  const footer = page.locator(".atlas-map-footer");
  const reading = page.getByRole("figure").locator(".radial-atlas__size");
  const resume = footer.getByRole("button", { name: "Resume verification", exact: true });
  await expect(footer.getByText("39 hashes pending", { exact: true })).toBeVisible();
  await expect(reading).toHaveText("≈100/100");
  await resume.press("Enter");
  await expect(footer.getByRole("button")).toBeDisabled();
  await expect(footer.getByRole("button")).toBeFocused();

  await page.clock.runFor(5_700);
  await expect(reading).toContainText("100/100");
  await expect(reading).not.toContainText("≈");
  await expect(reading.locator(".atlas-score-check")).toBeVisible();
  await expect(resume).toHaveCount(0);
  await expect(currentFolder(page)).toHaveText("Client review");
  await expect(footer.locator(":focus")).toHaveCount(1);
});

test.describe("compact Space health options", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("resuming verification is reachable from Map options on a compact screen", async ({ page }) => {
    await openPartialSpaceHealth(page);
    const toolbar = page.getByRole("button", { name: "Map options", exact: true });
    await toolbar.tap();
    const options = page.getByRole("group", { name: "Map options", exact: true });
    const resume = options.getByRole("button", { name: "Resume verification", exact: true });
    await expect(resume).toBeInViewport({ ratio: 1 });
    await resume.tap();
    await expect(options.locator('[aria-disabled="true"]')).toHaveCount(1);
    await expect(currentFolder(page)).toHaveText("Studio archive");

    await page.clock.runFor(5_700);
    await expect(resume).toHaveCount(0);
    await expect(page.getByRole("figure").locator(".radial-atlas__size")).not.toContainText("≈");
    await expect(currentFolder(page)).toHaveText("Studio archive");
  });
});

test("Details offers verification where a pending duplicate would be staged", async ({ page }) => {
  await openPartialSpaceHealth(page);
  const details = await inspectPendingTrailer(page);
  await expect(details.getByText("Verify this site to stage duplicate files.", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Resume verification", exact: true }).press("Enter");

  await page.clock.runFor(5_700);
  await expect(details.getByText("Hash verified", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Stage for review", exact: true })).toBeEnabled();
  await expect(details.getByRole("button", { name: "Exact copies", exact: true })).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(details.getByRole("heading", { name: "Trailer master.mov", exact: true })).toBeVisible();
});

test("Exact copies stays open through a failed scan start, retry, and match refresh", async ({ page }) => {
  await openPartialSpaceHealth(page);
  const details = await inspectPendingTrailer(page);
  await details.getByRole("button", { name: "Exact copies", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Exact copies", exact: true });
  await expect(dialog).toBeVisible();
  await page.clock.runFor(10);
  await expect(dialog.getByRole("button", { name: "Show in Atlas", exact: true })).toHaveCount(0);
  const originalDialog = await dialog.elementHandle();
  const failure = "Could not start verification. The source is temporarily unavailable.";
  await page.evaluate((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let shouldFail = true;
    bridge.invoke = async (command, args) => {
      if (command === "start_scan" && shouldFail) {
        shouldFail = false;
        throw new Error(message);
      }
      return invoke(command, args);
    };
  }, failure);

  const resume = dialog.getByRole("button", { name: "Resume verification", exact: true });
  const alert = dialog.getByRole("alert");
  await resume.press("Enter");
  await expect(alert).toHaveText(failure);
  await expect(resume).toBeEnabled();
  await expect(resume).toBeFocused();
  expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(true);
  await resume.press("Enter");
  await expect(alert).toHaveCount(0);

  // The first published hashes advance the index revision before verification is finished.
  await page.clock.runFor(2_900);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(true);
  await expect(dialog.locator("button:focus")).toHaveAttribute("aria-disabled", "true");

  await page.clock.runFor(3_000);
  await expect(dialog.getByText("2 verified copies", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show in Atlas", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Close exact copies", exact: true })).toBeFocused();
  expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(details.getByRole("heading", { name: "Trailer master.mov", exact: true })).toBeVisible();
});
