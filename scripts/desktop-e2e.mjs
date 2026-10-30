import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const dir = await mkdtemp(join(tmpdir(),'archsync-exe-e2e-'));
const repo = join(dir,'unfamiliar');
const data = join(dir,'user-data');
await mkdir(join(repo,'src'),{recursive:true});
await writeFile(join(repo,'src','index.ts'),'export const hello = 1;');
for (const args of [['init','-q'],['add','-A'],['-c','user.name=fixture','-c','user.email=fixture@example.test','commit','-qm','fixture']]) execFileSync('git',args,{cwd:repo,windowsHide:true});
const executablePath = resolve('apps/desktop/release/win-unpacked/ArchSync.exe');
let app;
let agentPid;
async function launch() {
  const env = {...process.env,ARCHSYNC_DESKTOP_DATA_DIR:data,PORT:'0',AUTH_CODE:'',DEV_AUTH_MODE:'mock'};
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({executablePath,env,timeout:60000});
  const page = await app.firstWindow();
  await page.waitForURL('http://127.0.0.1:*/',{timeout:60000});
  await page.locator('.brand-name').waitFor();
  const health = await page.evaluate(async () => (await fetch('/healthz')).json());
  assert.ok(health.instanceId); assert.ok(health.pid); agentPid = health.pid;
  const login = page.getByPlaceholder('输入显示名，例如：访客');
  if (await login.isVisible()) {await login.fill('RC4 fixture');await page.getByRole('button',{name:'进入',exact:true}).click();}
  return page;
}
async function stop() {
  await app.close(); app = null;
  for(let i=0;i<50;i++) {try {process.kill(agentPid,0);} catch {return;} await new Promise(r=>setTimeout(r,100));}
  throw new Error('owned agent survived normal app quit');
}
try {
  let page = await launch();
  await page.locator('.add-project-btn').click();
  await page.locator('.add-project-card input').first().fill(repo);
  await page.getByRole('button',{name:'添加',exact:true}).click();
  await page.getByLabel('候选架构 YAML').waitFor();
  await page.getByRole('button',{name:'确认保存并监控'}).click();
  await page.getByRole('dialog',{name:'添加项目',exact:true}).waitFor({state:'hidden'});
  await access(join(repo,'.archsync','project.yaml'));
  await page.waitForFunction(async () => {const r=await (await fetch('/api/v1/registry')).json();return r.projects.some(p=>p.name==='local/unfamiliar'&&p.snapshotVersion>0);});
  await access(join(data,'data','registry.sqlite'));
  await page.screenshot({path:resolve('docs/screenshots/rc4-packaged-local.png')});
  const oldPid=agentPid; await stop();
  page = await launch(); assert.notEqual(agentPid,oldPid);
  const registry = await page.evaluate(async () => (await fetch('/api/v1/registry')).json());
  assert.ok(registry.projects.some(p=>p.localPath===repo));
  console.log('PASS: packaged EXE identity, web load, UI init, scan, user-data SQLite, restart persistence');
  // Self repository read-only scan: isolated application data, no source writes.
  await page.locator('.add-project-btn').click();
  await page.locator('.add-project-card input').first().fill(resolve('.'));
  await page.getByRole('button',{name:'添加',exact:true}).click();
  await page.getByRole('dialog',{name:'添加项目',exact:true}).waitFor({state:'hidden'});
  await page.waitForFunction(async () => {const r=await (await fetch('/api/v1/registry')).json();return r.projects.some(p=>p.id==='archsync'&&p.snapshotVersion>0);});
  console.log('PASS: self repository existing config through packaged UI');
  await stop();
  console.log('PASS: normal application quit cleans up its own agent');
} finally {
  if(app) await app.close();
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
