# Automated Movie Pipeline Plan

## Objective

Add a guided, local-first Movie workspace that turns an approved story into a complete editable film using MiniMax H3 T2V, I2V, first/last-frame video, Ref2V, local Ollama planning, dialogue audio, optional lip sync, ComfyUI rendering, and the existing Clip Editor.

The system must save every decision and artifact, support pause and resume, estimate its work before rendering, and never spend substantial GPU time without an approved plan. It must not automatically join generated clips. Joining and full-film export remain explicit actions in the Clip Editor.

## Product principles

- Treat this as a guided production manager, not a single opaque “make movie” command.
- Separate the target film runtime from the available compute-time budget.
- Generate and approve a low-cost animatic before final video production.
- Keep all source clips, attempts, references, dialogue, and exports non-destructive.
- Require explicit approval at configurable checkpoints.
- Cap automatic retries and ask the user when the pipeline is uncertain.
- Keep planning local through Ollama and rendering local through ComfyUI.
- Preserve user-selected model locations and workflow settings.

## Guided production flow

1. Story setup
2. Production bible
3. Screenplay and dialogue
4. Shot plan and mode routing
5. Storyboards
6. Low-cost animatic
7. Draft renders in small batches
8. Shot review and selective retries
9. Final renders, dialogue, sound, and upscale
10. Explicit timeline assembly and export

Every stage has `Back`, `Save`, `Pause`, and `Approve and continue` controls. The user can review every shot or choose scene-level/batch-level review gates.

## 1. Story setup

Collect:

- Premise, outline, or imported screenplay.
- Film runtime target.
- Compute budget or stop time.
- Genre, tone, audience rating, visual style, and pacing.
- Aspect ratio, draft resolution, final resolution, and frame rate.
- Dialogue level and number of recurring characters.
- Review frequency: every shot, every scene, or every N shots.
- Quality profile: Preview, Balanced, or Maximum.
- Whether the pipeline may continue unattended after approved gates.

Before production, benchmark one representative draft shot on the current hardware. Use that result to show an estimate range for render time and disk usage. Recalculate the estimate as real jobs complete.

## 2. Production bible

Create a versioned source of truth for the project:

- Character names, appearance, age, body shape, hair, face, and distinguishing details.
- Front, three-quarter, full-body, neutral-expression, and costume references.
- Approved voice reference and delivery notes for each speaking character.
- Locations, time of day, lighting, palette, props, and set details.
- Camera rules, lens style, composition, motion, and prohibited visual changes.
- Continuity facts such as wardrobe, injuries, carried objects, screen direction, and emotional state.

Approved references become locked versions. Changing one warns the user which planned or rendered shots depend on it.

## 3. Structured screenplay

Use Ollama structured JSON output and validate it in the application. The LLM proposes creative material, while application code enforces durations, supported modes, reference counts, and model constraints.

Suggested entities:

```ts
type MovieProject = {
  id: string
  title: string
  targetRuntimeSeconds: number
  computeBudgetMinutes?: number
  status: 'planning' | 'animatic' | 'production' | 'paused' | 'complete'
  bible: ProductionBible
  scenes: MovieScene[]
  settings: MovieRenderProfile
}

type MovieScene = {
  id: string
  title: string
  summary: string
  locationId: string
  continuityState: Record<string, string>
  shots: MovieShot[]
}

type MovieShot = {
  id: string
  order: number
  durationSeconds: number
  prompt: string
  characters: string[]
  dialogue: DialogueCue[]
  generationMode: 'text' | 'image' | 'frames' | 'reference' | 'video'
  dependencies: string[]
  referenceIds: string[]
  stage: 'planned' | 'storyboard' | 'draft' | 'review' | 'approved' | 'final' | 'locked'
  attempts: RenderAttempt[]
}
```

## 4. Generation-mode router

Choose the least expensive mode that can satisfy the shot:

| Requirement | Preferred route |
| --- | --- |
| Establishing shot without a recurring subject | T2V |
| Exact starting composition | I2V |
| Recurring character, costume, location, or voice | Ref2V |
| Direct continuation from an existing clip | Grab end frame, then I2V |
| Required start and final composition | First + Last |
| Existing motion or camera structure must be retained | V2V or controlled LTX |
| Exact spoken words | Approved audio followed by audio-driven video or lip sync |
| Non-critical ambience and incidental speech | Native H3 synchronized audio/video |

