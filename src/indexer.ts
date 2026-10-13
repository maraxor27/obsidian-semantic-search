import { App, TFile } from 'obsidian';
import { SemanticSettings } from './settings';
import { EmbeddingChunk, IndexedFile } from './search';
import { shouldIndexFile } from './utils/folderFilter';

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

  private chunkText(text: string, maxChars: number, overlap: number): { text: string; headingPath: string }[] {
    const lines = text.split('\n');
    let headingPath = Array<string>(6).fill('');
    const chunks: { text: string; headingPath: string }[] = [];
    let buffer = '';
    const flush = () => {
      if (buffer.trim()) {
        const heading = headingPath.filter(Boolean).join(' > ');
        chunks.push({ text: buffer.trim(), headingPath: heading });
        if (overlap > 0 && buffer.length > overlap) {
          buffer = buffer.slice(-overlap);
        } else {
          buffer = '';
        }
      }
    };
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        const level = m[1]!.length;
        const title = m[2]!;
        for (let i = level - 1; i < 6; i++) headingPath[i] = i === level - 1 ? title : '';
        flush();
        buffer = `${headingPath.filter(Boolean).join(' > ')}: ${line}\n`;
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
    if (!endpointUrl || !apiKey) return texts.map(() => []);
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
      text: c.text,
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
