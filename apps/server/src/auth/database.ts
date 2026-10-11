import { getMigrations } from 'better-auth/db/migration'

export async function migrateAuthDatabase(
  options: Parameters<typeof getMigrations>[0],
) {
  const migration = await getMigrations(options)
  if (migration.schemaProblems.length) {
    throw new Error(`认证数据库结构异常：${migration.schemaProblems.join('; ')}`)
  }
  await migration.runMigrations()
}