An extracted continuation frame only configures the next generation. The completed render remains a separate asset. The user adds both videos to the Clip Editor and explicitly exports the joined timeline.

## 5. Dialogue and audio

For exact dialogue:

1. Write and approve the line.
2. Generate or import the voice audio.
3. Let the user listen and approve it.
4. Measure its exact duration.
5. Fit the shot length and acting beats around the approved audio.
6. Use the audio as an H3/LTX reference or apply an optional dedicated lip-sync pass.
7. Mix dialogue, ambience, effects, and music as separate tracks.

Prefer one visible speaker for detailed lip-sync shots. Use reaction shots, over-the-shoulder framing, or wider framing for conversations involving several visible faces. Voice cloning must require user confirmation that they have the necessary rights and consent.

## 6. Storyboards and animatic

Generate one inexpensive approved image per shot before video. Assemble these images with temporary dialogue, subtitles, simple camera moves, and transitions into an FFmpeg animatic.

The animatic review shows:

- Full story and pacing.
- Predicted and actual runtime.
- Estimated GPU time and disk usage.
- Missing character/location references.
- Dialogue that does not fit its shot.
- Continuity conflicts.
- Risky or unusually expensive shots.

Final video rendering remains locked until the animatic or selected scenes are approved.

## 7. Progressive rendering

Move each shot through:

```text
planned -> storyboard -> draft -> review -> approved -> final -> locked
                               |          |
                               v          v
                             failed     retry requested
```

- Storyboard: still image only.
- Draft: reduced resolution, turbo steps, no upscale.
- Candidate: one normal-quality attempt.
- Approved: selected candidate.
- Final: full quality, optional upscale and audio finishing.
- Locked: protected from automated replacement.

Default retry policy: one initial attempt and at most one automatic correction. Further retries require user review. Render small batches until references and settings prove stable.

## 8. Consistency system

- Compile every shot prompt from the locked production bible.
- Route recurring subjects through approved reference packs.
- Use previous-shot boundary frames where visual continuity is required.
- Keep model, VAE, LoRA, sampler, scheduler, and quality profile stable within a scene.
- Track wardrobe, props, lighting, time, screen direction, and emotional state in a continuity ledger.
- Store keyframes from approved shots as scene memory.
- Compare storyboard and output frames using general visual embeddings.
- Make optional face-identity scoring license-aware and disabled by default.
- Flag low-confidence results for humans instead of blindly retrying.

Using a repeated seed alone is not considered an identity-control mechanism.

## 9. Quality checks

Automated checks can detect or score:

- Missing/corrupt/black output frames.
- Incorrect duration, resolution, FPS, or audio stream.
- Excessive repeated frames or unexpectedly low motion.
- Character, costume, and location similarity to approved references.
- First/last-frame continuity.
- Audio clipping and silence.
- Dialogue length and synchronization.
- Prompt/reference/workflow mismatches.

Scores are warnings and routing signals, not final creative judgments.

## 10. Pause, resume, and recovery

Persist the pipeline as durable tasks:

```text
planned -> ready -> queued -> rendering -> reviewing -> approved -> final
                    |          |
                    v          v
                 cancelled    failed
```

Provide:

- `Pause after current shot` to preserve the active render.
- `Stop now` to interrupt the active ComfyUI job.
- Resume from the next incomplete dependency.
- Startup reconciliation against ComfyUI queue and history.
- A readable error and retry action for every failed task.
- No deletion of completed assets when a task is retried.

## 11. Movie workspace interface

Add a `Movie` navigation destination with:

- Left: scenes and ordered shots.
- Center: storyboard, preview, or animatic player.
- Right inspector: prompt, references, continuity, dialogue, render route, attempts, and approval state.
- Top status bar: project stage, runtime, estimated remaining compute, disk estimate, and pause control.
- Bottom production queue: current task and the next few dependent tasks.

Avoid large modal-driven shot workflows. Use the inspector for normal shot edits. Character and location creation use focused, viewport-safe modals so the main production bible stays scannable; destructive confirmations, voice authorization, and final export settings may also use dialogs.

