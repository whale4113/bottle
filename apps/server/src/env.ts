import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { config } from 'dotenv'

const currentDir = dirname(fileURLToPath(import.meta.url))
const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'apps/server/.env'),
  join(currentDir, '..', '.env'),
  join(currentDir, '..', '..', '.env'),
]

const envPath = envCandidates.find((candidate) => existsSync(candidate))

if (envPath) {
  config({ path: envPath, quiet: true })
}
