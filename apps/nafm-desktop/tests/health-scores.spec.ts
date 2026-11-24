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
