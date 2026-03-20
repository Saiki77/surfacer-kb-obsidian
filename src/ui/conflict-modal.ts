import { Modal, App, ButtonComponent } from "obsidian";
import type { ResolutionResult } from "../sync/conflict-resolver";

export class ConflictModal extends Modal {
  private path: string;
  private localContent: string;
  private remoteContent: string;
  private onResolve: (result: ResolutionResult) => void;

  constructor(
    app: App,
    path: string,
    localContent: string,
    remoteContent: string,
    onResolve: (result: ResolutionResult) => void
  ) {
    super(app);
    this.path = path;
    this.localContent = localContent;
    this.remoteContent = remoteContent;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kb-sync-conflict-modal");

    contentEl.createEl("h2", { text: `Conflict: ${this.path}` });
    contentEl.createEl("p", {
      text: "Both the local and remote versions have changed since the last sync.",
      cls: "kb-sync-conflict-desc",
    });

    // Side-by-side panes
    const paneContainer = contentEl.createDiv({
      cls: "kb-sync-pane-container",
    });

    // Local pane
    const localPane = paneContainer.createDiv({ cls: "kb-sync-pane" });
    localPane.createEl("h3", { text: "Local Version" });
    const localText = localPane.createEl("textarea", {
      cls: "kb-sync-content",
    });
    localText.value = this.localContent;
    localText.readOnly = true;

    // Remote pane
    const remotePane = paneContainer.createDiv({ cls: "kb-sync-pane" });
    remotePane.createEl("h3", { text: "Remote Version (S3)" });
    const remoteText = remotePane.createEl("textarea", {
      cls: "kb-sync-content",
    });
    remoteText.value = this.remoteContent;
    remoteText.readOnly = true;

    // Merge editor (hidden initially)
    const mergeContainer = contentEl.createDiv({
      cls: "kb-sync-merge-container",
    });
    mergeContainer.style.display = "none";
    mergeContainer.createEl("h3", { text: "Merged Version" });
    const mergeText = mergeContainer.createEl("textarea", {
      cls: "kb-sync-merge-editor",
    });
    mergeText.value = this.localContent;

    // Buttons
    const buttonContainer = contentEl.createDiv({
      cls: "kb-sync-buttons",
    });

    new ButtonComponent(buttonContainer)
      .setButtonText("Keep Local")
      .setCta()
      .onClick(() => {
        this.onResolve({ content: this.localContent, action: "keep-local" });
        this.close();
      });

    new ButtonComponent(buttonContainer)
      .setButtonText("Keep Remote")
      .onClick(() => {
        this.onResolve({
          content: this.remoteContent,
          action: "keep-remote",
        });
        this.close();
      });

    const mergeBtn = new ButtonComponent(buttonContainer)
      .setButtonText("Edit & Merge")
      .onClick(() => {
        // Show merge editor, hide panes
        paneContainer.style.display = "none";
        mergeContainer.style.display = "block";
        mergeBtn.buttonEl.style.display = "none";
        saveMergeBtn.buttonEl.style.display = "inline-block";
      });

    const saveMergeBtn = new ButtonComponent(buttonContainer)
      .setButtonText("Save Merged")
      .setCta()
      .onClick(() => {
        this.onResolve({ content: mergeText.value, action: "merged" });
        this.close();
      });
    saveMergeBtn.buttonEl.style.display = "none";
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
