# Put the actual homepage inside Website OS

Inspect the URL and locate its source. Make a working copy when demonstrating an existing site. Preserve the original homepage's typography, media, motion, layout and interactions. The default Website tab must render that functioning page, not a description of it.

## Static project shape

Use a project root with `project/` for homepage source and assets, `studio/` for the workspace shell, `tools/` for the Python scripts, `workspace.json` for the site's identity and assets, and `dist/` for public output. Copy `templates/workspace/` into `studio/`. Copy `tools/site_os.py`, `tools/build.py`, `tools/copy_review.py`, `tools/media.py` and `tools/serve.py` into the project's `tools/` folder. Copy `vendor/slopmonster/tools/deslop.py` to the project's `tools/deslop.py` and retain its licence. The build runs this checker on the saved homepage and exposes the real report in Copy.

Prepare `project/template.html` from the existing HTML. Add `{{wos:field.id}}` slots only where edits belong. Put `data-os-field="field.id"` on each corresponding leaf element so browser previews can bind the same value. Bind repeated desktop/mobile headline variants to the same field ID. Preserve animation attributes, IDs, anchors and decorative wrappers.

```html
<h1 split-hero="" data-os-field="hero.line1">{{wos:hero.line1}}</h1>
<img data-os-field="portrait.src" src="{{wos:portrait.src}}" alt="Portrait">
<style id="wos-brand">/* website-os:tokens */</style>
```

Place the token style after the existing token definitions so its root variables take effect. Map fields to the site's real CSS custom properties. Define labels, groups, types and initial values in `project/fields.json`. The shell currently supplies text, image-source and colour controls. Extend its controls when adding number, URL or choice fields; the runtime supports those types.

Initialize in a directory without a generated `index.html`. Preserve the original separately first.

```sh
python3 tools/site_os.py init project --template project/template.html --fields project/fields.json
python3 tools/build.py
python3 tools/serve.py --port 8876
```

`build.py` exports the verified homepage as `dist/homepage.html`, the workspace as `dist/index.html`, public fields as `dist/model.json`, and assets in `assets/`, `art/`, `img/` or `logos/`. It also copies root CSS, JS, SVG and ICO files. Adjust the explicit public-file list for a site's other asset folders. Never copy all project files into the public directory.

`workspace.json` follows `templates/workspace.example.json`. Set the actual name, typography notes, sample headline, starter prompt and asset tuples of label, purpose, preview URL and optional motion URL. Use the actual asset inventory, not placeholders. Adapt the workspace CSS font to a font you may use in that project.

## Preview and save

The local server binds to 127.0.0.1. Browser saves use typed changes and a revision check, then rebuild the homepage. The server rejects foreign Host/Origin requests and non-JSON writes. It is a development server, not a public CMS.

The preview creates a fresh same-origin frame before loading the revised document. That isolates a homepage's animation globals. Verify preview, save, reload and undo on the actual page, including its script-driven interactions.

Chat edits use `site_os.py inspect`, `draft`, `apply`, then `build.py`. Refresh the open workspace to show the saved model. Keep one source of truth for browser and conversation edits.

A static deployment cannot write to the local model. The shell detects this and offers Copy edit request instead of claiming to save. The request contains structured operations for the assistant to apply to source. Publishing remains the project's existing hosting operation.

## Framework sites

Keep React, Next.js and Worker projects in their own framework. Put the homepage route or component inside a small workspace layout and wire the four tabs to its actual data. Use its existing build, content modules and Git history instead of forcing it through this static helper.


## Preserve the desktop layout while editing

The workspace provides Desktop (1440 × 900), Tablet (768 × 1024), Mobile (390 × 844), custom sizes from 320 to 2560 pixels, rotation and full screen. These are real iframe viewport dimensions, scaled to fit the workspace. Opening a panel preserves the chosen viewport. Changing dimensions recreates the page frame so script-driven typography and WebGL measure the correct screen. Inspect the actual rendered page at each relevant breakpoint.


For animated text, put `data-os-field` on the existing text element whenever it already contains the whole field. Adding a wrapper span can prevent SplitText from measuring and wrapping lines. Keep navigation anchor IDs on that same element where possible. Inspect the rendered multi-line copy after binding it.


## Colour controls, media and page settings

The compiled HeroUI React colour picker ships in `templates/workspace/ui-build`; the Python preview needs no npm install to use it. To edit the controls, copy the contents of `templates/react-ui/` into the project root, then run `npm ci` and `npm run build:ui`. Components use `components/ui`, the `@/*` alias points to the root, and Tailwind enters through `index.css`. Keep this folder for portable shadcn imports. HeroUI styles load from `@heroui/styles`; the obsolete `/css` export is not used. Run `python3 tools/build.py` after a UI build.

Colours update the actual page immediately. Map tokens to the properties used by the visible page, including body and section backgrounds. The saved-colour reset, saved/draft comparison and explicit Save changes keep exploration reversible.

Use `workspace.media` for editable media records. Each record has `id`, `name`, `imageField`, optional `videoField`, original image/video URLs and an optional generation prompt. Bind the same fields in all cards, lightboxes and floating decorations using `data-os-attr-src`, `data-os-attr-poster`, `data-os-attr-href`, `data-os-attr-data-media` and `data-os-attr-data-poster`. Mark non-editable live effects as `referenceOnly`. Do not imply a WebGL effect is an uploaded image.

Uploads use ffmpeg/ffprobe to preserve the existing slot dimensions. Regeneration uses an authenticated OpenArt CLI and incurs provider credits only when Generate is submitted. The tool produces a candidate; selecting it changes a preview, and Save changes updates the source field. Original files remain available for restoration. Never automatically retry a billable job after a crash. Static previews copy a generation request instead.

For SEO, add bound `seo.title` and `seo.description` fields, and `workspace.seo.recommendedTitle` / `recommendedDescription` from an actual editorial review. The UI presents selectable before/after suggestions and a search-result preview before saving. This is an on-page check, not keyword research or a ranking guarantee. Inspect the actual H1 structure without silently changing the design or publication indexing. Page text lives beside SlopMonster and SEO inside Copy. Keep stale or pending rival-model reviews labelled.
