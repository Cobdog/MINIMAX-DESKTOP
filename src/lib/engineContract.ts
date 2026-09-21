/**
 * THE ENGINE-CONTRACT VALIDATOR (task 8dga2dy — the T=1 lesson made
 * structural). Mirrors ComfyUI execution.py's `validate_inputs` prompt gate
 * (revision a87667f, v0.34.0) as a pure function over the REAL served
 * object_info — the committed capture fixture
 * scripts/fixtures/engine-object-info.json. A graph this module accepts is a
 * graph the engine's validation phase accepts; a graph it rejects carries the
 * engine's own error vocabulary.
 *
 * WHY THIS EXISTS (2026-09-21): our builders emitted parameter values the
 * engine refuses or silently reinterprets at execution — `length: 1` refused
 * by schema-min enforcement; packet tiers 9/13 snapping to 22 frames. Every
 * prior test verified graph SHAPE against synthetic object_info stubs, which
 * by construction cannot know the real constraints. Capability claims never
 * ride on synthetic evidence (docs/agent/testing.md, the doctrine).
 *
 * Fidelity notes (what is mirrored, what is deliberately not):
 *  - Mirrored: required-input presence; link shape [node_id, slot]; link slot
 *    range against the source node's real output arity; socket-type
 *    compatibility (exact / '*' Any / comma-union overlap —
 *    comfy_execution/validation.py semantics); INT/FLOAT/STRING/BOOLEAN
 *    coercion-failure; schema min/max; combo membership (both serving
 *    shapes: legacy [options, extra] and COMBO {options}).
 *  - Deliberately NOT mirrored (recorded, not silent):
 *    (a) custom VALIDATE_INPUTS bodies — filesystem existence checks
 *        (LoadImage.image, model folders) and cross-field rules are
 *        runtime-environment contract, not schema contract;
 *    (b) empty combo options = environment-enumerated (a folder listing on
 *        the serving box) — membership is skipped, not failed;
 *    (c) dynamic v3 combos whose options are {key, inputs} trees
 *        (SaveVideo format/codec) — the engine resolves these per submitted
 *        value; any string is accepted here;
 *    (d) `is_input_list` fields (list-of-links inputs) — none in our emitted
 *        surface; a list value on a non-list input is treated as a link
 *        attempt, exactly like the engine treats it.
 */
export type ObjectInfoLike = Record<string, unknown> | undefined

export type ContractViolation = {
  nodeId: string
  classType: string
  inputName?: string
  type:
    | 'missing_node_type'
    | 'required_input_missing'
    | 'bad_linked_input'
    | 'unknown_linked_node'
    | 'bad_linked_slot'
    | 'return_type_mismatch'
    | 'invalid_input_type'
    | 'value_smaller_than_min'
    | 'value_bigger_than_max'
    | 'value_not_in_list'
    | 'dependency_cycle'
  message: string
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> }
export type ContractGraph = Record<string, GraphNode>

type ServedField = unknown[]

function servedClass(info: ObjectInfoLike, classType: string): Record<string, unknown> | undefined {
  if (!info || typeof info !== 'object') return undefined
  const entry = (info as Record<string, unknown>)[classType]
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : undefined
}

/** required ∪ optional field specs: [section, name, spec] rows. */
function declaredInputs(entry: Record<string, unknown>): Array<{ name: string; spec: ServedField; required: boolean }> {
  const input = entry.input as Record<string, Record<string, ServedField>> | undefined
  const rows: Array<{ name: string; spec: ServedField; required: boolean }> = []
  if (!input || typeof input !== 'object') return rows
  for (const section of ['required', 'optional'] as const) {
    const fields = input[section]
    if (!fields || typeof fields !== 'object') continue
    for (const name of Object.keys(fields)) {
      const spec = fields[name]
      if (Array.isArray(spec)) rows.push({ name, spec, required: section === 'required' })
    }
  }
  return rows
}

function inputTypeOf(spec: ServedField): string {
  const head = spec[0]
  return typeof head === 'string' ? head : 'COMBO'
}

function extraInfoOf(spec: ServedField): Record<string, unknown> {
  const extra = spec[1]
  return extra && typeof extra === 'object' && !Array.isArray(extra) ? (extra as Record<string, unknown>) : {}
}

