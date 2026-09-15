/**
 * MiniMax-H3 adaln form detection at model-scan time (task k271ykk).
 *
 * The same tensor-shape contract the form-adapter node enforces at load
 * time (custom-nodes/minimax-lora-form-adapter), applied to the model
 * REGISTRY so the studio can tag every scanned file with its form and give
 * clear guidance for mismatched LoRA×base combinations:
 *
 *   model side   curve   ⇐ a shared `adaln_t_table [grid, k]` buffer is
 *                          present (ComfyUI's own detection —
 *                          comfy/model_detection.py; never the filename: the
 *                          b25-49 hybrid carries no "pruned" in its name)
 *                 full   ⇐ `time_embedder.*` present, or block-0 adaln at
 *                          width 2688
 *   lora side    full-width-adaln ⇐ `*.adaln_proj.linear.lora_A.weight`
 *                          with shape[1] == 2688 (the larryvrh-turbo /
 *                          Acc-trunk class — the ones the stock loader
 *                          cannot put on a pruned base)
 *                 curve-adaln      ⇐ width == 8 (kijai _pruned, ethanfel)
 *                 adaln-free       ⇐ no adaln keys (most Civitai style
 *                          LoRAs + the lightx2v/official turbo files — the
 *                          stock loader already handles them everywhere)
 *
 * All reading is header-only (8-byte LE length + JSON — a few hundred KB at
 * most, no tensors), bounded, and failure-tolerant: an unreadable or exotic
 * file reports no form rather than breaking the scan for every other entry.
 */
import { open } from 'node:fs/promises'
import type { ModelKind } from '../src/types'

export type H3ModelForm = 'curve' | 'full'
export type H3LoraForm = 'adaln-free' | 'curve-adaln' | 'full-width-adaln'

/** Refuse absurd headers instead of reading the described size. */
const MAX_HEADER_BYTES = 256 * 1024 * 1024

export type SafetensorInfo = { dtype: string; shape: number[]; data_offsets: [number, number] }
export type SafetensorsHeader = Record<string, SafetensorInfo | { [key: string]: unknown }> | null

/** Reads only the safetensors JSON header of a file. Null for anything that
 *  is not a plausible safetensors file (wrong magic length, absurd size,
 *  unreadable, not JSON) — never a thrown error: scans must tolerate junk. */
