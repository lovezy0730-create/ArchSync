import { readFileSync } from 'node:fs';
import type { CollabData } from '@archsync/contracts';
import { CollabDataSchema } from '@archsync/contracts';

/**
 * Read the project's demo collaboration fixture. The fixture is fictional by
 * contract and carries `_notice`; the parsed result keeps `demo: true` so the
 * published static bundle labels it end-to-end.
 */
export function readDemoCollab(fixturePath: string, fetchedAt: string | null): CollabData {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  delete raw._notice;
  return CollabDataSchema.parse({
    ...raw,
    source: 'demo',
    demo: true,
    fetchedAt: fetchedAt ?? new Date(0).toISOString(),
    error: null,
  });
}