/** Combo options as strings; null when NOT a plain-string combo (empty =
 * environment-enumerated; object trees = dynamic v3 combo). Mirrors the
 * engine's own membership source for both serving shapes. */
function comboOptions(spec: ServedField): string[] | null {
  const head = spec[0]
  if (Array.isArray(head)) {
    const options = head.filter((v): v is string => typeof v === 'string')
    return options.length === head.length ? options : null
  }
  const extra = extraInfoOf(spec)
  if (Array.isArray(extra.options)) {
    const options = (extra.options as unknown[]).filter((v): v is string => typeof v === 'string')
    if (options.length !== (extra.options as unknown[]).length) return null // dynamic {key,inputs} tree
    return options
  }
  return null
}

/** comfy_execution/validation.py semantics: exact; '*' Any on either side;
 * comma-union overlap otherwise. */
export function socketTypeCompatible(received: string, expected: string): boolean {
  if (received === expected) return true
  if (received === '*' || expected === '*') return true
  const receivedSet = new Set(received.split(',').map((t) => t.trim()))
  const expectedSet = new Set(expected.split(',').map((t) => t.trim()))
  if (receivedSet.has('*') || expectedSet.has('*')) return true
  for (const t of Array.from(receivedSet)) if (expectedSet.has(t)) return true
  return false
}

/** Coerce a submitted scalar the way the engine's validation does (int(val)
 * / float(val) / str(val) / bool(val)); null when the coercion itself
 * fails — the engine's invalid_input_type class. Dict values reach here only
 * without a __value__ wrap (the engine unwraps that first); Python coercion
 * semantics are mirrored: str()/bool() accept anything, int()/float() reject
 * plain objects. */
function coerceScalar(inputType: string, value: unknown): { ok: true; value: number | string | boolean } | { ok: false } {
  if (inputType === 'INT' || inputType === 'FLOAT') {
    let n: number
    if (typeof value === 'number') n = value
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) n = Number(value)
    else if (typeof value === 'boolean') n = value ? 1 : 0
    else return { ok: false }
    if (inputType === 'INT' && !Number.isInteger(n)) return { ok: false }
    return { ok: true, value: n }
  }
  if (inputType === 'STRING') {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) }
    if (value !== null && typeof value === 'object') return { ok: true, value: JSON.stringify(value) } // str(dict) succeeds in Python
    return { ok: false }
  }
  if (inputType === 'BOOLEAN') {
    return { ok: true, value: Boolean(value) }
  }
  return { ok: true, value: value as number | string | boolean }
}

/**
 * Validate one built graph against one object_info snapshot the way
 * execution.py's prompt gate does. Every violation carries the engine's own
 * error type — the messages a submitter would actually see. Deterministic
 * order (node id, then declared input order).
 */
