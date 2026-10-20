// @effect-diagnostics nodeBuiltinImport:off - existence of Playwright's browser binary is a Node filesystem check.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import * as HostProcess from "@goat/shared/HostProcess";

import { presentAsChrome } from "./ServerBrowserContexts.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";

// `chromium.launch({ headless: true })` starts chromium-headless-shell.
// `chromium.executablePath()` is the full Chrome build, so it stays missing
// after `install --only-shell`. Linux CI installs the shell; a Mac checkout
// often has not. Skip the live cases instead of failing the file. The drag
// case below does not launch anything.
const chromiumInstalled = (() => {
  try {
    const require = NodeModule.createRequire(import.meta.url);
    const packageRoot = NodePath.dirname(require.resolve("playwright-core/package.json"));
    const browsers = JSON.parse(
      NodeFS.readFileSync(NodePath.join(packageRoot, "browsers.json"), "utf8"),
    ) as {
      browsers: ReadonlyArray<{ name: string; revision: string }>;
    };
    const revision = browsers.browsers.find(
      (browser) => browser.name === "chromium-headless-shell",
    )?.revision;
    if (revision === undefined) return false;
    const platform = HostProcess.Platform.defaultValue();
    const arch = HostProcess.Architecture.defaultValue();
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const registry =
      browsersPath === "0"
        ? NodePath.join(packageRoot, ".local-browsers")
        : browsersPath
          ? NodePath.resolve(process.env.INIT_CWD || process.cwd(), browsersPath)
          : NodePath.join(
              platform === "linux"
                ? process.env.XDG_CACHE_HOME || NodePath.join(NodeOS.homedir(), ".cache")
                : platform === "darwin"
                  ? NodePath.join(NodeOS.homedir(), "Library", "Caches")
                  : process.env.LOCALAPPDATA || NodePath.join(NodeOS.homedir(), "AppData", "Local"),
              "ms-playwright",
            );
    const directory = NodePath.join(registry, `chromium_headless_shell-${revision}`);
    const executable =
      platform === "win32"
        ? ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]
        : platform === "darwin"
          ? [
              arch === "arm64"
                ? "chrome-headless-shell-mac-arm64"
                : "chrome-headless-shell-mac-x64",
              "chrome-headless-shell",
            ]
          : arch === "arm64"
            ? ["chrome-linux", "headless_shell"]
            : ["chrome-headless-shell-linux64", "chrome-headless-shell"];
    return NodeFS.existsSync(NodePath.join(directory, ...executable));
  } catch {
    return false;
  }
})();

