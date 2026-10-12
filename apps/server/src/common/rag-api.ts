import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common'

function requestTimeout(): number {
  const configured = Number(process.env.RAG_API_TIMEOUT_MS || 120000)
  return Number.isFinite(configured) && configured > 0 ? configured : 120000
}

// Retry only reads: a disconnected POST may already have changed upstream state.
export async function fetchRagApi(url: string, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(requestTimeout())
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const attempts = (init?.method || 'GET').toUpperCase() === 'GET' ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetch(url, { ...init, signal })
    } catch (error) {
      if (init?.signal?.aborted) throw error
      if (signal.aborted || attempt === attempts - 1) {
        throw new ServiceUnavailableException(
          'Python API is unavailable or timed out. Please check that pnpm run dev:api is running and try again.',
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  throw new ServiceUnavailableException('Python API is unavailable.')
}

export async function readRagJson(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json()
  } catch {
    // Preserve the status of non-JSON error responses, but never treat a broken
    // successful response (including a disconnected body) as valid empty data.
    if (!response.ok) return {}
    throw new BadGatewayException('Python API returned an incomplete or invalid response. Please try again.')
  }
}