export function validateGraphAgainstSchemas(graph: ContractGraph, info: ObjectInfoLike): ContractViolation[] {
  const violations: ContractViolation[] = []
  const visiting: string[] = []
  const done = new Set<string>()

  const validateNode = (nodeId: string): void => {
    if (done.has(nodeId)) return
    if (visiting.includes(nodeId)) {
      const cycleStart = visiting.indexOf(nodeId)
      const cycle = visiting.slice(cycleStart).concat([nodeId])
      for (const id of Array.from(new Set(cycle))) {
        done.add(id)
        violations.push({ nodeId: id, classType: String((graph[id] as GraphNode | undefined)?.class_type ?? '?'), type: 'dependency_cycle', message: 'Dependency cycle detected' })
      }
      return
    }
    const node = graph[nodeId]
    if (!node || typeof node !== 'object') return
    const entry = servedClass(info, node.class_type)
    if (!entry) {
      violations.push({ nodeId, classType: node.class_type, type: 'missing_node_type', message: `Node class '${node.class_type}' is not served by this engine (not in object_info)` })
      done.add(nodeId)
      return
    }
    visiting.push(nodeId)
    for (const field of declaredInputs(entry)) {
      if (!(field.name in (node.inputs ?? {}))) {
        if (field.required) violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'required_input_missing', message: `Required input '${field.name}' is missing` })
        continue
      }
      const value = node.inputs[field.name]
      if (Array.isArray(value)) {
        if (value.length !== 2) {
          violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'bad_linked_input', message: `Bad linked input '${field.name}': must be a length-2 list of [node_id, slot_index]` })
          continue
        }
        const [sourceId, slot] = value as [unknown, unknown]
        const source = typeof sourceId === 'string' ? (graph[sourceId] as GraphNode | undefined) : undefined
        if (!source) {
          violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'unknown_linked_node', message: `Linked input '${field.name}' references node '${String(sourceId)}' which does not exist in the graph` })
          continue
        }
        const sourceEntry = servedClass(info, source.class_type)
        const outputs = sourceEntry ? (sourceEntry.output as unknown[]) : undefined
        if (typeof slot !== 'number' || !Array.isArray(outputs) || slot < 0 || slot >= outputs.length) {
          violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'bad_linked_slot', message: `Linked input '${field.name}' slot ${String(slot)} is outside node '${String(sourceId)}' outputs (0..${Array.isArray(outputs) ? outputs.length - 1 : '?'})` })
          continue
        }
        const receivedType = String(outputs[slot])
        const expectedType = inputTypeOf(field.spec)
        if (!socketTypeCompatible(receivedType, expectedType)) {
          violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'return_type_mismatch', message: `Return type mismatch on '${field.name}': received ${receivedType}, input expects ${expectedType}` })
          continue
        }
        validateNode(typeof sourceId === 'string' ? sourceId : '')
        continue
      }
      if (value !== null && typeof value === 'object') {
        // The engine unwraps {__value__: x} widget wraps; a plain dict then
        // hits the typed coercion (int()/float() reject it, str()/bool()
        // accept) — handled inside coerceScalar.
        const inputType = inputTypeOf(field.spec)
        if (inputType !== 'INT' && inputType !== 'FLOAT' && inputType !== 'STRING' && inputType !== 'BOOLEAN') continue
        const unwrapped = '__value__' in (value as Record<string, unknown>) ? (value as Record<string, unknown>).__value__ : value
        if (unwrapped !== null && typeof unwrapped === 'object' && !('__value__' in (value as Record<string, unknown>))) {
          const dictCoerced = coerceScalar(inputType, unwrapped)
          if (!dictCoerced.ok) violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'invalid_input_type', message: `Failed to convert input '${field.name}' to a ${inputType} value (got ${JSON.stringify(value)})` })
        }
        continue
      }
      const inputType = inputTypeOf(field.spec)
      const coerced = coerceScalar(inputType, value)
      if (!coerced.ok) {
        violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'invalid_input_type', message: `Failed to convert input '${field.name}' to a ${inputType} value (got ${JSON.stringify(value)})` })
        continue
      }
      const extra = extraInfoOf(field.spec)
      // The engine skips generic min/max/combo when a custom VALIDATE_INPUTS
      // owns the field; the known instances in our surface coincide with the
      // environment-enumerated combos, which the empty-options rule already
      // skips. Real enums keep their membership teeth.
      if (coerced.value === null || typeof coerced.value === 'boolean' || typeof coerced.value === 'string') {
        // min/max only apply to numeric values
      } else if (typeof extra.min === 'number' && coerced.value < extra.min) {
        violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'value_smaller_than_min', message: `Value ${coerced.value} smaller than min of ${extra.min} (input '${field.name}')` })
        continue
      } else if (typeof extra.max === 'number' && coerced.value > extra.max) {
        violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'value_bigger_than_max', message: `Value ${coerced.value} bigger than max of ${extra.max} (input '${field.name}')` })
        continue
      }
      const options = comboOptions(field.spec)
      if (options !== null && options.length > 0 && !options.includes(String(value))) {
        violations.push({ nodeId, classType: node.class_type, inputName: field.name, type: 'value_not_in_list', message: `Value '${String(value)}' not in options for '${field.name}'` })
      }
    }
    visiting.pop()
    done.add(nodeId)
  }

  for (const nodeId of Object.keys(graph)) validateNode(nodeId)
  violations.sort((a, b) => (a.nodeId === b.nodeId ? (a.inputName ?? '').localeCompare(b.inputName ?? '') : a.nodeId.localeCompare(b.nodeId, undefined, { numeric: true })))
  return violations
}

/** The readable one-line verdict for a violation list (the log/report form). */
export function contractVerdict(violations: ContractViolation[]): string | null {
  if (!violations.length) return null
  return violations.map((v) => `${v.nodeId} (${v.classType})${v.inputName ? ` '${v.inputName}'` : ''}: ${v.type} — ${v.message}`).join('\n')
}
