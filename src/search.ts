/** Embeddings come from the API as number[] and are stored/hydrated as Float32Array. */
export type EmbeddingVector = number[] | Float32Array;

export interface EmbeddingChunk {
  id: string;
  text: string;
  headingPath: string;
  embedding: EmbeddingVector;
}

export interface IndexedFile {
  path: string;
  mtime: number;
  chunks: EmbeddingChunk[];
}

export interface SearchResult {
  filePath: string;
  chunk: EmbeddingChunk;
  score: number;
}

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rankResults(queryEmbedding: number[], index: IndexedFile[], maxResults: number, minSimilarity: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const file of index) {
    for (const chunk of file.chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score >= minSimilarity) {
        results.push({ filePath: file.path, chunk, score });
      }
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
