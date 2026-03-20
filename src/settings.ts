import { App, PluginSettingTab, Setting } from "obsidian";
import type KBSyncPlugin from "./main";

export interface KBSyncSettings {
  s3Bucket: string;
  s3Prefix: string;
  awsRegion: string;
  awsProfile: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  credentialMode: "profile" | "keys";
  syncFolderPath: string;
  pullIntervalMinutes: number;
  pushIntervalMinutes: number;
  conflictStrategy: "ask" | "prefer-local" | "prefer-remote";
  syncEnabled: boolean;
  userName: string;
  presenceHeartbeatMinutes: number;
}

export const DEFAULT_SETTINGS: KBSyncSettings = {
  s3Bucket: "claude-unified-bucket",
  s3Prefix: "knowledge-base/",
  awsRegion: "eu-central-1",
  awsProfile: "default",
  awsAccessKeyId: "",
  awsSecretAccessKey: "",
  credentialMode: "profile",
  syncFolderPath: "knowledge-base",
  pullIntervalMinutes: 2,
  pushIntervalMinutes: 10,
  conflictStrategy: "ask",
  syncEnabled: true,
  userName: "",
  presenceHeartbeatMinutes: 2,
};

export class KBSyncSettingTab extends PluginSettingTab {
  plugin: KBSyncPlugin;

  constructor(app: App, plugin: KBSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Knowledge Base S3 Sync" });

    // AWS Configuration
    containerEl.createEl("h3", { text: "AWS Configuration" });

    new Setting(containerEl)
      .setName("S3 Bucket")
      .setDesc("The S3 bucket containing the knowledge base")
      .addText((text) =>
        text
          .setPlaceholder("my-bucket")
          .setValue(this.plugin.settings.s3Bucket)
          .onChange(async (value) => {
            this.plugin.settings.s3Bucket = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("S3 Prefix")
      .setDesc("Object key prefix in the bucket")
      .addText((text) =>
        text
          .setPlaceholder("knowledge-base/")
          .setValue(this.plugin.settings.s3Prefix)
          .onChange(async (value) => {
            this.plugin.settings.s3Prefix = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("AWS Region")
      .addText((text) =>
        text
          .setPlaceholder("eu-central-1")
          .setValue(this.plugin.settings.awsRegion)
          .onChange(async (value) => {
            this.plugin.settings.awsRegion = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Credential Mode")
      .setDesc("How to authenticate with AWS")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("profile", "AWS Profile (~/.aws/credentials)")
          .addOption("keys", "Access Key / Secret Key")
          .setValue(this.plugin.settings.credentialMode)
          .onChange(async (value) => {
            this.plugin.settings.credentialMode = value as "profile" | "keys";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.credentialMode === "profile") {
      new Setting(containerEl)
        .setName("AWS Profile")
        .addText((text) =>
          text
            .setPlaceholder("default")
            .setValue(this.plugin.settings.awsProfile)
            .onChange(async (value) => {
              this.plugin.settings.awsProfile = value;
              await this.plugin.saveSettings();
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Access Key ID")
        .addText((text) =>
          text
            .setValue(this.plugin.settings.awsAccessKeyId)
            .onChange(async (value) => {
              this.plugin.settings.awsAccessKeyId = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Secret Access Key")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setValue(this.plugin.settings.awsSecretAccessKey)
            .onChange(async (value) => {
              this.plugin.settings.awsSecretAccessKey = value;
              await this.plugin.saveSettings();
            });
        });
    }

    // Sync Configuration
    containerEl.createEl("h3", { text: "Sync Configuration" });

    new Setting(containerEl)
      .setName("Sync Folder")
      .setDesc("Vault folder to sync with S3 (created if it doesn't exist)")
      .addText((text) =>
        text
          .setPlaceholder("knowledge-base")
          .setValue(this.plugin.settings.syncFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.syncFolderPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pull Interval (minutes)")
      .setDesc("How often to check S3 for changes")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pullIntervalMinutes))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.pullIntervalMinutes = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Push Interval (minutes)")
      .setDesc("How often to upload local changes to S3")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pushIntervalMinutes))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.pushIntervalMinutes = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Conflict Strategy")
      .setDesc("How to handle conflicts when both sides change a file")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask me (show diff modal)")
          .addOption("prefer-local", "Always keep local version")
          .addOption("prefer-remote", "Always keep remote version")
          .setValue(this.plugin.settings.conflictStrategy)
          .onChange(async (value) => {
            this.plugin.settings.conflictStrategy = value as
              | "ask"
              | "prefer-local"
              | "prefer-remote";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable Sync")
      .setDesc("Toggle automatic sync on/off")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.syncEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    // Collaboration
    containerEl.createEl("h3", { text: "Collaboration" });

    new Setting(containerEl)
      .setName("Your Name")
      .setDesc(
        "Used for live presence and hand-offs. Team members see who's active."
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. justus")
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Presence Heartbeat (minutes)")
      .setDesc("How often to update your presence status")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.presenceHeartbeatMinutes))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.presenceHeartbeatMinutes = num;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
