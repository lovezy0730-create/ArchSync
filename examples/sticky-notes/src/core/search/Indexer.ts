import { tokenize } from './Tokenizer';

/** 倒排索引：增量更新而非全量重建。 */
export class SearchIndexer {
  private index = new Map<string, Set<string>>();

  add(noteId: string, body: string): void {
    for (const term of tokenize(body)) {
      const bucket = this.index.get(term) ?? new Set<string>();
      bucket.add(noteId);
      this.index.set(term, bucket);
    }
  }

  remove(noteId: string): void {
    for (const bucket of this.index.values()) bucket.delete(noteId);
  }

  search(query: string): string[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const first = this.index.get(terms[0]!) ?? new Set<string>();
    const result = new Set(first);
    for (const t of terms.slice(1)) {
      const bucket = this.index.get(t);
      if (!bucket) return [];
      for (const id of result) if (!bucket.has(id)) result.delete(id);
    }
    return [...result];
  }
}
