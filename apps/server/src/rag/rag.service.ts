import { fetchRagApi, readRagJson } from '../common/rag-api.js'
import {
  BadGatewayException,
  BadRequestException,
  HttpException,
  Injectable,
} from '@nestjs/common'

@Injectable()
export class RagService {
  private readonly ragApiBaseUrl =
    process.env.RAG_API_BASE_URL || 'http://127.0.0.1:8787'

  async documents(): Promise<unknown> {
    return this.request('/api/documents')
  }

  async embeddings(userId: string, source: string, offset: number): Promise<unknown> {
    const params = new URLSearchParams({ source, offset: String(offset) })
    return this.request(`/api/documents/embeddings/${encodeURIComponent(userId)}?${params}`)
  }

  async search(query: string, topK: number, userId: string): Promise<unknown> {
    return this.request('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: topK, user_id: userId }),
    })
  }

  async embeddingSettings(userId: string): Promise<unknown> {
    return this.request(`/api/settings/embedding/${encodeURIComponent(userId)}`)
  }

  async configureEmbedding(
    userId: string,
    body: unknown,
    test = false,
  ): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Embedding settings are required.')
    const value = body as Record<string, unknown>
    // Forward only supported fields; identity always comes from the session.
    return this.request(`/api/settings/embedding${test ? '/test' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        provider: value.provider,
        model: value.model,
        base_url: value.base_url,
        api_key: value.api_key,
        dimensions: value.dimensions,
        timeout: value.timeout,
      }),
    })
  }

  async llmSettings(userId: string): Promise<unknown> {
    return this.request(`/api/settings/llm/${encodeURIComponent(userId)}`)
  }

  async configureLlm(
    userId: string,
    body: unknown,
    test = false,
  ): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('LLM settings are required.')
    const value = body as Record<string, unknown>
    return this.request(`/api/settings/llm${test ? '/test' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        enabled: value.enabled,
        answer_enabled: value.answer_enabled,
        rerank_enabled: value.rerank_enabled,
        model: value.model,
        base_url: value.base_url,
        api_key: value.api_key,
        timeout: value.timeout,
        embedding_summary_enabled: value.embedding_summary_enabled,
        github_summary_prompt: value.github_summary_prompt,
        document_summary_prompt: value.document_summary_prompt,
      }),
    })
  }

  async answer(userId: string, body: unknown): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('A question and sources are required.')
    const value = body as Record<string, unknown>
    return this.request('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        query: value.query,
        sources: value.sources,
      }),
    })
  }

  async answerStream(
    userId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('A question and sources are required.')
    const value = body as Record<string, unknown>
    const response = await fetchRagApi(`${this.ragApiBaseUrl}/api/answer/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        user_id: userId,
        query: value.query,
        sources: value.sources,
      }),
    })
    if (!response.ok) {
      const payload = await readRagJson(response)
      throw new HttpException(
        payload.detail || 'Unable to start the answer stream.',
        response.status,
      )
    }
    if (!response.body)
      throw new BadGatewayException('The answer stream is empty.')
    return response
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchRagApi(`${this.ragApiBaseUrl}${path}`, init)
    const payload = await readRagJson(response)
    if (!response.ok) {
      if ([400, 401, 403, 409, 422, 429, 503].includes(response.status)) {
        throw new HttpException(
          payload.detail || payload.error || 'RAG request failed',
          response.status,
        )
      }
      throw new BadGatewayException(
        payload.detail || payload.error || 'RAG service request failed',
      )
    }
    return payload
  }
}
