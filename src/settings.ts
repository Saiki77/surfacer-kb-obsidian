import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type KBSyncPlugin from "./main";
import { setupNewTeam, joinExistingTeam } from "./aws/setup-wizard";

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
  statusMessage: string;
  collaborationEnabled: boolean;
  wsUrl: string;
}

export const DEFAULT_SETTINGS: KBSyncSettings = {
  s3Bucket: "",
  s3Prefix: "knowledge-base/",
  awsRegion: "us-east-1",
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
  statusMessage: "",
  collaborationEnabled: false,
  wsUrl: "",
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

    // Quick Setup (shown when not configured)
    if (!this.plugin.settings.s3Bucket) {
      this.renderQuickSetup(containerEl);
      return; // Don't show advanced settings until setup is done
    }

    // Configured status
    const statusEl = containerEl.createDiv({ cls: "setting-item" });
    statusEl.createEl("div", {
      cls: "setting-item-info",
    }).createEl("div", {
      cls: "setting-item-description",
      text: `Bucket: ${this.plugin.settings.s3Bucket} | Region: ${this.plugin.settings.awsRegion} | Collab: ${this.plugin.settings.collaborationEnabled ? "on" : "off"}`,
    });

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
          .setPlaceholder("e.g. alice")
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

    // Live Collaboration
    containerEl.createEl("h3", { text: "Live Collaboration" });

    new Setting(containerEl)
      .setName("Enable Live Collaboration")
      .setDesc(
        "Allow real-time co-editing with team members via WebSocket. " +
        "Requires deploying the collab-stack CloudFormation template."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.collaborationEnabled)
          .onChange(async (value) => {
            this.plugin.settings.collaborationEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.collaborationEnabled) {
      new Setting(containerEl)
        .setName("WebSocket URL")
        .setDesc(
          "The wss:// URL from the CloudFormation stack output"
        )
        .addText((text) =>
          text
            .setPlaceholder("wss://xxx.execute-api.region.amazonaws.com/prod")
            .setValue(this.plugin.settings.wsUrl)
            .onChange(async (value) => {
              this.plugin.settings.wsUrl = value;
              await this.plugin.saveSettings();
            })
        );

      // Latency check
      const latencySetting = new Setting(containerEl)
        .setName("Test Connection")
        .setDesc("Check WebSocket connectivity and measure latency");

      const resultEl = containerEl.createDiv({
        cls: "kb-sync-latency-result",
      });

      latencySetting.addButton((button) =>
        button
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            const wsUrl = this.plugin.settings.wsUrl;
            if (!wsUrl) {
              resultEl.setText("No WebSocket URL configured.");
              resultEl.style.color = "var(--text-error)";
              return;
            }

            resultEl.setText("Connecting...");
            resultEl.style.color = "var(--text-muted)";

            try {
              const { connectMs, pingMs } = await this.measureLatency(wsUrl);
              resultEl.setText(
                `Connected (${connectMs}ms) \u2014 message round-trip: ${pingMs}ms`
              );
              resultEl.style.color = "var(--color-green)";
            } catch (err) {
              resultEl.setText(
                `Connection failed: ${(err as Error).message}`
              );
              resultEl.style.color = "var(--text-error)";
            }
          })
      );
    }
  }

  private renderQuickSetup(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Quick Setup" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Set up your team's knowledge base in one click. Creates an S3 bucket and real-time collaboration infrastructure on your AWS account.",
    });

    // Region
    new Setting(containerEl)
      .setName("AWS Region")
      .addDropdown((dropdown) => {
        for (const r of [
          "us-east-1", "us-west-2", "eu-west-1", "eu-central-1",
          "ap-southeast-1", "ap-northeast-1",
        ]) {
          dropdown.addOption(r, r);
        }
        dropdown.setValue(this.plugin.settings.awsRegion);
        dropdown.onChange(async (v) => {
          this.plugin.settings.awsRegion = v;
          await this.plugin.saveSettings();
        });
      });

    // Credential mode
    new Setting(containerEl)
      .setName("Credential Mode")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("keys", "Access Key / Secret Key")
          .addOption("profile", "AWS Profile (~/.aws/credentials)")
          .setValue(this.plugin.settings.credentialMode)
          .onChange(async (v) => {
            this.plugin.settings.credentialMode = v as "profile" | "keys";
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.credentialMode === "keys") {
      new Setting(containerEl)
        .setName("Access Key ID")
        .addText((t) =>
          t.setValue(this.plugin.settings.awsAccessKeyId).onChange(async (v) => {
            this.plugin.settings.awsAccessKeyId = v;
            await this.plugin.saveSettings();
          })
        );
      new Setting(containerEl)
        .setName("Secret Access Key")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.awsSecretAccessKey).onChange(
            async (v) => {
              this.plugin.settings.awsSecretAccessKey = v;
              await this.plugin.saveSettings();
            }
          );
        });
    } else {
      new Setting(containerEl)
        .setName("AWS Profile")
        .addText((t) =>
          t
            .setPlaceholder("default")
            .setValue(this.plugin.settings.awsProfile)
            .onChange(async (v) => {
              this.plugin.settings.awsProfile = v;
              await this.plugin.saveSettings();
            })
        );
    }

    // Your Name
    new Setting(containerEl)
      .setName("Your Name")
      .setDesc("Visible to teammates in presence and chat")
      .addText((t) =>
        t
          .setPlaceholder("e.g. alice")
          .setValue(this.plugin.settings.userName)
          .onChange(async (v) => {
            this.plugin.settings.userName = v;
            await this.plugin.saveSettings();
          })
      );

    // Progress area
    const progressEl = containerEl.createDiv({
      cls: "setting-item-description",
    });
    progressEl.style.marginTop = "8px";
    progressEl.style.fontWeight = "500";

    // Buttons
    const btnContainer = containerEl.createDiv();
    btnContainer.style.display = "flex";
    btnContainer.style.gap = "8px";
    btnContainer.style.marginTop = "12px";

    const createBtn = btnContainer.createEl("button", {
      text: "Create New Team",
      cls: "mod-cta",
    });
    const joinBtn = btnContainer.createEl("button", {
      text: "Join Existing Team",
    });

    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      joinBtn.disabled = true;
      createBtn.setText("Setting up...");
      try {
        const result = await setupNewTeam(
          this.plugin.settings,
          (msg) => (progressEl.textContent = msg)
        );
        // Auto-configure everything
        this.plugin.settings.s3Bucket = result.bucketName;
        this.plugin.settings.wsUrl = result.wsUrl;
        this.plugin.settings.collaborationEnabled = true;
        this.plugin.settings.syncEnabled = true;
        await this.plugin.saveSettings();
        new Notice(
          "Team setup complete! Share your bucket name with teammates.\n" +
            `Bucket: ${result.bucketName}\n` +
            "Live collab costs ~$0.10/day when active."
        );
        this.display();
      } catch (err) {
        progressEl.textContent = `Error: ${(err as Error).message}`;
        progressEl.style.color = "var(--text-error)";
        createBtn.disabled = false;
        joinBtn.disabled = false;
        createBtn.setText("Create New Team");
      }
    });

    joinBtn.addEventListener("click", () => {
      // Show bucket name input
      const joinEl = containerEl.createDiv();
      joinEl.style.marginTop = "12px";
      new Setting(joinEl)
        .setName("Team Bucket Name")
        .setDesc("Get this from your team admin")
        .addText((t) =>
          t.setPlaceholder("kb-a1b2c3-eu-central-1").onChange((v) => {
            this.plugin.settings.s3Bucket = v;
          })
        )
        .addButton((b) =>
          b
            .setButtonText("Join")
            .setCta()
            .onClick(async () => {
              progressEl.textContent = "Connecting to team...";
              try {
                const result = await joinExistingTeam(this.plugin.settings);
                this.plugin.settings.wsUrl = result.wsUrl;
                this.plugin.settings.collaborationEnabled = true;
                this.plugin.settings.syncEnabled = true;
                await this.plugin.saveSettings();
                new Notice("Joined team! Syncing will start shortly.");
                this.display();
              } catch (err) {
                progressEl.textContent = `Error: ${(err as Error).message}`;
                progressEl.style.color = "var(--text-error)";
              }
            })
        );
      joinBtn.disabled = true;
    });

    // Cost note
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Infrastructure costs ~$0.10/day during active co-editing. Scales to zero when idle. Uses API Gateway WebSocket + Lambda + DynamoDB.",
    });
  }

  private measureLatency(
    wsUrl: string
  ): Promise<{ connectMs: number; pingMs: number }> {
    return new Promise((resolve, reject) => {
      const connectStart = performance.now();
      let settled = false;

      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error("Connection timed out (5s)"));
        }
      }, 5000);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        const connectMs = Math.round(performance.now() - connectStart);
        // Now measure actual message round-trip with ping/pong
        const pingStart = performance.now();
        ws.send(JSON.stringify({ action: "ping", ts: pingStart }));

        ws.onmessage = (event) => {
          const pingMs = Math.round(performance.now() - pingStart);
          settled = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ connectMs, pingMs });
        };
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error("WebSocket connection error"));
        }
      };
    });
  }
}
