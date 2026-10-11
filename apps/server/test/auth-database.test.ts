import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { betterAuth } from 'better-auth'
import { migrateAuthDatabase } from '../src/auth/database.js'

test('initializes an empty auth database and preserves users on repeated migration', async () => {
  const database = new Database(':memory:')
  const options = { database, emailAndPassword: { enabled: true } }
  try {
    await migrateAuthDatabase(options)
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    for (const name of ['user', 'session', 'account', 'verification']) {
      assert.ok(tables.some((table) => table.name === name))
    }
    database.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run('existing', 'Existing', 'existing@example.com', 0, Date.now(), Date.now())
    await migrateAuthDatabase(options)
    assert.equal(database.prepare('SELECT count(*) AS count FROM user').get()?.count, 1)
    const auth = betterAuth(options)
    const response = await auth.handler(new Request('http://localhost:3000/api/auth/get-session'))
    assert.equal(response.status, 200)
    assert.equal(await response.json(), null)
  } finally {
    database.close()
  }
})
