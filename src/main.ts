import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  SemanticSettings,
  SemanticSettingTab,
} from './settings';
import { SemanticSearchView, VIEW_TYPE_SEMANTIC } from './view';
import { IndexStatus, Indexer } from './indexer';

export default class SemanticPlugin extends Plugin {
  settings!: SemanticSettings;
  indexer!: Indexer;
  private statusBarEl!: HTMLElement;
  private debounceTimers = new Map<string, number>();

  async onload() {
    await this.loadSettings();
    this.indexer = new Indexer(this.app, this.settings);

    // Register view
    this.registerView(VIEW_TYPE_SEMANTIC, (leaf) => new SemanticSearchView(leaf, this));

    // Command to open view
    this.addCommand({
      id: 'open-semantic-search',
      name: 'Open Semantic Search',
      callback: () => this.activateView(),
    });

    // Command to refresh index
    this.addCommand({
      id: 'semantic-refresh-index',
      name: 'Refresh Semantic Index',
      callback: async () => {
        await this.refreshIndex();
      },
    });

    // Settings tab
    this.addSettingTab(new SemanticSettingTab(this.app, this));

    // Status bar: shows indexing progress, click to rebuild
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('mod-clickable');
    this.statusBarEl.setAttr('aria-label', 'Semantic index status');
    this.statusBarEl.setAttr('title', 'Click to rebuild the semantic index');
    this.statusBarEl.addEventListener('click', () => {
      void this.refreshIndex();
    });
    this.indexer.onStatusChange = (status) => this.renderStatusBar(status);
    this.renderStatusBar(this.indexer.getStatus());

    // Index on load
    this.indexer.indexAll(3).catch(console.error);

    // File change handlers
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDelete(file)));
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as SemanticSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshIndex() {
    if (this.indexer.getStatus().state === 'indexing') {
      new Notice('Indexing already in progress');
      return;
    }
    // Rebuild index from scratch; the status bar reflects the result
    await this.indexer.indexAll(3);
  }

  private renderStatusBar(status: IndexStatus) {
    if (status.state === 'indexing') {
      this.statusBarEl.setText(status.total > 1 ? `Indexing ${status.done}/${status.total}…` : 'Indexing…');
    } else {
      this.statusBarEl.setText(`Index ready (${this.indexer.getCache().length})`);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_SEMANTIC);
    if (leaves.length > 0) {
      leaf = leaves[0]!;
    } else {
      const newLeaf = workspace.getRightLeaf(false);
      leaf = newLeaf ?? null;
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE_SEMANTIC, active: true });
    }
    if (leaf) void workspace.revealLeaf(leaf);
  }

  private onFileChange(file: TAbstractFile) {
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    this.scheduleIndex(file.path, file);
  }

  private onFileRename(file: TAbstractFile, oldPath: string) {
    this.cancelScheduled(oldPath);
    this.indexer.removeFile(oldPath);
    this.onFileChange(file);
  }

  private onFileDelete(file: TAbstractFile) {
    this.cancelScheduled(file.path);
    this.indexer.removeFile(file.path);
  }

  private scheduleIndex(path: string, file: TFile) {
    this.cancelScheduled(path);
    this.debounceTimers.set(path, window.setTimeout(() => {
      this.debounceTimers.delete(path);
      void this.indexer.indexFile(file).catch(console.error);
    }, this.settings.debounceMs));
  }

  private cancelScheduled(path: string) {
    const timer = this.debounceTimers.get(path);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
  }
}
