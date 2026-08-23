#!/usr/bin/env node
/**
 * The boost modal's component body, checked for bindings read before they are
 * declared.
 *
 * ⚠️ IT EXISTS BECAUSE ONE OF THESE REACHED PRODUCTION AND WAS INVISIBLE UNTIL
 * A REAL PAYMENT WAS IN FLIGHT. `paySeconds` read `payTick` about thirty lines
 * above its `useState`, which is a temporal dead zone — but the read sits
 * inside a ternary, `payingLeg?.startedAt ? (… payTick …) : 0`, so the branch
 * is only evaluated once a leg is actually paying. The form rendered, the done
 * screen rendered, every test passed, and then a live boost threw
 * `Cannot access 'payTick' before initialization` **during render**, about a
 * second in.
 *
 * What that costs is out of proportion to the typo, which is why this is worth
 * a script of its own. A render error with no boundary above it **unmounts the
 * React root**: the modal vanishes mid-payment, the payment completes anyway
 * because its promise is detached, no note is ever published because `phase`
 * never reaches 'done', and the page's Boost button is dead until a reload
 * because the host root no longer exists. Four unrelated-looking symptoms, one
 * missing line-order.
 *
 * ⚠️ THIS REPO HAS NO LINTER. `no-use-before-define` would catch this class in
 * one rule, and adding eslint to `login-widget/` is the better fix if anyone
 * ever wants it. Until then this scan is the whole defence, so **keep it
 * pointed at every component that renders during a payment**.
 *
 * ⚠️ IT IS A TEXT SCAN, NOT AN EXECUTION. A real render test would need jsdom
 * (state has to advance past 'form' before the crashing branch is reachable,
 * and `renderToString` runs no effects), which is a dependency this repo does
 * not have. The scan cannot see everything a renderer would; what it does see
 * is the exact failure that got us here, cheaply, with no new dependency.
 *
 * Run: node scripts/test-boost-modal-render.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Every component that renders while a leg is in flight. A crash in any of
// these takes the widget root down mid-payment.
const TARGETS = [
  ['login-widget/src/components/ExternalBoostModal.jsx', 'export default function ExternalBoostModal'],
]

let passed = 0
function ok(label) { passed++; console.log(`  ✓ ${label}`) }

/**
 * Top-level `const`/`let` bindings of one function body, in source order.
 * Anchored to two-space indentation, which is the component body's own level:
 * a binding nested inside a callback or a block has its own scope and cannot
 * be the subject of this check.
 */
function topLevelBindings(body) {
  const decl = /^ {2}(?:const|let) (?:\[\s*([A-Za-z0-9_]+)\s*,\s*[A-Za-z0-9_$]+\s*\]|([A-Za-z0-9_]+))\s*=/gm
  const out = []
  let m
  while ((m = decl.exec(body))) out.push({ name: m[1] || m[2], at: m.index })
  return out
}

/** Reads of `name` in `text`, ignoring comment lines and property accesses. */
function readsOf(name, text) {
  const re = new RegExp(`(?<![A-Za-z0-9_.$])${name}(?![A-Za-z0-9_])`, 'g')
  return [...text.matchAll(re)].filter((hit) => {
    const lineStart = text.lastIndexOf('\n', hit.index) + 1
    const lineEnd = text.indexOf('\n', hit.index)
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    // JSDoc and `//` lines name these bindings constantly and mean nothing by
    // it. This is the one heuristic in here; a binding named only in prose
    // above its declaration is not a use.
    return !/^\s*(\*|\/\/|\/\*)/.test(line)
  })
}

console.log('\nNo binding is read before it is declared:')
for (const [file, anchor] of TARGETS) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const start = src.indexOf(anchor)
  assert.notEqual(start, -1, `${file}: could not find "${anchor}" — was the component renamed?`)
  const body = src.slice(start)

  const offenders = []
  for (const { name, at } of topLevelBindings(body)) {
    const hits = readsOf(name, body.slice(0, at))
    if (hits.length) {
      const line = body.slice(0, hits[0].index).split('\n').length
      const declLine = body.slice(0, at).split('\n').length
      offenders.push(`${name} — read at body line ${line}, declared at ${declLine}`)
    }
  }
  assert.deepEqual(offenders, [], `${file}: temporal dead zone(s)\n  ${offenders.join('\n  ')}`)
  ok(`${file.split('/').pop()} (${topLevelBindings(body).length} bindings checked)`)
}

