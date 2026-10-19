import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const addProvider = vi.hoisted(() => ({
  canManage: true,
  // Set by the harness so the stand-in dialog can publish the snapshot the server would.
  publish: (_instanceId: string) => {},
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((environmentId: string | null, scope: string) =>
    environmentId !== null && scope === "providers:manage" && addProvider.canManage) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((environmentId: string | null) =>
    environmentId ? { label: "Studio Mac" } : null) as never,
}));
// The wizard talks to the environment over RPC; this stand-in finishes setup the way it reports back.
vi.mock(import("../settings/AddProviderInstanceDialog"), async (original) => ({
  ...(await original()),
  AddProviderInstanceDialog: ((props: {
    environmentLabel: string;
    onOpenChange: (open: boolean) => void;
    onFinished?: (result: { instanceId: ProviderInstanceId; signedIn: boolean }) => void;
  }) => (
    <div role="dialog" aria-label="Add provider">
      {props.environmentLabel}
      <button
        type="button"
        onClick={() => {
          addProvider.publish("claude_new");
          props.onFinished?.({ instanceId: ProviderInstanceId.make("claude_new"), signedIn: true });
          props.onOpenChange(false);
        }}
      >
        Finish setup
      </button>
      <button type="button" onClick={() => props.onOpenChange(false)}>
        Close setup
      </button>
    </div>
  )) as never,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

const favoritesAtom = Atom.make<ReadonlyArray<{ provider: ProviderInstanceId; model: string }>>(
  [],
).pipe(Atom.keepAlive);

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: useAtomValue(favoritesAtom),
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => {
    const setFavorites = useAtomSet(favoritesAtom);
    return async (provider: ProviderInstanceId, model: string) => {
      setFavorites((favorites) =>
        favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model),
      );
    };
  },
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => vi.fn(),
}));

let pickerRoot: Root | undefined;
let pickerRegistry: AtomRegistry.AtomRegistry | undefined;

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

afterEach(async () => {
  if (pickerRoot) await act(async () => pickerRoot!.unmount());
  pickerRoot = undefined;
  pickerRegistry?.dispose();
  pickerRegistry = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

// Returns the trigger's visible text, which is what the user reads before opening the picker.
async function triggerText(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  const text = container.querySelector("button")?.textContent ?? "";
  await act(async () => root.unmount());
  return text;
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return triggerText(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {})}
    />,
  );
}

async function click(target: Parameters<typeof userEvent.click>[0]) {
  await act(async () => userEvent.click(target));
}

async function openLegacyPicker(activeModel: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const entry = providerEntry("codex", "codex");
  pickerRegistry = AtomRegistry.make();
  pickerRegistry.set(favoritesAtom, [
    { provider: entry.instanceId, model: "current-favorite" },
    { provider: entry.instanceId, model: "legacy-favorite" },
  ]);
  pickerRoot = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    pickerRoot!.render(
      <RegistryContext.Provider value={pickerRegistry!}>
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={entry.instanceId}
          model={activeModel}
          lockedProvider={null}
          instanceEntries={[entry]}
          modelOptionsByInstance={
            new Map([
              [
                entry.instanceId,
                [
                  { slug: "current", name: "Current model" },
                  { slug: "legacy-favorite", name: "Legacy favorite", isLegacy: true },
                  { slug: "current-favorite", name: "Current favorite" },
                  { slug: "other-legacy", name: "Other legacy", isLegacy: true },
                ],
              ],
            ])
          }
          onInstanceModelChange={() => {}}
        />
      </RegistryContext.Provider>,
    ),
  );
  await click(document.querySelector("button")!);
  await click(page.getByRole("button", { name: entry.displayName, exact: true }));
}

