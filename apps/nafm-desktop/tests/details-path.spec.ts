import { expect, test, type Page } from "@playwright/test";
import { createFixtures } from "../mock/fixtures";

const folders = ["Production Archive", "2025 Campaigns", "Spring Launch", "Camera Originals", "Second Unit", "Interview Selects"];
const directoryPath = ["/demo/Studio Archive", ...folders].join("/");
const fileName = "Day 03 interview.mxf";
const filePath = directoryPath + "/" + fileName;
const fileEntry = /^Day 03 interview\.mxf/;

test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

async function openInterviewFolder(page: Page) {
  await page.goto("/mock/?scenario=deep");
  const current = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(current).toHaveText("Studio archive");
  const map = page.getByRole("region", { name: "Circular storage map" });
  for (const folder of folders) {
    await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
    await expect(current).toHaveText(folder);
  }
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const details = inspector.getByRole("region", { name: "Storage details", exact: true });
  const file = contents.getByRole("grid").getByRole("button", { name: fileEntry });
  await expect(file).toBeVisible();
  return { current, inspector, contents, details, file };
}

async function stubClipboard(page: Page, { failFirstWrite = false, holdFirstWrite = false } = {}) {
  return page.evaluateHandle(({ failFirstWrite, holdFirstWrite }) => {
    const writes: string[] = [];
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    if (!holdFirstWrite) release();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(text: string) {
          writes.push(text);
          if (writes.length === 1) {
            await firstWrite;
            if (failFirstWrite) throw new Error("Clipboard denied for this test");
          }
        },
      },
    });
    return { writes, release };
  }, { failFirstWrite, holdFirstWrite });
}

test("Details reads and copies a long path while preserving the filtered Contents visit", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  const { current, inspector, contents, details, file } = await openInterviewFolder(page);
  const clipboard = await stubClipboard(page);
  const studio = createFixtures("deep").trees.get("studio-archive");
  const folder = folders.reduce((node, name) => node?.children.find((child) => child.name === name), studio);
  const modified = folder?.children.find((child) => child.name === fileName)?.modified_unix_millis;
  expect(modified).toBeDefined();

  await inspector.getByRole("tab", { name: "Details", exact: true }).press("Enter");
  const verification = details.getByText("Verification", { exact: true }).locator("..");
  await expect(verification).toBeInViewport({ ratio: 0.99 });
  await expect(details.getByText("Contents modified", { exact: true }).locator("..").locator("time"))
    .toHaveAttribute("datetime", new Date(folder!.modified_unix_millis!).toISOString());
  await inspector.getByRole("tab", { name: "Contents", exact: true }).press("Enter");
  await contents.getByRole("button", { name: "Search this folder", exact: true }).press("Enter");
  const filter = contents.getByRole("searchbox", { name: "Find in folder", exact: true });
  await filter.fill("  dAy 03  ");
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  await file.press("Enter");

  await expect(details.getByRole("heading", { name: fileName, exact: true })).toBeVisible();
  await expect(details.getByText("Share of parent", { exact: true }).locator("..").locator("dd"))
    .toHaveAttribute("title", "Interview Selects");
  await expect(details.getByText("Modified", { exact: true }).locator("..").locator("time"))
    .toHaveAttribute("datetime", new Date(modified!).toISOString());
  const code = details.locator(".atlas-detail-path code");
  const show = details.getByRole("button", { name: "Show full path", exact: true });
  const hide = details.getByRole("button", { name: "Show less", exact: true });
  const copy = details.getByRole("button", { name: "Copy path", exact: true });
  await expect(code).toHaveText(filePath);
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(show).toHaveAttribute("aria-controls", (await code.getAttribute("id"))!);
  expect(await code.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await copy.press("Enter");
  await expect(details.getByRole("status").filter({ hasText: "Path copied." })).toHaveText("Path copied.");
  expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath]);
  await expect(copy).toBeFocused();
  await expect(show).toHaveAttribute("aria-expanded", "false");

  await show.press("Enter");
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(hide).toBeFocused();
  expect(await code.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await hide.press("Enter");
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(show).toBeFocused();

  await inspector.getByRole("button", { name: "Back to Contents", exact: true }).press("Enter");
  await expect(current).toHaveText("Interview Selects");
  await expect(filter).toHaveValue("  dAy 03  ");
  await expect(file).toBeFocused();
});