describe.skipIf(!chromiumInstalled)("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

  it("captures a full document without changing viewport, scroll, or responsive layout", async () => {
    await page.setViewportSize({ width: 800, height: 600 });
    await page.setContent(
      "<style>body{margin:0} main{height:2900px} footer{height:100px;background:rgb(255,0,0)}</style><main>Long page</main><footer></footer>",
    );
    await page.evaluate("scrollTo(0, 450)");
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      fullPage: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
    expect(result.screenshot).toMatchObject({ width: 800, height: 3000, clipped: false });
    const bottomPixel = await page.evaluate(`(async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${result.screenshot.data}";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(10, 2990, 1, 1).data);
    })()`);
    expect(bottomPixel).toEqual([255, 0, 0, 255]);
    expect(page.viewportSize()).toEqual({ width: 800, height: 600 });
    expect(
      await page.evaluate("({x: scrollX, y: scrollY, width: innerWidth, height: innerHeight})"),
    ).toEqual({ x: 0, y: 450, width: 800, height: 600 });
    const viewport = await takeSnapshot();
    expect(viewport.screenshot).toMatchObject({ width: 800, height: 600 });
  });

  it("captures CSS pixels from a real Retina document", async () => {
    const retina = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
    });
    try {
      const retinaPage = await retina.newPage();
      await retinaPage.setContent("<style>body{margin:0;height:3000px}</style>Retina");
      const result = await ServerBrowserPage.snapshot({
        page: retinaPage,
        cdp: await retina.newCDPSession(retinaPage),
        renderScale: 2,
        fullPage: true,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      });
      expect(result.screenshot).toMatchObject({ width: 800, height: 3000, clipped: false });
      const image = Buffer.from(result.screenshot.data, "base64");
      expect(image.readUInt32BE(16)).toBe(800);
      expect(image.readUInt32BE(20)).toBe(3000);
      expect(result.screenshot.byteLength).toBe(image.length);
      expect(result.screenshot.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      await retina.close();
    }
  });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    // Page text masks the same values, so it can't be compared against the tree.
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    // Masked before the cut, so no prefix of the value is left.
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs on takeover and issues usable refs in the next snapshot", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    ServerBrowserPage.invalidateRefs(page);
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    const fresh = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await ServerBrowserPage.click(page, { locator: fresh });
    expect(await page.locator("button").textContent()).toBe("clicked");
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("only accepts refs from the most recent snapshot", async () => {
    await page.setContent("<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await takeSnapshot();
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves CSS selectors containing an aria-ref attribute", async () => {
    await page.setContent(
      '<button aria-ref="save" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[aria-ref="save"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });

  it("presents a headless page as Chrome, with client hints that agree", async () => {
    await presentAsChrome(cdp, { platform: "linux", arch: "x64" });
    // userAgentData exists only in secure contexts; https comes from a route.
    let secChUa: string | undefined;
    await page.route("https://example.test/", (route) => {
      secChUa = route.request().headers()["sec-ch-ua"];
      return route.fulfill({ contentType: "text/html", body: "<p>hi</p>" });
    });
    await page.goto("https://example.test/");
    const identity = (await page.evaluate(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands.map((brand) => brand.brand),
      full: (await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]))
        .fullVersionList.map((brand) => brand.brand),
    }))()`)) as { userAgent: string; brands: string[]; full: string[] };
    expect(identity.userAgent).not.toContain("Headless");
    expect(identity.userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
    expect(identity.brands).toContain("Google Chrome");
    expect([...identity.brands, ...identity.full].join()).not.toContain("Headless");
    expect(secChUa).toContain('"Google Chrome"');
    expect(secChUa).not.toContain("Headless");
  });

  it.each(["hidden", "detached"] as const)("waits for an element to become %s", async (state) => {
    await page.setContent('<div id="dialog">Dialog</div>');
    const waiting = ServerBrowserPage.waitFor(page, {
      locator: "#dialog",
      state,
      timeoutMs: 1_000,
    });
    let finished = false;
    void waiting.then(() => {
      finished = true;
    });
    await page.evaluate("document.body.innerText");
    expect(finished).toBe(false);
    await page.evaluate(state === "hidden" ? 'dialog.style.display = "none"' : "dialog.remove()");
    await waiting;
    expect(await page.locator("#dialog").count()).toBe(state === "hidden" ? 1 : 0);
    expect(await page.locator("#dialog").isVisible()).toBe(false);
  });

  it("keeps legacy attachment waits for hidden and repeated matches", async () => {
    await page.setContent('<div class="match" hidden>one</div><div class="match" hidden>two</div>');
    await ServerBrowserPage.waitFor(page, { selector: ".match", timeoutMs: 1_000 });
  });

  it("requires all conditions to hold together, including same-document URL changes", async () => {
    await page.route("https://wait.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="ready">Ready</div>',
      }),
    );
    await page.goto("https://wait.test/");
    const waiting = ServerBrowserPage.waitFor(page, {
      locator: "#ready",
      state: "visible",
      text: "Done",
      urlIncludes: "#done",
      timeoutMs: 1_000,
    });
    await page.evaluate(
      'ready.hidden = true; document.body.append("Done"); history.pushState({}, "", "#done")',
    );
    let finished = false;
    void waiting.then(() => {
      finished = true;
    });
    // A round trip after every other condition holds must not finish a hidden-target wait.
    await page.evaluate("document.body.innerText");
    expect(finished).toBe(false);
    await page.evaluate("ready.hidden = false");
    await waiting;
    expect(page.url()).toBe("https://wait.test/#done");
  });

  it("follows a replacement document instead of accepting the old document's load", async () => {
    const routed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "image") {
        routed.resolve();
        await release.promise;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<p>New document</p><img src="/slow.png">',
      });
    });
    const waiting = ServerBrowserPage.waitFor(page, {
      text: "New document",
      urlIncludes: "wait.test",
      loadState: "load",
      timeoutMs: 1_000,
    });
    let finished = false;
    void waiting.then(() => {
      finished = true;
    });
    try {
      await page.goto("https://wait.test/", { waitUntil: "domcontentloaded" });
      await routed.promise;
      expect(await page.evaluate("document.readyState")).toBe("interactive");
      expect(finished).toBe(false);
      release.resolve();
      await waiting;
      expect(await page.evaluate("document.readyState")).toBe("complete");
    } finally {
      release.resolve();
    }
  });

  it("times out at the requested load milestone", async () => {
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "image") {
        requested.resolve();
        await release.promise;
      }
      await route.fulfill({ contentType: "text/html", body: '<img src="/slow.png">' });
    });
    try {
      await page.goto("https://wait.test/", { waitUntil: "domcontentloaded" });
      await requested.promise;
      await ServerBrowserPage.waitFor(page, { loadState: "domContentLoaded", timeoutMs: 1_000 });
      await expect(
        ServerBrowserPage.waitFor(page, { loadState: "load", timeoutMs: 100 }),
      ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    } finally {
      release.resolve();
    }
  });

  it("only waits for network idle when explicitly requested, with a bounded deadline", async () => {
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await page.route("https://wait.test/**", async (route) => {
      if (route.request().resourceType() === "fetch") {
        requested.resolve();
        await release.promise;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<p>Ready</p><script>fetch("/busy")</script>',
      });
    });
    try {
      await page.goto("https://wait.test/");
      await requested.promise;
      await ServerBrowserPage.waitFor(page, { text: "Ready", timeoutMs: 1_000 });
      await expect(
        ServerBrowserPage.waitFor(page, { loadState: "networkIdle", timeoutMs: 100 }),
      ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
      release.resolve();
      await ServerBrowserPage.waitFor(page, { loadState: "networkIdle", timeoutMs: 1_000 });
    } finally {
      release.resolve();
    }
  });

  it("stops an evaluation at its deadline so the page answers the next one", async () => {
    await expect(
      ServerBrowserPage.evaluate(cdp, { expression: "for (;;) {}" }, 200),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await ServerBrowserPage.evaluate(cdp, { expression: "1 + 1" }, 2_000)).toBe(2);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
