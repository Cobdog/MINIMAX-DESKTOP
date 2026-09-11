/** MiniMax Music 3 workspace: the official three-section caption builder,
 *  lyrics with structure-tag insertion, the local caption rewriter, and
 *  up-to-5-minute generation through the official template graph. */
import { useEffect, useState } from 'react'
import { AlertCircle, Check, LoaderCircle, Music2, Play, RotateCcw, WandSparkles } from 'lucide-react'
import type { GenerationJob } from '../types'
import type { Music3ModelSelection, Music3GenerationOptions } from '../lib/music3Workflow'
import { MUSIC3_SECTION_TAGS, buildMusic3Caption, buildMusic3CaptionRewriteRequest } from '../lib/music3Workflow'

type Music3Draft = {
  globalMetadata: string
  vocalDetails: string
  arrangement: string
  lyrics: string
  duration: number
  seed: number
  tiledDecode: boolean
}

const DRAFT_KEY = 'minimax.music3-workspace'

function loadDraft(): Music3Draft {
  try {
    const stored = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') as Partial<Music3Draft>
    return {
      globalMetadata: stored.globalMetadata ?? '',
      vocalDetails: stored.vocalDetails ?? '',
      arrangement: stored.arrangement ?? '',
      lyrics: stored.lyrics ?? '',
      duration: Math.min(300, Math.max(10, Number(stored.duration) || 60)),
      seed: Number(stored.seed) || Math.floor(Math.random() * 1_000_000_000),
      tiledDecode: stored.tiledDecode ?? true,
    }
  } catch {
    return { globalMetadata: '', vocalDetails: '', arrangement: '', lyrics: '', duration: 60, seed: Math.floor(Math.random() * 1_000_000_000), tiledDecode: true }
  }
}

