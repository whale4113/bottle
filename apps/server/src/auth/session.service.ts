import { Injectable, UnauthorizedException } from '@nestjs/common'
import { fromNodeHeaders } from 'better-auth/node'
import type { Request } from 'express'

import { auth, type AuthSession } from './auth.js'

@Injectable()
export class SessionService {
  async getSession(request: Request): Promise<AuthSession> {
    return auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    })
  }

  async requireSession(request: Request): Promise<NonNullable<AuthSession>> {
    const session = await this.getSession(request)
    if (!session) {
      throw new UnauthorizedException('Authentication required')
    }
    return session
  }
}

