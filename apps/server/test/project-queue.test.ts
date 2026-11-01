import { expect, it } from 'vitest';
import { ProjectQueue } from '../src/sync/project-queue.js';

it('serializes all work for a project, even after a failure, without blocking other projects', async () => {
  const queue = new ProjectQueue();
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run('a', async () => { events.push('first'); await blocked; throw new Error('failed'); });
  const second = queue.run('a', async () => { events.push('second'); });
  const third = queue.run('a', async () => { events.push('third'); });
  await queue.run('b', async () => { events.push('other'); });
  expect(events).toEqual(['first', 'other']);
  release();
  await expect(first).rejects.toThrow('failed');
  await Promise.all([second, third]);
  expect(events).toEqual(['first', 'other', 'second', 'third']);
  await queue.drain();
});
