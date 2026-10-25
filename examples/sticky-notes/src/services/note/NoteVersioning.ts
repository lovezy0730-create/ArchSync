export interface Versioned {
  version: number;
}

/** 乐观锁版本推进：不一致时抛冲突。 */
export function bumpVersion<T extends Versioned>(record: T, expectedVersion: number): T {
  if (record.version !== expectedVersion) {
    throw new Error(`version_conflict: expected ${expectedVersion}, got ${record.version}`);
  }
  return { ...record, version: record.version + 1 };
}
