import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDatabase } from '../src/db.js';
import { GithubApiClient } from '../src/sync/github-client.js';
afterEach(() => vi.unstubAllGlobals());
const path = '/repos/o/r/issues?per_page=30';
const page = (items: unknown[], next?: string) => new Response(JSON.stringify(items), { headers: { etag: '"one"', ...(next ? { link: `<${next}>; rel="next"` } : {}) } });
describe('complete request cache and credential boundary', () => {
  it.each([
    [400, 'bad_request'], [401, 'auth'], [403, 'forbidden'], [429, 'rate_limited'],
  ] as const)('classifies HTTP %i without claiming a successful sync', async (status, kind) => {
    const db = new LocalDatabase(':memory:');
    try {
      const client = new GithubApiClient(db, () => null);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })));
      const result = await client.request('p', 'repo', '/repos/o/r');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(status);
      expect(result.errorKind).toBe(kind);
    } finally { db.close(); }
  });
  it('distinguishes an actual 403 rate limit from a permission denial', async () => {
    const db = new LocalDatabase(':memory:');
    try {
      const client = new GithubApiClient(db, () => null);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })));
      expect((await client.request('p', 'repo', '/repos/o/r')).errorKind).toBe('rate_limited');
    } finally { db.close(); }
  });
  it.each([['AbortError', 'timeout'], ['TypeError', 'network']] as const)('classifies %s separately', async (name, kind) => {
    const db = new LocalDatabase(':memory:');
    try {
      const client = new GithubApiClient(db, () => null);
      const error = new Error('fixture'); error.name = name;
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
      expect((await client.request('p', 'repo', '/repos/o/r')).errorKind).toBe(kind);
    } finally { db.close(); }
  });
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


describe('large PR file sets and check-run objects', () => {
  it('merges 101 renamed PR files and never sends first-page conditional headers to page 2', async () => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => 'secret');
    const route = '/repos/o/r/pulls/1/files?per_page=100';
    const fetcher = vi.fn().mockResolvedValueOnce(page(Array.from({length:100},(_,i)=>({filename:`src/${i}.ts`})), 'https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=2')).mockResolvedValueOnce(page([{filename:'new.ts',previous_filename:'old.ts'}]));
    vi.stubGlobal('fetch',fetcher);
    const result = await client.request<unknown[]>('p','files',route,{paginate:true});
    expect(result.data).toHaveLength(101);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({redirect:'error'});
    expect(fetcher.mock.calls[1]?.[1].headers['If-None-Match']).toBeUndefined(); db.close();
  });
  it('merges paginated check_runs and retains SHA-specific request caches', async () => {
    const db = new LocalDatabase(':memory:'); const client = new GithubApiClient(db, () => null);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({total_count:101,check_runs:Array.from({length:100},()=>({status:'completed',conclusion:'success'}))}),{headers:{link:'<https://api.github.com/repos/o/r/commits/sha/check-runs?per_page=100&page=2>; rel="next"'}})).mockResolvedValueOnce(new Response(JSON.stringify({check_runs:[{status:'completed',conclusion:'failure'}]}))));
    const result = await client.request<{check_runs:unknown[]}>('p','checks','/repos/o/r/commits/sha/check-runs?per_page=100',{paginate:true,itemsKey:'check_runs'});
    expect(result.data?.check_runs).toHaveLength(101); db.close();
  });
});
