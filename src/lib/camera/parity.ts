/**
 * Python output-parity helpers for the camera compiler port (task ving89w).
 *
 * The upstream compiler is Python (NyckM/3d-Camera-control-H3-Minimax,
 * camera.py / motion.py @ 846880de859959e801b2c506dc424bd5c8b5c6c4, v19.1,
 * Apache-2.0). Its prompts are f-strings and json.dumps output, so a faithful
 * port must reproduce CPython's number formatting byte-for-byte.
 *
 * The subtle part is TIES: CPython's float formatting (:g, :.Nf) rounds the
 * EXACT decimal value of the double with banker's rounding, while JS toFixed
 * / toPrecision break exact ties upward. Exact ties are reachable here —
 * e.g. start_s = 0.5 × 5.125 s = 2.5625 formats as '2.562' in Python and
 * '2.563' with toFixed. So all prompt-path formatting goes through the
 * BigInt exact-decimal machinery below (a double is always m·2^e, an exact
 * finite decimal) and rounds half-even, exactly like CPython.
 */

// NOTE: no `**` on BigInt in this file — the VM test harness transpiles to
// an ES3-ish target where TS downlevels `**` to Math.pow, which throws on
// BigInt. bigPow is the explicit loop.
function bigPow(base: bigint, exp: number | bigint): bigint {
  let result = 1n
  let n = typeof exp === 'bigint' ? exp : BigInt(exp)
  while (n > 0n) {
    if (n & 1n) result *= base
    base *= base
    n >>= 1n
  }
  return result
}

/** |x| as an exact finite decimal: value = digits · 10^-scale. */
interface ExactDecimal {
  digits: bigint
  scale: bigint
}

function exactDecimal(abs: number): ExactDecimal {
  const buf = new DataView(new ArrayBuffer(8))
  buf.setFloat64(0, abs)
  // setFloat64/getUint32 both default to big-endian per spec, so the word
  // split is host-independent: bytes 0–3 carry sign/exponent/mantissa-high.
  const hi = buf.getUint32(0)
  const lo = buf.getUint32(4)
  const exponentBits = (hi >>> 20) & 0x7ff
  let mantissa: bigint
  let exponent: number
  if (exponentBits === 0) {
    mantissa = BigInt(hi & 0xfffff) * 4294967296n + BigInt(lo)
    exponent = -1074
  } else {
    mantissa = BigInt(hi & 0xfffff) * 4294967296n + BigInt(lo) + 4503599627370496n
    exponent = exponentBits - 1075
  }
  if (exponent >= 0) return { digits: mantissa << BigInt(exponent), scale: 0n }
  // m·2^-k = m·5^k·10^-k — the decimal expansion is exact and finite.
  const k = -exponent
  return { digits: mantissa * bigPow(5n, k), scale: BigInt(k) }
}

/** Round the exact decimal half-even at the 10^pos place (pos may be
 *  negative): result = kept · 10^pos with kept an integer. The kept unit
 *  count is V·10^-pos = digits · 10^-(scale+pos), hence the cut exponent. */
function roundAt(exact: ExactDecimal, pos: bigint): { kept: bigint; scale: bigint } {
  const cut = exact.scale + pos
  if (cut <= 0n) {
    // Nothing to drop; pad the representation out to pos (kept units).
    return { kept: exact.digits * bigPow(10n, -cut), scale: pos }
  }
  const divisor = bigPow(10n, cut)
  const dropped = exact.digits % divisor
  let kept = exact.digits / divisor
  const half = divisor / 2n
  if (dropped > half || (dropped === half && kept % 2n === 1n)) kept += 1n
  return { kept, scale: pos }
}

function decimalExponent(exact: ExactDecimal): bigint {
  // value = 0.D1D2… · 10^E with D1 ≠ 0  →  E = digitCount − scale.
  return BigInt(exact.digits.toString().length) - exact.scale
}

/** Python f'{x:.Nf}' — correctly rounded, banker's on exact ties, and a
 *  negative zero or a negative underflow keeps its sign ('-0.000'). */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return 'nan'
  const neg = Object.is(x, -0) || x < 0
  const exact = exactDecimal(Math.abs(x))
  const { kept } = roundAt(exact, -BigInt(digits))
  const divisor = bigPow(10n, digits)
  const intPart = kept / divisor
  const fracPart = kept % divisor
  const body = digits > 0
    ? `${intPart}.${fracPart.toString().padStart(digits, '0')}`
    : `${intPart}`
  // Python keeps the sign even when everything rounds away ('-0.000').
  return neg ? `-${body}` : body
}

/** Python f'{x:g}' — %g with the default precision of 6: round to six
 *  significant digits, then fixed notation when the decimal exponent X
 *  (= floor(log10|v|), computed from the ROUNDED value so a carry like
 *  999999.6 → 1e+06 switches style) satisfies -4 <= X < 6, exponential
 *  otherwise; trailing zeros stripped in both forms; minimum two exponent
 *  digits. */