test("Details keeps a file's share after it scrolls out of the Contents window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/mock/?scenario=large");
  await page.getByRole("button", { name: "Find files", exact: true }).press("Enter");
  const finder = page.getByRole("dialog", { name: "Find files", exact: true });
  await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("Proof 096");
  await finder.getByRole("button", { name: /^Proof 096\.jpg/ }).press("Enter");
  const inspector = page.getByRole("complementary", { name: "Inspector", exact: true });
  const details = inspector.getByRole("region", { name: "Storage details", exact: true });
  const share = details.getByText("Share of parent", { exact: true }).locator("..").locator("dd");
  await expect(share).toHaveAttribute("title", "Photo Library");
  const initialShare = await share.textContent();

  await details.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
  const contents = inspector.getByRole("tabpanel", { name: "Contents", exact: true });
  const proof = contents.getByRole("button", { name: /^Proof 096\.jpg/ });
  await expect(proof).toBeFocused();
  await contents.evaluate((pane) => { pane.scrollTop = 0; });
  await expect(contents.getByRole("button", { name: /^Studio portraits/ })).toBeInViewport();
  await expect(proof).toHaveCount(0);

  await inspector.getByRole("tab", { name: "Details", exact: true }).press("Enter");
  await expect(details.getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await expect(share).toHaveText(initialShare!);
  await expect(share).toHaveAttribute("title", "Photo Library");
});

test("a denied clipboard write expands the path for manual selection and can be retried", async ({ page }) => {
  const { details, file } = await openInterviewFolder(page);
  const clipboard = await stubClipboard(page, { failFirstWrite: true });
  await file.press("Enter");
  const copy = details.getByRole("button", { name: "Copy path", exact: true });
  const message = details.locator(".atlas-detail-path [role=status]");
  const code = details.locator(".atlas-detail-path code");
  await expect(details.getByRole("button", { name: "Show full path", exact: true })).toBeVisible();
  await copy.press("Enter");
  await expect(message).toContainText("Select it above to copy it manually.");
  await expect(message).toBeVisible();
  await expect(details.getByRole("button", { name: "Show less", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(copy).toBeFocused();
  expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath]);
  const manual = await code.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const text = selection?.toString();
    selection?.removeAllRanges();
    return { text, userSelect: getComputedStyle(element).userSelect };
  });
  expect(manual).toEqual({ text: filePath, userSelect: "text" });

  await copy.press("Enter");
  await expect(message).toHaveText("Path copied.");
  expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath, filePath]);
  await expect(copy).toBeFocused();
});

test("a pending path copy does not block file browsing or publish stale feedback", async ({ page }) => {
  const { inspector, details, file } = await openInterviewFolder(page);
  const clipboard = await stubClipboard(page, { holdFirstWrite: true });
  const copy = details.getByRole("button", { name: "Copy path", exact: true });
  const next = inspector.getByRole("button", { name: "Next file", exact: true });
  const message = details.locator(".atlas-detail-path [role=status]");
  const transcriptPath = directoryPath + "/Transcript.txt";
  await file.press("Enter");
  try {
    await copy.press("Enter");
    await expect(copy).toHaveAttribute("aria-busy", "true");
    expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath]);
    await next.press("Enter");
    await expect(next).toBeFocused();
    await expect(copy).toBeDisabled();
    await expect(message).toBeEmpty();
    await copy.focus();
    await page.keyboard.press("Enter");
    expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath]);
  } finally {
    await clipboard.evaluate(({ release }) => release());
  }
  await expect(details.getByRole("heading", { name: "Transcript.txt", exact: true })).toBeVisible();
  await expect(details.locator(".atlas-detail-path code")).toHaveText(transcriptPath);
  await expect(copy).toBeEnabled();
  await expect(message).toBeEmpty();
  await expect(details.getByRole("button", { name: "Show full path", exact: true })).toHaveAttribute("aria-expanded", "false");
  await copy.press("Enter");
  await expect(message).toHaveText("Path copied.");
  expect(await clipboard.evaluate(({ writes }) => writes)).toEqual([filePath, transcriptPath]);
});
