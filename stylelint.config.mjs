import fs from 'node:fs'
import path from 'node:path'
import stylelint from 'stylelint'

/**
 * Studio lint stack — CSS half of `pnpm lint` (eslint owns JS/TS).
 *
 * Two layers, both signal-only:
 *  1. stylelint-config-standard — syntax correctness and genuine foot-guns.
 *  2. minimax/no-raw-colors (custom, below) — design-token discipline: color
 *     values in declarations must go through var(--token) (the wave-2b token
 *     system in src/styles.css :root). Raw literals are allowed ONLY in
 *     token definitions (custom properties) and on the documented allowlist
 *     (secondary.allow) — every entry there states why it is a one-off.
 *
 * Rules from the standard config that only fight the codebase's established
 * patterns are disabled BELOW with a comment stating why (documented
 * suppression, not silent).
 */

// CSS named colors (basic extended set) — matched with word boundaries.
const NAMED_COLOR_SOURCE = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
  'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue',
  'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink', 'indianred',
  'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime',
  'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue', 'mediumorchid', 'mediumpurple',
  'mediumseagreen', 'mediumslateblue', 'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown',
  'salmon', 'sandybrown', 'seagreen', 'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet',
  'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
]
const NAMED_COLOR = new RegExp(`\\b(?:${NAMED_COLOR_SOURCE.join('|')})\\b`, 'i')
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/
const COLOR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/i

// Wave-2b blessed one-off literals (exact property+value matches), generated
// from the first full-tree audit — see scripts/stylelint-raw-color-allowlist.json.
const allowlistPath = path.resolve(import.meta.dirname, 'scripts', 'stylelint-raw-color-allowlist.json')
// Normalized to postcss's view of a value (!important is parsed out of
// Declaration#value, so allowlist entries match with or without it).
const rawColorAllow = (JSON.parse(fs.readFileSync(allowlistPath, 'utf8')).allow)
  .map((entry) => ({ ...entry, value: entry.value.replace(/\s*!important$/, '') }))

const noRawColors = stylelint.createPlugin('minimax/no-raw-colors', (primary, secondary) => (root, result) => {
  if (!primary) return
  // Documented one-offs: the committed JSON inventory plus any { property,
  // value, reason } entries passed via the rule's secondary `allow` option.
  const allow = [...rawColorAllow, ...(Array.isArray(secondary?.allow) ? secondary.allow : [])]
  root.walkDecls((decl) => {
    if (decl.prop.startsWith('--')) return // token definitions live in :root by design
    const value = decl.value
    if (value.includes('var(')) return // token-composed (incl. color-mix over tokens)
    if (value.trim() === 'transparent') return // no token needed for full transparency
    if (!HEX_COLOR.test(value) && !COLOR_FUNCTION.test(value) && !NAMED_COLOR.test(value)) return
    if (allow.some((entry) => entry.property === decl.prop && entry.value === value.trim())) return
    stylelint.utils.report({
      ruleName: 'minimax/no-raw-colors',
      result,
      node: decl,
      message: `Use a design token (var(--…)) for the color in "${decl.prop}"; raw literals need a documented allowlist entry in stylelint.config.mjs (got: "${value.trim().slice(0, 48)}").`,
    })
  })
})

export default {
  plugins: [noRawColors],
  extends: ['stylelint-config-standard'],
  rules: {
    'minimax/no-raw-colors': true,

    // ---- Documented suppressions (rules that only fight house style) ----
    // The stylesheets are deliberately written as dense SINGLE-LINE rules
    // (multiple declarations per line) — the format predates this lint and is
    // uniform across src/styles.css and src/guided-studio.css. Enforcing
    // one-declaration-per-line formatting on ~2000 lines is pure churn.
    'declaration-block-single-line-max-declarations': null,
    'rule-empty-line-before': null,
    'at-rule-empty-line-before': null,
    'declaration-empty-line-before': null,
    'custom-property-empty-line-before': null,
    'comment-empty-line-before': null,
    // The house color notation is legacy rgba()/hex with fractional alpha
    // (rgba(198,255,78,.34)); rewriting to rgb()/modern syntax/percentage
    // alphas would touch hundreds of values for zero rendering change.
    'color-function-notation': null,
    'color-function-alias-notation': null,
    'alpha-value-notation': null,
    // Media queries use the (min-width: Npx) prefix form throughout.
    'media-feature-range-notation': null,
    // Overrides are expressed as intentional later re-definitions of the same
    // selector (including a second :root token block) — cascade order is the
    // house mechanism; the rule reads every one of them as a defect.
    'no-duplicate-selectors': null,
    // Selector order follows DOM/feature grouping, not ascending specificity;
    // the rule's ordering mandate conflicts with that layout at scale.
    'no-descending-specificity': null,
    // overflow-x/overflow-y longhands (often with MIXED values) are the house
    // pattern for scroll containers — explicit axes over shorthand push.
    'declaration-block-no-redundant-longhand-properties': null,
  },
}