// ⚠️ THE SCAN IS ONLY WORTH ANYTHING IF IT STILL DETECTS THE ORIGINAL BUG.
// A regex that quietly stops matching passes forever, which is the failure
// mode of every text-based check. So it is fed the shape it was written for.
console.log('\nThe scan still catches the bug it was written for:')
const REGRESSION = `export default function Thing() {
  const legs = []
  const paying = legs[0]
  const seconds = paying?.startedAt
    ? Math.floor(((payTick || Date.now()) - paying.startedAt) / 1000)
    : 0
  const [payTick, setPayTick] = useState(0)
  return seconds
}`
{
  const body = REGRESSION.slice(REGRESSION.indexOf('export default function Thing'))
  const caught = topLevelBindings(body)
    .filter(({ name, at }) => readsOf(name, body.slice(0, at)).length)
    .map((b) => b.name)
  assert.deepEqual(caught, ['payTick'], 'the scan no longer detects the shipped bug')
  ok('the payTick shape is still detected')
}
{
  // And the other direction: a binding merely NAMED in a comment above its
  // declaration is not a use, or every documented constant would fail.
  const body = `export default function Thing() {
  // \`later\` is explained here, above where it lives.
  const first = 1
  const later = 2
  return first + later
}`.slice(0)
  const caught = topLevelBindings(body)
    .filter(({ name, at }) => readsOf(name, body.slice(0, at)).length)
  assert.deepEqual(caught, [], 'a comment mentioning a binding must not count as a read')
  ok('a binding named in a comment above itself is not a use')
}

// ─── The theme actually reaches the page ───────────────────────────────────
/**
 * ⚠️ A TAILWIND ARBITRARY VALUE THAT TAILWIND CANNOT CLASSIFY EMITS THE WRONG
 * PROPERTY, SILENTLY, AND THE BUILD SAYS NOTHING. Caught while shipping the
 * light theme: `font-[var(--font-display)]` compiled to
 * `font-weight: var(--font-display)` — Tailwind cannot tell a family from a
 * weight in a bare `font-[…]`, guessed weight, and produced a declaration the
 * browser then ignored. Every heading was in the default sans and every class
 * name in the markup looked correct. `font-[family-name:var(--font-display)]`
 * is the fix, and the same trap sits on `ring-`, `text-` and `bg-` wherever a
 * value could be read as a length or a colour.
 *
 * So the check is on the OUTPUT, not the source: for each token the modals
 * depend on, assert the built bundle carries a rule that actually sets it.
 * The CSS is injected as a JS string, so its selector escapes are doubled;
 * matching on the declaration side avoids that entirely.
 */