export function pyFormatG(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const neg = x < 0
  const exact = exactDecimal(Math.abs(x))
  // decimalExponent is E with v = 0.D1D2…·10^E (D1 ≠ 0); %g's X = E − 1.
  let xExp = decimalExponent(exact) - 1n
  // Six significant digits: last kept place is 10^(X−5).
  const rounded = roundAt(exact, xExp - 5n)
  let mantissa = rounded.kept.toString()
  if (mantissa.length > 6) {
    // Carry grew the digit count (999999.6 → 1000000): X moves up one and
    // the trailing zero of the carry drops off the significant digits.
    mantissa = mantissa.slice(0, -1)
    xExp += 1n
  }
  if (xExp < -4n || xExp >= 6n) {
    let head = mantissa[0]
    const rest = mantissa.slice(1).replace(/0+$/, '')
    if (rest) head += `.${rest}`
    const absE = xExp < 0n ? -xExp : xExp
    const expText = `${xExp < 0n ? '-' : '+'}${absE < 10n ? '0' : ''}${absE}`
    return `${neg ? '-' : ''}${head}e${expText}`
  }
  // Fixed: X + 1 integer digits, then strip trailing zeros.
  const intDigits = Number(xExp) + 1
  let text: string
  if (intDigits <= 0) {
    text = `0.${'0'.repeat(-intDigits)}${mantissa}`
  } else if (intDigits >= mantissa.length) {
    text = mantissa.padEnd(intDigits, '0')
  } else {
    text = `${mantissa.slice(0, intDigits)}.${mantissa.slice(intDigits)}`
  }
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return neg ? `-${text}` : text
}

/** CPython round() for digits === 0 — banker's rounding (ties to even). */
function pyRoundHalfEven0(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** CPython round(x, digits). For digits >= 1 an exact binary tie at the
 *  decimal digit is impossible (a tie would require the double to equal
 *  (2k+1)/(2·10^digits), which is never dyadic), so the tie rule never fires
 *  and toFixed — correctly rounded on the exact double value per spec —
 *  matches Python. Digits 0 keeps the banker's rule. */
export function pyRound(x: number, digits = 0): number {
  if (digits === 0) return pyRoundHalfEven0(x)
  return Number.parseFloat(x.toFixed(digits))
}

/** CPython repr() of a float — shortest round-trip text, with the switches
 *  Python makes: whole values inside ±1e16 keep a trailing '.0', and
 *  magnitudes below 1e-4 (or at/above 1e16) go exponential with a
 *  minimum-two-digit exponent. json.dumps uses this rendering. */
export function pyFloatRepr(x: number): string {
  // Python repr(-0.0) is '-0.0'; JS String(-0) is '0'. The mirroring sign
  // flip (azimuth * -1) produces negative zeros, so this is reachable.
  if (Object.is(x, -0)) return '-0.0'
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`
  if (x !== 0 && (Math.abs(x) < 1e-4 || Math.abs(x) >= 1e16)) {
    const parts = x.toExponential().split('e')
    const exp = Number.parseInt(parts[1], 10)
    const absExp = Math.abs(exp)
    return `${parts[0]}e${exp < 0 ? '-' : '+'}${absExp < 10 ? '0' : ''}${absExp}`
  }
  return String(x)
}

/** Python str.replace — replaces every occurrence (String.replace with a
 *  string pattern replaces only the first). */
export function replaceAll(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement)
}

/** Python repr() of a scalar for the `Unknown option {value!r}` messages. */
export function pyRepr(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  return String(value)
}

const PYJSON_INT_KEYS: ReadonlySet<string> = new Set([
  // Numbers the upstream leaves as Python ints inside otherwise-float
  // documents (options / storyboard / source / diagnostics). Everything
  // numeric that flows through validate_path is float()-coerced upstream, so
  // float rendering is the default and these keys are the only int sites.
  'coverage_views', 'coverage_hold_frames', 'semantic_resolution', 'input_frames',
  'reference_frames', 'freeze_index', 'segment',
])

/** Serialize like json.dumps(value, ensure_ascii=False, indent=2): 2-space
 *  indent, ", "/": " separators, insertion-ordered keys, Python float repr.
 *  intKeys is injectable for tests; production documents use the upstream
 *  int-key set above. */
export function pyJsonStringify(value: unknown, intKeys: ReadonlySet<string> = PYJSON_INT_KEYS): string {
  const write = (node: unknown, key: string | null, depth: number): string => {
    const pad = '  '.repeat(depth)
    const innerPad = '  '.repeat(depth + 1)
    if (node === null || node === undefined) return 'null'
    if (typeof node === 'boolean') return node ? 'true' : 'false'
    if (typeof node === 'number') {
      return key !== null && intKeys.has(key) && Number.isInteger(node)
        ? String(node) : pyFloatRepr(node)
    }
    if (typeof node === 'string') return JSON.stringify(node)
    if (Array.isArray(node)) {
      if (node.length === 0) return '[]'
      const items = node.map((item) => write(item, key, depth + 1))
      return `[\n${items.map((item) => `${innerPad}${item}`).join(',\n')}\n${pad}]`
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
      if (entries.length === 0) return '{}'
      const items = entries.map(([k, v]) => `${innerPad}${JSON.stringify(k)}: ${write(v, k, depth + 1)}`)
      return `{\n${items.join(',\n')}\n${pad}}`
    }
    return 'null'
  }
  return write(value, null, 0)
}
