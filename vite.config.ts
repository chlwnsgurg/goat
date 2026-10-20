import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

// GOAT tests that still select jsdom per file. Move each to a *.browser.test file or a Vitest
// project environment, then drop it here.
const DOM_TEST_ENVIRONMENT_ALLOWLIST: Array<string> = [
  "apps/mobile/src/components/MediaVideoPlayer.test.tsx",
  "apps/mobile/src/features/cloud/CloudAuthProvider.disabled.test.tsx",
  "apps/mobile/src/features/cloud/CloudAuthProvider.test.ts",
  "apps/mobile/src/features/decisions/useDecisionInbox.test.tsx",
  "apps/mobile/src/features/goat-bot/GoatBotBubble.test.tsx",
  "apps/mobile/src/features/goat-bot/GoatBotDayStamp.test.tsx",
  "apps/mobile/src/features/goat-bot/GoatBotScreen.appearance.test.tsx",
  "apps/mobile/src/features/goat-bot/GoatBotScreen.memory.test.tsx",
  "apps/mobile/src/features/goat-bot/GoatBotTimelineRow.test.tsx",
  "apps/mobile/src/features/goat-bot/MobileGoatBotHomeWorker.test.tsx",
  "apps/mobile/src/features/goat-bot/useMobileGoatBotHomeSettings.test.tsx",
  "apps/mobile/src/features/goat-bot/useMobileGoatBotSession.test.tsx",
  "apps/mobile/src/features/goat-bot/useReplying.test.tsx",
  "apps/mobile/src/features/settings/MemorySyncDiagnostics.test.tsx",
  "apps/mobile/src/features/settings/SettingsMemoryRouteScreen.test.tsx",
  "apps/mobile/src/features/threads/HumanHandoffCard.test.tsx",
  "apps/mobile/src/features/threads/SubagentRow.memory.test.tsx",
  "apps/mobile/src/features/threads/ThreadHeader.memory.test.tsx",
  "apps/mobile/src/features/threads/ThreadMarkdownImage.test.tsx",
  "apps/mobile/src/features/threads/useThreadHeaderOptions.test.tsx",
  "apps/mobile/src/lib/visible-animations.test.tsx",
  "apps/web/src/components/ChatView.ssh.test.tsx",
  "apps/web/src/components/ComposerPromptEditorTiptap.mount.test.tsx",
  "apps/web/src/components/RelativeTimeLabel.test.tsx",
  "apps/web/src/components/ThreadRouteView.test.tsx",
  "apps/web/src/components/chat/ChatComposer.ssh.test.tsx",
  "apps/web/src/components/chat/ChatHeader.memory.test.tsx",
  "apps/web/src/components/chat/HandoffCard.test.tsx",
  "apps/web/src/components/chat/V2ItemInspector.test.tsx",
  "apps/web/src/components/chat/useAssistantCitationTarget.test.tsx",
  "apps/web/src/components/decisions/DecisionInbox.test.tsx",
  "apps/web/src/components/decisions/DecisionUserInputForm.test.tsx",
  "apps/web/src/components/files/AttachmentFilePreview.media.test.tsx",
  "apps/web/src/components/files/FileMarkdownSelectionToolbar.test.tsx",
  "apps/web/src/components/files/FilePreviewPanel.test.ts",
  "apps/web/src/components/files/ProjectFilePicker.test.tsx",
  "apps/web/src/components/files/pdf/PdfFilePreview.test.tsx",
  "apps/web/src/components/files/pdf/pdfSearch.test.ts",
  "apps/web/src/components/goatBot/GoatBotChatView.empty.test.tsx",
  "apps/web/src/components/goatBot/GoatBotComposer.test.tsx",
  "apps/web/src/components/goatBot/GoatBotSidebarRow.preview.test.tsx",
  "apps/web/src/components/goatBot/GoatBotThreadView.visit.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.arrive.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.memory.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.receipt.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.replying.test.tsx",
  "apps/web/src/components/goatBot/GoatBotTimeline.time.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotHome.strictMode.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotHome.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotReadMenu.test.tsx",
  "apps/web/src/components/goatBot/useGoatBotSession.test.tsx",
  "apps/web/src/components/media/MediaImagePreview.test.tsx",
  "apps/web/src/components/media/MediaVideoPlayer.test.tsx",
  "apps/web/src/components/preview/PreviewAddressBar.test.tsx",
  "apps/web/src/components/settings/CodexHomeRouteSection.test.tsx",
  "apps/web/src/components/settings/ConnectionEnvironmentsSection.test.tsx",
  "apps/web/src/components/settings/HubDeviceCard.test.tsx",
  "apps/web/src/components/settings/MemoryScopePicker.test.tsx",
  "apps/web/src/components/settings/MemoryScopeSettings.subscriptions.test.tsx",
  "apps/web/src/components/settings/MemorySettings.test.tsx",
  "apps/web/src/components/settings/SshRuntimeSettingsRow.test.tsx",
  "apps/web/src/components/settings/settingsDrafts.test.tsx",
  "apps/web/src/components/sidebar/SidebarChrome.test.tsx",
  "apps/web/src/components/sidebar/SidebarEnvironmentConnection.test.tsx",
  "apps/web/src/components/sidebar/useThreadContextDrag.test.ts",
  "apps/web/src/fileContextMenu.test.ts",
  "apps/web/src/filePathCopy.test.ts",
  "apps/web/src/hooks/settingsPersistence.hook.test.tsx",
  "apps/web/src/hooks/useCopyConnectionDiagnostic.test.tsx",
  "apps/web/src/lib/memoryImportRecoveryStorage.test.ts",
  "apps/web/src/lib/storageMigration.integration.test.ts",
];

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@goat/client-runtime",
    message:
      "Import from an explicit @goat/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
];

