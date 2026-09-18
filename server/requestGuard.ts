/**
 * Origin/Host/content-type request guards for the LAN server (security
 * hardening 1, blind-audit CRITICAL finding). The server binds 0.0.0.0 by
 * design ("open on the LAN, like ComfyUI itself") — what that posture must
 * never buy is a WEBSITE driving the API through the maintainer's browser
 * (CSRF: any page can POST text/plain JSON) or DNS rebinding turning an
 * attacker domain same-origin (full read). Three pure checks close both:
 *
 *   Host    the request's Host must be an IP literal, localhost (or
 *           *.localhost), an mDNS *.local name, or an entry of the
 *           settings-exposed extra allowlist. A rebound attacker domain
 *           fails here no matter what it resolves to.
 *   Origin  when present (browsers always send it on cross-site POSTs),
 *           it must be same-origin with the request's own Host and the
 *           scheme the socket actually speaks — anything else, including
 *           `Origin: null`, is foreign.
 *   Type    state-changing requests must carry application/json when they
 *           carry a body at all. No /api/lan route takes multipart or raw
 *           binary — every upload route reads base64 inside JSON — so the
 *           exemption list is empty by enumeration. Cross-origin fetch
 *           cannot set this content type without a preflight, which this
 *           server never answers.
 *
 * Same-origin SPA traffic is unaffected: it speaks the server's own scheme,
 * Host it was loaded from, and application/json on every POST (see
 * src/lib/apiClient.ts / serverStorage.ts / canvas/api.ts).
 *
 * Pure and dependency-light (node imports only) so both server/core.ts and
 * server/realtime.ts share one source of truth without an import cycle.
 * Nothing in this file may import from 'electron'.
 */
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Strips the port from a Host header value, keeping IPv6 brackets handled. */
export function hostOnly(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    return close > 0 ? trimmed.slice(1, close) : trimmed
  }
  const colon = trimmed.lastIndexOf(':')
  return colon > 0 ? trimmed.slice(0, colon) : trimmed
}

/** True when a hostname may drive this server: loopback names, IP literals
 *  (the LAN addresses the boot URLs use), mDNS .local names, or the
 *  settings-exposed allowlist for custom hostnames (default empty). */
export function isAllowedRequestHost(host: string, extraAllowlist: readonly string[]): boolean {
  const hostname = hostOnly(host)
  if (!hostname || hostname.length > 253) return false
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true
  if (hostname.endsWith('.local')) return true
  if (isIP(hostname) !== 0) return true
  const allowlist = extraAllowlist.map((entry) => hostOnly(entry)).filter(Boolean)
  return allowlist.includes(hostname)
}

/** True when the Origin header (when a browser sends one) is same-origin
 *  with the request's Host on the scheme the socket actually speaks. An
 *  absent Origin (curl, same-origin GETs) is not cross-origin. `null`
 *  origins (sandboxed frames) are treated as foreign. */
export function isSameOrigin(request: IncomingMessage, socketEncrypted: boolean, hostHeader: string): boolean {
  const originHeader = request.headers.origin
  if (originHeader === undefined) return true
  const origin = (Array.isArray(originHeader) ? originHeader[0] : originHeader) ?? ''
  const scheme = socketEncrypted ? 'https' : 'http'
  return origin.trim().toLowerCase() === `${scheme}://${hostHeader.trim().toLowerCase()}`
}

/** True ONLY when the request proves it is the studio's own UI: the Origin
 *  header must be PRESENT and same-origin with the request's Host on the
 *  socket's scheme. Stricter than `isSameOrigin` (which treats an absent
 *  Origin as benign): consent RECORDING is a user-acknowledgement act, so a
 *  raw peer with no Origin at all is not an acceptable author (fetch-consent
 *  Option A, maintainer decision 2026-09-18). Cross-origin browsers were
 *  already refused by the global gate; this closes the no-Origin path. */
export function isUiOriginRequest(request: IncomingMessage, socketEncrypted: boolean): boolean {
  if (request.headers.origin === undefined) return false
  return isSameOrigin(request, socketEncrypted, request.headers.host ?? '')
}

/** True when a state-changing request's body declaration is JSON: either an
 *  explicit application/json content type, or no body at all (no content
 *  type, no chunked encoding, and content-length 0 or absent — a request
 *  with neither delimiter is empty by HTTP/1.1 semantics, and Node's client
 *  omits the header entirely on bodiless POSTs). A bodiless POST is inert on
 *  the readJson routes (they parse '{}' and fail validation) and the Origin
 *  check already covers bodiless browser CSRF: browsers attach a
 *  safelisted content type to every body they will send cross-origin
 *  without a preflight. */
export function hasJsonBodyContentType(request: IncomingMessage): boolean {
  const header = request.headers['content-type']
  const contentType = (Array.isArray(header) ? header[0] : header) ?? ''
  if (contentType) return contentType.split(';')[0].trim().toLowerCase() === 'application/json'
  const lengthHeader = request.headers['content-length']
  const length = (Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader) ?? ''
  const chunked = request.headers['transfer-encoding'] !== undefined
  return !chunked && (length.trim() === '' || length.trim() === '0')
}

export type RequestGuardVerdict = { allowed: true } | { allowed: false; reason: 'host' | 'origin' | 'content-type' }/** One-shot evaluation of all three checks for an HTTP request. Host and
 *  Origin apply to EVERY path (the WS upgrade at /ws included — cross-site
 *  handshakes and rebound hosts are refused everywhere); the content-type
 *  rule is scoped to the API because it is about state changes. */
export function evaluateRequestGuard(
  request: IncomingMessage,
  options: { apiPathPrefix: string; extraHostAllowlist: readonly string[]; socketEncrypted: boolean },
): RequestGuardVerdict {
  const hostHeader = request.headers.host ?? ''
  if (!isAllowedRequestHost(hostHeader, options.extraHostAllowlist)) return { allowed: false, reason: 'host' }
  if (!isSameOrigin(request, options.socketEncrypted, hostHeader)) return { allowed: false, reason: 'origin' }
  const url = request.url ?? '/'
  const isApi = url === options.apiPathPrefix || url.startsWith(`${options.apiPathPrefix}/`)
  if (isApi && STATE_CHANGING_METHODS.has((request.method ?? 'GET').toUpperCase()) && !hasJsonBodyContentType(request)) {
    return { allowed: false, reason: 'content-type' }
  }
  return { allowed: true }
}
