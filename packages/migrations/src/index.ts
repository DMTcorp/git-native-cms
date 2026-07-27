export interface ContentMigration<TValue = unknown> {
  readonly from: number;
  readonly to: number;
  readonly migrate: (value: TValue) => TValue;
}

export function migrateContent<TValue>(
  value: TValue,
  fromVersion: number,
  targetVersion: number,
  migrations: readonly ContentMigration<TValue>[],
): TValue {
  let current = structuredClone(value);
  let version = fromVersion;
  while (version < targetVersion) {
    const migration = migrations.find((candidate) => candidate.from === version);
    if (migration === undefined || migration.to <= version) {
      throw new Error(`Missing migration from schema version ${version}.`);
    }
    current = migration.migrate(current);
    version = migration.to;
  }
  if (version !== targetVersion) {
    throw new Error(`Migration chain ended at ${version}, expected ${targetVersion}.`);
  }
  return current;
}
