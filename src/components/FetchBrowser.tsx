/** FetchBrowser — the Settings surface for the local-first fetcher (task
 *  hgjbea2): a grouped, searchable browser of everything the studio can
 *  fetch on explicit request, with per-item license + size + status, a
 *  consent dialog that shows the license BEFORE anything touches the
 *  network, live progress over the realtime fabric's system channel, and a
 *  post-fetch availability refresh. Self-contained by design so the canvas
 *  redesign can lift it wholesale. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Download, Globe, LoaderCircle, PackageOpen, RefreshCw, Scale, Search, Trash2 } from 'lucide-react'
import type { AppSettings, FetchEntryStatus, FetchProgress } from '../types'
import { formatBytes } from '../lib/format'
import { StudioDialog } from '../ui/StudioDialog'
import { subscribe } from '../lib/useRealtime'

const GROUPS: Array<{ id: FetchEntryStatus['group']; label: string; note: string }> = [
  { id: 'node-packs', label: 'Node packs', note: 'custom_nodes/ packs fetched from their repository at a pinned (or fetch-stamped) revision — never vendored when the license forbids redistribution.' },
  { id: 'weights', label: 'Model weights', note: 'checkpoints and stage files, downloaded once into the studio cache and LINKED into your model roots (never copied).' },
  { id: 'preprocessors', label: 'Preprocessor weights', note: 'control-surface extractors (pose/depth/edge) the experiments need on disk before their first offline run.' },
  { id: 'engine', label: 'Engine', note: 'the reference ComfyUI revision, fetched as a checkout you can nominate for the managed engine.' },
]

/** Licenses that get the warning treatment at consent time. */
function flaggedLicense(spdx: string): boolean {
  return spdx === 'NO-LICENSE' || spdx.startsWith('GPL') || spdx.startsWith('AGPL') || spdx.startsWith('CC')
}

