import { BadGatewayException, Injectable } from '@nestjs/common'

@Injectable()
export class RagService {
  private readonly ragApiBaseUrl = process.env.RAG_API_BASE_URL || 'http://127.0.0.1:8787'

  async documents(): Promise<unknown> {
    return this.request('/api/documents')
  }

  async search(query: string, topK: number): Promise<unknown> {
    return this.request('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: topK }),
    })
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.ragApiBaseUrl}${path}`, init)
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new BadGatewayException(payload.detail || payload.error || 'RAG service request failed')
    }
    return payload
  }
}

