/**
 * The Electron shell — window management, the privileged media protocol, and
 * the IPC bridge. Every capability the renderer actually uses lives in
 * server/core.ts (shared with the standalone web server); the handlers here
 * are thin delegates. This file goes away when the Electron decommission
 * (migration Phase D) completes.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol, shell } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStudioServer } from '../server/core'
import type { AppSettings } from '../src/types'

protocol.registerSchemesAsPrivileged([
  { scheme: 'minimax-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const studio = createStudioServer({
  settingsFile: join(app.getPath('userData'), 'settings.json'),
  lanTokenFile: join(app.getPath('userData'), 'lan-access-token.txt'),
  tempDirectory: app.getPath('temp'),
  documentsDirectory: app.getPath('documents'),
  staticRoot: join(__dirname, '..', 'dist'),
})

function createWindow() {
  nativeTheme.themeSource = 'dark'
  const window = new BrowserWindow({
    width: 1680,
    height: 1020,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#101412',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101412', symbolColor: '#d9e2dc', height: 42 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.setMenuBarVisibility(false)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(async () => {
  await studio.startLanServer()
  protocol.handle('minimax-media', async (request) => {
    const requestUrl = new URL(request.url)
    if (requestUrl.hostname === 'comfy') {
      const target = requestUrl.searchParams.get('url')
      if (!target) return new Response('Missing ComfyUI media URL', { status: 400 })
      const configuredUrl = new URL((await studio.loadSettings()).comfyUrl.replace(/\/+$/, ''))
      const targetUrl = new URL(target)
      if (targetUrl.origin !== configuredUrl.origin || targetUrl.pathname !== '/view') {
        return new Response('Media URL is outside the configured ComfyUI server', { status: 403 })
      }
      const upstream = await net.fetch(targetUrl.toString(), { headers: request.headers })
      const headers = new Headers(upstream.headers)
      headers.delete('content-security-policy')
      headers.delete('content-disposition')
      headers.set('access-control-allow-origin', '*')
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
    }

    const requestedPath = requestUrl.searchParams.get('path')
    if (!requestedPath) return new Response('Missing media path', { status: 400 })
    if (requestUrl.hostname === 'selected') {
      const allowed = new Set(['.mp4', '.webm', '.mov', '.mkv', '.flac', '.wav', '.mp3', '.ogg', '.m4a', '.aac', '.opus', '.png', '.jpg', '.jpeg', '.webp', '.bmp'])
      if (!existsSync(requestedPath) || !allowed.has(extname(requestedPath).toLowerCase())) return new Response('Selected media is unavailable', { status: 404 })
      return studio.localMediaResponse(requestedPath, request)
    }
    const settings = await studio.loadSettings()
    const configured = settings.outputDirectory.replace(/\/+$/, '')
    const candidate = requestedPath.replace(/\/+$/, '')
    const contained = candidate.toLowerCase().startsWith(`${configured.toLowerCase()}\\`) || candidate.toLowerCase() === configured.toLowerCase()
    if (!contained || !existsSync(candidate)) return new Response('Media is outside the configured output directory', { status: 403 })
    return studio.localMediaResponse(candidate, request)
  })
  ipcMain.handle('settings:get', () => studio.loadSettings())
  ipcMain.handle('system:gpu-telemetry', () => studio.readGpuTelemetry())
  ipcMain.handle('lan:status', () => studio.status())
  ipcMain.handle('lan:sync-characters', (_event, characters: unknown[]) => studio.syncCharacters(characters))
  ipcMain.handle('lan:rotate-token', () => studio.rotateToken())
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => studio.saveSettings(settings))
  ipcMain.handle('dialog:directory', async (_event, initialPath?: string) => {
    const result = await dialog.showOpenDialog({
      defaultPath: initialPath && existsSync(initialPath) ? initialPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:media', async (_event, type: 'image' | 'video' | 'audio') => {
    const filters = {
      image: { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      video: { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] },
      audio: { name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] },
    }
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [filters[type]] })
    return result.canceled ? null : { path: result.filePaths[0], name: basename(result.filePaths[0]) }
  })
  ipcMain.handle('models:scan', (_event, settings: AppSettings) => studio.scanModels(settings))
  ipcMain.handle('comfy:status', async (_event, url: string) => {
    const started = Date.now()
    try {
      const stats = await studio.comfyFetch(url, '/system_stats')
      return { connected: true, latencyMs: Date.now() - started, stats }
    } catch (error) {
      return { connected: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('comfy:info', (_event, url: string) => studio.comfyFetch(url, '/object_info'))
  ipcMain.handle('comfy:submit', (_event, url: string, prompt: unknown, clientId?: string) =>
    studio.comfyFetch(url, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId ?? randomUUID() }) }))
  ipcMain.handle('comfy:queue', (_event, url: string) => studio.comfyFetch(url, '/queue'))
  ipcMain.handle('comfy:history', (_event, url: string, promptId: string) => studio.comfyFetch(url, `/history/${encodeURIComponent(promptId)}`))
  ipcMain.handle('comfy:cancel', (_event, url: string, promptId: string) => studio.cancelPromptAt(url, promptId))
  ipcMain.handle('comfy:upload', (_event, url: string, filePath: string, subfolder = 'minimax-desktop') => studio.uploadFileAt(url, filePath, subfolder))
  ipcMain.handle('comfy:upload-data', async (_event, url: string, data: string) => {
    if (data.length > 64_000_000) throw new Error('The prepared image is too large.')
    const form = new FormData()
    form.append('image', new Blob([Buffer.from(data.split(',')[1], 'base64')], { type: 'image/png' }), `frame-${randomUUID()}.png`)
    form.append('type', 'input'); form.append('subfolder', 'minimax-desktop'); form.append('overwrite', 'true')
    return studio.comfyFetch(url, '/upload/image', { method: 'POST', body: form })
  })
  ipcMain.handle('comfy:output-image', async (_event, url: string, file: { filename: string; subfolder?: string; type?: string }) => {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const response = await fetch(`${url.replace(/\/+$/, '')}/view?${query}`)
    if (!response.ok) throw new Error('The generated image is unavailable.')
    return `data:${response.headers.get('content-type') ?? 'image/png'};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  })
  ipcMain.handle('comfy:save-output-image', async (_event, url: string, file: { filename: string; subfolder?: string; type?: string }, outputDirectory: string) => {
    const settings = await studio.loadSettings()
    if (outputDirectory.replace(/[\\/]+$/, '') !== settings.outputDirectory.replace(/[\\/]+$/, '')) throw new Error('Images can only be saved into the configured output directory.')
    return studio.saveOutputImage(file, settings.outputDirectory, url)
  })
  ipcMain.handle('outputs:resolve', (_event, outputDirectory: string, file: { filename: string; subfolder?: string; type?: string }) => {
    const path = studio.resolveOutputFile(outputDirectory, file)
    return path ? `minimax-media://local?path=${encodeURIComponent(path)}` : null
  })
  ipcMain.handle('ollama:list', async (_event, url: string) => {
    const data = await studio.comfyFetch(url, '/api/tags') as { models?: Array<{ name: string; size?: number; remote_model?: string; details?: { family?: string; parameter_size?: string } }> }
    return (data.models ?? []).map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      family: model.details?.family ?? '',
      parameterSize: model.details?.parameter_size ?? '',
      local: !model.remote_model && model.size !== 342,
    }))
  })
  ipcMain.handle('ollama:generate', async (_event, url: string, model: string, prompt: string) => {
    const data = await studio.comfyFetch(url, '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.65, num_predict: 1200 } }),
    }) as { response?: string; error?: string }
    if (!data.response) throw new Error(data.error || 'Ollama returned an empty response.')
    const answer = data.response.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '').trim()
    if (!answer) throw new Error('Ollama returned reasoning without a final answer.')
    return answer
  })
  ipcMain.handle('ollama:structured', async (_event, url: string, model: string, prompt: string, schema: Record<string, unknown>) => {
    const data = await studio.comfyFetch(url, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0.2, num_predict: 6000 },
      }),
    }) as { message?: { content?: string }; error?: string }
    const content = data.message?.content ? data.message.content.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '').trim() : ''
    if (!content) throw new Error(data.error || 'Ollama returned an empty movie plan.')
    try { return JSON.parse(content) }
    catch { throw new Error('Ollama returned a movie plan that was not valid JSON.') }
  })
  ipcMain.handle('file:data-url', async (_event, filePath: string) => {
    const extension = extname(filePath).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${(await readFile(filePath)).toString('base64')}`
  })
  ipcMain.handle('file:media-url', (_event, filePath: string) => {
    const allowed = new Set(['.mp4', '.webm', '.mov', '.mkv', '.flac', '.wav', '.mp3', '.ogg', '.m4a', '.aac', '.opus', '.png', '.jpg', '.jpeg', '.webp', '.bmp'])
    if (!existsSync(filePath) || !allowed.has(extname(filePath).toLowerCase())) throw new Error('The selected media is unavailable.')
    return `minimax-media://selected?path=${encodeURIComponent(filePath)}`
  })
  ipcMain.handle('video:frame', async (_event, source: string, position: number | 'last', outputDirectory: string, ffmpegPath: string) => {
    const input = await studio.resolveVideoSource(source)
    return studio.extractVideoFrameAt(input, position, outputDirectory, ffmpegPath)
  })
  ipcMain.handle('video:frames', async (_event, source: string, positions: number[], outputDirectory: string, ffmpegPath: string) => {
    const input = await studio.resolveVideoSource(source)
    return studio.extractVideoFramesAt(input, positions, outputDirectory, ffmpegPath)
  })
  ipcMain.handle('video:trim', async (_event, source: string, start: number, end: number, outputDirectory: string, ffmpegPath: string) => {
    const input = await studio.resolveVideoSource(source)
    return studio.trimVideoAt(input, start, end, outputDirectory, ffmpegPath)
  })
  ipcMain.handle('video:join', async (_event, clips: Array<{ source: string; start?: number; end?: number }>, outputDirectory: string, ffmpegPath: string) => {
    if (!Array.isArray(clips) || clips.length < 2) throw new Error('Add at least two clips to join.')
    const inputs = await Promise.all(clips.map((clip) => studio.resolveVideoSource(clip.source)))
    const result = await studio.joinVideosAt(inputs, clips, outputDirectory, ffmpegPath)
    return { path: result.path, url: `minimax-media://local?path=${encodeURIComponent(result.path)}` }
  })
  ipcMain.handle('shell:show-output', async (_event, outputPath: string) => {
    const { mkdir } = await import('node:fs/promises')
    if (!existsSync(outputPath)) await mkdir(outputPath, { recursive: true })
    shell.showItemInFolder(join(outputPath, '.'))
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  // A throw anywhere in startup (token write, protocol registration, window
  // creation) previously left a running process with no window.
  dialog.showErrorBox('MiniMax Studio failed to start', `Startup failed before the window could open:\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n\nThe application will close.`)
  app.quit()
})

app.on('window-all-closed', () => {
  studio.stopLanServer()
  if (process.platform !== 'darwin') app.quit()
})
