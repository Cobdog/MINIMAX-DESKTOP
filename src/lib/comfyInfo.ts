export type ObjectInfo = Record<string, { input: { required: Record<string, unknown[]> } }>
/** Shape-tolerant enum read (the server-side instanceInventory contract, task
 *  9om4bi9: "an exotic instance must not" take the surface down): real
 *  instances serve every node with input.required, but lean/exotic ones may
 *  serve a bare object — degrade to an empty list, never a throw. Exposed by
 *  the rq0lsax instance-override e2e, whose fake engine lists UNETLoader
 *  without an input block. */
export function choices(info: ObjectInfo, node: string, field: string): string[] {
  const input = info[node]?.input?.required?.[field]
  if (!input || !Array.isArray(input)) return []
  if (Array.isArray(input[0])) return input[0].filter((v): v is string => typeof v === 'string')
  const options = (input[1] as { options?: unknown[] } | undefined)?.options
  return options?.filter((v): v is string => typeof v === 'string') ?? []
}
