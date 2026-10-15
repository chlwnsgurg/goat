import {
  OrchestratorMcpFailure,
  ProviderDiagnoseInput,
  ProviderDiagnoseResult,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderDiagnosisService from "../../../provider/ProviderDiagnosisService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Agent surface path `provider.diagnose` (docs/internals/agent-surface.md). The
// registry lane reads this name from the registry once it lands.
const ProviderDiagnoseTool = Tool.make("goat_provider_diagnose", {
  description:
    'Diagnose why a provider instance cannot run, without changing anything. Returns checks per instance; a failed check has a reason and a fix whose actor says who acts: agent (something you can do now, such as calling another tool) or human (a person must change provider settings, install or update a CLI, or sign in; tell the user the instruction and never try to sign in or read credentials yourself). Claude Cloud and Devin Cloud are checked live: instance, sibling Claude or Devin ACP instance, forbidden environment variables such as ANTHROPIC_AUTH_TOKEN, executable, version, cloud support, and sign-in. Other providers report their readiness snapshot, refreshed first when instanceId is passed. Pass driver:"claudeCloud" or driver:"devinCloud" to diagnose a cloud provider that is not configured yet. Pass cwd to also check that project\'s repository remote. fix.path names the agent-surface step that will automate the fix (provider.setup and provider.login_start are not callable yet).',
  parameters: ProviderDiagnoseInput,
  success: ProviderDiagnoseResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderDiagnosisService.ProviderDiagnosisService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProviderToolkit = Toolkit.make(ProviderDiagnoseTool);