## Implementation phases

## Feature-pass progress

### Feature Pass 1 — Planning foundation (implemented)

- Persistent local movie projects with schema-safe defaults.
- Story, target runtime, compute budget, aspect ratio, quality, and review-gate setup.
- Editable production bible for global visual rules, characters, wardrobe, voices, and locations.
- Local Ollama structured-output scene and shot planning.
- Manual scene and shot creation when Ollama is unavailable.
- Planned-versus-target runtime feedback.
- Persistent pause/resume project state.
- One-shot handoff into the existing Create workspace.
- No automatic ComfyUI submission, retry, or video joining.

### Feature Pass 2 — Movie assets and assisted authoring (implemented)

- Focused create/edit modals for movie characters and recurring locations.
- Compact production-bible cards after each asset is saved.
- Persistent character and location reference-image lists that keep the original local file paths.
- Local Ollama assistance for story treatments, global continuity rules, characters, locations, and individual MiniMax shot prompts.
- Character assignment per shot for explicit recurring-cast continuity.
- Ref2V handoff loads the assigned character and scene-location references into Create without starting a render.
- Progressive story layout with collapsible production limits.
- Compact shot rows with details expanded only when requested.
- Collapsible scene cards showing the scene summary, location, shot count, runtime, generation-route mix, and assigned cast before opening.
- Responsive modal bodies and always-reachable modal actions in resized desktop windows.
- Browser-preview mocks for all new structured assistant flows.

Next test gate: exercise reference-image selection in the packaged Electron build with real local images, confirm Ref2V handoff loads them, and then begin storyboard/animatic timing work. References are not copied into project storage yet, so moving or deleting an original file will intentionally make that reference unavailable.

### Feature Pass 3 — Scene continuity foundation (implemented)

- Scene cards can be opened independently and summarize story beat, location, duration, shot count, route mix, assigned cast, and continuation readiness.
- Every scene after the opening scene defaults to an explicit connection with the preceding scene; users can switch it to a hard cut.
- Connected scenes wait for the preceding scene’s final shot instead of silently falling back to an unrelated first frame.
- Completed movie-linked renders are written back to their source shot without joining clips or queuing follow-up work.
- Opening the first shot of a ready connected scene extracts the preceding scene’s final rendered frame automatically and routes the shot through I2V.
- Continuation handoff adds explicit identity, wardrobe, prop, lighting, color, lens, camera-axis, screen-direction, pose, and motion-momentum preservation guidance.
- Hard-cut scenes remain freely routable through T2V, I2V, first/last-frame, or Ref2V.

Next test gate: complete two real linked scene renders in packaged Electron, verify the extracted handoff frame against the prior video’s final decoded frame, and add storyboard thumbnails plus animatic timing without automatic generation.

### Feature Pass 4 — Project copilot and movie review (implemented)

- A persistent right-side movie copilot uses the selected local Ollama model and receives the current story, production rules, recurring cast, locations, scenes, shots, and recent project conversation.
- Copilot conversations are stored per movie project and restored with that project.
- Structured copilot responses can safely revise project, scene, and shot fields while preserving unrequested content and rejecting unknown character or location IDs.
- Every completed render opened from a movie shot is collected into a project-specific movie preview in scene and shot order.
- The movie preview plays clips sequentially without joining, modifying, or duplicating the source files.
- The Clip Editor frame extractor now accepts an FFmpeg executable or FFmpeg folder, supports quoted Windows paths, verifies that a real image was produced, and displays extraction progress in the modal.
- Extracted frames are shown through the app media protocol and can be routed to I2V, first/last-frame, or Ref2V without automatically joining clips.

Next test gate: render several movie-linked clips out of order and confirm the preview restores story order, then exercise start/end frame extraction from local, ComfyUI-served, and trimmed clips in the packaged app.

### Feature Pass 5 — Whole-project conversational builder (implemented)

