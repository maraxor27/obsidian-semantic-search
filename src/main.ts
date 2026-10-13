import { Plugin, WorkspaceLeaf } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  SemanticSettings,
  SemanticSettingTab,
} from './settings';
import { SemanticSearchView, VIEW_TYPE_SEMANTIC } from './view';
import { Indexer } from './indexer';

export default class SemanticPlugin extends Plugin {
  settings!: SemanticSettings;
  indexer!: Indexer;

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

    // Index on load
    this.indexer.indexAll(3).catch(console.error);

    // File change handlers
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDelete(file)));
  }

  onunload() {
    // cleanup handled by registerEvent
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as SemanticSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async refreshIndex() {
    // Rebuild index from scratch
    const results = await this.indexer.indexAll(3);
    console.log(`Semantic index refreshed: ${results.length} files indexed`);
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
    if (leaf) workspace.revealLeaf(leaf);
  }

  private async onFileChange(file: any) {
    if (!file || file.extension !== 'md') return;
    const debounceMs = this.settings.debounceMs;
    const key = file.path;
    if (this.indexer && 'debounceMap' in this) {
      // simple debounce via setTimeout
      if ((this as any).debounceTimer) clearTimeout((this as any).debounceTimer);
      (this as any).debounceTimer = setTimeout(async () => {
        await this.indexer.indexFile(file);
      }, debounceMs);
    }
  }

  private onFileDelete(file: any) {
    // TODO: remove from cache
  }
}
