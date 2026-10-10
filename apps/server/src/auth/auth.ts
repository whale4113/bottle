import '../env.js'

import { betterAuth } from 'better-auth'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(currentDir, '..', '..', 'data')

mkdirSync(dataDir, { recursive: true })

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL || 'http://127.0.0.1:4000',
  secret:
    process.env.BETTER_AUTH_SECRET ||
    'local-dev-better-auth-secret-change-before-production',
  trustedOrigins: parseTrustedOrigins(),
  database: new Database(join(dataDir, 'auth.sqlite')),
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    },
  },
})

export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>

function parseTrustedOrigins(): string[] {
  return (process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}