const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "~/components/solar",
  importNames: [
    "GitMergeIcon",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraftIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

/** Web icons are Solar Linear and come from one module, so every surface draws the same set. */
const RESTRICTED_ICON_LIBRARY_IMPORTS = ["lucide-react", "lucide"].map((name) => ({
  name,
  message: "Import icons from ~/components/solar (Solar Linear) so the app keeps one icon set.",
}));

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/.t3/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      // Macroscope's glob-per-line ignore grammar, not Markdown: formatting
      // it rewrites `*` as `_` and joins lines.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/solar.generated.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/solar.generated.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-goat/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "goat/no-global-process-runtime": "error",
      "goat/no-inline-schema-compile": "warn",
      "goat/no-low-value-comments": "error",
      "goat/no-manual-effect-runtime-in-tests": "error",
      "goat/no-native-title-tooltip": "error",
      "goat/no-raw-mcp-registration": "error",
      "goat/no-test-in-loop": "error",
      "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }],
      "goat/no-unscoped-has": "error",
      "goat/namespace-node-imports": "error",
      "goat/prefer-catch-tags": "error",
      "goat/require-centered-scroll-gutter": "error",
      "goat/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: ["apps/**/src/**", "packages/**/src/**"],
        excludeFiles: DOM_TEST_ENVIRONMENT_ALLOWLIST,
        rules: { "goat/no-dom-test-environment": "error" },
      },
      {
        files: ["packages/client-runtime/src/state/**", "apps/{web,mobile,desktop}/src/**"],
        rules: { "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
      },
      {
        files: [
          "packages/client-runtime/src/state/runtime.ts",
          "packages/client-runtime/src/state/vcsAction.ts",
        ],
        rules: {
          "goat/no-rpc-permission-bypass": [
            "error",
            { allowGuardInstallation: true, allowRawClientAccess: false },
          ],
        },
      },
      {
        files: [
          "apps/web/src/components/settings/ConnectionsSettings.tsx",
          "apps/mobile/src/features/updates/app-updates.ts",
          "apps/web/src/components/device/DevicePhoneViewport.tsx",
          "apps/web/src/components/device/DeviceDuoViewport.tsx",
        ],
        rules: { "goat/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        files: ["packages/client-runtime/src/connection/outdatedHostUpdate.ts"],
        rules: { "goat/no-rpc-permission-bypass": "off" },
      },
      {
        files: [
          "packages/client-runtime/src/rpc/**",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "goat/no-rpc-permission-bypass": "off" },
      },
      {
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "goat/no-global-process-runtime": "off" },
      },
      {
        // The `t3` npm launcher is published as plain, dependency-free Node.
        files: ["scripts/npm-launcher/**"],
        rules: {
          "goat/no-global-process-runtime": "off",
          "goat/namespace-node-imports": "off",
        },
      },
      {
        files: ["apps/server/src/mcp/McpHttpServer.ts"],
        rules: { "goat/no-raw-mcp-registration": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [
                ...RESTRICTED_IMPORT_PATHS,
                ...RESTRICTED_ICON_LIBRARY_IMPORTS,
                RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS,
              ],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            { paths: [...RESTRICTED_IMPORT_PATHS, ...RESTRICTED_ICON_LIBRARY_IMPORTS] },
          ],
        },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: { "goat/no-mobile-uniwind-theme-escape-hatches": "error" },
      },
      {
        files: ["apps/mobile/src/**"],
        excludeFiles: [
          "apps/mobile/src/components/ui/AppSymbol.tsx",
          "apps/mobile/src/components/ui/AppSymbol.ios.tsx",
          "apps/mobile/src/features/pull-requests/pullRequestGlyphs.ts",
        ],
        rules: { "goat/no-mobile-pull-request-glyph-literals": "error" },
      },
      {
        // React commits state set in a raw ResizeObserver callback after the paint, so derived
        // layout lands a frame late. observeResize flushes every observed resize in one render.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "goat/no-raw-resize-observer": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "goat/no-outset-state-indicators": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks (brand logos, the macOS permission panes, Codex's Computer Use
        // mark) must keep their exact colors, so the files that hold them are exempt.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "transition",
                "rounded-[inherit]",
                "gap-[0.33em]",
                "px-[0.5em]",
                "rounded-[0.5em]",
                "text-[0.86em]",
                "rounded-[25%]",
                "text-[length:80cqh]",
                "bg-[Highlight]",
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // Every web file must compile under the React Compiler. Its bailout rules are errors here,
        // and manual memoization is redundant. No upstream rule bans useMemo/useCallback, hence
        // goat/no-manual-memo.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "react/exhaustive-effect-dependencies": "error",
          "react/globals": "error",
          "react/hooks": "error",
          "react/immutability": "error",
          // The compiler memoizes context values; this rule would ask for useMemo.
          "react/jsx-no-constructed-context-values": "off",
          "react/memo-dependencies": "error",
          "react/preserve-manual-memoization": "error",
          "react/purity": "error",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "goat/no-manual-memo": "error",
        },
      },
      {
        // The sign-in masthead is T3 brand artwork: fixed gradients, not theme surfaces.
        files: ["apps/web/src/components/auth/AuthSurfaceShell.tsx"],
        rules: { "shadcn/no-arbitrary-values": "off" },
      },
      {
        // Shared client code must not call APIs missing from Hermes. Our ESNext
        // TypeScript target accepts them even when they would crash mobile at launch.
        // Tests run on Node and are exempt.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "goat/no-hermes-unsupported-apis": "error" },
      },
      {
        // Mobile is ratcheting toward full React Compiler coverage
        // (apps/mobile/src/reactCompilerCoverage.test.ts). Directives would hide bailouts from it;
        // the manual memo hooks go once the allowlist there is empty.
        files: ["apps/mobile/src/**/*.{ts,tsx}"],
        rules: { "goat/no-manual-memo": ["error", { allowMemoHooks: true }] },
      },
      {
        // The compiler only compiles a use* function that calls a hook; one that calls none is
        // silently left as a plain function, so whatever it returns loses its caching.
        files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "goat/no-hookless-use-function": "error" },
      },
      {
        files: [
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/home/HomeHeader.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
          "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/settings/appearance/components/FontSizeSliderRow.tsx",
          "apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx",
          "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-items.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/T3ComposerEditor.ios.tsx",
          "apps/mobile/src/native/T3ComposerEditor.native.tsx",
          "apps/mobile/src/native/SelectableMarkdownText.tsx",
        ],
        rules: {
          "goat/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
