/** H3 live-preview override entry: inserts the engine-side low-res preview
 * decoder into the model chain so the realtime fabric receives RGB frames
 * during sampling (node '7' in the pre-registry graph — the id and widget
 * contract are unchanged). */
import { findH3PreviewOverrideNode } from '../h3Stack'
import type { ObjectInfo } from '../comfyInfo'
import type { ComfyPrompt, GraphContext, OptimizationEntry, TransformOptions } from './types'
import { H3 } from './ids'

function previewTransform(graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void {
  const override = opts.previewOverride
  if (!override) return
  ctx.wrapModel('previewOverride', H3.previewOverride, {
    class_type: override.nodeType ?? 'MiniMaxH3PreviewOverride',
    inputs: {
      max_resolution: 512,
      preview_frames: override.frames,
      preview_fps: override.fps,
      // This is the tiny per-step RGB decoder from models/vae_approx, not the
      // full MiniMax video VAE used by the final decode branch. The factory
      // passes the selected preview VAE through ctx.params; when neither the
      // override nor the selection names one the value stays undefined exactly
      // as the pre-registry builder left it.
      vae_name: override.vaeName ?? ctx.params.previewVae,
      jpeg_quality: override.jpegQuality ?? 85,
      suppress_default_preview: true,
    },
  })
}

export const PREVIEW_ENTRY: OptimizationEntry = {
  id: 'preview.h3-override',
  label: 'H3 live preview override',
  kind: 'preview',
  appliesTo: ['minimax'],
  wraps: 'modelChain',
  detect(info: ObjectInfo | undefined) {
    const node = info ? findH3PreviewOverrideNode(info) : undefined
    return { available: Boolean(node), missingNodes: node ? [] : ['MiniMaxH3PreviewOverride'] }
  },
  transform: previewTransform,
  ui: {
    description: 'Streams low-resolution RGB frames from the engine while sampling (taeh3 approximated decode).',
    installHint: 'Comfy-Org MiniMax H3 support ≥ the preview-override node (MiniMaxH3PreviewOverrideCS on newer engines).',
  },
}
