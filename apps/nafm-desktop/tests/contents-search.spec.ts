import { expect, test, type Locator, type Page } from "@playwright/test";

function currentFolder(page: Page) {
  return page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
}

function entry(contents: Locator, name: RegExp) {
  return contents.getByRole("grid").getByRole("button", { name });
}

function firstEntry(contents: Locator) {
  return contents.locator('[aria-rowindex="1"] [data-entry-id]');
}

function searchButton(contents: Locator) {
  return contents.getByRole("button", { name: "Search this folder", exact: true });
}

function searchInput(contents: Locator) {
  return contents.getByRole("searchbox", { name: "Find in folder", exact: true })
    .or(contents.getByRole("textbox", { name: "Find in folder", exact: true }));
}

async function openPhotoLibrary(page: Page) {
  await page.goto("/mock/");
  await page.getByRole("region", { name: "Circular storage map" })
    .getByRole("button", { name: /^Photo Library,/ }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await page.getByRole("button", { name: "Contents & details" }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents" });
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "100");
  return contents;
}

async function showFoundProofInContents(page: Page) {
  await page.getByRole("button", { name: "Find files", exact: true }).press("Enter");
  const finder = page.getByRole("dialog", { name: "Find files", exact: true });
  await finder.getByRole("searchbox", { name: "File name", exact: true }).fill("Proof 096");
  await finder.getByRole("button", { name: /^Proof 096\.jpg/ }).press("Enter");

  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(finder).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(inspector.getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");
}

test("Contents finds distant entries and returns from Details to the same filtered row", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const grid = contents.getByRole("grid");
  const distantFile = entry(contents, /^Proof 096\.jpg/);
  const first = firstEntry(contents);
  await expect(distantFile).toHaveCount(0);
  const readOffsets = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { offset: number; query?: string }) => Promise<unknown> };
    };
    const offsets: number[] = [];
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = (command, args) => {
      if (command === "get_storage_children" && args.query === "proof") offsets.push(args.offset);
      return invoke(command, args);
    };
    return offsets;
  });

  await searchButton(contents).press("Enter");
  const search = searchInput(contents);
  await expect(search).toBeFocused();
  await search.fill("proof");
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(first).toHaveAccessibleName(/^Proof 001\.jpg/);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(distantFile).toBeInViewport();
  await expect(contents.locator('[aria-rowindex="96"] [data-entry-id]')).toHaveAccessibleName(/^Proof 096\.jpg/);
  expect(await readOffsets.evaluate((offsets) => offsets.some((offset) => offset > 0))).toBe(true);

  await search.fill("  pRoOf 09  ");
  await expect(grid).toHaveAttribute("aria-rowcount", "7");
  await expect(first).toHaveAccessibleName(/^Proof 090\.jpg/);
  await expect(distantFile).toBeVisible();

  const sort = contents.getByRole("button", { name: "Sort contents", exact: true });
  await sort.click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Descending", exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(first).toHaveAccessibleName(/^Proof 096\.jpg/);
  await expect(grid).toHaveAttribute("aria-rowcount", "7");

  await distantFile.click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("heading", { name: "Proof 096.jpg", exact: true })).toBeVisible();
  await inspector.getByRole("button", { name: "Back to Contents", exact: true }).click();
  await expect(search).toHaveValue("  pRoOf 09  ");
  await expect(grid).toHaveAttribute("aria-rowcount", "7");
  await expect(distantFile).toBeFocused();
  await expect(currentFolder(page)).toHaveText("Photo Library");

  await search.press("Escape");
  await expect(search).toBeHidden();
  await expect(contents).toBeVisible();
  await expect(searchButton(contents)).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(first).toHaveAccessibleName(/^Studio portraits/);
});

test("Show in Contents keeps the folder search and reveals a late match", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const proof = entry(contents, /^Proof 096\.jpg/);
  const query = "  pRoOf  ";

  await searchButton(contents).click();
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(proof).toHaveCount(0);

  await showFoundProofInContents(page);
  await expect(search).toHaveValue(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "96");
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  await expect(proof).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(entry(contents, /^Proof 095\.jpg/)).toBeFocused();
});

