import { expect, test, type Page } from "@playwright/test";

function addDialog(page: Page) {
  return page.getByRole("dialog", { name: "Add site", exact: true });
}

async function openSources(page: Page) {
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: /^Sources\b/ }).click();
  return page.getByRole("dialog", { name: "Sources", exact: true });
}

function holdNextDashboardRefresh(page: Page, failure?: string) {
  return page.evaluateHandle((failure) => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = { pending: false, release };
    bridge.invoke = async (command, ...args) => {
      const response = await invoke(command, ...args);
      if (command === "load_dashboard" && !read.pending) {
        read.pending = true;
        await gate;
        if (failure) throw new Error(failure);
      }
      return response;
    };
    return read;
  }, failure);
}

test("adding or dismissing a site leaves the atlas on the folder being explored", async ({ page }) => {
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(folder).toHaveText("Projects");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  const launch = rail.getByRole("button", { name: "Add site" });
  await launch.press("Enter");

  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator("dialog:modal")).toHaveCount(1);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.width).toBeLessThan(page.viewportSize()!.width * 0.75);
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await expect(name).toBeFocused();
  await name.fill("Unfinished draft");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(launch).toBeFocused();
  await expect(folder).toHaveText("Projects");

  await launch.press("Enter");
  await expect(name).toHaveValue("");
  await dialog.getByRole("button", { name: "Close add site" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await name.fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  await expect(rail.getByRole("button", { name: "Open Print masters in Atlas" })).toBeVisible();
  await expect(folder).toHaveText("Projects");
});

test("adding a site from the compact rail reveals its row after inventory refresh", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/mock/");
  const map = page.getByRole("region", { name: "Circular storage map" });
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await map.getByRole("button", { name: /^Projects,/ }).press("Enter");
  await expect(folder).toHaveText("Projects");
  await page.getByRole("button", { name: "Contents & details", exact: true }).click();
  const contents = page.getByRole("tabpanel", { name: "Contents", exact: true });
  await expect(contents.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  const launch = rail.getByRole("button", { name: "Add site" });

  const refresh = await holdNextDashboardRefresh(page);

  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const row = rail.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Open Print masters in Atlas" }) });
  try {
    await expect.poll(() => refresh.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
  } finally {
    await refresh.evaluate((read) => read.release());
  }

  const created = row.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeFocused();
  await expect(row).toBeInViewport({ ratio: 0.98 });
  await expect(row.getByRole("status")).toHaveText("Site added");
  await expect(created).not.toHaveAttribute("aria-current", "true");
  await expect(folder).toHaveText("Projects");
  await expect(contents).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(created).toHaveAttribute("aria-current", "true");
  await expect(folder).toHaveText("Print masters");
  await expect(rail).toBeVisible();
  await expect(contents).toBeVisible();
  await expect(map.getByRole("button", { name: "Scan this site", exact: true })).toBeEnabled();
});

test("a delayed site refresh leaves focus in Contents when browsing resumes", async ({ page }) => {
  await page.goto("/mock/");
  const folder = page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]');
  await expect(folder).toHaveText("Studio archive");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Sites" });
  await expect(rail.getByRole("button", { name: "Open Studio archive in Atlas" })).toBeFocused();
  const refresh = await holdNextDashboardRefresh(page);

  await rail.getByRole("button", { name: "Add site" }).click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Print masters");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Prints");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const contents = page.getByRole("tab", { name: "Contents", exact: true });
  try {
    await expect.poll(() => refresh.evaluate((read) => read.pending)).toBe(true);
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Contents & details", exact: true }).click();
    await expect(contents).toBeFocused();
  } finally {
    await refresh.evaluate((read) => read.release());
  }

  const created = rail.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeVisible();
  await expect(contents).toBeFocused();
  const pane = page.getByRole("tabpanel", { name: "Contents", exact: true });
  await expect(pane.getByRole("heading", { name: "Studio archive", exact: true })).toBeVisible();
});

