import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from 'obsidian';
import {
  DEFAULT_SETTINGS,
  SemanticSettings,
  SemanticSettingTab,
} from './settings';
import { SemanticSearchView, VIEW_TYPE_SEMANTIC } from './view';
import { IndexStatus, Indexer } from './indexer';
import { SqliteIndexStore } from './store';
import { ConfigMismatchModal } from './ui/configMismatchModal';

/** Settings that, when changed, make the stored index incompatible. */
interface CompatConfig {
  model: string;
  chunkMaxChars: number;
  chunkOverlapChars: number;
}

const COMPAT_CHECK_DEBOUNCE_MS = 1500;

export default class SemanticPlugin extends Plugin {
  settings!: SemanticSettings;
  indexer!: Indexer;
  private store!: SqliteIndexStore;
  private statusBarEl!: HTMLElement;
  private debounceTimers = new Map<string, number>();
  private settingTab?: SemanticSettingTab;
  private compatCheckTimer: number | null = null;
  private compatModal: ConfigMismatchModal | null = null;
  /** Signature of the mismatch the user chose to "decide later"; suppressed until settings change again. */
  private lastDismissedCompat: string | null = null;

  async onload() {
    await this.loadSettings();

    // Persistent index store (SQLite via sql.js); degrades to memory-only on failure.
    this.store = new SqliteIndexStore(this);
    await this.store.open();

    this.indexer = new Indexer(this.app, this.settings, this.store);
    this.indexer.loadFromStore();

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
    this.settingTab = new SemanticSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

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

    // File change handlers
    this.registerEvent(this.app.vault.on('modify', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('create', (file) => this.onFileChange(file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.onFileDelete(file)));

    // Startup index strategy: reconcile incrementally, unless the stored
    // index was built with incompatible settings (then ask the user first).
    const mismatch = this.getCompatMismatch();
    if (mismatch) {
      this.showCompatModal(mismatch);
    } else {
      await this.writeCompatMetaIfMissing();
      void this.indexer.reconcile().catch(console.error);
    }
  }

  onunload() {
    for (const timer of this.debounceTimers.values()) {
      window.clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.compatCheckTimer !== null) {
      window.clearTimeout(this.compatCheckTimer);
      this.compatCheckTimer = null;
    }
    this.compatModal?.close();
    void this.store.flush();
    this.store.close();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as SemanticSettings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.queueCompatCheck();
  }

  async refreshIndex() {
    if (this.indexer.getStatus().state === 'indexing') {
      new Notice('Indexing already in progress');
      return;
    }
    // A manual rebuild always adopts the current settings.
    await this.writeCompatMeta();
    this.lastDismissedCompat = null;
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

  // --- Index-store compatibility ------------------------------------------

  private compatSignature(config: CompatConfig): string {
    return `${config.model}|${config.chunkMaxChars}|${config.chunkOverlapChars}`;
  }

  private currentCompatConfig(): CompatConfig {
    return {
      model: this.settings.model,
      chunkMaxChars: this.settings.chunkMaxChars,
      chunkOverlapChars: this.settings.chunkOverlapChars,
    };
  }

  /** Differences between the stored index's settings and the current ones, or null if compatible. */
  private getCompatMismatch(): string[] | null {
    const storedModel = this.store.getMeta('embedding_model');
    if (storedModel === null) return null; // fresh index — nothing to invalidate
    const changes: string[] = [];
    if (storedModel !== this.settings.model) {
      changes.push(`Embedding model: ${storedModel} → ${this.settings.model}`);
    }
    const storedMax = this.store.getMeta('chunk_max_chars');
    if (storedMax !== null && Number(storedMax) !== this.settings.chunkMaxChars) {
      changes.push(`Chunk max chars: ${storedMax} → ${this.settings.chunkMaxChars}`);
    }
    const storedOverlap = this.store.getMeta('chunk_overlap_chars');
    if (storedOverlap !== null && Number(storedOverlap) !== this.settings.chunkOverlapChars) {
      changes.push(`Chunk overlap chars: ${storedOverlap} → ${this.settings.chunkOverlapChars}`);
    }
    return changes.length > 0 ? changes : null;
  }

  private async writeCompatMeta(): Promise<void> {
    const config = this.currentCompatConfig();
    this.store.setMeta('embedding_model', config.model);
    this.store.setMeta('chunk_max_chars', String(config.chunkMaxChars));
    this.store.setMeta('chunk_overlap_chars', String(config.chunkOverlapChars));
  }

  private async writeCompatMetaIfMissing(): Promise<void> {
    if (this.store.getMeta('embedding_model') === null) {
      await this.writeCompatMeta();
    }
  }

  /** Check for compatibility after settings change, debounced against typing. */
  private queueCompatCheck(): void {
    if (this.compatCheckTimer !== null) window.clearTimeout(this.compatCheckTimer);
    this.compatCheckTimer = window.setTimeout(() => {
      this.compatCheckTimer = null;
      const mismatch = this.getCompatMismatch();
      if (mismatch === null) {
        this.lastDismissedCompat = null;
        return;
      }
      if (this.compatModal !== null) return;
      const signature = this.compatSignature(this.currentCompatConfig());
      if (signature === this.lastDismissedCompat) return;
      this.showCompatModal(mismatch);
    }, COMPAT_CHECK_DEBOUNCE_MS);
  }

  private showCompatModal(changes: string[]): void {
    this.compatModal?.close();
    const previous = {
      model: this.store.getMeta('embedding_model'),
      chunkMaxChars: this.store.getMeta('chunk_max_chars'),
      chunkOverlapChars: this.store.getMeta('chunk_overlap_chars'),
    };
    this.compatModal = new ConfigMismatchModal(this.app, {
      changes,
      onRebuild: async () => {
        this.lastDismissedCompat = null;
        await this.writeCompatMeta();
        await this.refreshIndex();
      },
      onRevert: async () => {
        if (previous.model !== null) this.settings.model = previous.model;
        if (previous.chunkMaxChars !== null) this.settings.chunkMaxChars = Number(previous.chunkMaxChars);
        if (previous.chunkOverlapChars !== null) this.settings.chunkOverlapChars = Number(previous.chunkOverlapChars);
        await this.saveSettings();
        this.settingTab?.display();
        new Notice('Settings reverted to match the existing index.');
        void this.indexer.reconcile().catch(console.error);
      },
      onLater: () => {
        this.lastDismissedCompat = this.compatSignature(this.currentCompatConfig());
        new Notice('Keeping the existing index. Use "Refresh Semantic Index" to rebuild with the new settings.');
      },
      onClosed: () => {
        this.compatModal = null;
      },
    });
    this.compatModal.open();
  }

  // --- File event handlers -------------------------------------------------

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
