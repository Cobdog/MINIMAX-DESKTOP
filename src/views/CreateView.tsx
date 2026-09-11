/** The MiniMax H3 Create workspace: mode tabs, prompt composer with reference
 *  binding, source-media modal, live preview, and the output/quality panel. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertCircle,
  Aperture,
  Check,
  ChevronDown,
  CircleStop,
  Clock3,
  Copy,
  Film,
  Gauge,
  Image as ImageIcon,
  LoaderCircle,
  MapPin,
  MessageSquareText,
  Play,
  Plus,
  Scissors,
  Shirt,
  SlidersHorizontal,
  Sparkles,
  Users,
  Volume2,
  WandSparkles,
  X,
} from 'lucide-react'
import type { Film as FilmIcon } from 'lucide-react'
import type {
  CharacterProject,
  GenerationJob,
  GenerationMode,
  LocationProject,
  MediaFile,
  MediaKind,
  ModelSelection,
  MovieReferenceBinding,
  UpscaleMode,
  WardrobeProject,
} from '../types'
import type { ObjectInfo } from '../lib/comfyInfo'
import { choices } from '../lib/comfyInfo'
import { RenderSize } from '../components/RenderSize'
import { ImageCrop } from '../components/ImageCrop'
import { RenderConstruction } from '../components/RenderConstruction'
import { SmartPromptEditor, type SmartPromptEditorHandle } from '../components/SmartPromptEditor'
import { CharacterDialogueModal, type CharacterDialogueDraft } from '../components/CharacterDialogueModal'
import { characterReferences } from '../lib/characterLibrary'
import { loadHairStyleProjects } from '../lib/hairLibrary'
import { wardrobeReferences } from '../lib/wardrobeLibrary'
import { locationReferences } from '../lib/locationLibrary'
import { allocateWorkspaceReferences, composeReferenceInstructions } from '../lib/promptComposer'
import { composeH3Prompt, resolveRenderReferenceImages } from '../lib/promptPolicies'
import { buildBaseContractDraft, buildReferenceContractDraft, referenceOrderWarnings, suggestCutTimes } from '../lib/promptContracts'
import { PromptLibraryBrowser } from '../components/PromptLibraryBrowser'
import { findH3PreviewOverrideNode } from '../lib/h3Stack'
import { frameCount, frameIndexForSeconds, guideFrameWarning } from '../lib/workflow'
import type { LivePreview } from '../lib/useLivePreview'
import { SelectField, NumberField } from '../components/form'
import { PipelineItem, StatusBadge } from '../components/chrome'
import { VideoPlayer, VideoContinuationControls, MediaDrop } from '../components/media'

const modeInfo: Array<{ id: GenerationMode; label: string; note: string; icon: typeof FilmIcon }> = [
  { id: 'text', label: 'Text', note: 'Prompt to video', icon: WandSparkles },
  { id: 'image', label: 'Image', note: 'Animate one frame', icon: ImageIcon },
  { id: 'frames', label: 'First + last', note: 'Direct the transition', icon: Aperture },
  { id: 'reference', label: 'Reference', note: 'Images, video, audio', icon: Sparkles },
]

export type CreateViewProps = {
  info: ObjectInfo
  sampler: string; setSampler(value: string): void; scheduler: string; setScheduler(value: string): void
  experimentalSampling: boolean; setExperimentalSampling(value: boolean): void
  refImageSize: 'match' | 'max'; setRefImageSize(value: 'match' | 'max'): void
  sigmaShiftMode: 'model' | 'custom'; setSigmaShiftMode(value: 'model' | 'custom'): void
  shiftVideo: number; setShiftVideo(value: number): void; shiftAudio: number; setShiftAudio(value: number): void
  loraStrength: number; setLoraStrength(value: number): void
  liveEnabled: boolean; setLiveEnabled(value: boolean): void; livePreviewMode: 'standard' | 'h3-override'; setLivePreviewMode(value: 'standard' | 'h3-override'): void; liveConnected: boolean; livePreview: LivePreview | null
  upscaleMode: UpscaleMode; setUpscaleMode(value: UpscaleMode): void; ltxAvailable: boolean; ltxMissingNodes: readonly string[]
  noDialogue: boolean; setNoDialogue(value: boolean): void
  naturalMovement: boolean; setNaturalMovement(value: boolean): void
  clothingPolicy: 'wardrobe' | 'underwear' | 'unrestricted'; setClothingPolicy(value: 'wardrobe' | 'underwear' | 'unrestricted'): void
  rtxModels: string[]; rtxModel: string; setRtxModel(value: string): void
  updateReference(index: number, file: MediaFile): void
  mode: GenerationMode; setMode(value: GenerationMode): void
  prompt: string; setPrompt(value: string): void
  duration: number; setDuration(value: number): void
  resolution: string; setResolution(value: string): void
  turbo: 'off' | '4' | '8'; setTurbo(value: 'off' | '4' | '8'): void
  steps: number; setSteps(value: number): void
  seed: number; setSeed(value: number): void
  advanced: boolean; setAdvanced(value: boolean): void
  firstFrame: MediaFile | null; lastFrame: MediaFile | null
  setFirstFrame(value: MediaFile | null): void; setLastFrame(value: MediaFile | null): void
  chooseMedia(kind: MediaKind, setter: (file: MediaFile) => void): Promise<void>
  referenceImages: MediaFile[]; referenceVideos: MediaFile[]; referenceAudios: MediaFile[]; timelineGuides: Array<{ file: MediaFile; seconds: number }>; setTimelineGuides(value: Array<{ file: MediaFile; seconds: number }>): void
  characters: CharacterProject[]; wardrobes: WardrobeProject[]; locations: LocationProject[]; selectedCharacterIds: string[]; selectedLocationIds: string[]; loadCharacter(characterId: string): void; loadWardrobe(wardrobeId: string): void; loadLocation(locationId: string): void
  refreshSourceMedia(): Promise<void>
  removeReference(kind: MediaKind, index: number): void
  addReferenceImage(file: MediaFile): void
  chooseReference(kind: MediaKind): Promise<void>
  editVideoReference(index: number): void
  h3Validated: boolean
  modelReady: boolean; selection: ModelSelection; submitting: boolean; cancelling: boolean; connected: boolean
  ollamaAvailable: boolean; ollamaModel: string; promptSuggestion: string
  promptingTool: 'enhance' | 'timeline' | 'audio' | null
  dialogueGenerating: boolean
  onPromptTool(tool: 'enhance' | 'timeline' | 'audio'): void
  onGenerateDialogue(draft: CharacterDialogueDraft): Promise<string>
  onUseSuggestion(): void; onDismissSuggestion(): void
  onGenerate(): void; onCancel(job: GenerationJob): void; onContinue(job: GenerationJob, position: number | 'last'): Promise<void>; latestJob?: GenerationJob
  onOpenSettings(): void
}

export function CreateView(props: CreateViewProps) {
  const {
    info, sampler, setSampler, scheduler, setScheduler, experimentalSampling, setExperimentalSampling, refImageSize, setRefImageSize,
    sigmaShiftMode, setSigmaShiftMode, shiftVideo, setShiftVideo, shiftAudio, setShiftAudio, loraStrength, setLoraStrength, liveEnabled, setLiveEnabled, livePreviewMode, setLivePreviewMode, liveConnected, livePreview,
    upscaleMode, setUpscaleMode, ltxAvailable, ltxMissingNodes, noDialogue, setNoDialogue, naturalMovement, setNaturalMovement, clothingPolicy, setClothingPolicy, rtxModels, rtxModel, setRtxModel, updateReference,
    mode, setMode, prompt, setPrompt, duration, setDuration, resolution, setResolution, turbo, setTurbo, steps, setSteps,
    seed, setSeed, advanced, setAdvanced, firstFrame, lastFrame, setFirstFrame, setLastFrame, chooseMedia,
    referenceImages, referenceVideos, referenceAudios, timelineGuides, setTimelineGuides, addReferenceImage, characters, wardrobes, locations, selectedCharacterIds, selectedLocationIds, loadCharacter, loadWardrobe, loadLocation, refreshSourceMedia, removeReference, chooseReference, editVideoReference, h3Validated, modelReady, selection,
    submitting, cancelling, connected, ollamaAvailable, ollamaModel, promptSuggestion, promptingTool, dialogueGenerating,
    onPromptTool, onGenerateDialogue, onUseSuggestion, onDismissSuggestion, onGenerate, onCancel, onContinue, latestJob, onOpenSettings,
  } = props
  const promptRef = useRef<SmartPromptEditorHandle>(null)
  const previewPanelRef = useRef<HTMLElement>(null)
  // Fit the preview panel to the viewport from its natural position, so the
  // Generate bar is on screen at scroll position 0 without hard-coding the
  // page-heading height in CSS. offsetTop is layout-stable under sticky.
  useEffect(() => {
    const panel = previewPanelRef.current
    if (!panel) return
    const fit = () => {
      const scroller = panel.closest<HTMLElement>('.main-area')
      const visible = scroller?.clientHeight ?? window.innerHeight
      const gap = Math.max(panel.offsetTop, 16)
      panel.style.setProperty('--preview-cap', `${Math.max(320, visible - gap - 16)}px`)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  const sourceMediaTriggerRef = useRef<HTMLButtonElement>(null)
  const sourceMediaCloseRef = useRef<HTMLButtonElement>(null)
  const dialogueTriggerRef = useRef<HTMLButtonElement>(null)
  const [sourceMediaOpen, setSourceMediaOpen] = useState(false)
  const [dialogueOpen, setDialogueOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [renderedVideoDuration, setRenderedVideoDuration] = useState(0)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const h3PreviewOverrideAvailable = Boolean(findH3PreviewOverrideNode(info))
  const selectedCharacters = selectedCharacterIds.map((id) => characters.find((character) => character.id === id)).filter(Boolean) as CharacterProject[]
  const selectedLocations = selectedLocationIds.map((id) => locations.find((location) => location.id === id)).filter(Boolean) as LocationProject[]
  const selectedBindings = allocateWorkspaceReferences(selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds })), wardrobes, selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location), environmentMode: location.environmentMode })))
  const activeSelectedBindings = clothingPolicy === 'wardrobe' ? selectedBindings : selectedBindings.filter((binding) => binding.purpose !== 'wardrobe')
  const builderReferenceImages = resolveRenderReferenceImages(referenceImages, selectedBindings, clothingPolicy)
  const composedPrompt = composeH3Prompt({ prompt, mode, bindings: selectedBindings, clothingPolicy, noDialogue, naturalMovement })
  const sourceMediaCount = referenceImages.length + referenceVideos.length + referenceAudios.length
  const closeSourceMedia = useCallback(() => {
    setSourceMediaOpen(false)
    window.requestAnimationFrame(() => sourceMediaTriggerRef.current?.focus())
  }, [])
  const keepSourceMediaFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    const first = controls[0]
    const last = controls.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }
  useEffect(() => {
    if (!sourceMediaOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSourceMedia()
    }
    window.addEventListener('keydown', closeOnEscape)
    window.requestAnimationFrame(() => sourceMediaCloseRef.current?.focus())
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeSourceMedia, sourceMediaOpen])
  useEffect(() => {
    if (mode !== 'reference' && sourceMediaOpen) setSourceMediaOpen(false)
  }, [mode, sourceMediaOpen])
  useEffect(() => setRenderedVideoDuration(0), [latestJob?.id])
  const insertPromptText = (text: string) => promptRef.current?.insert(text)
  const copyComposedPrompt = async () => {
    if (!composedPrompt) return
    try {
      await navigator.clipboard.writeText(composedPrompt)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1600)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 2400)
    }
  }
  const closeDialogue = useCallback(() => {
    setDialogueOpen(false)
    window.requestAnimationFrame(() => dialogueTriggerRef.current?.focus())
  }, [])
  const smartCharacterOptions = characters.filter((character) => characterReferences(character).length > 0).map((character) => {
    const projected = selectedCharacterIds.includes(character.id) ? selectedCharacters : [...selectedCharacters, character]
    const projectedBindings = allocateWorkspaceReferences(projected.map((item) => ({ id: item.id, name: item.name, identity: characterReferences(item), hairStyleIds: item.hairStyleIds, wardrobeIds: item.wardrobeIds, accessoryIds: item.accessoryIds })), wardrobes, selectedLocations.map((location) => ({ id: location.id, name: location.name, images: locationReferences(location), environmentMode: location.environmentMode })))
    const wardrobeCount = projectedBindings.filter((binding) => binding.characterId === character.id && binding.purpose === 'wardrobe').length
    return { id: `character.${character.id}`, category: 'character' as const, label: character.name, description: wardrobeCount ? `${character.description || 'Character Studio identity'} · wardrobe isolated` : character.description || 'Character Studio identity', insertion: `Character: ${character.name}.`, thumbnail: characterReferences(character)[0]?.preview, meta: `${projectedBindings.filter((binding) => binding.characterId === character.id).length} allocated refs`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadCharacter(character.id) } }
  })
  const smartWardrobeOptions = wardrobes.filter((wardrobe) => wardrobeReferences(wardrobe).length > 0).map((wardrobe) => { const files = wardrobeReferences(wardrobe).slice(0, 9); const tags = files.map((_, index) => `<Picture ${index + 1}>`).join(', ').replace(/, ([^,]+)$/, ' and $1'); return { id: `wardrobe.${wardrobe.id}`, category: 'wardrobe' as const, label: wardrobe.name, description: wardrobe.description || 'Approved Wardrobe Studio outfit', insertion: `Wardrobe: apply the approved ${wardrobe.name} outfit from ${tags}; preserve its garments, materials, colors, fit, and accessories.`, thumbnail: files[0]?.preview, meta: `${files.length} approved`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadWardrobe(wardrobe.id) } } })
  const smartLocationOptions = locations.filter((location) => locationReferences(location).length > 0).map((location) => { const files = locationReferences(location); const projected = selectedLocationIds.includes(location.id) ? selectedLocations : [...selectedLocations, location]; const projectedBindings = allocateWorkspaceReferences(selectedCharacters.map((character) => ({ id: character.id, name: character.name, identity: characterReferences(character), hairStyleIds: character.hairStyleIds, wardrobeIds: character.wardrobeIds, accessoryIds: character.accessoryIds })), wardrobes, projected.map((item) => ({ id: item.id, name: item.name, images: locationReferences(item), environmentMode: item.environmentMode }))); return { id: `location.${location.id}`, category: 'location' as const, label: location.name, description: location.description || 'Approved Location Studio environment', insertion: `Location: ${location.name}.`, thumbnail: files[0]?.preview, meta: `${projectedBindings.filter((binding) => binding.locationId === location.id).length} allocated view${projectedBindings.filter((binding) => binding.locationId === location.id).length === 1 ? '' : 's'}`, onSelect: (nextPrompt: string) => { setPrompt(nextPrompt); loadLocation(location.id) } } })
  const applyCreatePreset = (preset: 'quality' | 'turbo' | 'preview') => {    const [width, height] = resolution.split('x').map(Number)
    const portrait = height > width
    const square = height === width
    const base = preset === 'preview' ? square ? '640x640' : portrait ? '480x864' : '864x480' : square ? '768x768' : portrait ? '768x1344' : '1344x768'
    setResolution(base)
    setTurbo(preset === 'quality' ? 'off' : '8')
    setSteps(30); setSampler('res_multistep'); setScheduler('simple'); setExperimentalSampling(false)
    setSigmaShiftMode('model'); setShiftVideo(12); setShiftAudio(3); setLoraStrength(1); setUpscaleMode('off')
  }
  const timedCutsScaffold = suggestCutTimes(duration, duration > 6 ? 2 : duration > 3 ? 1 : 0)
    .map((time, index) => `[Shot ${index + 2}] At ${time}, `)
    .join('\n')
  const identityLockLine = selectedCharacters.length
    ? `Identity lock: preserve ${selectedCharacters.map((character) => `${character.name}'s exact face, proportions, skin, hairline, and distinguishing marks`).join('; and ')}. Never exchange faces, bodies, garments, or accessories between characters.`
    : ''
  const orderWarnings = mode === 'reference'
    ? referenceOrderWarnings(prompt, { images: builderReferenceImages.length, videos: referenceVideos.length, audios: referenceAudios.length })
    : []
  return (
    <div className="create-page">
      <div className="page-heading">
        <div><p className="eyebrow">LOCAL VIDEO WORKSPACE</p><h1>Create with MiniMax H3</h1><p>Generate synchronized video and audio through your local ComfyUI engine.</p></div>
        <div className="heading-state">{!modelReady
          ? <button type="button" onClick={onOpenSettings} title="Open Settings to fix model paths"><AlertCircle size={15} />Check model paths</button>
          : <span className={h3Validated ? 'ok' : 'warn'}>{h3Validated ? <Check size={15} /> : <AlertCircle size={15} />}{h3Validated ? 'Validated H3 stack' : 'Custom H3 stack'}</span>}</div>
      </div>

      <div className="workspace-grid">
        <section className="composer-panel">
          <div className="mode-tabs" role="tablist" aria-label="Generation mode">
            {modeInfo.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'selected' : ''} onClick={() => { setMode(item.id); if (item.id === 'reference' && turbo === '8') setTurbo('off') }}><item.icon size={18} /><span><strong>{item.label}</strong><small>{item.note}</small></span></button>)}
          </div>

          <section className={`create-section create-direction-section ${mode === 'reference' ? 'reference-prompt-builder' : ''}`}>
            <div className="create-section-heading"><span><WandSparkles size={15} /></span><div><strong>{mode === 'reference' ? 'Prompt Builder' : 'Shot direction'}</strong><small>{mode === 'reference' ? 'Compose the scene while reference assignments and safeguards stay synchronized.' : 'Describe the subject, action, camera, lighting, and sound.'}</small></div><em className={prompt.trim() ? 'complete' : ''}>{prompt.trim() ? 'Ready' : 'Required'}</em></div>
          <div className="field-group prompt-field">
            {mode === 'reference' && <>
              <section className="automatic-prompt-preview" aria-labelledby="automatic-prompt-title">
                <header><span><Sparkles size={15} /><strong id="automatic-prompt-title">Automatic prompt <em>Generated</em></strong></span><button type="button" className="secondary-button" disabled={!composedPrompt} onClick={() => void copyComposedPrompt()}><Copy size={14} />{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'}</button></header>
                <div className={composedPrompt ? '' : 'empty'}>{composedPrompt || 'Write a scene prompt or add references to preview the exact instructions that will be sent to ComfyUI.'}</div>
                <footer><span>{composedPrompt.length.toLocaleString()} characters</span><small>Includes active reference, clothing, dialogue, and movement rules</small></footer>
              </section>
              <ReferenceMediaStrip files={builderReferenceImages} bindings={activeSelectedBindings} videoCount={referenceVideos.length} audioCount={referenceAudios.length} onManage={() => void refreshSourceMedia().then(() => setSourceMediaOpen(true))} />
              <div className="reference-editor-heading"><span><WandSparkles size={15} /></span><div><strong>Edit your prompt</strong><small>Use <code>//</code> commands to insert characters, wardrobe, locations, camera, action, and more.</small></div></div>
            </>}
            <div className="field-label"><label htmlFor="prompt">{mode === 'reference' ? 'Scene prompt' : 'Prompt'}</label><span>{prompt.length.toLocaleString()} characters</span></div>
            <SmartPromptEditor ref={promptRef} id="prompt" value={prompt} onChange={setPrompt} options={[...smartCharacterOptions, ...smartWardrobeOptions, ...smartLocationOptions]} placeholder={mode === 'reference' ? 'Describe the scene and references. Type // for production presets…' : 'Describe the shot, subject, movement, camera, lighting, and audio…'} />
            <div className="contract-helper" aria-label="Official MiniMax H3 prompt structures">
              <button type="button" title="Insert the official MiniMax prompt scaffold for this mode" onClick={() => insertPromptText(mode === 'reference'
                ? buildReferenceContractDraft({ bindings: selectedBindings, referenceVideos, referenceAudios, duration, prompt })
                : buildBaseContractDraft({ mode, duration, prompt }))}>Official {mode === 'reference' ? 'six-section' : 'three-field'} structure</button>
              {mode !== 'reference' && <button type="button" title="Insert the timed [Shot N] cut scaffold with computed cut times" onClick={() => insertPromptText(timedCutsScaffold || '[Shot 1] One continuous take — no cuts needed at this duration.')}>Timed cuts</button>}
              <button type="button" title="Insert inline negative statements the model respects" onClick={() => insertPromptText('No soft dissolves, no garbled text, no watermarks, no burned-in captions or logos; do not introduce objects or people not described here.')}>Inline negatives</button>
              {identityLockLine && <button type="button" title="Insert identity-preservation enumeration for the selected cast" onClick={() => insertPromptText(identityLockLine)}>Identity lock</button>}
              <button type="button" className="prompt-library-open" title="Search public Civitai generation metadata for reusable prompts" onClick={() => setLibraryOpen(true)}>Community library</button>
            </div>
            {orderWarnings.length > 0 && <div className="reference-order-warning" role="status">{orderWarnings.map((warning) => <span key={warning}><AlertCircle size={12} />{warning}</span>)}</div>}
            <div className="prompt-policy-toggles" aria-label="Prompt safeguards">
              <label className="no-dialogue-toggle" title={`Adds a render instruction that blocks spoken words, narration, singing, lip-sync, captions, and text overlays${mode === 'reference' ? ' in this Reference render' : ''}.`}><input type="checkbox" checked={noDialogue} onChange={(event) => setNoDialogue(event.target.checked)} /><span><strong>{mode === 'reference' ? 'No dialogue · Reference mode' : 'No dialogue'}</strong><small>{noDialogue ? 'Ambient sound only' : 'Dialogue and lip-sync allowed'}</small></span></label>
              <label className="no-dialogue-toggle natural-movement-toggle" title="Adds restrained breathing, blinking, eye movement, and posture adjustment without changing the requested action, pose, camera, identity, wardrobe, or scene."><input type="checkbox" checked={naturalMovement} onChange={(event) => setNaturalMovement(event.target.checked)} /><span><strong>Natural movement</strong><small>{naturalMovement ? 'Subtle subject motion' : 'No added motion direction'}</small></span></label>
            </div>
            {mode === 'reference' && <ReferencePromptHelper pictureCount={builderReferenceImages.length} videoCount={referenceVideos.length} audioCount={referenceAudios.length} referenceInstructions={composeReferenceInstructions(activeSelectedBindings)} onInsert={insertPromptText} />}
            <div className="prompt-tools" aria-label="Local Ollama prompt tools">
              <div className="prompt-tool-buttons">
                <button type="button" onClick={() => onPromptTool('enhance')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Rewrite the prompt for stronger MiniMax video direction">
                  {promptingTool === 'enhance' ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}Enhance
                </button>
                <button type="button" onClick={() => onPromptTool('timeline')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Add a concise sequence of timed shots">
                  {promptingTool === 'timeline' ? <LoaderCircle size={14} className="spin" /> : <Clock3 size={14} />}Shot timeline
                </button>
                <button type="button" onClick={() => onPromptTool('audio')} disabled={!ollamaAvailable || Boolean(promptingTool)} title="Improve ambience, dialogue, and sound cues">
                  {promptingTool === 'audio' ? <LoaderCircle size={14} className="spin" /> : <Volume2 size={14} />}Audio pass
                </button>
                {mode === 'reference' && <button ref={dialogueTriggerRef} type="button" className="dialogue-tool-button" onClick={() => setDialogueOpen(true)} title="Write performable dialogue for a selected character"><MessageSquareText size={14} />Character dialogue</button>}
              </div>
              <span className={`local-model-chip ${ollamaAvailable ? 'online' : ''}`} title={ollamaAvailable ? `Local Ollama model: ${ollamaModel}` : 'Configure Ollama in Settings'}>
                <span />{ollamaAvailable ? ollamaModel : 'Ollama offline'}
              </span>
            </div>
            {promptSuggestion && (
              <div className="assistant-result" role="status">
                <div className="assistant-result-heading"><span><Sparkles size={14} />Local suggestion</span><small>Review before replacing your prompt</small></div>
                <textarea aria-label="Ollama prompt suggestion" value={promptSuggestion} readOnly />
                <div className="assistant-actions"><button type="button" className="secondary-button" onClick={onDismissSuggestion}>Dismiss</button><button type="button" className="primary-button" onClick={onUseSuggestion}><Check size={14} />Use suggestion</button></div>
              </div>
            )}
          </div>
          </section>

          {(mode === 'image' || mode === 'frames' || mode === 'reference') && <section className={`create-section create-input-section ${mode === 'reference' ? 'source-media-section' : ''}`}>
            <div className="create-section-heading"><span><ImageIcon size={15} /></span><div><strong>Source media</strong><small>{mode === 'reference' ? 'Choose reusable identity, motion, and audio references.' : mode === 'frames' ? 'Set the opening and closing composition.' : 'Choose the frame this shot begins from.'}</small></div><em className={(mode === 'reference' ? referenceImages.length + referenceVideos.length + referenceAudios.length > 0 : firstFrame && (mode !== 'frames' || lastFrame)) ? 'complete' : ''}>{mode === 'reference' ? `${referenceImages.length + referenceVideos.length + referenceAudios.length} loaded` : mode === 'frames' ? `${Number(Boolean(firstFrame)) + Number(Boolean(lastFrame))} of 2` : firstFrame ? 'Ready' : 'Required'}</em></div>
          {(mode === 'image' || mode === 'frames') && (
            <div className={`frame-grid ${mode === 'image' ? 'single' : ''}`}>
              <div><MediaDrop label="First frame" note="PNG, JPG or WebP" file={firstFrame} onChoose={() => void chooseMedia('image', (file) => setFirstFrame(file))} onRemove={() => setFirstFrame(null)} />{firstFrame && <ImageCrop label="First frame" file={firstFrame} resolution={resolution} onChange={setFirstFrame} />}</div>
              {mode === 'frames' && <div><MediaDrop label="Last frame" note="Automatically fitted to output size" file={lastFrame} onChoose={() => void chooseMedia('image', (file) => setLastFrame(file))} onRemove={() => setLastFrame(null)} />{lastFrame && <ImageCrop label="Last frame" file={lastFrame} resolution={resolution} onChange={setLastFrame} />}</div>}
            </div>
          )}
          {mode === 'reference' && (
            <div className="source-media-summary">
              <div className="source-media-overview" aria-label="Selected source media summary">
                <SourceMediaStat icon={Users} label="Cast" value={selectedCharacterIds.length ? `${selectedCharacterIds.length} selected` : 'None'} />
                <SourceMediaStat icon={MapPin} label="Locations" value={selectedLocationIds.length ? `${selectedLocationIds.length} selected` : 'None'} />
                <SourceMediaStat icon={ImageIcon} label="Pictures" value={`${referenceImages.length} of 9`} />
                <SourceMediaStat icon={Film} label="Video + audio" value={`${referenceVideos.length} + ${referenceAudios.length}`} />
              </div>
              <div className="source-media-summary-footer">
                <span><strong>{clothingPolicy === 'wardrobe' ? 'Assigned wardrobe' : clothingPolicy === 'underwear' ? 'Underwear' : 'Unrestricted'}</strong><small>{refImageSize === 'max' ? 'Maximum identity' : 'Balanced fidelity'}</small></span>
                <button ref={sourceMediaTriggerRef} type="button" className="primary-button source-media-manage" onClick={() => void refreshSourceMedia().then(() => setSourceMediaOpen(true))}><SlidersHorizontal size={15} />Manage source media</button>
              </div>
            </div>
          )}
          </section>}

          {sourceMediaOpen && mode === 'reference' && (
            <div className="modal-backdrop source-media-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSourceMedia() }}>
              <section className="source-media-modal" role="dialog" aria-modal="true" aria-labelledby="source-media-modal-title" aria-describedby="source-media-modal-description" onKeyDown={keepSourceMediaFocus}>
                <header>
                  <div><span><ImageIcon size={18} /></span><div><small>REFERENCE WORKSPACE</small><strong id="source-media-modal-title">Source media</strong><p id="source-media-modal-description">Build the cast, locations, look, motion, and sound for this render.</p></div></div>
                  <div className="source-media-header-actions"><em>{sourceMediaCount} loaded</em><button ref={sourceMediaCloseRef} type="button" aria-label="Close source media" onClick={closeSourceMedia}><X size={18} /></button></div>
                </header>
                <div className="source-media-modal-body">
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>01</span><div><strong>Libraries</strong><small>Select reusable people and environments. Their approved pictures share the 9-picture budget.</small></div></div><div className="reference-groups source-media-library-groups"><CharacterReferencePicker characters={characters} wardrobes={wardrobes} values={selectedCharacterIds} onChange={loadCharacter} /><LocationReferencePicker locations={locations} values={selectedLocationIds} onChange={loadLocation} /></div>{selectedBindings.length > 0 && <details className="source-media-auto-prompt"><summary><Sparkles size={14} /><span><strong>Automatic reference direction</strong><small>{selectedBindings.length} numbered picture assignment{selectedBindings.length === 1 ? '' : 's'} synced to the prompt</small></span><ChevronDown size={14} /></summary><ol>{composeReferenceInstructions(selectedBindings).map((line) => <li key={line}>{line}</li>)}</ol></details>}</section>
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>02</span><div><strong>Clothing behavior</strong><small>Decide whether assigned wardrobe or identity-photo clothing is authoritative.</small></div></div><div className="reference-groups source-media-policy-groups"><fieldset className="reference-fidelity clothing-policy"><legend><Shirt size={15} /><span><strong>Clothing intent</strong><small>Controls whether identity-photo clothing or assigned wardrobe is authoritative.</small></span></legend><div><label className={clothingPolicy === 'wardrobe' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'wardrobe'} onChange={() => setClothingPolicy('wardrobe')} /><span><strong>Assigned wardrobe</strong><small>Wardrobe Studio images exclusively control clothing. Identity-photo clothes are discarded.</small></span></label><label className={clothingPolicy === 'underwear' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'underwear'} onChange={() => setClothingPolicy('underwear')} /><span><strong>Underwear</strong><small>Use each adult character's own identity reference without assigned outerwear.</small></span></label><label className={clothingPolicy === 'unrestricted' ? 'selected' : ''}><input type="radio" name="clothing-policy" checked={clothingPolicy === 'unrestricted'} onChange={() => setClothingPolicy('unrestricted')} /><span><strong>Unrestricted</strong><small>Follow explicit adult fictional clothing or nudity direction in the scene prompt.</small></span></label></div></fieldset></div></section>
                  <section className="source-media-modal-section"><div className="source-media-section-title"><span>03</span><div><strong>Files and crops</strong><small>Add standalone pictures, motion references, and audio cues.</small></div></div><div className="reference-groups source-media-file-groups"><ReferenceRow icon={ImageIcon} label="Pictures" limit="Up to 9" kind="image" files={referenceImages} onAdd={() => void chooseReference('image')} onRemove={(index) => removeReference('image', index)} />{referenceImages.length > 0 && <div className="reference-crops">{referenceImages.map((file, i) => <details key={`${file.path}-${i}`}><summary>Picture {i + 1} · crop to output</summary><ImageCrop label={`Picture ${i + 1}`} file={file} resolution={resolution} onChange={(next) => updateReference(i, next)} /></details>)}</div>}<ReferenceRow icon={Film} label="Videos" limit="Up to 3 · trim longer sources to 2–15 seconds" kind="video" files={referenceVideos} onAdd={() => void chooseReference('video')} onEdit={editVideoReference} onRemove={(index) => removeReference('video', index)} /><ReferenceRow icon={Volume2} label="Audio" limit="Up to 3" kind="audio" files={referenceAudios} onAdd={() => void chooseReference('audio')} onRemove={(index) => removeReference('audio', index)} /><div className="timeline-guides"><div className="reference-title"><span><Clock3 size={17} /></span><div><strong>Timeline keyframes</strong><small>Pin images at exact seconds through MiniMaxH3AddGuide</small></div></div>{timelineGuides.map((guide, index) => { const warning = guideFrameWarning(guide.seconds, duration); const promptVisible = referenceImages.some((file) => file.path === guide.file.path); return <div className={`timeline-guide-row ${warning ? 'invalid' : ''}`} key={`${guide.file.path}-${index}`} title={warning ?? undefined}>{guide.file.preview ? <img src={guide.file.preview} alt="" /> : <span className="reference-choice-placeholder"><ImageIcon size={16} /></span>}<span><strong>Keyframe {index + 1}</strong><small>{guide.file.name}</small></span>{!promptVisible && <button type="button" className="timeline-guide-mirror" title="Guide-only images are not visible to the text encoder. Mirror this image into the reference Pictures so the prompt can describe it as <Picture N>." onClick={() => addReferenceImage(guide.file)}>Not prompt-visible — add as Picture</button>}<label>Seconds<input type="number" min={-15} max={duration} step={0.1} value={guide.seconds} onChange={(event) => setTimelineGuides(timelineGuides.map((item, itemIndex) => itemIndex === index ? { ...item, seconds: Number(event.target.value) } : item))} /></label><output>frame {frameIndexForSeconds(guide.seconds)}</output><button aria-label={`Remove keyframe ${index + 1}`} onClick={() => setTimelineGuides(timelineGuides.filter((_item, itemIndex) => itemIndex !== index))}><X size={14} /></button></div> })}<button className="add-reference" onClick={() => void chooseMedia('image', (file) => setTimelineGuides(timelineGuides.length < 6 ? [...timelineGuides, { file, seconds: Math.max(0.5, Math.round((duration / (timelineGuides.length + 2)) * 10) / 10) }] : timelineGuides))} disabled={timelineGuides.length >= 6}><Plus size={16} />Add keyframe</button><small className="timeline-guide-note">Keyframes pin composition at their frame but are not visible to the text encoder — also load them as Pictures when the prompt must describe their content. Negative seconds count from the clip's end.</small></div></div></section>
                </div>
                <footer><span>{sourceMediaCount ? `${sourceMediaCount} file${sourceMediaCount === 1 ? '' : 's'} ready for this render` : 'No standalone files added yet'}</span><button type="button" className="primary-button" onClick={closeSourceMedia}><Check size={15} />Done</button></footer>
              </section>
            </div>
          )}

          {libraryOpen && <PromptLibraryBrowser onClose={() => setLibraryOpen(false)} onInsert={(prompt) => insertPromptText(prompt)} />}

          {dialogueOpen && mode === 'reference' && <CharacterDialogueModal
            characters={selectedCharacters}
            duration={duration}
            generating={dialogueGenerating}
            ollamaAvailable={ollamaAvailable}
            onClose={closeDialogue}
            onGenerate={onGenerateDialogue}
            onInsert={(text) => { setNoDialogue(false); insertPromptText(text); closeDialogue() }}
          />}

        </section>

        <aside className="preview-panel" ref={previewPanelRef}>
          <div className="panel-heading"><div><span>OUTPUT</span><strong>Current workspace</strong></div>{latestJob && <StatusBadge status={latestJob.status} />}</div>
          {liveEnabled && livePreview && livePreview.promptId === latestJob?.promptId && latestJob && ['running', 'queued'].includes(latestJob.status) && <figure className={`live-preview ${livePreview.animated ? 'animated' : ''}`}>{livePreview.mime === 'video/mp4' ? <video key={livePreview.url} src={livePreview.url} aria-label="Animated MiniMax H3 generation preview" autoPlay loop muted playsInline /> : <img key={livePreview.url} src={livePreview.url} alt={livePreview.animated ? 'Animated MiniMax H3 generation preview' : 'Live generation preview'} />}<figcaption>{livePreview.animated ? `Animated H3 preview · 50 frames${livePreview.fps ? ` · ${livePreview.fps} fps` : ''}${livePreview.step && livePreview.totalSteps ? ` · sampler step ${livePreview.step} of ${livePreview.totalSteps}` : ''}` : 'Live preview · intermediate frame'}</figcaption></figure>}
          <div className="preview-scroll">
          <div className="preview-stage">
            {latestJob?.outputUrl ? <VideoPlayer src={latestJob.outputUrl} onDuration={setRenderedVideoDuration} /> : latestJob && ['queued', 'running'].includes(latestJob.status) ? <div className="render-state constructing"><RenderConstruction /><strong>{latestJob.progressLabel ?? (latestJob.status === 'queued' ? 'Waiting in queue' : 'Rendering locally')}</strong><span>{latestJob.currentStep !== undefined && latestJob.totalSteps ? `Live sampler step ${latestJob.currentStep} of ${latestJob.totalSteps}` : `${latestJob.width} × ${latestJob.height} · ${latestJob.duration}s`}</span><div className="progress"><i style={{ width: `${latestJob.progress}%` }} /></div><small>{Math.round(latestJob.progress)}% · live ComfyUI status</small></div> : !connected || !modelReady ? (
            <div className="setup-checklist" aria-label="Studio setup steps">
              <strong>Set up the studio</strong>
              <span>Complete these once — then generate from any browser on your network.</span>
              <ol>
                <li className={connected ? 'done' : ''}>{connected ? 'ComfyUI engine connected' : 'Start ComfyUI and confirm its address in Settings'}</li>
                <li className={modelReady ? 'done' : ''}>{modelReady ? 'MiniMax H3 models detected' : 'Point Settings at your MiniMax H3 model folders'}</li>
                <li>Describe a shot and press Generate video</li>
              </ol>
              <button type="button" className="primary-button" onClick={onOpenSettings}>Open Settings</button>
            </div>
          ) : <div className="empty-preview"><div className="preview-icon"><Film size={28} /></div><strong>Your video will appear here</strong><span>Configure a shot, then send it to the local engine.</span></div>}
          </div>
          {latestJob?.mode === 'reference' && latestJob.status === 'completed' && latestJob.outputUrl && <VideoContinuationControls job={latestJob} duration={renderedVideoDuration || latestJob.duration} onContinue={onContinue} />}
          <div className="pipeline-summary">
            <PipelineItem ready={Boolean(mode === 'reference' ? selection.ref2va : selection.fl2va)} label="Diffusion" value={mode === 'reference' ? selection.ref2va : selection.fl2va} />
            <PipelineItem ready={Boolean(selection.textEncoder)} label="Encoder" value={selection.textEncoder} />
            <PipelineItem ready={Boolean(selection.videoVae && selection.audioVae)} label="Video + audio VAE" value={selection.videoVae && selection.audioVae ? 'Both detected' : 'Missing component'} />
          </div>
          <section className="create-section create-output-section preview-output-settings">
            <div className="create-section-heading"><span><Gauge size={15} /></span><div><strong>Output and quality</strong><small>Tune the next render directly beneath its preview.</small></div><em className="complete">{resolution.replace('x', ' × ')} · {duration}s</em></div>
            {mode !== 'reference' && <div className="create-presets" aria-label="Recommended H3 presets"><button type="button" onClick={() => applyCreatePreset('quality')}><strong>Native Quality</strong><small>1344 × 768 · 30 steps</small></button><button type="button" onClick={() => applyCreatePreset('turbo')}><strong>Turbo 8</strong><small>Native canvas · official LoRA</small></button><button type="button" onClick={() => applyCreatePreset('preview')}><strong>Preview</strong><small>864 × 480 · Turbo 8</small></button></div>}
            <RenderSize value={resolution} onChange={setResolution} />
            {mode === 'reference' && <details className="output-reference-fidelity"><summary><Gauge size={16} /><span><small>REFERENCE FIDELITY</small><strong>{refImageSize === 'max' ? 'Maximum identity' : 'Balanced'}</strong><em>{refImageSize === 'max' ? 'Keep more original source detail' : 'Fit references to the output canvas'}</em></span><ChevronDown size={15} /></summary><fieldset><legend>Choose how much source-image detail H3 preserves</legend><label className={refImageSize === 'match' ? 'selected' : ''}><input type="radio" name="output-reference-fidelity" checked={refImageSize === 'match'} onChange={() => setRefImageSize('match')} /><span><strong>Balanced</strong><small>Fit references to the output canvas. Faster and uses less memory.</small></span></label><label className={refImageSize === 'max' ? 'selected' : ''}><input type="radio" name="output-reference-fidelity" checked={refImageSize === 'max'} onChange={() => setRefImageSize('max')} /><span><strong>Maximum identity</strong><small>Keep more original image detail. Slower and uses more memory.</small></span></label></fieldset></details>}
            <div className="render-controls"><div className="field-group"><label htmlFor="duration">Duration</label><div className="range-line"><input id="duration" type="range" min="2" max="15" step="0.5" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><output>{duration}s</output></div></div><SelectField label="Sampling quality" value={turbo === '4' && mode !== 'reference' ? '8' : turbo} onChange={(value) => { if (mode !== 'reference') applyCreatePreset(value === 'off' ? 'quality' : 'turbo'); else { setTurbo(value as 'off' | '4'); setSampler('res_multistep'); setScheduler('simple'); setExperimentalSampling(false); setSigmaShiftMode('model'); setShiftVideo(12); setShiftAudio(3); setLoraStrength(1); setUpscaleMode('off'); if (value === 'off') { setSteps(30); const [rw, rh] = resolution.split('x').map(Number); setResolution(rw === rh ? '768x768' : rw > rh ? '1344x768' : '768x1344') } } }} options={mode === 'reference' ? [["off", 'Native quality · 30 steps'], ["4", 'Official 4-step Ref2V']] : [["off", 'Native quality · 30 steps'], ["8", 'Official Turbo 8']]} /></div>
            <div className="render-extras"><label><input type="checkbox" checked={liveEnabled} onChange={(event) => setLiveEnabled(event.target.checked)} />Live preview <small>{liveEnabled ? liveConnected ? 'Connected · waiting for preview frames' : 'Connecting to ComfyUI…' : 'Off'}</small></label><label className="live-preview-mode"><span>Preview source</span><select value={livePreviewMode} disabled={!liveEnabled} onChange={(event) => setLivePreviewMode(event.target.value as 'standard' | 'h3-override')}><option value="standard">Standard first frame</option><option value="h3-override">MiniMax H3 animated · 50 frames at 12 fps</option></select></label><p className={`field-help ${livePreviewMode === 'h3-override' && !h3PreviewOverrideAvailable ? 'upscale-warning' : ''}`}>{livePreviewMode === 'h3-override' && h3PreviewOverrideAvailable ? 'The installed MiniMax H3 Preview Override node is wired between the model and sampler and streams a 50-frame, 12 fps animated preview.' : livePreviewMode === 'h3-override' ? 'Animated preview is selected, but the required Preview Override node is not detected. Install or enable it, restart ComfyUI, then click the Local engine status to refresh before generating.' : h3PreviewOverrideAvailable ? 'MiniMax H3 Preview Override is installed. Select the animated option to preview motion while sampling.' : 'You can select animated preview now. Generation will wait until the MiniMax H3 Preview Override custom node is installed and detected.'}</p><div className="upscale-options" role="group" aria-labelledby="upscale-label"><span id="upscale-label">Post-render upscale</span><label><input type="radio" name="upscale" checked={upscaleMode === 'off'} onChange={() => setUpscaleMode('off')} />Off</label><label><input type="radio" name="upscale" checked={upscaleMode === 'ltx'} disabled={!ltxAvailable} onChange={() => setUpscaleMode('ltx')} />LTX 2.5 latent · 2×</label><label><input type="radio" name="upscale" checked={upscaleMode === 'rtx'} disabled={rtxModels.length === 0} onChange={() => setUpscaleMode('rtx')} />RTX / CUDA frames · 2× · experimental</label></div>{upscaleMode === 'rtx' && <SelectField label="AI upscale model" value={rtxModel} onChange={setRtxModel} options={rtxModels.map((name) => [name, name])} />}<p className={`field-help ${upscaleMode === 'rtx' ? 'upscale-warning' : ''}`}>{upscaleMode === 'ltx' ? `Verified latent pipeline: MiniMax frames are encoded with the LTX‑2.5 video VAE, spatially upsampled exactly 2× in latent space, decoded, trimmed to the original duration, and joined to the untouched MiniMax audio. Final size: ${resolution.split('x').map((value) => Number(value) * 2).join(' × ')}.` : upscaleMode === 'rtx' ? `Experimental frame-by-frame upscale using ${rtxModel || 'the selected model'}. It does not understand motion and can amplify noise, flicker, or temporal shimmer. Diagnose output quality with upscale Off first.` : !ltxAvailable && ltxMissingNodes.length ? `LTX 2× is unavailable until ComfyUI provides: ${ltxMissingNodes.join(', ')}.` : !ltxAvailable && rtxModels.length === 0 ? 'No compatible upscale models were reported by ComfyUI.' : 'The original MiniMax video is saved without post-processing.'}</p></div>
            <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}><SlidersHorizontal size={16} />Advanced controls<ChevronDown size={15} className={advanced ? 'rotated' : ''} /></button>
            {advanced && <div className="advanced-grid"><NumberField label="Full-quality steps" value={steps} min={16} max={30} onChange={setSteps} disabled={turbo !== 'off'} /><NumberField label="Seed" value={seed} min={0} max={999999999999} onChange={setSeed} /><NumberField label="LoRA strength" value={loraStrength} min={0} max={2} step={0.05} onChange={setLoraStrength} disabled={turbo === 'off'} /><label className="sampling-opt-in"><input type="checkbox" checked={experimentalSampling} onChange={(event) => setExperimentalSampling(event.target.checked)} />Use custom sampler and scheduler</label><SelectField label="Experimental Turbo override" value={turbo} onChange={(value) => setTurbo(value as 'off' | '4' | '8')} options={[["off", 'Off · native quality'], ["8", 'Official 8-step'], ["4", '4-step · preview testing']]} /><SelectField label="Sampler" value={experimentalSampling ? sampler : 'res_multistep'} onChange={setSampler} disabled={!experimentalSampling} options={[...new Set([sampler, 'res_multistep', ...choices(info, 'KSamplerSelect', 'sampler_name')])].map((value) => [value, value])} /><SelectField label="Scheduler" value={experimentalSampling ? scheduler : 'simple'} onChange={setScheduler} disabled={!experimentalSampling} options={[...new Set([scheduler, 'simple', ...choices(info, 'BasicScheduler', 'scheduler')])].map((value) => [value, value])} /><SelectField label="Sigma shifts" value={sigmaShiftMode} onChange={(value) => setSigmaShiftMode(value as 'model' | 'custom')} options={[["model", 'Model defaults · video 12 / audio 3'], ["custom", 'Custom official sigma-shift node']]} /><NumberField label="Video sigma shift" value={shiftVideo} min={0.01} max={100} step={0.01} onChange={setShiftVideo} disabled={sigmaShiftMode !== 'custom'} /><NumberField label="Audio sigma shift" value={shiftAudio} min={0.01} max={100} step={0.01} onChange={setShiftAudio} disabled={sigmaShiftMode !== 'custom'} /><p className="field-help">The published ComfyUI workflow uses <strong>res_multistep + simple</strong>, CFG 1, denoise 1, 24 fps, and the model’s native 12/3 shifts. Custom sampling—including Euler + Beta for converted Turbo LoRAs—is experimental and should be tested against the same seed.</p></div>}
            <p className="field-help render-duration">{frameCount(duration)} frames · {(frameCount(duration) / 24).toFixed(2)}s actual duration at 24 fps. Rounded up to MiniMax’s frame grid.</p>
          </section>
          </div>
          <div className="generate-bar preview-generate-bar"><div className="generation-summary"><Gauge size={17} /><span><strong>{resolution.replace('x', ' × ')}</strong><small>{duration}s · 24 fps · {turbo === 'off' ? `${steps} steps` : `${turbo}-step turbo`}</small></span></div><div className="generate-actions">{latestJob && ['queued', 'running'].includes(latestJob.status) && <button className="danger-button" onClick={() => onCancel(latestJob)} disabled={cancelling}><CircleStop size={16} />{cancelling ? 'Stopping…' : 'Cancel generation'}</button>}<button className="primary-button generation-button" onClick={onGenerate} disabled={submitting || !connected || !modelReady}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Play size={18} fill="currentColor" />}{submitting ? 'Submitting…' : 'Generate video'}</button></div></div>
        </aside>
      </div>
    </div>
  )
}

function SourceMediaStat({ icon: Icon, label, value }: { icon: typeof FilmIcon; label: string; value: string }) {
  return <span className="source-media-stat"><Icon size={15} /><span><small>{label}</small><strong>{value}</strong></span></span>
}

function ReferenceMediaStrip({ files, bindings, videoCount, audioCount, onManage }: { files: MediaFile[]; bindings: MovieReferenceBinding[]; videoCount: number; audioCount: number; onManage(): void }) {
  const labelFor = (file: MediaFile, index: number) => {
    const binding = bindings.find((item) => item.file.path === file.path)
    if (!binding) return { title: file.name, type: 'Picture' }
    const title = binding.label.replace(/^(Character|Wardrobe|Hair|Accessory|Location):\s*/i, '').replace(/\s*\/\s*(identity|wardrobe|hair|accessory|location).*$/i, '')
    const type = binding.purpose === 'wardrobe' ? 'Outfit' : binding.purpose === 'hair' ? 'Hair' : binding.purpose === 'location' ? 'Location' : binding.purpose === 'accessory' ? 'Accessory' : 'Identity'
    return { title: title || `Picture ${index + 1}`, type }
  }
  return <section className="reference-media-strip" aria-labelledby="reference-media-title">
    <header><span><ImageIcon size={15} /><strong id="reference-media-title">Reference images <em>{files.length}</em></strong></span><small>{videoCount ? `${videoCount} video${videoCount === 1 ? '' : 's'}` : ''}{videoCount && audioCount ? ' · ' : ''}{audioCount ? `${audioCount} audio` : ''}</small></header>
    <div>{files.map((file, index) => { const label = labelFor(file, index); return <figure key={`${file.path}-${index}`}>{file.preview ? <img src={file.preview} alt="" /> : <span><ImageIcon size={22} /></span>}<figcaption><b>{index + 1}</b><span><strong title={label.title}>{label.title}</strong><small>{label.type}</small></span></figcaption></figure> })}<button type="button" className="reference-add-card" onClick={onManage}><Plus size={22} /><span>{files.length ? 'Manage references' : 'Add references'}</span></button></div>
  </section>
}