export function FetchBrowser({ settings, setSettings, onAfterFetch, onAdoptCheckout }: { settings: AppSettings; setSettings(value: AppSettings): void; onAfterFetch(): void; onAdoptCheckout(path: string): void }) {
  const [entries, setEntries] = useState<FetchEntryStatus[] | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [consentFor, setConsentFor] = useState<FetchEntryStatus | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [progress, setProgress] = useState<Record<string, FetchProgress>>({})
  const [destinationDir, setDestinationDir] = useState('')
  const checkboxRef = useRef<HTMLInputElement | null>(null)
  // The consent record lives in the SERVER's settings; keep the caller's
  // copy fresh so a later Save never wipes it back off.
  const afterFetchRef = useRef(onAfterFetch)
  afterFetchRef.current = onAfterFetch

  const refresh = async () => {
    try {
      setEntries((await window.minimax.listFetchCatalog()).entries)
    } catch { /* surfaced on the next action; the section stays empty */ }
  }

  useEffect(() => { void refresh() }, [settings.engine.checkoutPath, settings.modelRoot, settings.paths.diffusion_models])

  // Live fetch progress rides the fabric's system channel ({type:'fetch'}).
  // One subscription for the component's life (the callbacks go through a
  // ref so an unstable parent prop never churns the socket).
  useEffect(() => subscribe('system', (envelope) => {
    if (envelope.type !== 'fetch') return
    const payload = envelope.payload as FetchProgress
    setProgress((current) => ({ ...current, [payload.id]: payload }))
    if (payload.phase === 'done') {
      setEntries((current) => current?.map((entry) => entry.id === payload.id ? { ...entry, state: 'placed', inFlight: false } : entry) ?? current)
      afterFetchRef.current()
      void refresh()
    }
    if (payload.phase === 'failed') {
      setError(payload.message ?? 'The fetch failed.')
      void refresh()
    }
  }), [])

  const openConsent = (entry: FetchEntryStatus) => {
    setAcknowledged(false)
    setDestinationDir('')
    setError(null)
    setConsentFor(entry)
  }

  const confirmFetch = async () => {
    if (!consentFor) return
    const entry = consentFor
    setBusy(entry.id)
    setError(null)
    try {
      await window.minimax.setFetchConsent(entry.id, true)
      setSettings(await window.minimax.getSettings())
      const started = await window.minimax.startFetch(entry.id, entry.destination.kind === 'engine-checkout' && destinationDir.trim() ? { destinationDir: destinationDir.trim() } : undefined)
      if (!started.started) throw new Error('The fetch could not be started.')
      setConsentFor(null)
      setEntries((current) => current?.map((candidate) => candidate.id === entry.id ? { ...candidate, inFlight: true } : candidate) ?? current)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const removeItem = async (entry: FetchEntryStatus) => {
    setBusy(entry.id)
    setError(null)
    try {
      const result = await window.minimax.removeFetched(entry.id)
      setEntries(result.entries)
      onAfterFetch()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const filtered = useMemo(() => {
    if (!entries) return []
    const needle = filter.trim().toLowerCase()
    if (!needle) return entries
    return entries.filter((entry) => [entry.name, entry.description, entry.licenseSpdx, entry.group, entry.source.kind === 'hf' ? entry.source.repo : entry.source.url].join(' ').toLowerCase().includes(needle))
  }, [entries, filter])

  return <section className="settings-section fetch-section" aria-label="Fetchable items">
    <div className="settings-heading">
      <div><Globe size={19} /><span><strong>Fetchable items</strong><small>Optional models, packs and the reference engine — fetched from the network ONLY when you ask, with the license on screen first. Nothing fetches on its own; the app stays fully offline otherwise.</small></span></div>
      <button type="button" className="secondary-button" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button>
    </div>
    <div className="connection-row fetch-search-row">
      <div className="field-group grow"><label htmlFor="fetch-filter">Search</label>
        <div className="fetch-search">
          <Search size={15} />
          <input id="fetch-filter" value={filter} placeholder="name, license, repository…" onChange={(event) => setFilter(event.target.value)} />
        </div>
      </div>
    </div>
    {GROUPS.map((group) => {
      const groupEntries = filtered.filter((entry) => entry.group === group.id)
      if (groupEntries.length === 0) return null
      return <div className="fetch-group" key={group.id}>
        <div className="fetch-group-heading"><strong>{group.label}</strong><small>{group.note}</small></div>
        <div className="node-pack-list">
          {groupEntries.map((entry) => {
            const live = progress[entry.id] ?? (entry.inFlight ? { phase: 'downloading' as const, at: Date.now(), id: entry.id } : null)
            const fetching = Boolean(live) && live!.phase !== 'done' && live!.phase !== 'failed'
            const fraction = live && typeof live.bytes === 'number' && typeof live.totalBytes === 'number' && live.totalBytes > 0 ? Math.min(1, live.bytes / live.totalBytes) : null
            return <div className="node-pack-row fetch-row" key={entry.id}>
              <div className="node-pack-main">
                <div className="node-pack-title">
                  <strong>{entry.name}</strong>
                  <span className={`node-pack-license ${flaggedLicense(entry.licenseSpdx) ? 'warn' : ''}`} title={entry.licenseNote}>{entry.licenseSpdx}</span>
                  <span className="node-pack-mode">{entry.sizeBytes ? formatBytes(entry.sizeBytes) : entry.sizeClass}</span>
                  {entry.experimentPrerequisite && <span className="node-pack-mode" title="Needed by a committed experiment plan, not by the shipped features.">experiment prerequisite</span>}
                  {entry.optional && <span className="node-pack-mode" title="A preferred alternative exists (runtime merge).">optional</span>}
                  <span className={`node-pack-mode fetch-state-${entry.state}`}>{stateLabel(entry, fetching)}</span>
                </div>
                <small>{entry.description}</small>
                <small className="node-pack-meta">{entry.source.kind === 'hf' ? `${entry.source.repo} @ ${entry.source.revision.value.slice(0, 12)}` : `${entry.source.url.replace('https://github.com/', '')} @ ${entry.source.revision.kind}:${entry.source.revision.value}`}{entry.installedRevision && entry.state === 'placed' ? ` — fetched at ${entry.installedRevision.slice(0, 12)}` : ''}{entry.verified && entry.state === 'placed' ? ` · ${entry.verified === 'sha256' ? 'sha256-verified' : entry.verified === 'size' ? 'size-verified' : 'recorded without a pin'}` : ''}{entry.note ? ` — ${entry.note}` : ''}</small>
                {fetching && <div className="fetch-progress" role="status">
                  <span className="fetch-progress-bar"><span style={{ width: fraction === null ? '100%' : `${Math.round(fraction * 100)}%` }} className={fraction === null ? 'indeterminate' : ''} /></span>
                  <small>{live!.phase === 'downloading' && typeof live!.bytes === 'number' && live!.totalBytes
                    ? `${live!.file ? `${live!.file} · ` : ''}${formatBytes(live!.bytes)} / ${formatBytes(live!.totalBytes)}`
                    : live!.message ?? live!.phase}</small>
                </div>}
              </div>
              <div className="node-pack-actions">
                {entry.state === 'placed' && entry.destination.kind === 'engine-checkout' && entry.placedPaths?.[0] && settings.engine.checkoutPath !== entry.placedPaths[0]
                  && <button type="button" className="secondary-button" onClick={() => onAdoptCheckout(entry.placedPaths![0])}>Use as managed checkout</button>}
                <button type="button" className="secondary-button" disabled={fetching || busy === entry.id} onClick={() => openConsent(entry)}>
                  {fetching ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{entry.state === 'placed' || entry.state === 'present' || entry.state === 'cached' ? 'Refetch' : 'Fetch'}
                </button>
                {(entry.state === 'placed' || entry.state === 'cached') && <button type="button" className="secondary-button" disabled={fetching || busy === entry.id} onClick={() => void removeItem(entry)} aria-label={`Remove the studio's placement of ${entry.name}`}><Trash2 size={14} /></button>}
              </div>
            </div>
          })}
        </div>
      </div>
    })}
    {entries === null && <p className="settings-note">Loading the fetch catalog…</p>}
    {entries !== null && filtered.length === 0 && <p className="settings-note">Nothing matches "{filter}".</p>}
    {error && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{error}</span></div>}
    <p className="settings-note">Downloads land in the studio's fetch cache and are <strong>linked</strong> into your model roots — bytes are never duplicated, and your own files are never overwritten. Removing an item removes the studio's links only.</p>

    <StudioDialog
      open={consentFor !== null}
      onClose={() => setConsentFor(null)}
      popupClassName="clip-modal fetch-consent-modal"
      labelledBy="fetch-consent-title"
      describedBy="fetch-consent-summary"
      initialFocus={checkboxRef}
    >
      {consentFor && <>
        <header>
          <div>
            <span>FETCH CONSENT</span>
            <strong id="fetch-consent-title">{consentFor.name}</strong>
          </div>
          <Scale size={26} />
        </header>
        <div className="fetch-consent-body" id="fetch-consent-summary">
          <p>{consentFor.description}</p>
          <dl>
            <div><dt>Source</dt><dd>{consentFor.source.kind === 'hf' ? consentFor.source.repo : consentFor.source.url} <span className="node-pack-mode">{consentFor.source.revision.kind}: {consentFor.source.revision.value}</span></dd></div>
            <div><dt>Size</dt><dd>{consentFor.sizeBytes ? formatBytes(consentFor.sizeBytes) : consentFor.sizeClass}{consentFor.files && consentFor.files.length > 1 ? ` · ${consentFor.files.length} files` : ''}</dd></div>
            <div><dt>License</dt><dd><span className={`node-pack-license ${flaggedLicense(consentFor.licenseSpdx) ? 'warn' : ''}`}>{consentFor.licenseSpdx}</span>{consentFor.licenseUrl && <> · <a href={consentFor.licenseUrl} target="_blank" rel="noreferrer">read the full terms</a></>}</dd></div>
            <div><dt>Destination</dt><dd>{destinationText(consentFor, settings)}</dd></div>
          </dl>
          {consentFor.licenseNote && <div className={`llm-test-result ${flaggedLicense(consentFor.licenseSpdx) ? 'fail' : 'ok'}`} role="status"><AlertCircle size={14} /><span>{consentFor.licenseNote}</span></div>}
          {consentFor.destination.kind === 'engine-checkout' && <div className="field-group grow">
            <label htmlFor="fetch-engine-destination">Checkout directory (optional)</label>
            <input id="fetch-engine-destination" value={destinationDir} placeholder="empty = studio-managed location" onChange={(event) => setDestinationDir(event.target.value)} />
          </div>}
          <label className="settings-check fetch-consent-check">
            <input ref={checkboxRef} type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span><strong>I understand the license terms and want this downloaded now</strong><small>This is the only consent the studio needs or accepts: the download starts on your explicit request, the license above is recorded with it, and nothing else touches the network.</small></span>
          </label>
        </div>
        <footer>
          <span className="fetch-consent-note"><PackageOpen size={14} /> Weights land as links; your existing files are never replaced.</span>
          <div className="fetch-consent-actions">
            <button type="button" className="secondary-button" onClick={() => setConsentFor(null)}>Cancel</button>
            <button type="button" className="primary-button" disabled={!acknowledged || busy === consentFor.id} onClick={() => void confirmFetch()}>
              {busy === consentFor.id ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Fetch {consentFor.sizeBytes ? formatBytes(consentFor.sizeBytes) : ''}
            </button>
          </div>
        </footer>
      </>}
    </StudioDialog>
  </section>
}

function stateLabel(entry: FetchEntryStatus, fetching: boolean): string {
  if (fetching) return 'fetching…'
  switch (entry.state) {
    case 'placed': return 'fetched'
    case 'present': return 'already on disk'
    case 'cached': return 'cached (not linked)'
    default: return 'not fetched'
  }
}

function destinationText(entry: FetchEntryStatus, settings: AppSettings): string {
  switch (entry.destination.kind) {
    case 'model-root':
      return `${entry.destination.root} — ${settings.paths[entry.destination.root as keyof typeof settings.paths] ?? `${settings.modelRoot}/${entry.destination.root}`}${entry.destination.subpath ? `/${entry.destination.subpath}` : ''}`
    case 'pack-ckpt':
      return `custom_nodes/${entry.destination.packDirectory}/${entry.destination.relativePath}`
    case 'node-pack':
      return `custom_nodes/ (the configured checkout)`
    case 'engine-checkout':
      return 'a ComfyUI checkout directory (nominate it for the managed engine afterwards)'
  }
}
