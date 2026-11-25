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

test("Contents searches immediate entries and clears the filter on folder navigation", async ({ page }) => {
  const contents = await openPhotoLibrary(page);
  await searchButton(contents).click();
  const search = searchInput(contents);
  await search.fill("Surfaces.tif");
  await expect(contents.getByText(/no matches|0 matches/i).first()).toBeVisible();
  await expect(contents.getByRole("grid")).toBeHidden();
  await expect(currentFolder(page)).toHaveText("Photo Library");

  await search.fill("Reference images");
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  await entry(contents, /^Reference images/).click();
  await expect(currentFolder(page)).toHaveText("Reference images");
  await expect(entry(contents, /^Surfaces\.tif/)).toBeVisible();
  await expect(search).toBeHidden();

  await searchButton(contents).click();
  await search.fill("Surfaces");
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "1");
  await contents.getByRole("button", { name: "Close search", exact: true }).click();
  await expect(searchButton(contents)).toBeFocused();
  await expect(contents.getByRole("grid")).toHaveAttribute("aria-rowcount", "2");
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
