import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/db.js';
import { GithubApiClient } from '../src/sync/github-client.js';
afterEach(() => vi.unstubAllGlobals());
const path = '/repos/o/r/issues?per_page=30';
const page = (items: unknown[], next?: string) => new Response(JSON.stringify(items), { headers: { etag: '"one"', ...(next ? { link: `<${next}>; rel="next"` } : {}) } });
describe('complete request cache and credential boundary', () => {
  it('merges >30 issues, caches complete pages and preserves cache on page failure', async () => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => 'secret');
    const first = Array.from({length:30}, (_, i) => ({number:i+1}));
    const fetcher = vi.fn().mockResolvedValueOnce(page(first, 'https://api.github.com/repos/o/r/issues?per_page=30&page=2')).mockResolvedValueOnce(page([{number:31}]));
    vi.stubGlobal('fetch', fetcher);
    const complete = await client.request<unknown[]>('p','issues',path,{paginate:true});
    expect(complete.data).toHaveLength(31);
    fetcher.mockResolvedValueOnce(page(first, 'https://api.github.com/repos/o/r/issues?per_page=30&page=2')).mockResolvedValueOnce(new Response('',{status:503}));
    const partial = await client.request('p','issues',path,{paginate:true});
    expect(partial.ok).toBe(false);
    expect(client.readCache<unknown[]>('p','issues')).toHaveLength(31);
    db.close();
  });
  it.each(['https://evil.example/repos/o/r/issues?page=2','http://api.github.com/repos/o/r/issues?page=2','https://api.github.com/repos/other/r/issues?page=2','https://user:pass@api.github.com/repos/o/r/issues?page=2'])('rejects unsafe Link %s before requesting it', async (next) => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => 'secret');
    const fetcher = vi.fn().mockResolvedValue(page([{number:1}],next)); vi.stubGlobal('fetch',fetcher);
    expect((await client.request('p','issues',path,{paginate:true})).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1); db.close();
  });
  it('marks maxPages truncation as failure', async () => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => null);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(page([1],'https://api.github.com/repos/o/r/issues?page=2')));
    expect((await client.request('p','issues',path,{paginate:true,maxPages:1})).ok).toBe(false);
    expect(client.readCache('p','issues')).toBeNull(); db.close();
  });
  it('never reuses another path payload for a 304', async () => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => null);
    const fetcher = vi.fn().mockResolvedValueOnce(page([1])).mockResolvedValueOnce(page([2])); vi.stubGlobal('fetch',fetcher);
    await client.request('p','files','/repos/o/r/pulls/1/files');
    await client.request('p','files','/repos/o/r/pulls/2/files');
    fetcher.mockResolvedValueOnce(new Response(null,{status:304}));
    expect((await client.request('p','files','/repos/o/r/pulls/1/files')).data).toEqual([1]); db.close();
  });
});
