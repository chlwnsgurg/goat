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
          description="Set up in Terminal on the Mac that runs GOAT Bot: goat imessage enable, then goat imessage link-code."
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