console.log('\nThe themed classes emit real CSS:')
{
  const bundle = readFileSync(new URL('../assets/widgets/login-widget.js', import.meta.url), 'utf8')
  // [css property, token] — the pair that has to appear together in the built
  // CSS. Kept as pairs rather than as one string because `--tw-ring-color` has
  // a space after its colon and the minifier trims `0.55` to `.55`, so any
  // exact-string form passes today and rots on the next build.
  const REQUIRED = [
    ['background-color', '--modal-bg'],
    ['background-color', '--modal-field'],
    ['background-color', '--modal-inset'],
    ['background-color', '--brand'],
    ['background-color', '--brand-tint'],
    ['background-color', '--scrim'],
    ['color', '--ink'],
    ['color', '--muted'],
    ['color', '--ok'],
    ['color', '--warn'],
    ['color', '--danger'],
    ['border-color', '--border'],
    ['accent-color', '--brand'],
    // The two that compiled wrong once. Family, not weight; ring COLOUR, not width.
    ['font-family', '--font-display'],
    ['--tw-ring-color', '--brand-ring'],
  ]
  const missing = REQUIRED.filter(([prop, token]) =>
    !new RegExp(`${prop}:\\s*var\\(${token}[,)]`).test(bundle))
  assert.deepEqual(missing.map(([p, t]) => `${p}:var(${t})`), [],
    'the built widget emits no rule for the above')
  ok(`${REQUIRED.length} declarations present in the built bundle`)

  // And the wrong-property version must not come back.
  assert.equal(bundle.includes('font-weight:var(--font-display)'), false,
    'font-[var(--font-display)] is compiling to font-weight again — it needs the family-name hint')
  ok('no token is being applied as the wrong property')

  /**
   * ⚠️ THE SECOND SILENT-FAILURE SHAPE, FOUND THE SAME WAY: Tailwind cannot
   * apply an opacity modifier to an arbitrary `var()` colour. `border-[var(--
   * brand)]/40` emits **nothing at all** — not a wrong property this time, just
   * no rule — so the element falls back to `currentColor` and the build says
   * nothing. Five of these had crept in across the modals.
   *
   * There is no way to express it in the token, so the rule is: an alpha on a
   * var is a literal `rgba()` or a different token. This scan is what enforces
   * it, since neither Tailwind nor the bundler will.
   */
  const ALPHA_ON_VAR = /(?:bg|text|border|ring|divide|from|to|via)-\[var\(--[a-z-]+\)\]\/\d/
  const styled = [
    'ExternalBoostModal', 'WalletConnectModal', 'LoginModal', 'LoginScreen', 'BoostModal',
    'MultiLegBoostForm', 'BugReportModal', 'ConfirmLeaveOverlay', 'ModalErrorBoundary',
    'IdentityDropdown', 'BoostProgressView', 'BoostExpectations', 'ToastHost', 'LoginButton',
  ]
  const offenders = []
  for (const name of styled) {
    const text = readFileSync(new URL(`../login-widget/src/components/${name}.jsx`, import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const hit = line.match(ALPHA_ON_VAR)
      if (hit) offenders.push(`${name}: ${hit[0]}`)
    }
  }
  assert.deepEqual(offenders, [], `an opacity modifier on a var() colour emits no CSS:\n  ${offenders.join('\n  ')}`)
  ok('no class applies an alpha to a var() colour')

  /**
   * ⚠️ EVERY `var()` IN THE WIDGET CARRIES A LITERAL FALLBACK, AND AN INVISIBLE
   * MODAL IS WHY.
   *
   * The widget's colours live in `assets/css/theme.css`, a file it does not
   * control and cannot version together with itself. `scripts/stamp-assets.js`
   * gives every asset URL a `?v=` so one version of one file can never meet
   * another — except that **`assets/widgets/` files are stamped at the
   * reference site and never rewritten**, so `login-widget.js?v=ob-v94` and
   * `?v=ob-v95` are the same file on disk and the server hands back the current
   * build for either. A browser holding `theme.css?v=ob-v94` in its four-hour
   * HTTP cache while fetching the widget fresh therefore gets **a new widget
   * against an old stylesheet**, which is precisely the `ob-v53` class of
   * failure the stamper exists to prevent, arriving through the one door it
   * cannot close.
   *
   * An undefined custom property makes the whole declaration invalid at
   * computed-value time, so `background-color: var(--modal-bg)` resolves to
   * **transparent**. Observed 2026-08-21: the boost modal rendered as a
   * near-invisible outline over the dimmed page, mid-payment-flow.
   *
   * The fallbacks are mirrors, not a second source of truth: this assertion
   * reads `theme.css` and requires each one to equal the token's current value,
   * so editing the palette without re-running the mirror fails here.
   */
  const themeCss = readFileSync(new URL('../assets/css/theme.css', import.meta.url), 'utf8')
  const rootBlock = themeCss.slice(themeCss.indexOf('\n:root {'))
  const declared = {}
  for (const m of rootBlock.slice(0, rootBlock.indexOf('\n}')).matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    declared[m[1]] = m[2].replace(/\s+/g, '')
  }
  // ⚠️ THE FONT TOKENS MIRROR TOO, VIA THE UNDERSCORE. Tailwind converts `_` to
  // a space inside an arbitrary value, so `'Playfair_Display'` compiles to the
  // real family — which matters, because the earlier `Georgia,serif` fallback
  // meant a stale theme.css rendered every heading in a face this site uses
  // nowhere. Reported as "some weird font we dont use anywhere". Both sides are
  // stripped of `_` before comparing so the mirror still holds.
  const unspace = (v) => v.replace(/_/g, '')

  const bare = []
  const wrong = []
  for (const name of styled) {
    const text = readFileSync(new URL(`../login-widget/src/components/${name}.jsx`, import.meta.url), 'utf8')
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) bare.push(`${name}: var(${m[1]})`)
    // ⚠️ A BALANCED WALK, NOT A REGEX. A fallback can be `rgba(0,175,240,0.32)`,
    // and `[^)]*` stops at the FIRST `)` — which reports every nested-paren
    // fallback as drifted while quoting a value identical to the one it is
    // compared against. That is a test failing on its own parser, which is the
    // most expensive kind of red.
    for (const m of text.matchAll(/var\((--[a-z0-9-]+),/g)) {
      const token = m[1]
      let i = m.index + m[0].length
      let depth = 1
      while (i < text.length && depth > 0) {
        if (text[i] === '(') depth++
        else if (text[i] === ')') { depth--; if (depth === 0) break }
        i++
      }
      const fallback = text.slice(m.index + m[0].length, i)
      if (declared[token] === undefined) { wrong.push(`${name}: ${token} is not in theme.css`); continue }
      if (unspace(declared[token]) !== unspace(fallback)) {
        wrong.push(`${name}: ${token} falls back to ${fallback}, theme.css says ${declared[token]}`)
      }
    }
  }
  assert.deepEqual(bare, [], `a var() with no fallback renders TRANSPARENT against a stale theme.css:\n  ${bare.join('\n  ')}`)
  ok('every var() in the widget carries a fallback')
  assert.deepEqual(wrong, [], `a fallback has drifted from theme.css:\n  ${wrong.join('\n  ')}`)
  ok('every fallback still equals its token in theme.css')

  /**
   * ⚠️ WITHOUT THIS, EVERY BORDER IN THE WIDGET DRAWS NOTHING. Tailwind's
   * `border` utility sets `border-width` only; the `border-style: solid` comes
   * from preflight, which is off here so the bundle cannot reset the host page.
   * `border-width: 1px` over CSS's initial `border-style: none` renders no
   * line, and `border-style` appeared nowhere in the built bundle at all.
   *
   * It survived the dark theme because those surfaces differ by fill. On the
   * light theme the borders carry all the definition, so their absence
   * flattened every modal into one pale rectangle — reported as "these colors
   * and lines all washout", which was right except that the lines were never
   * drawn. `login-widget/src/styles.css` restores it in a scoped base layer.
   */
  assert.equal(bundle.includes('border-style:solid'), true,
    'the base layer in styles.css is gone — every border in the widget is invisible')
  ok('borders have a style, so they actually draw')

  /**
   * ⚠️ THE RESET IS SCOPED TO `.lb-w` AND EVERY PORTAL MUST WEAR IT. A portal
   * renders into `document.body`, outside any wrapper, so a `createPortal` that
   * forgets the wrapper puts a modal back in the browser's native form chrome —
   * the "weird button outlines" of 2026-08-21, which were the operating
   * system's own. That reads as a styling bug rather than a missing div, so it
   * is checked here instead of being left to be noticed.
   */
  assert.equal(/:where\(\.lb-w\)/.test(bundle), true,
    'the scoped preflight is gone — every button reverts to native OS chrome')
  ok('the scoped reset is in the bundle')

  /**
   * ⚠️ AND EVERY PORTAL STILL HAS TO BE PASSED A CONTAINER. Adding the wrapper
   * by hand put the closing `</div>` on the wrong side of the comma in **eight
   * of ten** call sites, so `createPortal(<div>…document.body</div>)` received
   * ONE argument and rendered nothing. It is valid JSX — `document.body` simply
   * became text inside the div — so the build was silent, every test passed,
   * and the only symptom was that the Boost button and the nav Log in button
   * stopped opening anything at all.
   *
   * So this walks to the matching paren and counts top-level commas rather than
   * pattern-matching the source, because the broken form and the correct form
   * differ by six characters in the middle of a JSX block.
   */
  const portalFiles = ['index.jsx', 'components/IdentityDropdown.jsx', 'components/ToastHost.jsx', 'components/BoostProgressBanner.jsx']
  const unwrapped = []
  const argless = []
  for (const file of portalFiles) {
    const text = readFileSync(new URL(`../login-widget/src/${file}`, import.meta.url), 'utf8')
    for (const m of text.matchAll(/createPortal\(/g)) {
      let i = m.index + m[0].length
      let depth = 1
      let commas = 0
      while (i < text.length && depth > 0) {
        const c = text[i]
        if ('([{'.includes(c)) depth++
        else if (')]}'.includes(c)) { depth--; if (!depth) break }
        else if (c === ',' && depth === 1) commas++
        i++
      }
      const call = text.slice(m.index, i)
      const line = text.slice(0, m.index).split('\n').length
      if (!call.includes('lb-w')) unwrapped.push(`${file}:${line}`)
      if (commas < 1 || /document\.body<\//.test(call)) argless.push(`${file}:${line}`)
    }
  }
  assert.deepEqual(argless, [], `createPortal called with no container — it renders NOTHING:\n  ${argless.join('\n  ')}`)
  ok('every createPortal is passed a container')
  assert.deepEqual(unwrapped, [], `a portal renders outside the .lb-w scope:\n  ${unwrapped.join('\n  ')}`)
  ok('every createPortal wraps its children in the scope')

  // ⚠️ `:where()` is what keeps the reset at preflight's own specificity. Drop
  // it and `.lb-w button { padding: 0 }` outranks `.py-3`, flattening every
  // button in the widget — a far worse outcome than the bug it was fixing.
  const css = readFileSync(new URL('../login-widget/src/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')   // the prose names `.lb-w` constantly
  const naked = [...css.matchAll(/(?<!:where\()\.lb-w\b/g)].length
  assert.equal(naked, 0,
    `${naked} selector(s) use .lb-w without :where() — the reset now outranks the padding utilities`)
  ok('the reset stays at preflight specificity')

  /* ⚠️ AND THE `.lb-w` CHECK ABOVE IS NOT ENOUGH, BECAUSE AN ATTRIBUTE
   * SELECTOR CARRIES CLASS WEIGHT.
   *
   * `:where(.lb-w) [type='button']` passes that check — the scope IS wrapped —
   * and is still (0,1,0), dead level with `.bg-[var(--brand-dd,#0a6fa8)]`.
   * This file is appended AFTER `@tailwind utilities`, so the tie broke in the
   * reset's favour and `background-color: transparent` won. Every element in
   * the widget carrying an explicit `type="button"` had its `bg-*` utility
   * silently killed, from the day the reset shipped until 2026-08-22. It
   * surfaced as four boost presets rendering at the modal's own background
   * with the picked one white-on-white, and it was reported as a colour bug
   * twice before anyone measured the pixels.
   *
   * So this computes the real specificity of every selector in the scoped
   * reset and demands (0,0,0). `:where()` contributes nothing, which is what
   * makes that reachable. */
  const specificity = (sel) => {
    // :where(...) contributes zero, so remove it and its contents, innermost
    // first, before counting anything.
    let s = sel
    for (let guard = 0; guard < 20; guard++) {
      const next = s.replace(/:where\(([^()]*)\)/g, '')
      if (next === s) break
      s = next
    }
    return {
      a: (s.match(/#[\w-]+/g) || []).length,
      b: (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[/g) || []).length,
    }
  }
  const overweight = []
  for (const [, selector] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    if (!selector.includes('.lb-w')) continue
    // Strip :where() first: its contents may hold the commas that would
    // otherwise split one selector into several.
    let flat = selector
    for (let guard = 0; guard < 20; guard++) {
      const next = flat.replace(/:where\(([^()]*)\)/g, ':where()')
      if (next === flat) break
      flat = next
    }
    for (const part of flat.split(',')) {
      const { a, b } = specificity(part)
      if (a || b) overweight.push(`(0,${b},…) ${part.trim()}`)
    }
  }
  assert.deepEqual(overweight, [], 
    `the scoped reset outranks a Tailwind utility and will silently beat it:\n  ${overweight.join('\n  ')}`)
  ok('no reset selector can outrank a utility class')

  // ⚠️ The bundle is a build artifact. If it is stale the two assertions above
  // pass against yesterday's CSS, so the source is checked to agree with it.
  const src = readFileSync(new URL('../login-widget/src/components/ExternalBoostModal.jsx', import.meta.url), 'utf8')
  assert.equal(/\bbg-neutral-|\btext-neutral-|\bbg-orange-|\btext-amber-400\b/.test(src), false,
    'ExternalBoostModal still carries dark-theme classes — was the widget rebuilt?')
  ok('the boost modal carries no dark-theme classes')
}

// ⚠️ ON LOCAL BITCOINERS THE NAV BUTTON IS "Boost the Show" AND IT OPENS
// `openShowBoost` → `MultiLegBoostForm`, the LB money path (kind-30078
// receipts, boost_session, the bots' claim contract). OnlyBoosts pointed its
// nav at `openSiteDonation` because its tip is a one-leg ExternalBoostModal;
// that wiring does not apply here. Phase 2 of the port grafts the four-outcome
// form and the wallet gate INTO MultiLegBoostForm, so this assertion will
// change shape then — what it must never do is let the nav button silently
// degrade into a login wall via a boot-script fallback. React mounts
// `BoostApp` over `#lb-boost-slot` as soon as the bundle lands, so this is the
// handler that actually runs; `nav-widget-boot.js` governs only the first press.
{
  const src = readFileSync(new URL('../login-widget/src/index.jsx', import.meta.url), 'utf8')
  const m = /function BoostApp\(\)\s*\{([\s\S]*?)\n\}/.exec(src)
  assert.notEqual(m, null, 'BoostApp not found — was it renamed?')
  assert.match(m[1], /api\.openShowBoost\(\)/,
    'the nav Boost button must open the show-boost flow')
  ok('the nav Boost button opens the show-boost flow')
}


// ⚠️ PHASE 2: THE SHOW/EPISODE PATH HAS NO LOGIN GATE AND NO WALLET GATE IN
// THE OPENER. A bare `api.requestLogin()` inside either opener is the old
// login wall coming back; a `wallet.ensureReady` there is the wallet gate in
// front of the form again. Both belong behind the form's own Boost button.
{
  const src = readFileSync(new URL('../login-widget/src/index.jsx', import.meta.url), 'utf8')
  for (const name of ['openShowBoost', 'openEpisodeBoost']) {
    const m = new RegExp(`async ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},`).exec(src)
    assert.notEqual(m, null, `${name} not found`)
    assert.equal(/api\.requestLogin\(\)/.test(m[1]), false, `${name} calls api.requestLogin() — the login wall is back`)
    assert.equal(/wallet\.ensureReady\(/.test(m[1]), false, `${name} runs the wallet gate before the form mounts`)
    assert.match(m[1], /ensureSignerVerified/, `${name} dropped the signer-match gate for a signed-in user`)
  }
  ok('openShowBoost and openEpisodeBoost carry no login or wallet gate')

  const form = readFileSync(new URL('../login-widget/src/components/MultiLegBoostForm.jsx', import.meta.url), 'utf8')
  assert.match(form, /signKindOneWithSite/, 'the form has no site-signed route')
  assert.match(form, /buildShowSiteNoteTemplate/, 'the site-signed route does not use the show template')
  assert.match(form, /signNoteAfterSettle/, 'the site-signed note is not deferred to settlement')
  assert.match(form, /onRequestWallet\?\.\(\)/, 'the form never asks for a wallet')
  assert.match(form, /Private Boost/, 'the Private Boost control is missing')
  assert.equal(/Share to my feed/.test(form), false, 'the old opt-in share checkbox is still there')
  assert.equal(/walletGone/.test(form), false, 'the "wallet not connected" dead-end screen is back')
  // A retry never re-signs a note: the parent boost already (maybe) posted one.
  const retry = /async function handleRetryLeg[\s\S]*?\n  \}\n/.exec(form)
  assert.notEqual(retry, null)
  assert.equal(/signNoteAfterSettle|signedKindOne: [^n]/.test(retry[0]), false, 'a retry would publish a second note')
  ok('MultiLegBoostForm carries the four-outcome form and the site-signed route')
}

console.log(`\n${passed} assertions passed.\n`)
