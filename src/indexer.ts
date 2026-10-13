import { App, TFile } from 'obsidian';
import { SemanticSettings } from './settings';
import { EmbeddingChunk, IndexedFile } from './search';
import { shouldIndexFile } from './utils/folderFilter';

class TextChunk {
  private _headers: string[];
  private _body: string;

  constructor(headers: string[], body: string) {
    this._headers = headers;
    this._body = body;
  }

  get headers(): string[] {
    return this._headers;
  }

  get body(): string {
    return this._body;
  }

  get text(): string {
    const headers = this.headers;
    const length = headers.length;
    return `${'#'.repeat(length)} ${headers[length-1]}\n${this._body}`;
  }

  get headingPath() {
    return this.headers.join(' > ');
  }
}

export class Indexer {
  private app: App;
  private settings: SemanticSettings;
  private cache: Map<string, IndexedFile> = new Map();
  private embeddingCache: Record<string, IndexedFile> = {};

  constructor(app: App, settings: SemanticSettings) {
    this.app = app;
    this.settings = settings;
  }

  async loadCache(): Promise<void> {
    // In a real plugin, load from plugin data
    // For simplicity, start empty
    this.embeddingCache = {};
    this.cache.clear();
  }

  private chunkText(text: string, maxChars: number, overlap: number): TextChunk[] {
    let headerIndex = 0;
    let headingPath = Array<string>(6).fill('');
    const chunks: TextChunk[] = [];
    let buffer = '';
    
    const flush = () => {
      // Only create a chunk if there is a body.
      if (buffer.trim()) {
        chunks.push(new TextChunk(headingPath.slice(0, headerIndex), buffer.trim()));
        if (overlap > 0 && buffer.length > maxChars) {
          buffer = '... ' + buffer.slice(-overlap);
        } else {
          buffer = '';
        }
      }
    };

    const lines = text.split('\n');
    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        flush();

        const level = headerMatch[1]!.length;
        const title = headerMatch[2]!;

        headerIndex = level;
        headingPath[level - 1] = title;
        for (let i = level; i < 6; i++) headingPath[i] = '';
        buffer = line + '\n';
        continue;
      }

      buffer += line + '\n';
      if (buffer.length > maxChars) flush();
    }

    flush();
    return chunks;
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    const { endpointUrl, apiKey, model } = this.settings;
    if (!endpointUrl) return texts.map(() => []);
    try {
      const resp = await fetch(`${endpointUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: texts, model }),
      });
      if (!resp.ok) {
        console.error('Embedding API error', resp.status);
        return texts.map(() => []);
      }
      const data = await resp.json();
      return data.data?.map((d: any) => d.embedding) ?? [];
    } catch (e) {
      console.error('Embedding fetch error', e);
      return texts.map(() => []);
    }
  }

  async indexFile(file: TFile): Promise<IndexedFile | null> {
    if (!shouldIndexFile(file, this.settings.includeFolders, this.settings.excludeFolders, this.settings.excludePatterns)) {
      return null;
    }
    const content = await this.app.vault.read(file);
    const rawChunks = this.chunkText(content, this.settings.chunkMaxChars, this.settings.chunkOverlapChars);
    const texts = rawChunks.map(c => c.text);
    const embeddings = await this.embedTexts(texts);
    const chunks: EmbeddingChunk[] = rawChunks.map((c, i) => ({
      id: `${file.path}::${i}`,
      text: c.body,
      headingPath: c.headingPath,
      embedding: embeddings[i] ?? [],
    }));
    const indexed: IndexedFile = { path: file.path, mtime: file.stat.mtime, chunks };
    this.cache.set(file.path, indexed);
    return indexed;
  }

  async indexAll(concurrency = 3): Promise<IndexedFile[]> {
    const files = this.app.vault.getMarkdownFiles();
    const results: IndexedFile[] = [];
    const queue = [...files];
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const file = queue.shift()!;
        const indexed = await this.indexFile(file);
        if (indexed) results.push(indexed);
      }
    });
    await Promise.all(workers);
    return results;
  }

  getCache(): IndexedFile[] {
    return Array.from(this.cache.values());
  }
}