export function Music3Workspace({ settings, models, connected, pipelineReady, missingNodes, latestJob, submitting, cancelling, ollamaAvailable, onGenerate, onCancel, onNotice }: {
  settings: { ollamaModel: string }
  models: Music3ModelSelection
  connected: boolean
  pipelineReady: boolean
  missingNodes: readonly string[]
  latestJob?: GenerationJob
  submitting: boolean
  cancelling: boolean
  ollamaAvailable: boolean
  onGenerate(options: Music3GenerationOptions): void
  onCancel(job: GenerationJob): void
  onNotice(tone: 'error' | 'success' | 'neutral', text: string): void
}) {
  const [draft, setDraft] = useState<Music3Draft>(loadDraft)
  const [rewriting, setRewriting] = useState(false)
  const modelsReady = Boolean(models.diffusion && models.textEncoder && models.vae)

  useEffect(() => { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)) }, [draft])

  const patch = (part: Partial<Music3Draft>) => setDraft((current) => ({ ...current, ...part }))

  const rewriteCaption = async () => {
    const caption = buildMusic3Caption(draft)
    if (!caption.trim()) { onNotice('error', 'Write a caption first — the rewriter improves an existing description.'); return }
    if (!ollamaAvailable) { onNotice('error', 'No local Ollama text model is available. Check Ollama in Settings.'); return }
    setRewriting(true)
    try {
      const rewritten = await window.minimax.generateWithOllama('', settings.ollamaModel, buildMusic3CaptionRewriteRequest(caption))
      const section = (heading: string) => {
        const match = new RegExp(`${heading}:\\s*([\\s\\S]*?)(?=\\n[A-Z][a-z]+ [A-Z]|$)`).exec(rewritten)
        return match ? match[1].trim() : ''
      }
      const next = { globalMetadata: section('Global Metadata'), vocalDetails: section('Vocal Details'), arrangement: section('Arrangement') }
      if (!next.globalMetadata && !next.vocalDetails && !next.arrangement) {
        onNotice('error', 'The rewriter did not return the three-section format — its output was discarded. Try again or edit manually.')
      } else {
        patch(next)
        onNotice('success', 'Caption rewritten locally — review each section before generating.')
      }
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error))
    } finally {
      setRewriting(false)
    }
  }

  const sectionField = (key: 'globalMetadata' | 'vocalDetails' | 'arrangement', label: string, hint: string) => (
    <label className="music3-section"><span>{label}<small>{hint}</small></span>
      <textarea value={draft[key]} onChange={(event) => patch({ [key]: event.target.value } as Partial<Music3Draft>)} placeholder={`${label}…`} />
    </label>
  )

  return (
    <div className="standard-page music3-page">
      <div className="page-heading">
        <div><p className="eyebrow">LOCAL MUSIC ENGINE</p><h1>MiniMax Music 3</h1><p>Complete songs up to five minutes — caption, lyrics, and structure tags through the official template graph.</p></div>
        <div className="heading-state"><span className={modelsReady ? 'ok' : 'warn'}>{modelsReady ? <Check size={15} /> : <AlertCircle size={15} />}{modelsReady ? 'Music 3 models detected' : 'Music 3 models missing'}</span></div>
      </div>
      {!pipelineReady && <div className="reference-order-warning" role="alert"><span><AlertCircle size={12} />Update ComfyUI for Music 3. Missing core nodes: {missingNodes.join(', ')}.</span></div>}
      {!modelsReady && <div className="reference-order-warning" role="alert"><span><AlertCircle size={12} />Install the Music 3 files into ComfyUI (diffusion_models: minimax_music3_dit_int8_convrot · text_encoders: minimax_music3_text_encoder_pruned_int8_convrot · vae: minimax_music3_dav), then rescan in Settings.</span></div>}
      <div className="music3-grid">
        <section className="music3-composer">
          {sectionField('globalMetadata', 'Global Metadata', 'Genre, BPM, key and scale, emotional progression, listening scenario, production profile')}
          {sectionField('vocalDetails', 'Vocal Details', 'Voice gender, timbre, performance style, harmonies, vocal effects')}
          {sectionField('arrangement', 'Arrangement', 'Primary and secondary instruments, groove, bass, percussion, textures, spatial effects')}
          <div className="prompt-tool-buttons music3-rewrite">
            <button type="button" className="secondary-button" onClick={() => void rewriteCaption()} disabled={!ollamaAvailable || rewriting} title={ollamaAvailable ? 'Rewrite the caption locally with Ollama following the official rules' : 'Configure a local Ollama text model in Settings to enable the rewriter'}>{rewriting ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}Rewrite caption</button>
            <button type="button" className="secondary-button" onClick={() => patch({ globalMetadata: '', vocalDetails: '', arrangement: '', lyrics: '', seed: Math.floor(Math.random() * 1_000_000_000) })} title="Clear the caption and lyrics for a fresh start"><RotateCcw size={14} />Clear</button>
          </div>
          <label className="music3-lyrics"><span>Lyrics<small>Structure tags are the only structural instructions — the lyric text carries the mood</small></span>
            <textarea value={draft.lyrics} onChange={(event) => patch({ lyrics: event.target.value })} placeholder={'[Intro]\n[Verse]\nYour words here…\n\n[Chorus]\n…'} />
          </label>
          <div className="music3-tags" aria-label="Lyrics structure tags">
            {MUSIC3_SECTION_TAGS.map((tag) => <button type="button" key={tag} title={`Insert ${tag} into the lyrics`} onClick={() => patch({ lyrics: `${draft.lyrics}${draft.lyrics.endsWith('\n') || !draft.lyrics ? '' : '\n'}${tag}\n` })}>{tag}</button>)}
          </div>
        </section>
        <aside className="music3-controls">
          <label>Target length<small>Up to about 5 minutes; the model may end the song earlier</small>
            <input type="number" min={10} max={300} step={5} value={draft.duration} onChange={(event) => patch({ duration: Math.min(300, Math.max(10, Number(event.target.value) || 60)) })} />
          </label>
          <label>Seed<input type="number" min={0} max={999999999999} value={draft.seed} onChange={(event) => patch({ seed: Number(event.target.value) })} /></label>
          <label className="music3-tiled"><input type="checkbox" checked={draft.tiledDecode} onChange={(event) => patch({ tiledDecode: event.target.checked })} /><span>Tiled audio decode<small>Overlapping tiles cut VRAM on long songs at a small seam risk; disable on large GPUs for best quality</small></span></label>
          <div className="generate-bar">
            <div className="generation-summary"><Music2 size={17} /><span><strong>{Math.round(draft.duration / 60 * 10) / 10} min</strong><small>mp3 · 32 kHz stereo</small></span></div>
            <div className="generate-actions">
              {latestJob && ['queued', 'running'].includes(latestJob.status) && <button className="danger-button" onClick={() => onCancel(latestJob)} disabled={cancelling}>{cancelling ? 'Stopping…' : 'Stop'}</button>}
              <button className="primary-button generation-button" disabled={submitting || !connected || !modelsReady || !pipelineReady || !buildMusic3Caption(draft).trim()} onClick={() => onGenerate({ caption: buildMusic3Caption(draft), lyrics: draft.lyrics, duration: draft.duration, seed: draft.seed, tiledDecode: draft.tiledDecode, filenamePrefix: `audio/MiniMax_Music3_${Date.now()}` })}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Play size={18} fill="currentColor" />}{submitting ? 'Submitting…' : 'Generate song'}</button>
            </div>
          </div>
          {latestJob?.outputUrl && <audio className="job-audio music3-result" src={latestJob.outputUrl} controls />}
        </aside>
      </div>
    </div>
  )
}
