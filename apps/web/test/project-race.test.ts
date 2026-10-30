import { it, expect, vi } from 'vitest';
import type { Snapshot } from '@archsync/contracts';
const mocks = vi.hoisted(() => ({loadSnapshot:vi.fn(),loadTeam:vi.fn(async()=>({team:[],demo:false}))}));
vi.mock('../src/lib/server-provider.js',()=>({createServerProvider:()=>({capabilities:{presence:false},...mocks})}));
import { useStore } from '../src/store.js';
it('late project A response cannot replace selected project B', async () => {
  let finishA!: (snapshot:Snapshot)=>void;
  const a = new Promise<Snapshot>(resolve => {finishA=resolve;});
  const snapshot = (id:string) => ({projectId:id,version:1,modules:[],layers:[],views:[],defaultViewId:null} as unknown as Snapshot);
  mocks.loadSnapshot.mockImplementation((id:string)=>id==='a'?a:Promise.resolve(snapshot('b')));
  const pending = useStore.getState().switchProject('a');
  await useStore.getState().switchProject('b');
  finishA(snapshot('a')); await pending;
  expect(useStore.getState().projectId).toBe('b');
  expect(useStore.getState().snapshot?.projectId).toBe('b');
});
