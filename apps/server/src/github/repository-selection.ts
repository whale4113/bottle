import { BadRequestException } from '@nestjs/common'

export function parseRepositorySelection(body: unknown): number[] {
  const ids =
    body && typeof body === 'object'
      ? (body as { repositoryIds?: unknown }).repositoryIds
      : undefined
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 20000 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new BadRequestException('请至少选择一个有效仓库（最多 20000 个）')
  }
  return [...new Set(ids as number[])]
}

export function parseStarsPage(page: string | undefined): number {
  const pageNumber = Number(page || 1)
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > 200) {
    throw new BadRequestException('仓库列表页码无效')
  }
  return pageNumber
}

export type AllRepositorySelection = {
  selectAll: true
  excludedRepositoryIds: number[]
}
export function parseImportSelection(
  body: unknown,
): number[] | AllRepositorySelection {
  const value = body as Record<string, unknown> | null
  if (value?.selectAll === true) {
    const excluded = value.excludedRepositoryIds ?? []
    if (
      value.repositoryIds !== undefined ||
      !Array.isArray(excluded) ||
      excluded.length > 20000 ||
      excluded.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw new BadRequestException('Invalid all-repositories selection.')
    return {
      selectAll: true,
      excludedRepositoryIds: [...new Set(excluded as number[])],
    }
  }
  if (
    (value?.selectAll !== undefined && value.selectAll !== false) ||
    value?.excludedRepositoryIds !== undefined
  )
    throw new BadRequestException('Invalid repository selection mode.')
  return parseRepositorySelection(body)
}