describe("ProviderModelPicker", () => {
  it("hoists legacy favorites in provider order and returns an unfavorited model to legacy", async () => {
    await openLegacyPicker("current");
    const legacyFavorite = page.getByRole("option", { name: /Legacy favorite/ });
    const currentFavorite = page.getByRole("option", { name: /Current favorite/ });
    const current = page.getByRole("option", { name: /Current model/ });
    const legacySection = page.getByRole("option", { name: /Legacy models/ });

    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(currentFavorite).toBeVisible();
    await expect.element(current).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeLessThan(
      currentFavorite.element().getBoundingClientRect().top,
    );
    expect(currentFavorite.element().getBoundingClientRect().top).toBeLessThan(
      current.element().getBoundingClientRect().top,
    );

    await click(legacyFavorite.getByRole("button", { name: "Remove from favorites" }));
    await expect.element(legacyFavorite).not.toBeInTheDocument();
    await click(legacySection);
    await expect.element(legacyFavorite).toBeVisible();
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
    expect(legacyFavorite.element().getBoundingClientRect().top).toBeGreaterThan(
      legacySection.element().getBoundingClientRect().top,
    );
    await expect
      .element(legacyFavorite.getByRole("button", { name: "Add to favorites" }))
      .toBeVisible();
  });

  it("keeps unrelated legacy models collapsed when the active model is a favorite", async () => {
    await openLegacyPicker("legacy-favorite");

    await expect.element(page.getByRole("option", { name: /Legacy favorite/ })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: /Other legacy/ }))
      .not.toBeInTheDocument();
    await click(page.getByRole("option", { name: /Legacy models/ }));
    await expect.element(page.getByRole("option", { name: /Other legacy/ })).toBeVisible();
  });

  it("shows a neutral aggregate value without a representative model or availability badge", async () => {
    const label = await renderPicker({
      instanceId: "codex_personal",
      driver: "codex",
      model: "gpt-5",
      options: [{ slug: "gpt-5", name: "GPT 5", isUnavailable: true }],
      triggerLabel: "Mixed values",
    });
    expect(label).toContain("Mixed values");
    expect(label).not.toContain("GPT 5");
    expect(label).not.toContain("Unavailable");
  });

  it.each(["", ANTIGRAVITY_DEFAULT_MODEL])(
    "shows a choice prompt before Antigravity has an account catalog for %s",
    async (model) => {
      const label = await renderPicker({
        instanceId: "antigravity",
        driver: "antigravity",
        model,
        options: [],
      });

      expect(label).toContain("Choose model");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each([{ aliases: [ANTIGRAVITY_DEFAULT_MODEL] }, { isDefault: true }])(
    "shows the actual default model for an Antigravity marker with %j",
    async (defaultMetadata) => {
      const label = await renderPicker({
        instanceId: "google_work",
        driver: "antigravity",
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [
          { slug: "gemini-fast", name: "Gemini Fast" },
          { slug: "gemini-pro", name: "Gemini Pro", ...defaultMetadata },
        ],
      });

      expect(label).toContain("Gemini Pro");
      expect(label).not.toContain("Gemini Fast");
      expect(label).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each(["opencode", "antigravity"])(
    "keeps the selected model label when the %s account catalog does not contain it",
    async (driver) => {
      const label = await renderPicker({
        instanceId: "team_runtime",
        driver,
        model: "missing-model",
        options: [{ slug: "fallback", name: "Fallback model" }],
      });

      expect(label).toContain("missing-model");
      expect(label).not.toContain("Fallback model");
    },
  );

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "uses the first option label for a missing %s model",
    async (driver) => {
      const label = await renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(label).toContain("Fallback model");
      expect(label).not.toContain("missing-model");
    },
  );

  it("prefers a matching model for OpenCode", async () => {
    const label = await renderPicker({
      instanceId: "custom_runtime",
      driver: "opencode",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(label).toContain("Selected model");
    expect(label).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", async () => {
    const label = await renderPicker({
      instanceId: "missing_instance",
      driver: "opencode",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(label).toContain("Fallback model");
    expect(label).not.toContain("missing-model");
  });

  it("keeps instance initials visible in the resting trigger", async () => {
    const activeEntry = providerEntry("codex_personal", "codex");
    const label = await triggerText(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={activeEntry.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex"), activeEntry]}
        modelOptionsByInstance={new Map()}
        size="xs"
        onInstanceModelChange={() => {}}
      />,
    );

    expect(label).toContain("CP");
  });
});

describe("ProviderModelPicker add provider", () => {
  const environmentId = EnvironmentId.make("studio");
  const codex = providerEntry("codex", "codex");
  const models = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
    [codex.instanceId, [{ slug: "gpt-5", name: "GPT 5" }]],
    [ProviderInstanceId.make("claude_new"), [{ slug: "opus", name: "Claude Opus" }]],
  ]);

  function Harness(props: { composer?: boolean }) {
    const [entries, setEntries] = useState([codex, providerEntry("cursor", "cursor")]);
    useEffect(() => {
      addProvider.publish = (instanceId) =>
        setEntries((current) => [...current, providerEntry(instanceId, "claudeAgent")]);
    }, []);
    return (
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={codex.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={models}
        isComposerOwned={props.composer ?? true}
        onInstanceModelChange={() => {}}
      />
    );
  }

  async function openPicker(node: ReactNode) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(node));
    await act(async () => container.querySelector("button")!.click());
    return root;
  }
  const addButton = () =>
    document.querySelector<HTMLButtonElement>("[data-model-picker-add-provider] button");
  const railButton = (label: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-model-picker-sidebar] button[aria-label="${label}"]`,
    );
  const clickText = (label: string) =>
    act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === label)!
        .click(),
    );
  const setupDialog = () => document.querySelector('[role="dialog"][aria-label="Add provider"]');
  // The wizard is code-split, so the first open waits for its chunk.
  const openSetup = async () => {
    await act(async () => addButton()!.click());
    await vi.waitFor(() => expect(setupDialog()).not.toBeNull());
  };

  afterEach(() => {
    addProvider.canManage = true;
  });

  it("ends the rail with Add provider, reachable with the arrow keys", async () => {
    const root = await openPicker(<Harness />);

    expect(addButton()?.getAttribute("aria-label")).toBe("Add provider");
    railButton("Cursor")!.focus();
    await act(async () => userEvent.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(addButton());
    await act(async () => root.unmount());
  });

  it("explains why it is unavailable without providers:manage", async () => {
    addProvider.canManage = false;
    const root = await openPicker(<Harness />);

    expect(addButton()?.getAttribute("aria-label")).toBe(
      "You don't have permission to manage providers on Studio Mac.",
    );
    await act(async () => addButton()!.click());
    expect(setupDialog()).toBeNull();
    await act(async () => root.unmount());
  });

  it("is not offered outside the composer", async () => {
    const root = await openPicker(<Harness composer={false} />);

    expect(railButton("Codex")).not.toBeNull();
    expect(addButton()).toBeNull();
    await act(async () => root.unmount());
  });

  it("opens setup and returns to the picker on the new provider with its models", async () => {
    const root = await openPicker(<Harness />);
    await openSetup();

    expect(setupDialog()?.textContent).toContain("Studio Mac");
    expect(document.querySelector("[data-model-picker-sidebar]")).toBeNull();

    await clickText("Finish setup");
    expect(railButton("Claude New")?.getAttribute("aria-pressed")).toBe("true");
    // The model list is virtualized and fills in after it measures.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-model-picker-content]")?.textContent).toContain(
        "Claude Opus",
      ),
    );
    expect(document.querySelector("[data-model-picker-content]")?.textContent).not.toContain(
      "GPT 5",
    );
    await act(async () => root.unmount());
  });

  it("returns to the picker when setup is closed", async () => {
    const root = await openPicker(<Harness />);
    await openSetup();
    await clickText("Close setup");

    expect(railButton("Codex")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.unmount());
  });
});