- The Ollama copilot is a full-height companion beside the entire Movie Maker workspace rather than a panel tied to one planning stage.
- The complete editable project is supplied as context: setup, story, global visual rules, character continuity, locations, scenes, shots, dialogue, render routes, status, and recent conversation.
- Structured chat operations can create or revise characters, locations, scenes, and shots; explicitly requested deletes are also supported.
- Temporary IDs from a single Ollama response are safely translated into persistent IDs, allowing a new shot to reference a new scene or character created in the same response.
- Existing reference images, shot output links, render timestamps, and stages survive chat edits to their parent entities.
- Unknown character, location, scene, and shot references are rejected instead of corrupting the project graph.
- Chat replies support safe presentation markup for headings, paragraphs, bullets, bold text, and inline code without injecting HTML.
- Responses include smart review actions that open the affected Story, Bible, Shots, or Movie Preview area.
- Starter actions let a filmmaker develop the treatment, create recurring cast and sets, or create connected scenes and MiniMax-ready shots directly from the sidebar.
- The conversation and every applied-change summary remain stored with the selected movie project.

Next test gate: use several different installed Ollama model families against the expanded schema, measure response reliability on large projects, and add an undoable review step for destructive or broad multi-scene revisions.

### Feature Pass 6 — Storyboard and conversational revision safety (next)

- Add a pending-change preview showing field-level diffs before broad chat revisions are committed.
- Keep an undo history for AI-applied story, bible, scene, and shot edits.
- Summarize older conversation and completed scenes into compact project memory when the local model context window becomes crowded.
- Generate Z-Image storyboard candidates per shot and show approved thumbnails on scene cards.
- Add an animatic player using approved storyboards, dialogue placeholders, shot durations, and temporary audio.
- Surface continuity warnings in chat and scene cards when wardrobe, location anchors, screen direction, duration, or generation route drift from the production bible.
- Let chat select a specific character, location, scene, or shot as its focused editing scope while retaining awareness of the full project.
- Require explicit confirmation before chat removes assets, scenes, rendered outputs, or more than a configurable number of shots.

### Feature Pass 7 — LAN mobile companion (implemented foundation)

- Start a private companion web server with the desktop app and expose it only on the local network.
- Show a scannable QR link in the desktop title bar; its private token persists across restarts and changes only when the user explicitly rotates the access link.
- Provide a focused phone workspace for T2V and I2V without exposing the full desktop editor.
- Reuse the desktop model-folder settings, MiniMax model selection rules, workflow builder, output resolutions, orientation controls, and automatic image-crop editor.
- Upload only the prepared I2V crop to the desktop ComfyUI input folder, queue the real MiniMax workflow, poll completion, and preview or download the resulting video.
- Proxy generated video with byte-range support so mobile playback and seeking work without exposing ComfyUI directly to the network.
- Add a web manifest, mobile icons, standalone presentation, safe-area layout, and an offline shell service worker.
- Preserve the access token on the phone after a home-screen launch while keeping it out of cached request URLs.
- Treat the initial HTTP LAN page as a same-network browser companion. Full browser-verified PWA installation and service-worker caching require a trusted HTTPS origin (localhost is the development exception).

Next test gate: install the rebuilt desktop app, allow its private-network firewall prompt, scan from a real phone on the same Wi-Fi, submit one T2V and one cropped I2V, seek and download both outputs, and verify the layout in phone portrait, phone landscape, and tablet widths.

### Feature Pass 8 — Trusted mobile install and production controls (next)

- Add an opt-in LAN companion setting, port selection, connection list, and a prominent stop-sharing control.
- Provide a guided trusted-HTTPS setup for full PWA installation without asking users to bypass certificate warnings.
- Mirror phone-started jobs into the desktop queue and library with source-device labels.
- Add mobile queue visibility, generation recovery after page reload, and completed-output history.
- Validate phone uploads by decoded media type and dimensions in addition to file size.
- Add automated LAN API tests covering authorization, invalid workflows, upload limits, ComfyUI errors, range requests, and stale tokens.

### Feature Pass 9 — Dedicated first-frame and expanded mobile creation (implemented)

- Move Z-Image Turbo out of the MiniMax composer into its own First Frame workspace with persistent prompt, canvas, seed, and model-component settings.
- Provide a large still-image preview, cancellation, local Ollama enhancement, and an explicit **Use in MiniMax I2V** handoff that also matches the video canvas.
- Keep the original Z-Image output in ComfyUI while passing a prepared image copy to the later MiniMax workflow.
- Add mobile Ollama prompt tools for enhancement, shot timing, synchronized audio, and free-form revision instructions.
- Add mobile LTX 2.5 latent 2× and RTX/CUDA frame 2× post-render options using the upscalers detected from the desktop ComfyUI instance.
- Relay ComfyUI sampler progress and binary preview frames to the mobile page without exposing ComfyUI on the LAN.
- Add mobile generation cancellation and retain the persistent, manually rotated mobile access token.

