export type ObjectInfo = Record<string, { input: { required: Record<string, unknown[]> } }>
export function choices(info: ObjectInfo, node: string, field: string): string[] {
  const input = info[node]?.input.required[field]
  if (!input) return []
  if (Array.isArray(input[0])) return input[0].filter((v): v is string => typeof v === 'string')
  const options = (input[1] as { options?: unknown[] } | undefined)?.options
  return options?.filter((v): v is string => typeof v === 'string') ?? []
}