export async function readSafetensorsHeader(file: string): Promise<Record<string, SafetensorInfo> | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const { buffer: lengthBytes, bytesRead } = await handle.read({ buffer: Buffer.alloc(8), position: 0 })
    if (bytesRead !== 8) return null
    // u64 LE — readUIntLE caps at 6 bytes, so the BigInt reader it is
    const headerLength = Number(lengthBytes.readBigUInt64LE(0))
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) return null
    const headerBuffer = Buffer.alloc(headerLength)
    const headerRead = await handle.read({ buffer: headerBuffer, position: 8 })
    if (headerRead.bytesRead !== headerLength) return null
    const parsed = JSON.parse(headerBuffer.toString('utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const tensors: Record<string, SafetensorInfo> = {}
    for (const [name, info] of Object.entries(parsed)) {
      if (name === '__metadata__' || !info || typeof info !== 'object' || Array.isArray(info)) continue
      const candidate = info as Partial<SafetensorInfo>
      if (!Array.isArray(candidate.shape) || typeof candidate.dtype !== 'string') continue
      tensors[name] = { dtype: candidate.dtype, shape: candidate.shape, data_offsets: candidate.data_offsets as [number, number] }
    }
    return tensors
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Classify a checkpoint header (model side). Null = not a MiniMax-H3 shape. */
export function detectH3ModelForm(header: Record<string, SafetensorInfo> | null): H3ModelForm | null {
  if (!header) return null
  const table = Object.entries(header).find(([name, info]) => name.endsWith('adaln_t_table') && info.shape.length === 2)
  if (table) return 'curve'
  if (Object.keys(header).some((name) => name.startsWith('time_embedder.') || name.includes('.time_embedder.'))) return 'full'
  if (Object.keys(header).some((name) => name.endsWith('blocks.0.adaln_proj.linear.weight'))) return 'full'
  return null
}

export type H3LoraFormInfo = {
  form: H3LoraForm
  adalnPairs: number
  adalnAWidth: number | null
  prefixed: boolean
  diffUsersNaming: boolean
}

/** Classify a LoRA header (LoRA side) from the adaln lora_A width alone. */
export function detectH3LoraForm(header: Record<string, SafetensorInfo> | null, fullWidth = 2688): H3LoraFormInfo | null {
  if (!header) return null
  const adalnA = Object.entries(header).filter(([name, info]) => name.endsWith('.adaln_proj.linear.lora_A.weight') && info.shape.length === 2)
  const widths = new Set(adalnA.map(([, info]) => info.shape[1]))
  let form: H3LoraForm
  let adalnAWidth: number | null
  if (adalnA.length === 0) {
    form = 'adaln-free'
    adalnAWidth = null
  } else if (widths.size !== 1) {
    // inconsistent widths: malformed; treat as the wider (refusing) form so
    // the guidance errs toward "needs attention", never toward silence
    form = 'full-width-adaln'
    adalnAWidth = Math.max(...widths)
  } else {
    adalnAWidth = widths.values().next().value as number
    form = adalnAWidth === fullWidth ? 'full-width-adaln' : 'curve-adaln'
  }
  const names = Object.keys(header)
  return {
    form,
    adalnPairs: adalnA.length,
    adalnAWidth,
    prefixed: adalnA.some(([name]) => name.startsWith('diffusion_model.')),
    diffUsersNaming: names.some((name) => name.includes('.to_q.') || name.includes('.to_k.') || name.includes('.to_out.0.') || name.includes('.ff.net.')),
  }
}

export type H3LoraCompat = 'ok' | 'needs-adapter' | 'refused' | 'unknown'

/** The verdict for one (base form, LoRA form) pair — the same decision the
 *  node makes at load time (plan_form_adaptation), expressed for the UI. */
export function h3LoraCompat(modelForm: H3ModelForm | null, loraForm: H3LoraForm | null): H3LoraCompat {
  if (!loraForm) return 'unknown'
  if (loraForm === 'adaln-free') return 'ok'
  if (!modelForm) return 'unknown'
  if (loraForm === 'full-width-adaln') return modelForm === 'curve' ? 'needs-adapter' : 'ok'
  return modelForm === 'full' ? 'refused' : 'ok' // curve-adaln on curve base: ok
}

/** One-line guidance for the registry/UI, mirroring the node's messages. */
export function h3LoraGuidance(modelForm: H3ModelForm | null, lora: H3LoraFormInfo | null, adapterPackName: string): string | undefined {
  if (!lora) return undefined
  const verdict = h3LoraCompat(modelForm, lora.form)
  if (verdict === 'needs-adapter') {
    return `full-width adaln LoRA (${lora.adalnPairs} pairs) on a pruned/curve base: load it through the ${adapterPackName} node (MiniMaxH3LoraFormLoader), which projects the adaln pairs at load time — the stock LoRA loader throws a shape error here.`
  }
  if (verdict === 'refused') {
    return `curve-form LoRA (adaln width ${lora.adalnAWidth}) on a full-width base: wrong direction — use a full-width LoRA or a pruned base.`
  }
  if (lora.diffUsersNaming) {
    return 'diffusers/PEFT naming detected: convert before use (namespace + fc1 half-swap + qkv block-diagonal) — no loader applies it as-is.'
  }
  return undefined
}

/** Form tags for one scanned model file; undefined when the file is not
 *  safetensors, unreadable, or not an H3-shaped artifact. Weights nothing:
 *  header reads only, and a failed read degrades to "no tag". */
export async function h3FormForScannedFile(file: string, kind: ModelKind): Promise<string | undefined> {
  if (!file.toLowerCase().endsWith('.safetensors')) return undefined
  const header = await readSafetensorsHeader(file)
  if (!header) return undefined
  if (kind === 'diffusion_models') return detectH3ModelForm(header) ?? undefined
  if (kind === 'loras') return detectH3LoraForm(header)?.form
  return undefined
}
