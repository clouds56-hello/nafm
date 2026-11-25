import { expect, test, type Locator, type Page } from "@playwright/test";

const mirroredTrailer = "smb://media.example.test/Studio/Campaign mirror/Trailer master.mov";
const studioTrailer = "/demo/Studio Archive/Projects/Brand campaign/Trailer master.mov";
const searchError = "Could not read the workspace index.";

function folderPath(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" });
}

function currentFolder(page: Page) {
  return folderPath(page).locator('[aria-current="location"]');
}

function finder(page: Page) {
  return page.getByRole("dialog", { name: "Find files", exact: true });
}

function query(dialog: Locator) {
  return dialog.getByRole("searchbox", { name: "File name", exact: true });
}

function result(dialog: Locator, fileName: RegExp) {
  return dialog.getByRole("list", { name: "Matching files", exact: true }).getByRole("button", { name: fileName });
}

test("Find files distinguishes same names across sites and Back restores the starting folder", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Projects");

  await page.keyboard.press("ControlOrMeta+f");
  const dialog = finder(page);
  const input = query(dialog);
  await expect(input).toBeFocused();
  await input.fill("  TrAiLeR master  ");

  const trailers = result(dialog, /Trailer master\.mov/i);
  const mirrored = trailers.filter({ hasText: mirroredTrailer });
  await expect(trailers).toHaveCount(3);
  await expect(trailers.filter({ hasText: studioTrailer })).toContainText("Studio archive");
  await expect(mirrored).toContainText("Team share");
  await expect(mirrored).toContainText(/verified/i);
  await input.press("ArrowDown");
  await expect(trailers.first()).toBeFocused();
  const mirrorIndex = await trailers.evaluateAll(
    (rows, path) => rows.findIndex((row) => row.textContent?.includes(path)),
    mirroredTrailer,
  );
  for (let index = 0; index < mirrorIndex; index += 1) await page.keyboard.press("ArrowDown");
  await expect(mirrored).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Campaign mirror");
  const details = page.getByRole("complementary", { name: "Inspector" })
    .getByRole("region", { name: "Storage details" });
  await expect(details).toContainText(mirroredTrailer);
  await expect(details).toBeFocused();

  await folderPath(page).getByRole("button", { name: "Previous location", exact: true }).click();
  await expect(currentFolder(page)).toHaveText("Projects");
});

test("Find files reads more matches when scrolled and includes the distant file", async ({ page }) => {
  await page.goto("/mock/");
  const opener = page.getByRole("button", { name: "Find files", exact: true });
  await expect(opener).toBeEnabled();
  const offsets = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string; offset?: number }) => Promise<unknown> };
    };
    const reads: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "search_indexed_files" && args.query?.toLowerCase() === "proof") reads.push(Number(args.offset ?? 0));
      return invoke(command, args);
    };
    return reads;
  });

  await opener.click();
  const dialog = finder(page);
  await query(dialog).fill("proof");
  await expect(result(dialog, /Proof 001\.jpg/i)).toBeVisible();
  const last = result(dialog, /Proof 096\.jpg/i);
  await expect(last).toHaveCount(0);

  await expect(async () => {
    await dialog.getByRole("list", { name: "Matching files", exact: true }).evaluate((list) => {
      let pane = list as HTMLElement | null;
      while (pane && pane.tagName !== "DIALOG") {
        const { overflowY } = getComputedStyle(pane);
        if ((overflowY === "auto" || overflowY === "scroll") && pane.scrollHeight > pane.clientHeight) {
          pane.scrollTop = pane.scrollHeight;
          return;
        }
        pane = pane.parentElement;
      }
    });
    await expect(last).toBeInViewport({ timeout: 1_000 });
  }).toPass({ timeout: 12_000 });
  expect(await offsets.evaluate((reads) => reads.some((offset) => offset > 0))).toBe(true);
});

test("an older finder result cannot replace a newer query and a failed search can be retried", async ({ page }) => {
  await page.goto("/mock/");
  const opener = page.getByRole("button", { name: "Find files", exact: true });
  await expect(opener).toBeEnabled();
  const delayed = await page.evaluateHandle((message) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    let failOnce = true;
    bridge.invoke = async (command, args) => {
      if (command !== "search_indexed_files") return invoke(command, args);
      const query = args.query?.toLowerCase();
      if (query === "camera originals" && failOnce) {
        failOnce = false;
        throw new Error(message);
      }
      const response = await invoke(command, args);
      if (query === "trailer master") {
        request.pending = true;
        await gate;
        request.replied = true;
      }
      return response;
    };
    return request;
  }, searchError);

  await opener.click();
  const dialog = finder(page);
  const input = query(dialog);
  try {
    await input.fill("Trailer master");
    await expect.poll(() => delayed.evaluate((request) => request.pending)).toBe(true);
    await input.fill("Camera originals");
    await expect(dialog.getByRole("alert")).toContainText(searchError);
    await expect(input).toHaveValue("Camera originals");
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(result(dialog, /Camera originals\.mxf/i)).toHaveCount(2);
  } finally {
    await delayed.evaluate((request) => request.release());
  }

  await expect.poll(() => delayed.evaluate((request) => request.replied)).toBe(true);
  await expect(result(dialog, /Camera originals\.mxf/i)).toHaveCount(2);
  await expect(result(dialog, /Trailer master\.mov/i)).toHaveCount(0);
  await expect(input).toHaveValue("Camera originals");
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test.describe("compact workspace finder", () => {
  test.use({ viewport: { width: 320, height: 640 }, hasTouch: true });

  test("can open and dismiss Find files from Workspace actions without losing focus", async ({ page }) => {
    await page.goto("/mock/");
    await expect(currentFolder(page)).toHaveText("Studio archive");
    const actions = page.getByRole("button", { name: "Workspace actions" });
    await actions.tap();
    await page.getByRole("group", { name: "Workspace actions", exact: true })
      .getByRole("button", { name: "Find files", exact: true }).tap();

    const dialog = finder(page);
    await expect(query(dialog)).toBeFocused();
    await expect(query(dialog)).toBeInViewport();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(actions).toBeFocused();
    await expect(currentFolder(page)).toHaveText("Studio archive");
  });
});
