import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import SemanticPlugin from './main';
import { rankResults, SearchResult } from './search';

export const VIEW_TYPE_SEMANTIC = 'semantic-search-view';

export class SemanticSearchView extends ItemView {
  plugin: SemanticPlugin;
  private queryInput!: HTMLInputElement;
  private clearBtn!: HTMLButtonElement;
  private resultsEl!: HTMLElement;
  private nInput!: HTMLInputElement;
  private minInput!: HTMLInputElement;
  private debounceTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SemanticPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_SEMANTIC;
  }

  getDisplayText() {
    return 'Semantic Search';
  }

  getIcon() {
    return 'brain-circuit';
  }

  async onOpen() {
    const { containerEl } = this;
    containerEl.empty();

    const wrapper = containerEl.createDiv('semantic-search-wrapper');

    // Search bar (styled after the native core search header)
    const bar = wrapper.createDiv('semantic-search-bar-container');
    const search = bar.createDiv('semantic-search-bar');

    const searchIcon = search.createSpan('semantic-search-icon');
    setIcon(searchIcon, 'search');

    this.queryInput = search.createEl('input', {
      cls: 'semantic-search-input',
      attr: { type: 'text', placeholder: 'Search notes...', 'aria-label': 'Semantic search query' },
    });

    this.clearBtn = search.createEl('button', {
      cls: 'semantic-search-button',
      attr: { type: 'button', 'aria-label': 'Clear search' },
    });
    setIcon(this.clearBtn, 'x');
    this.clearBtn.hide();

    const optionsBtn = bar.createEl('button', {
      cls: 'semantic-search-button',
      attr: { type: 'button', 'aria-label': 'Search settings' },
    });
    setIcon(optionsBtn, 'sliders-horizontal');

    // Settings table, shown under the search box via the sliders toggle
    const settings = wrapper.createDiv('semantic-search-settings');
    settings.hide();

    const nRow = settings.createDiv('semantic-search-setting-row');
    nRow.createEl('label', { text: 'Results' });
    this.nInput = nRow.createEl('input', {
      cls: 'semantic-search-setting-input',
      attr: { type: 'number', min: '1', max: '100', value: String(this.plugin.settings.maxResults) },
    });

    const minRow = settings.createDiv('semantic-search-setting-row');
    minRow.createEl('label', { text: 'Min similarity' });
    this.minInput = minRow.createEl('input', {
      cls: 'semantic-search-setting-input',
      attr: { type: 'number', min: '0', max: '1', step: '0.01', value: String(this.plugin.settings.minSimilarity) },
    });

    this.resultsEl = containerEl.createDiv('semantic-search-results');

    this.clearBtn.addEventListener('click', () => {
      this.queryInput.value = '';
      this.clearBtn.hide();
      this.resultsEl.empty();
      this.queryInput.focus();
    });

    // The sliders button acts as a toggle: highlighted when the settings are shown
    const setSettingsOpen = (open: boolean) => {
      settings.toggle(open);
      optionsBtn.toggleClass('is-active', open);
      optionsBtn.setAttr('aria-pressed', String(open));
    };

    optionsBtn.addEventListener('click', () => {
      setSettingsOpen(!settings.isShown());
    });

    this.queryInput.addEventListener('input', () => this.handleQuery());
    this.nInput.addEventListener('change', () => this.handleQuery());
    this.minInput.addEventListener('change', () => this.handleQuery());

    this.renderResults([]);
  }

  async onClose() {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async handleQuery() {
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(async () => {
      const query = this.queryInput.value.trim();
      if (query) {
        this.clearBtn.show();
      } else {
        this.clearBtn.hide();
        this.resultsEl.empty();
        return;
      }
      const maxResults = parseInt(this.nInput.value || '10', 10);
      const minSimilarity = parseFloat(this.minInput.value || '0.8');
      // embed query
      const embeddings = await this.fetchEmbedding([query]);
      if (!embeddings[0] || embeddings[0].length === 0) {
        new Notice('Embedding API not configured');
        return;
      }
      // ensure index built
      const index = this.plugin.indexer.getCache();
      if (index.length === 0) {
        // build lazily
        await this.plugin.indexer.indexAll(2);
      }
      const results: SearchResult[] = rankResults(embeddings[0], this.plugin.indexer.getCache(), maxResults, minSimilarity);
      this.renderResults(results);
    }, 300);
  }

  private async fetchEmbedding(texts: string[]): Promise<number[][]> {
    const { endpointUrl, apiKey, model } = this.plugin.settings;
    if (!endpointUrl) return texts.map(() => []);
    try {
      const resp = await fetch(`${endpointUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!resp.ok) {
        new Notice('Response NOT ok');
        return texts.map(() => []);
      }
      const data = await resp.json();
      return data.data?.map((d: any) => d.embedding) ?? [];
    } catch {
      return texts.map(() => []);
    }
  }

  private renderResults(results: SearchResult[]) {
    this.resultsEl.empty();
    if (results.length === 0) {
      this.resultsEl.createEl('p', { 
        cls: 'semantic-no-result', 
        text: 'No matches found.' 
      });
      return;
    }
    for (const r of results) {
      const el = this.resultsEl.createDiv('semantic-search-result');
      el.createEl('strong', { text: r.filePath });
      if (r.chunk.headingPath) {
        el.createEl('div', { cls: 'semantic-search-result-heading', text: r.chunk.headingPath });
      }

      // pre + code combo for multiline strings
      const pre = el.createEl('pre');
      const text = r.chunk.text;
      pre.createEl('code', { cls: 'semantic-search-result-snippet', text: text.slice(0, 200) + (text.length > 200 ? '...' : '') });
      el.createEl('small', { cls: 'semantic-search-result-score', text: `Score: ${r.score.toFixed(3)}` });
      el.addEventListener('click', async () => {
        const file = this.app.vault.getAbstractFileByPath(r.filePath);
        if (file) this.app.workspace.openLinkText(file.path, '', false);
      });
    }
  }
}