function ReferenceRow({ icon: Icon, label, limit, kind, files, onAdd, onEdit, onRemove }: { icon: typeof FilmIcon; label: string; limit: string; kind: MediaKind; files: MediaFile[]; onAdd(): void; onEdit?(index: number): void; onRemove(index: number): void }) {
  return <div className="reference-row"><div className="reference-title"><span><Icon size={17} /></span><div><strong>{label}</strong><small>{limit}</small></div></div><div className="reference-files">{files.map((file, index) => <div className="file-pill" key={`${file.path}-${index}`}>{file.preview && kind === 'image' ? <img src={file.preview} alt="" /> : <Icon size={15} />}<span><strong>{kind === 'image' ? `Picture ${index + 1}` : kind === 'video' ? `Video ${index + 1}` : `Audio ${index + 1}`}</strong><small>{file.clip ? `${(file.clip.end - file.clip.start).toFixed(1)}s · ${file.name}` : file.name}</small></span>{onEdit && <button onClick={() => onEdit(index)} aria-label={`Edit clip ${file.name}`} title="Change reference clip"><Scissors size={13} /></button>}<button onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`}><X size={14} /></button></div>)}<button className="add-reference" onClick={onAdd} disabled={files.length >= (kind === 'image' ? 9 : 3)}><Plus size={16} />Add {kind}</button></div></div>
}

function CharacterReferencePicker({ characters, wardrobes, values, onChange }: { characters: CharacterProject[]; wardrobes: WardrobeProject[]; values: string[]; onChange(value: string): void }) {
  return <fieldset className="character-reference-picker multi-character-picker"><legend>Characters in this render</legend><div><span><Users size={17} /></span><span><strong>Character library</strong><small>Select several people. Their identity, assigned hair, wardrobe, and accessories are imported together within the 9-picture limit.</small></span></div><div className="character-reference-choices">{characters.map((character) => { const references = characterReferences(character); const selected = values.includes(character.id); const wardrobe = wardrobes.find((item) => item.id === character.wardrobeIds[0]); const wardrobeCount = wardrobe ? wardrobeReferences(wardrobe).length : 0; const hair = loadHairStyleProjects().find((item) => item.id === character.hairStyleIds[0]); return <label className={selected ? 'selected' : ''} key={character.id}><input type="checkbox" checked={selected} disabled={!references.length} onChange={() => onChange(character.id)} />{references[0]?.preview ? <img className="reference-choice-thumbnail" src={references[0].preview} alt="" /> : <span className="reference-choice-placeholder"><Users size={18} /></span>}<span><strong>{character.name}</strong><small>{references.length ? `${references.length} identity image${references.length === 1 ? '' : 's'}` : 'No approved identity images'}</small><em>{hair?.referenceImage ? `Hair · ${hair.name}` : character.hairStyleIds.length ? 'Hair needs an approved image' : 'No assigned hair'} · {wardrobeCount ? `Wardrobe · ${wardrobe?.name}` : character.wardrobeIds.length ? 'Wardrobe needs an approved image' : 'No assigned wardrobe'}</em></span>{wardrobeCount > 0 && wardrobeReferences(wardrobe!)[0]?.preview && <img className="reference-choice-asset" src={wardrobeReferences(wardrobe!)[0].preview} alt={`${wardrobe!.name} assigned wardrobe`} />}</label> })}</div>{values.length > 0 && <button type="button" className="secondary-button" onClick={() => onChange('')}>Clear cast</button>}</fieldset>
}

function LocationReferencePicker({ locations, values, onChange }: { locations: LocationProject[]; values: string[]; onChange(value: string): void }) {
  if (!locations.length) return null
  return <fieldset className="character-reference-picker multi-character-picker location-reference-picker"><legend>Locations in this render</legend><div><span><MapPin size={17} /></span><span><strong>Location library</strong><small>Add environments alongside the cast. All selected assets share the 9-picture limit.</small></span></div><div className="character-reference-choices">{locations.map((location) => { const references = locationReferences(location); const selected = values.includes(location.id); return <label className={selected ? 'selected' : ''} key={location.id}><input type="checkbox" checked={selected} disabled={!references.length} onChange={() => onChange(location.id)} />{references[0]?.preview ? <img className="reference-choice-thumbnail location" src={references[0].preview} alt="" /> : <span className="reference-choice-placeholder"><MapPin size={18} /></span>}<span><strong>{location.name}</strong><small>{references.length ? `${location.environmentMode === 'nature' ? 'Nature only · ' : ''}${references.length} approved view${references.length === 1 ? '' : 's'}` : 'No approved location views'}</small></span></label> })}</div>{values.length > 0 && <button type="button" className="secondary-button" onClick={() => onChange('')}>Clear locations</button>}</fieldset>
}

function ReferencePromptHelper({ pictureCount, videoCount, audioCount, referenceInstructions, onInsert }: { pictureCount: number; videoCount: number; audioCount: number; referenceInstructions: string[]; onInsert(value: string): void }) {
  const pictureTags = Array.from({ length: pictureCount }, (_, index) => `<Picture ${index + 1}>`)
  const identityText = referenceInstructions.join(' ')
  const directionSections = [
    ['Scene', 'Scene: '],
    ['Action', 'Action: '],
    ['Camera', 'Camera: '],
    ['Lighting', 'Lighting: '],
    ['Sound', 'Sound: '],
    ['Continuity', 'Continuity: '],
  ] as const
  const starter = [
    identityText,
    'Scene: ',
    'Action: ',
    'Camera: ',
    'Lighting: ',
    'Sound: ',
    referenceInstructions.length ? 'Continuity: Keep each named person distinct. Never exchange faces, bodies, garments, colors, or accessories between characters.' : '',
  ].filter(Boolean).join('\n')
  return <div className="reference-prompt-helper" aria-label="Reference prompt helpers"><div><strong>Quick-build prompt</strong><small>Insert media tags or production sections at the cursor.</small></div><div className="reference-tag-actions">{pictureTags.map((tag) => <button type="button" key={tag} onClick={() => onInsert(tag)}>{tag}</button>)}{Array.from({ length: videoCount }, (_, index) => <button type="button" key={`video-${index}`} onClick={() => onInsert(`<Video ${index + 1}>`)}>{`<Video ${index + 1}>`}</button>)}{Array.from({ length: audioCount }, (_, index) => <button type="button" key={`audio-${index}`} onClick={() => onInsert(`<Audio ${index + 1}>`)}>{`<Audio ${index + 1}>`}</button>)}{identityText && <button className="reference-identity-insert" type="button" onClick={() => onInsert(identityText)}>Cast + wardrobe rules</button>}</div><div className="reference-tag-actions reference-direction-actions">{directionSections.map(([label, value]) => <button type="button" key={label} onClick={() => onInsert(value)}>{label}</button>)}<button className="reference-template-insert" type="button" onClick={() => onInsert(starter)}>Insert full template</button></div>{pictureTags.length === 0 && videoCount === 0 && audioCount === 0 && <small className="reference-tag-empty">Load a picture, video, or audio reference to create matching tags.</small>}</div>
}