Next test gate: run Z-Image through the dedicated workspace and hand its output to I2V; then test phone T2V and I2V with each upscale mode, progress preview, Ollama editing, cancellation, and final download.

### Feature Pass 10 — DaVinci-style timeline interaction (next)

- Keep the media bin at left, program viewer above, timeline below, and add a collapsible clip inspector at right so the editor reads as one workspace rather than separate cards.
- Add a time ruler, draggable playhead, current/total timecode, timeline zoom, fit-to-timeline, horizontal wheel navigation, and a clearly visible active clip.
- Replace move-left/right as the primary interaction with direct clip dragging, magnetic snapping, insertion indicators, and keyboard-accessible reorder controls.
- Add draggable in/out trim handles with live viewer feedback, ripple-safe trimming, split-at-playhead, ripple delete, and undo/redo history.
- Add video and audio track headers with lock, mute, solo, visibility, and target controls before supporting layered clips.
- Add J/K/L playback, Space play/pause, arrow-frame stepping, I/O marks, S split, Delete/ripple-delete, and tooltips that expose shortcuts.
- Keep explicit export as the only join operation. Frame extraction and continuation rendering continue to create separate source clips.
- Adapt at smaller window sizes by collapsing the inspector and media bin into toggled panels while keeping transport and timeline controls reachable.

Research basis: Blackmagic’s Edit page uses a media pool, viewers, and timeline as a coordinated workspace; Resolve 20 also emphasizes trim modes, ripple controls, and safe trimming. See the official Editor’s Guide and Resolve documentation: https://documents.blackmagicdesign.com/UserManuals/DaVinci-Resolve-20-Editors-Guide.pdf and https://www.blackmagicdesign.com/support

### Feature Pass 11 — Consistency-first movie automation controller (next)

- Create a versioned identity pack for each character: approved hero portrait, profile, full body, wardrobe variants, color anchors, voice anchor, and protected textual traits.
- Pin every shot to explicit character/reference versions so later bible changes cannot silently alter already approved scenes.
- Generate and approve inexpensive Z-Image keyframes before expensive video. Use those anchors for I2V or Ref2V rather than relying on T2V to rediscover a recurring character.
- Route connected shots through last-frame I2V continuation; route hard cuts containing recurring cast through Ref2V identity packs; reserve pure T2V for establishing shots or intentionally new subjects.
- Maintain separate inter-shot memory (approved keyframes and identity references) and intra-shot memory (continuation frames and motion direction), reflecting current multi-shot consistency research.
- Add automated identity, wardrobe, location, palette, screen-direction, prompt-alignment, duration, and technical-output checks after every render.
- Compare face/subject embeddings against approved references and flag drift for review. Never auto-retry beyond a small user-configured budget.
- Ask for approval after storyboard/keyframe batches and after failed quality checks so automation saves time instead of repeatedly producing unusable video.
- Store every attempt, seed, prompt, references, model route, score, rejection reason, and chosen result in the project ledger.
- Add pause/resume checkpoints around planning, keyframes, video batches, dialogue, continuity repair, edit assembly, and final export.

### Feature Pass 12 — Independent LTX‑2.5 provider workspace (implemented)

- Add LTX‑2.5 as a dedicated navigation workspace rather than mixing its controls with MiniMax H3.
- Persist its T2V/I2V mode, prompt, first frame and crop, resolution, duration, seed, quality preset, and live-preview preference under a separate workspace key.
- Use the official ComfyUI two-stage distilled graph for Quality: fixed 8-step first-stage sigmas, half-resolution generation, latent spatial 2× upscaling, and fixed 3-step refinement.
- Offer a Turbo preset using the official fixed 8-step distilled schedule as a single full-resolution stage.
- Keep LTX output selection, current job, cancellation, progress, preview frame, and final playback isolated from the MiniMax composer while sharing the reliable ComfyUI queue transport.
- Detect and prefer the official INT8 ConvRot distilled transformer, projected Gemma 4 encoder, LTX video/audio VAEs, and latent spatial upscaler already installed by the user.
- Add local Ollama prompt refinement tailored to LTX T2V or I2V without altering MiniMax prompt state.