test("correcting a first site's location preserves the draft through a connection retry", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  const dialog = addDialog(page);
  const local = dialog.getByRole("radio", { name: "Local folder" });
  const smb = dialog.getByRole("radio", { name: "SMB share" });
  const folder = dialog.getByLabel("Folder path");
  const url = dialog.getByLabel("SMB URL");
  const name = dialog.getByLabel("Site name");
  const username = dialog.getByLabel("Username", { exact: true });
  const password = dialog.getByLabel("Password", { exact: true });
  const add = dialog.getByRole("button", { name: "Add site", exact: true });
  const share = "smb://archive.example.test/Field";

  await folder.fill(share);
  await folder.press("Tab");
  await expect(folder).toHaveAttribute("aria-invalid", "true");
  await smb.check();
  await expect(url).toHaveValue(share);
  await username.fill("sample-reader");
  await password.fill("temporary draft");
  await local.check();
  await dialog.getByRole("button", { name: "Browse…" }).click();
  const chosen = await folder.inputValue();
  expect(chosen).not.toBe("");
  await smb.check();
  await expect(username).toHaveValue("sample-reader");
  await expect(password).toHaveValue("");
  await local.check();
  await expect(folder).toHaveValue(chosen);
  await smb.check();
  await expect(url).toHaveValue(share);

  await page.evaluate(() => {
    const { __TAURI_INTERNALS__: bridge } = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, ...args: unknown[]) => Promise<unknown> };
    };
    const invoke = bridge.invoke.bind(bridge);
    let rejectNext = true;
    bridge.invoke = async (command, ...args) => {
      if (command === "connect_smb" && rejectNext) {
        rejectNext = false;
        throw new Error("The share rejected these credentials.");
      }
      return invoke(command, ...args);
    };
  });
  await password.fill("test input");
  await password.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("The share rejected these credentials.");
  await expect(password).toBeFocused();
  await expect(username).toHaveValue("sample-reader");
  await expect(add).toBeDisabled();
  await password.fill("updated test input");
  await password.press("Enter");
  await expect(name).toBeFocused();
  await name.fill("Field archive");

  // Reopening the type passively matches the saved connection. The URL keeps keyboard focus.
  await local.check();
  await smb.check();
  await url.focus();
  await expect(dialog.getByText("Saved connection available", { exact: true })).toBeVisible();
  await expect(url).toBeFocused();
  await dialog.getByRole("button", { name: "Reconnect" }).click();
  await expect(password).toBeFocused();
  await password.fill("renewed test input");
  await password.press("Enter");
  await expect(add).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Scan this site", exact: true })).toBeFocused();
});

