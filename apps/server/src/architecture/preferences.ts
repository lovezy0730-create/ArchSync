import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { emptyPreferences, type DiscoveryPreferences } from './discovery.js';

/**
 * User module preferences live in the ArchSync data directory, never in the
 * scanned repository. They only adjust the presentation of discovered
 * structure (moves/renames/hidden); they never invent code facts.
 */
const PreferencesSchema = z.object({
  version: z.literal(1),
  moves: z.record(z.string().max(4096), z.string().min(1).max(64)).default({}),
  rename: z.record(z.string().min(1).max(64), z.string().min(1).max(120)).default({}),
  hidden: z.array(z.string().min(1).max(64)).max(500).default([]),
});

export function preferencesPath(dataDir: string, projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(dataDir, 'architecture-preferences', `${safe}.json`);
}

export function readDiscoveryPreferences(dataDir: string, projectId: string): DiscoveryPreferences {
  const path = preferencesPath(dataDir, projectId);
  if (!existsSync(path)) return emptyPreferences();
  try {
    const parsed = PreferencesSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : emptyPreferences();
  } catch {
    return emptyPreferences();
  }
}

export function writeDiscoveryPreferences(
  dataDir: string,
  projectId: string,
  input: unknown,
): { ok: true; preferences: DiscoveryPreferences } | { ok: false; message: string } {
  const parsed = PreferencesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '偏好格式无效' };
  const path = preferencesPath(dataDir, projectId);
  try {
    mkdirSync(join(dataDir, 'architecture-preferences'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(parsed.data, null, 2), 'utf8');
    renameSync(tmp, path);
    return { ok: true, preferences: parsed.data };
  } catch (error) {
    return { ok: false, message: `写入失败: ${(error as Error).message}` };
  }
}