Next test gate: run one 5-second LTX T2V and one cropped I2V in both Quality and Turbo, compare the fixed seed, confirm native audio, cancel a queued render, and verify intermediate/final previews remain scoped to the LTX workspace.

Research basis: current work finds a real identity-versus-motion tradeoff, while multi-shot systems improve consistency through shared references/features, approved anchor frames, and separate shot/temporal memory. Relevant sources: https://arxiv.org/abs/2412.07750, https://arxiv.org/abs/2512.11274, and https://openaccess.thecvf.com/content/CVPR2025/html/Kara_ShotAdapter_Text-to-Multi-Shot_Video_Generation_with_Diffusion_Models_CVPR_2025_paper.html

### Phase 1 — Planning foundation

- Movie project persistence and schema migrations.
- Story wizard and compute/runtime settings.
- Ollama JSON-schema screenplay generation and validation.
- Production bible and versioned references.
- Scene/shot dependency model.

### Phase 2 — Storyboard and animatic

- Z-Image storyboard batches.
- Dialogue placeholders and timing.
- Shot-duration editor.
- FFmpeg animatic construction.
- Approval gates and continuity warnings.

### Phase 3 — Production controller

- Automatic generation-mode routing.
- Reuse existing MiniMax workflow builders and queue.
- Small-batch rendering, pause/resume, retries, and recovery.
- Send completed shots to the Clip Editor as separate assets.

### Phase 4 — Dialogue and quality control

- Voice library and approved master-audio workflow.
- H3/LTX audio-driven routing.
- Optional lip-sync integration.
- Visual consistency and technical output checks.
- Final audio mix, subtitles, and export validation.

## Research references

### Implemented workflow foundation

- MiniMax H3 T2V/I2V uses the official ComfyUI `MiniMaxH3ImageToVideo` sampling and joint video/audio decode graph.
- Ref2V uses the official `MiniMaxH3ReferenceToVideo` graph and published 4-step turbo path.
- Official `res_multistep` + `simple` sampling is the safe default; non-template combinations require an explicit experimental opt-in.
- Official INT8 ConvRot diffusion, NVFP4-AWQ encoder, and matching video/audio VAE filenames are preferred when multiple local safetensors match.
- Preview and upscale nodes remain downstream branches so they cannot change base MiniMax sampling.
- Main Settings now stores official quality, official 8-step Turbo, and experimental Euler/Beta Turbo defaults, including LoRA strength, reference fidelity, live preview, and optional core `MiniMaxH3SigmaShift` values.

- ComfyUI server routes and interruption: https://docs.comfy.org/development/comfyui-server/comms_routes
- ComfyUI progress and preview messages: https://docs.comfy.org/development/comfyui-server/comms_messages
- Ollama structured outputs: https://docs.ollama.com/capabilities/structured-outputs
- Official LTX-2 workflows: https://github.com/Comfy-Org/docs/blob/main/tutorials/video/ltx/ltx-2.mdx
- MiniMax H3 guide-frame node: https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/MiniMaxH3AddGuide/en.md
- Official ComfyUI workflow templates: https://github.com/Comfy-Org/workflow_templates
- Multi-shot character consistency research: https://arxiv.org/abs/2412.07750
- Cache-guided multi-shot consistency research: https://arxiv.org/abs/2512.11274
- LatentSync: https://github.com/bytedance/LatentSync
- DINOv2 model card: https://github.com/facebookresearch/dinov2/blob/main/MODEL_CARD.md

## Completion criteria

- A user can pause and resume without losing approved work.
- The app shows a meaningful time/storage estimate before final rendering.
- No expensive batch begins before its configured approval gate.
- Every final shot traces back to its prompt, references, settings, and attempts.
- Character and scene references remain consistent and versioned.
- Failed shots do not block unrelated ready work or destroy earlier outputs.
- Generated clips are never joined automatically.
- Joining happens only when the user explicitly exports a Clip Editor timeline.
