import { App, Modal, Setting } from 'obsidian';

export interface ConfigMismatchModalOptions {
  /** Human-readable list of what changed, e.g. "Embedding model: a → b". */
  changes: string[];
  onRebuild: () => Promise<void>;
  onRevert: () => Promise<void>;
  onLater: () => void;
  onClosed: () => void;
}

/**
 * Shown when the stored index was built with different embedding/chunking
 * settings than the current ones. Offers to rebuild with the new settings,
 * revert the settings, or decide later (keeping the stale index).
 */
export class ConfigMismatchModal extends Modal {
  private options: ConfigMismatchModalOptions;

  constructor(app: App, options: ConfigMismatchModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.titleEl.setText('Semantic index out of date');
    this.contentEl.createEl('p', {
      text: 'These settings changed, so the existing index no longer matches them:',
    });
    const list = this.contentEl.createEl('ul');
    for (const change of this.options.changes) {
      list.createEl('li', { text: change });
    }

    const actions = new Setting(this.contentEl);
    actions.addButton((button) =>
      button.setButtonText('Rebuild index').setCta().onClick(() => {
        this.close();
        void this.options.onRebuild();
      }),
    );
    actions.addButton((button) =>
      button.setButtonText('Revert settings').onClick(() => {
        this.close();
        void this.options.onRevert();
      }),
    );
    actions.addButton((button) =>
      button.setButtonText('Decide later').onClick(() => {
        this.close();
        this.options.onLater();
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
    this.options.onClosed();
  }
}
