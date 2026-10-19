import { GoatBotSettings } from "./GoatBotSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { SlackChannelSettings } from "./SlackChannelSettings";

/** Every GOAT Bot control in one place: where it runs, then the channels that reach it. */
export function GoatBotSettingsPanel() {
  return (
    <SettingsPageContainer>
      <GoatBotSettings />
      <SlackChannelSettings />
      <SettingsSection id="imessage-channel" title="iMessage">
        <SettingsRow
          {...searchableSetting("imessage-channel")}
          title="Set up in Terminal"
          description={
            <>
              On the Mac that runs GOAT Bot, run{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs whitespace-nowrap">
                goat imessage enable
              </code>
              , then{" "}
              <code className="rounded bg-muted px-1 py-px text-2xs whitespace-nowrap">
                goat imessage link-code
              </code>
              .
            </>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
