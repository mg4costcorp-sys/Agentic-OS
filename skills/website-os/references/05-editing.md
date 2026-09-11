# Editing through the conversation

The assistant interprets the user's request. The runtime handles typed values, HTML escaping, version history and stale-edit checks. No model API is called by this helper.

## Static HTML model

Use stable field IDs such as `hero.line1`, `hero.cta`, `brand.accent` and `seo.description`. Put editable text into leaf elements. Plain text slots deliberately cannot replace nested decorative markup.

```html
<h1><span>{{wos:hero.line1}}</span></h1>
<a href="{{wos:cta.url}}">{{wos:cta.label}}</a>
<meta name="description" content="{{wos:seo.description}}">
<img src="{{wos:hero.image}}" alt="{{wos:hero.alt}}">
<style>
/* website-os:tokens */
.hero { color:var(--ink); background:var(--canvas) }
</style>
```

The CSS marker emits one root block from fields with a `css` property. It must appear exactly once inside a style element when there are CSS fields. Content slots cannot appear in script, style, comments, event handlers, unquoted attributes or arbitrary tag names. Use quoted attributes.

```json
{
  "hero.line1":{"type":"text","value":"Make it yours.","max_length":80},
  "brand.accent":{"type":"color","value":"#FF6B35","css":"--accent"},
  "brand.radius":{"type":"number","value":12,"css":"--radius","unit":"px","min":0,"max":40}
}
```

Supported types are `text`, `url`, `image`, `color`, `number` and `choice`. URL/image slots only bind their corresponding safe attributes or display as text. Choice fields require `choices`. Numbers use an explicit bounded range where needed. Every field must have a real binding or CSS variable; unused schema fields fail validation.

## Create an editable site

Keep authoring files outside public output. For an existing homepage, read [Existing homepage integration](06-existing-homepage.md). Bind the user's actual page before initializing the model.

```sh
python3 tools/site_os.py init /path/to/project \
  --template /path/to/project/template.html --fields /path/to/project/fields.json
python3 tools/site_os.py inspect /path/to/project
```

The tool creates `/path/to/project/index.html` and `.website-os/state.json`. That state file is the authoritative saved model. It contains templates, schema, content and revisions. Keep it with the project for future edits; do not deploy it as a public asset. Do not hand-edit the generated index or state.

## Plan, preview and apply

Inspect the current fields before planning. Use the current values to identify the right target; do not guess an ID from a prior version. Save a changes file containing only the intended operations:

```json
[
  {"op":"set","id":"hero.line1","value":"YOUR NEXT IDEA."},
  {"op":"set","id":"brand.accent","value":"#D8EF70"}
]
```

```sh
python3 tools/site_os.py draft /path/to/project --changes /path/to/changes.json --message "Revise headline and accent"
python3 tools/site_os.py diff /path/to/project --draft DRAFT_ID_FROM_OUTPUT
python3 tools/site_os.py apply /path/to/project --draft DRAFT_ID_FROM_OUTPUT
python3 tools/site_os.py verify /path/to/project
```

`draft` validates the entire change set before writing a preview. It returns a unique ID, exact before/after diff and a preview HTML path beside the index so relative assets still resolve. Review the relevant layout, copy score and contrast before applying. If the user already asked to make the edit, apply the validated local change without asking again. If they requested an option or draft, retain the preview until selected.

`apply` rejects stale drafts and altered preview files. Unknown fields, duplicate operations, unsafe links and invalid token types fail before saving. Text is HTML-escaped; it never becomes arbitrary HTML. Once applied, re-open the generated site through the current preview route.

## Undo and layout edits

```sh
python3 tools/site_os.py history /path/to/project
python3 tools/site_os.py undo /path/to/project --message "Undo the last edit"
```

Undo creates a new history entry. Repeated undo walks backward through saved actions. The tool restores the template, schema and content together. Asset files are not versioned by the helper: use new filenames for replacement images, or version their bytes in Git so an old revision still resolves correctly.

For a requested layout or typography change, edit a copy of the saved template and the field definitions. Rebase it into the project:

```sh
python3 tools/site_os.py rebase /path/to/project \
  --template /path/to/revised-template.html --fields /path/to/fields.json \
  --message "Reorder the feature sections"
```

Rebase preserves values for existing field IDs. New fields take their supplied values. Use a separate draft to change an existing value. Removing fields requires `--allow-removed-fields`, used only when that deletion is part of the request. A rebase is a saved local revision and can be undone.

If the generated index was edited directly, preserve those edits separately and reconcile them into the template. `repair --confirm` intentionally restores the generated index from saved state. Use it only after understanding the mismatch. A write interrupted between output and state can also produce a mismatch; the same explicit repair restores the last saved state. Never use repair to conceal unexplained external changes.

## Export and hosting

```sh
python3 tools/site_os.py export /path/to/project --out /path/to/public-output
```

Export copies the verified index and any `assets/` or `img/` folders. It excludes `.website-os` and drafts. It rejects symlinked assets. Other public files such as a downloadable skill archive must be added intentionally. Check local references before deploying.

For Sites projects, copy the exported output into the configured static directory and use the installed Sites hosting workflow. Keep the authoritative source model in the repository outside that directory. A saved local revision is not a deployed update.

## Existing CMS or framework projects

Claude CMS already separates template, schema and content. Reuse those concepts, but do not execute its whole server merely to edit through this conversation. The bundled helper is a new small static implementation, not a compatible replacement for its database or HTTP API. There is no automatic importer for arbitrary URLs or CMS archives.

For existing React/Sites source, modify its own content modules or typed configuration. Use the framework's build and Git history. For a new static conversion, map the currently needed fields explicitly and verify that the rendered site still matches before replacing anything. Client accounts, databases and hosted publishing controls remain optional work only when requested.