test("Settings returns to Add root after explicitly connecting an SMB folder", async ({ page }) => {
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Sites", exact: true }).click();
  await page.getByRole("button", { name: "Manage Studio archive", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Add root", exact: true }).click();
  const share = "smb://archive.example.test/Field";
  await settings.getByLabel("Folder path").fill(share);
  await settings.getByRole("radio", { name: "SMB share" }).check();
  await expect(settings.getByLabel("SMB URL")).toHaveValue(share);
  await settings.getByLabel("Username", { exact: true }).fill("sample-reader");
  const password = settings.getByLabel("Password", { exact: true });
  await password.fill("sample input");
  await password.press("Enter");
  await expect(settings.getByRole("button", { name: "Add root", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings.getByText(share, { exact: true })).toBeVisible();
});

test.describe("compact Settings connections", () => {
  test.use({ viewport: { width: 390, height: 500 }, hasTouch: true });

  async function openConnections(page: Page) {
    await page.goto("/mock/");
    await page.getByRole("button", { name: "Workspace actions", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Settings", exact: true }).press("Enter");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.getByRole("button", { name: "Connections", exact: true }).press("Enter");
    await expect(settings.getByRole("heading", { name: "Saved SMB access", exact: true })).toBeVisible();
    return settings;
  }

  test("verifying saved SMB access keeps the draft and makes a rejected password reachable", async ({ page }) => {
    const settings = await openConnections(page);
    const url = settings.getByLabel("SMB URL", { exact: true });
    const username = settings.getByLabel("Username", { exact: true });
    const password = settings.getByLabel("Password", { exact: true });
    const share = "smb://archive.example.test/Field";
    const message = "Cannot verify access to this sample share.";
    await url.fill(share);
    await username.fill("sample-reader");
    await password.fill("sample input");
    const attempts = await page.evaluateHandle((message) => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = { calls: 0, release };
      bridge.invoke = async (command, args) => {
        if (command === "connect_smb" && ++state.calls === 1) {
          await gate;
          throw new Error(message);
        }
        return invoke(command, args);
      };
      return state;
    }, message);

    try {
      await password.press("Enter");
      const connecting = settings.getByRole("button", { name: "Connecting…", exact: true });
      await expect.poll(() => attempts.evaluate((state) => state.calls)).toBe(1);
      await expect(connecting).toBeDisabled();
      await expect(connecting).toBeFocused();
      await page.keyboard.press("Enter");
      expect(await attempts.evaluate((state) => state.calls)).toBe(1);
    } finally {
      await attempts.evaluate((state) => state.release());
    }

    const error = settings.getByRole("alert").filter({ hasText: message });
    await expect(error).toBeInViewport({ ratio: 0.99 });
    await expect(password).toBeFocused();
    await expect(password).toBeInViewport({ ratio: 0.99 });
    await expect(password).toHaveAccessibleDescription(message);
    await expect(url).toHaveValue(share);
    await expect(username).toHaveValue("sample-reader");
    await expect(password).toHaveValue("sample input");

    await password.fill("updated sample input");
    await page.keyboard.press("Enter");
    await expect(error).toBeHidden();
    await expect(settings.getByText(share, { exact: true })).toBeVisible();
    await expect(settings.getByRole("status").filter({ hasText: "Connection saved." })).toBeInViewport();
    await expect(url).toBeFocused();
    await expect(url).toHaveValue("");
    await expect(username).toHaveValue("");
    await expect(password).toHaveValue("");
  });

  test("read-only path preview returns from SSH cancellation and shows evidence before Save", async ({ page }) => {
    const settings = await openConnections(page);
    const machine = settings.getByRole("combobox", { name: /Remote machine/ });
    const smb = settings.getByLabel("SMB root", { exact: true });
    const native = settings.getByLabel("Native remote root", { exact: true });
    const preview = settings.getByRole("button", { name: "Preview path (read only)", exact: true });
    const share = "smb://media.example.test/Studio";
    const remote = "/srv/media/Studio";
    await machine.selectOption({ label: "Studio server" });
    await smb.fill(share);
    await native.fill(remote);
    const saves = await page.evaluateHandle(() => {
      const { __TAURI_INTERNALS__: bridge } = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> };
      };
      const invoke = bridge.invoke.bind(bridge);
      const state = { count: 0 };
      bridge.invoke = (command, args) => {
        if (command === "add_remote_path_mapping") state.count += 1;
        return invoke(command, args);
      };
      return state;
    });

    const authentication = page.getByRole("dialog", { name: "Verify SSH host fingerprint", exact: true });
    await preview.press("Enter");
    await expect(authentication).toBeVisible();
    await authentication.getByRole("button", { name: "Cancel connection", exact: true }).press("Enter");
    await expect(authentication).toBeHidden();
    await expect(settings.getByRole("alert").filter({ hasText: "SSH connection cancelled." })).toBeInViewport({ ratio: 0.99 });
    await expect(preview).toBeFocused();
    await expect(smb).toHaveValue(share);
    await expect(native).toHaveValue(remote);

    await page.keyboard.press("Enter");
    await expect(authentication).toBeVisible();
    await authentication.getByRole("checkbox", { name: "I independently verified this fingerprint." }).check();
    await authentication.getByRole("button", { name: "Trust fingerprint and connect", exact: true }).press("Enter");
    await expect(authentication).toBeHidden();
    const result = settings.getByRole("region", { name: "Path preview result", exact: true });
    const paths = result.getByText(`${share} → ${remote}`, { exact: true });
    await expect(result).toBeFocused();
    await expect(paths).toBeInViewport({ ratio: 0.99 });
    await expect(result.getByText(/The preview directory and sample files are readable/)).toBeInViewport({ ratio: 0.99 });
    await page.keyboard.press("Tab");
    await expect(result.getByRole("button", { name: "Confirm and save mapping", exact: true })).toBeFocused();
    expect(await saves.evaluate((state) => state.count)).toBe(0);
    await expect(smb).toHaveValue(share);
    await expect(native).toHaveValue(remote);
  });
});

test("the source library stays open while a site is cancelled or created", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/mock/");
  const sources = await openSources(page);
  const launch = sources.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.click();
  const save = dialog.getByRole("button", { name: "Add site", exact: true });
  await expect(save).toBeDisabled();
  const name = dialog.getByRole("textbox", { name: "Site name" });
  await name.fill("Studio archive");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await name.fill("Print masters");
  await save.click();

  await expect(dialog).toBeHidden();
  const created = sources.getByRole("button", { name: "Open Print masters in Atlas" });
  await expect(created).toBeFocused();
  await expect(created).toBeInViewport({ ratio: 0.98 });
  await expect(sources.getByRole("status").filter({ hasText: /^Site added$/ })).toBeVisible();
  await expect(created).not.toHaveAttribute("aria-current", "true");
  await expect(sources).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sources).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]')).toHaveText("Studio archive");
});

