import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/index.js';
it('registers remote-only, restarts and syncs through REST without a filesystem sentinel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rc4-remote-'));
  process.env.PORT = '0';
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://api.github.com')) return original(input, init);
    const data = url.includes('/pulls?') || url.includes('/issues?') || url.includes('/commits?') ? [] : {default_branch:'trunk'};
    return new Response(JSON.stringify(data));
  });
  let server = await createServer({repoRoot:root,quiet:true});
  try {
    const added = await fetch(server.url+'/api/v1/registry/add-github-remote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner:'acme',repo:'widget'})});
    expect(added.status).toBe(201);
    const result = await added.json() as {project:{id:string;kind:string}};
    expect(result.project.kind).toBe('remote-only');
    await server.close(); server = await createServer({repoRoot:root,quiet:true});
    const sync = await fetch(server.url+`/api/v1/registry/${result.project.id}/sync-github`,{method:'POST'});
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ok:true});
    const projects = await (await fetch(server.url+'/api/v1/projects')).json() as {projects:{id:string}[]};
    expect(projects.projects.map(p => p.id)).toContain(result.project.id);
  } finally { await server.close(); vi.unstubAllGlobals(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
});