test("Show in Contents can restore an excluding search and keeps the Finder jump in history", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const proof = entry(contents, /^Proof 096\.jpg/);
  const query = "  prOoF 01  ";
  const path = page.getByRole("navigation", { name: "Folder path" });

  await searchButton(contents).click();
  await search.fill(query);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");

  await showFoundProofInContents(page);
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await expect(proof).toBeInViewport({ ratio: 0.99 });
  await expect(proof).toBeFocused();
  await expect(search).toBeHidden();
  const paused = contents.getByRole("status").filter({ hasText: "Search paused" });
  await expect(paused).toBeVisible();
  await contents.getByRole("button", { name: "Restore search", exact: true }).press("Enter");
  await expect(paused).toBeHidden();
  await expect(search).toHaveValue(query);
  await expect(search).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await expect(proof).toHaveCount(0);

  await path.getByRole("button", { name: "Previous location", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
});

test("a file arc reveals in the matching search saved in its containing folder", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const path = page.getByRole("navigation", { name: "Folder path" });
  for (const folder of ["Projects", "Brand campaign"]) {
    await map.getByRole("button", { name: new RegExp(`^${folder},`) }).press("Enter");
    await expect(currentFolder(page)).toHaveText(folder);
  }
  await page.getByRole("button", { name: "Contents & details", exact: true }).press("Enter");
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  const grid = contents.getByRole("grid");
  const search = searchInput(contents);
  const trailer = entry(contents, /^Trailer master\.mov/);
  await searchButton(contents).press("Enter");
  await search.fill("Trailer master");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");

  await path.getByRole("button", { name: "Studio archive", exact: true }).press("Enter");
  await expect(currentFolder(page)).toHaveText("Studio archive");
  await map.getByRole("button", { name: /^Trailer master\.mov,/ })
    .and(page.locator('[data-node-id*="/Brand campaign/"]')).press("Enter");
  await page.getByRole("button", { name: "Show in Contents", exact: true }).press("Enter");

  await expect(currentFolder(page)).toHaveText("Brand campaign");
  await expect(search).toHaveValue("Trailer master");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  await expect(trailer).toBeFocused();
});

test("Contents restores each folder's search and the selected row across history", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const grid = contents.getByRole("grid");
  await searchButton(contents).click();
  const search = searchInput(contents);
  await search.fill("Surfaces.tif");
  await expect(contents.getByText(/no matches|0 matches/i).first()).toBeVisible();
  await expect(grid).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");

  const parentQuery = "  R  ";
  await search.fill(parentQuery);
  await expect(grid).toHaveAttribute("aria-rowcount", "99");
  // Name order puts the matching subfolder near the end of the virtual list.
  await contents.getByRole("button", { name: "Sort contents", exact: true }).click();
  await page.getByRole("radio", { name: "Name", exact: true }).click();
  await page.getByRole("radio", { name: "Ascending", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(firstEntry(contents)).toHaveAccessibleName(/^Editorial/);
  const folder = entry(contents, /^Reference images/);
  await expect(folder).toHaveCount(0);
  await contents.evaluate((pane) => { pane.scrollTop = pane.scrollHeight; });
  await expect(folder).toBeInViewport({ ratio: 1 });
  const parentScroll = await contents.evaluate((pane) => pane.scrollTop);
  expect(parentScroll).toBeGreaterThan(0);

  await folder.press("Enter");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toBeHidden();
  await expect(grid).toHaveAttribute("aria-rowcount", "2");

  await searchButton(contents).click();
  await search.fill("Surfaces");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");
  const childFile = entry(contents, /^Surfaces\.tif/);
  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(parentQuery);
  await expect(folder).toBeFocused();
  await expect(folder).toBeInViewport({ ratio: 1 });
  await expect.poll(() => contents.evaluate((pane) => pane.scrollTop)).toBeCloseTo(parentScroll, 0);

  await folder.press("Alt+ArrowRight");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toHaveValue("Surfaces");
  await expect(grid).toHaveAttribute("aria-rowcount", "1");

  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toHaveValue(parentQuery);
  await contents.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(searchButton(contents)).toBeFocused();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
  await searchButton(contents).press("Alt+ArrowRight");
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(search).toHaveValue("Surfaces");
  await childFile.press("Alt+ArrowLeft");
  await expect(currentFolder(page)).toHaveText("Photo Library");
  await expect(search).toBeHidden();
  await expect(grid).toHaveAttribute("aria-rowcount", "100");
});

test("a late folder search cannot replace the results of a newer query", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  const delayed = await page.evaluateHandle(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: { query?: string }) => Promise<unknown> };
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = { pending: false, replied: false, release };
    const invoke = bridge.invoke.bind(bridge);
    bridge.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "get_storage_children" && args.query === "Proof 09") {
        request.pending = true;
        await gate;
        request.replied = true;
      }
      return result;
    };
    return request;
  });

  const search = searchInput(contents);
  const grid = contents.getByRole("grid");
  const first = firstEntry(contents);
  try {
    await searchButton(contents).click();
    await search.fill("Proof 09");
    await expect.poll(() => delayed.evaluate((request) => request.pending)).toBe(true);
    await search.fill("Proof 01");
    await expect(grid).toHaveAttribute("aria-rowcount", "10");
    await expect(first).toHaveAccessibleName(/^Proof 010\.jpg/);
  } finally {
    await delayed.evaluate((request) => request.release());
  }

  await expect.poll(() => delayed.evaluate((request) => request.replied)).toBe(true);
  await expect(grid).toHaveAttribute("aria-rowcount", "10");
  await expect(first).toHaveAccessibleName(/^Proof 010\.jpg/);
  await expect(entry(contents, /^Proof 090\.jpg/)).toHaveCount(0);
});