test("Settings keeps the site draft when an SMB root overlaps, then selects the corrected site", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("/mock/");
  await page.getByRole("button", { name: "Workspace actions" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Sites", exact: true }).click();
  const launch = settings.getByRole("button", { name: "Add site", exact: true });
  await launch.click();
  const dialog = addDialog(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(launch).toBeFocused();

  await launch.click();
  const name = dialog.getByRole("textbox", { name: "Site name" });
  const url = dialog.getByRole("textbox", { name: "SMB URL" });
  const submit = dialog.getByRole("button", { name: "Add site", exact: true });
  await name.fill("Print shop");
  await dialog.getByRole("radio", { name: "SMB share" }).check();
  await url.fill("smb://media.example.test/Studio/Prints");
  await dialog.getByRole("checkbox", { name: "Include hidden files" }).uncheck();
  await submit.click();
  const error = dialog.getByRole("alert").filter({ hasText: "overlaps" });
  await expect(error).toContainText("in site Team share");
  await expect(error).toBeFocused();
  await expect(name).toHaveValue("Print shop");
  await expect(url).toHaveValue("smb://media.example.test/Studio/Prints");
  await expect(dialog.getByRole("checkbox", { name: "Include hidden files" })).not.toBeChecked();

  await url.fill("smb://media.example.test/Prints");
  await dialog.getByRole("textbox", { name: "Username" }).fill("sample-reader");
  await dialog.getByRole("textbox", { name: "Password" }).fill("sample input");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(dialog).toBeHidden();
  const created = settings.getByRole("button", { name: /^Print shop\b/ });
  await expect(created).toBeFocused();
  await expect(created).toBeInViewport({ ratio: 0.98 });
  await expect(created).toHaveAttribute("aria-current", "true");
  await expect(settings.getByRole("heading", { name: "Print shop" })).toBeVisible();
  await expect(settings.getByText("SMB · Hidden skipped")).toBeVisible();
});

for (const retry of [false, true]) {
  test(`the first registered site ${retry ? "hands focus to its retry and then Scan" : "keeps newer focus while its map opens"}`, async ({ page }) => {
    await page.setViewportSize(retry ? { width: 320, height: 480 } : { width: 1080, height: 700 });
    await page.goto("/mock/?scenario=empty");
    const map = page.getByRole("region", { name: "Circular storage map" });
    const add = map.getByRole("button", { name: "Add site", exact: true });
    await add.press("Enter");
    const dialog = addDialog(page);
    const name = "Field survey archive";
    await dialog.getByRole("textbox", { name: "Site name" }).fill(name);
    await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Field survey archive");
    const diagnostic = "The new site's dashboard could not be read.";
    const read = await holdNextDashboardRefresh(page, retry ? diagnostic : undefined);
    const status = map.getByRole("status").filter({ hasText: "Site added" });
    const actions = page.getByRole("button", { name: "Workspace actions", exact: true });
    await dialog.getByRole("button", { name: "Add site", exact: true }).press("Enter");
    try {
      await expect.poll(() => read.evaluate((result) => result.pending)).toBe(true);
      await expect(dialog).toBeHidden();
      await expect(status.getByText(name, { exact: true })).toBeInViewport({ ratio: 0.99 });
      await expect(status).toContainText("Opening site…");
      await expect(status).toBeFocused();
      await expect(add).toHaveCount(0);
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      if (!retry) await actions.focus();
    } finally {
      await read.evaluate((result) => result.release());
    }
    if (retry) {
      const failure = map.getByRole("alert").filter({ hasText: diagnostic });
      await expect(status).toContainText("Map unavailable");
      const again = failure.getByRole("button", { name: "Try again" });
      await expect(again).toBeFocused();
      const nextRead = await holdNextDashboardRefresh(page);
      await again.press("Enter");
      try {
        await expect.poll(() => nextRead.evaluate((result) => result.pending)).toBe(true);
        await expect(status).toContainText("Opening site…");
        await expect(status).toBeFocused();
      } finally {
        await nextRead.evaluate((result) => result.release());
      }
    }
    const scan = map.getByRole("button", { name: "Scan this site", exact: true });
    await expect(scan).toBeEnabled();
    await expect(status).toHaveCount(0);
    await expect(retry ? scan : actions).toBeFocused();
  });
}

test("an empty atlas opens Add site within a short viewport", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 320 });
  await page.goto("/mock/?scenario=empty");
  const launch = page.getByRole("button", { name: "Add site", exact: true });
  await expect(launch).toBeInViewport({ ratio: 0.99 });
  await launch.click();
  const dialog = addDialog(page);
  await dialog.getByRole("radio", { name: "SMB share" }).press("Space");
  await dialog.getByRole("textbox", { name: "SMB URL" }).fill("smb://media.example.test/Prints");
  await dialog.getByRole("textbox", { name: "Username" }).scrollIntoViewIfNeeded();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Close add site" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Add site", exact: true })).toBeInViewport({ ratio: 1 });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThan(640);
  expect(box!.height).toBeLessThan(320);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(launch).toBeFocused();

  await launch.press("Enter");
  await dialog.getByRole("textbox", { name: "Site name" }).fill("First archive");
  await dialog.getByRole("textbox", { name: "Folder path" }).fill("/demo/Archive");
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();
  const sites = page.getByRole("button", { name: "Sites", exact: true });
  await expect(page.getByRole("button", { name: "Scan this site", exact: true })).toBeFocused();
  await sites.press("Enter");
  const selected = page.getByRole("button", { name: "Open First archive in Atlas" });
  await expect(selected).toHaveAttribute("aria-current", "true");
});

