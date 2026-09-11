#!/usr/bin/env python3
"""Binary gates for a four-systems build. No opinions, no scores — pass or fail.

    python3 check.py index.html

A skill that never fails a build is a skill that never caught anything.
Expect the first run to fail.
"""
import re
import sys
import pathlib

FAILS, WARNS = [], []


def fail(gate, msg):
    FAILS.append((gate, msg))


def warn(gate, msg):
    WARNS.append((gate, msg))



def _init_opts(html):
    """The real MagicCopy.init call, not the one inside the doc comment.

    The engine's own header comment contains a `MagicCopy.init({` example. A naive
    find() lands there and parses prose as config, which silently disables every
    check below it. Anchor on newline + spaces so the comment's " *   " prefix
    cannot match.
    """
    m = re.search(r'\n[ \t]*MagicCopy\.init\(\{', html)
    if not m:
        return None
    tail = html[m.start():]
    end = tail.find('});')
    return tail[:end if end > 0 else len(tail)]


def check(html, path):
    root = pathlib.Path(path).parent

    # ---- structure: four views + a working switcher -------------------------
    for vid in ('view-site', 'view-ds', 'view-gfx', 'view-copy'):
        if f'id="{vid}"' not in html:
            fail('structure', f'missing view #{vid}')
    for tab in ('tab-site', 'tab-ds', 'tab-gfx', 'tab-copy'):
        if f'id="{tab}"' not in html:
            fail('structure', f'missing switcher button #{tab}')
    if 'id="dockToggle"' not in html:
        fail('structure', 'the dock has no collapse toggle')
    if not re.search(r'\.dock\{[^}]*position:fixed', html):
        fail('structure', 'the dock is not fixed-position')

    # ---- markup integrity ---------------------------------------------------
    depth = dips = 0
    for m in re.finditer(r'<div\b|</div>', html):
        depth += 1 if m.group().startswith('<div') else -1
        if depth < 0:
            dips += 1
    if depth:
        fail('markup', f'unbalanced <div>: final depth {depth:+d}')
    if dips:
        fail('markup', f'{dips} stray closing </div>')
    if html.count('<script') != html.count('</script>'):
        fail('markup', 'unbalanced <script> tags')

    # ---- motion law: scroll is the only clock -------------------------------
    # Scoped to the WEBSITE view on purpose. The Graphics tab demos the reveal
    # verbs looping, and a UI-state affordance (a "you are here" halo, a spinner)
    # is legitimate chrome. The law governs the marketing page, not the manuals.
    site_view = html[html.find('id="view-site"'):html.find('id="view-ds"')]
    looped = {cls for cls, _ in
              re.findall(r'\.([a-zA-Z-]+)\s*\{[^}]*animation:\s*([a-zA-Z-]+)[^;]*infinite', html)}
    running = sorted(c for c in looped if re.search(rf'class="[^"]*\b{re.escape(c)}\b', site_view))
    if running:
        fail('motion', f'idle animation loops on the website: {running} — '
                       'motion must be driven by scroll')
    if '__scrollStep' not in html:
        fail('motion', 'the scroll engine is missing')
    if 'prefers-reduced-motion' not in html:
        fail('motion', 'no prefers-reduced-motion guard')

    # ---- reveal system ------------------------------------------------------
    if re.search(r'\.rise\.in\{[^}]*transform:none', html):
        fail('reveal', '.rise.in sets transform:none — it will delete any '
                       'centering transform. Reveal on translate/scale instead.')

    # ---- level 3: every shipping asset is inventoried -----------------------
    site = html.split('id="view-ds"')[0]
    gfx_start = html.find('id="view-gfx"')
    gfx = html[gfx_start:html.find('id="view-copy"')] if gfx_start > 0 else ''
    site_assets = set(re.findall(r'src="(img/[^"?]+)', site))
    site_assets = {a for a in site_assets if '/layers/' not in a}
    gfx_assets = set(re.findall(r'src="(img/[^"?]+)', gfx))
    missing = sorted(site_assets - gfx_assets)
    if missing:
        fail('graphics', f'{len(missing)} website asset(s) never appear in the '
                         f'Graphics inventory: {missing[:4]}')

    # ---- level 3: fonts carry attribution + the licence FYI -----------------
    if gfx:
        if not re.search(r'licen[cs]e', gfx, re.I):
            fail('fonts', 'the type set carries no licence notice — '
                          'see references/fonts-and-licensing.md')
        faces = re.findall(r'font-family:\s*[\'"]([A-Z][A-Za-z ]+)[\'"]', gfx)
        if faces and not re.search(r'Google Fonts|Fontshare|foundry|OFL|Open Font',
                                   gfx, re.I):
            fail('fonts', 'font candidates listed without foundry/source attribution')

    # ---- level 4: the toggle is wired ---------------------------------------
    if 'MagicCopy' not in html:
        fail('copy', 'the magic-copy engine is missing')
    elif _init_opts(html) is None:
        fail('copy', 'magic-copy is never initialised')
    else:
        block = _init_opts(html)
        variants = re.findall(r"'([.#][^']+)':", block)
        if len(variants) < 3:
            fail('copy', f'only {len(variants)} magic-copy variant(s) — '
                         'the toggle should rewrite the page, not one line')
        if 'TODO' in block:
            fail('copy', 'magic-copy variants still contain TODO placeholders')

    # ---- level 4: the toggle must be REACHABLE, not just present -------------
    # The engine can be perfectly wired and still have no way to fire it. That
    # shipped once: button:false, no hotkey, and no control in the Copy tab.
    opts = _init_opts(html)
    if opts is not None:
        floating = not re.search(r'button:\s*false', opts)
        hotkey = not re.search(r'hotkey:\s*false', opts) and 'hotkey' in opts
        wired = "getElementById('copy-toggle')" in html
        if not (floating or hotkey or wired):
            fail('copy', 'the magic-copy toggle has no reachable control — '
                         'button:false, no hotkey, and nothing wired to #copy-toggle')

    # ---- level 4: no invented proof -----------------------------------------
    proof = re.findall(r'([\d,]{3,})\s*(?:\+\s*)?(?:early |happy |active )?'
                       r'(?:learners|users|customers|teams|students|members|downloads)',
                       html, re.I)
    if proof:
        fail('copy', f'looks like invented social proof: {proof[:3]} — '
                     'never claim numbers the product has not earned')

    # ---- unfinished work -----------------------------------------------------
    todos = len(re.findall(r'TODO', html))
    if todos:
        fail('finish', f'{todos} TODO marker(s) left in the page')
    for src in set(re.findall(r'src="(img/[^"?]+)', html)):
        if not (root / src).exists():
            fail('assets', f'broken asset reference: {src}')

    # ---- soft signals --------------------------------------------------------
    # Level 1 requires 3+ references synthesised, not one cloned. The steal list
    # belongs in the System tab. Warned rather than failed: it is prose, and people
    # word it a dozen ways — a flaky hard gate just teaches people to ignore the tool.
    ds_start = html.find('id="view-ds"')
    ds = html[ds_start:html.find('id="view-gfx"')] if ds_start > 0 else ''
    if ds and not re.search(r'came from|steal list|references?|lineage|influenc', ds, re.I):
        warn('lineage', 'the System tab does not say where the design came from — '
                        'add a "where this came from" panel naming 3+ references '
                        'and what was taken from each')

    if 'contrast' not in html.lower() and ':1' not in html:
        warn('system', 'no measured contrast ratios found in the palette panel')
    if not re.search(r'aria-label|role="tablist"', html):
        warn('a11y', 'switcher has no aria labelling')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    p = sys.argv[1]
    check(pathlib.Path(p).read_text(), p)

    for gate, msg in WARNS:
        print(f'  warn  [{gate}] {msg}')
    for gate, msg in FAILS:
        print(f'  FAIL  [{gate}] {msg}')

    print()
    if FAILS:
        print(f'{len(FAILS)} gate(s) failed. Not shippable.')
        sys.exit(1)
    print(f'All gates passed{f" ({len(WARNS)} warning(s))" if WARNS else ""}. Ship it.')