test("the first scan can be started, stopped and restarted from the atlas", async ({ page }) => {
  await page.goto("/mock/?scenario=empty");
  await page.getByRole("button", { name: "Add site", exact: true }).click();
  const dialog = addDialog(page);
  await dialog.getByRole("textbox", { name: "Site name" }).fill("Field survey");
  await dialog.getByRole("button", { name: "Browse…" }).click();
  await dialog.getByRole("button", { name: "Add site", exact: true }).click();

  const map = page.getByRole("region", { name: "Circular storage map" });
  const scan = map.getByRole("button", { name: "Scan this site", exact: true });
  await expect(map.getByText("Ready to scan", { exact: true })).toBeVisible();
  await scan.press("Enter");
  await expect(map.getByText("Finding files", { exact: true })).toBeVisible();
  await map.getByRole("button", { name: "Stop scan", exact: true }).click();
  const restart = map.getByRole("button", { name: /^Restart scan\b/ });
  await expect(restart).toBeEnabled();

  await restart.press("Enter");
  await expect(map.getByRole("button", { name: /^Sample Folder,/ })).toBeFocused({ timeout: 15_000 });
  const folder = map.getByRole("button", { name: /^Drone imagery,/ });
  await expect(folder).toBeVisible();
  await expect(scan).toBeHidden();
  await folder.press("Enter");
  await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]'))
    .toHaveText("Drone imagery");
});

test.describe("first site on a short touch display", () => {
  test.use({ hasTouch: true, viewport: { width: 640, height: 320 } });

  test("tapping Scan leaves the new inventory ready to browse with the keyboard", async ({ page }) => {
    await page.goto("/mock/?scenario=empty");
    await page.getByRole("button", { name: "Add site", exact: true }).tap();
    const dialog = addDialog(page);
    await dialog.getByRole("textbox", { name: "Site name" }).fill("Field survey");
    await dialog.getByRole("button", { name: "Browse…" }).tap();
    await dialog.getByRole("button", { name: "Add site", exact: true }).press("Enter");

    const map = page.getByRole("region", { name: "Circular storage map" });
    const scan = map.getByRole("button", { name: "Scan this site", exact: true });
    await expect(scan).toBeFocused();
    await expect(scan).toBeInViewport({ ratio: 1 });
    await scan.tap();

    const root = map.getByRole("button", { name: /^Sample Folder,/ });
    await expect(root).toBeFocused({ timeout: 15_000 });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("navigation", { name: "Folder path" }).locator('[aria-current="location"]'))
      .toHaveText("Sample Folder");
  });
});
