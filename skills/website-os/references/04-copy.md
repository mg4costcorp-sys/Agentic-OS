# Copy with SlopMonster

Website OS vendors the current SlopMonster tools from [Jack's repository](https://github.com/ItsssssJack/SlopMonster). `SOURCES.json` records the commit, retrieval date and hashes. The vendor files are unmodified and retain the MIT licence. Use this module instead of Four Systems' older `deslop.py`.

From this skill directory:

```sh
python3 vendor/slopmonster/tools/deslop.py /path/to/site/index.html --view view-site
python3 vendor/slopmonster/tools/test_deslop.py
```

The September 7 snapshot includes newer word-root matching, contracted sentence-shape detection, proof noun boundaries, Markdown/code exclusions and empty-input rejection. The catalogue is English-only. A clean score on another language does not establish that the writing is clean.

Read [Writing patterns](../vendor/slopmonster/references/signs-of-ai-writing.md) and [Principles](../vendor/slopmonster/references/principles.md) when rewriting substantial copy. Preserve the product's facts and voice. Remove AI vocabulary, repeated sentence shapes and padded claims. Then re-score the rendered marketing view. Educational before/after examples in the Copy view should not contaminate the marketing score.

Do not invent proof. Record evidence for factual numbers before using `--allow-proof`; that switch only changes how detected proof patterns affect the score. It does not verify a claim. Prices and real product quantities are not customer testimonials.

## Optional rival-model cleanse

The upstream workflow supports a rewrite by a different model family. It is optional for Website OS when the second model is unavailable or outside the user's current scope. Never claim a rival cleanse happened if it did not.

For copy written by Astra, the rival must be from another family. When the user has authorized that provider and it is available, use the bundled `tools/cleanse.sh` with `DESLOP_WRITER=gpt`; read the script before executing because it invokes a CLI and sends the draft to that model. Use the existing selected model where supported rather than guessing a model ID.

Without a rival tool, use [the bundled cleanse prompt](../vendor/slopmonster/prompts/cleanse.txt) for a manual second pass in the current conversation and describe it accurately. Re-lint afterward. Do not add a blocking cross-provider setup step to a routine copy edit.

## Keep the comparison truthful

The Copy view should show actual approved alternatives or the edit history, with a working before/after control. A comparison is temporary until a version is saved. Generate its displayed strings from the same content values as the website. Do not embed stale duplicate strings inside JavaScript.

The workspace edits the homepage’s live words through typed fields. Before/after options can be prepared in the conversation and previewed on that same page. The older `magic-copy.js` supports richer HTML variants but those are authored template code, not untrusted content values. Validate the selectors and test both directions after changing them.

## Refresh upstream later

Use `python3 tools/update_slopmonster.py --check` to compare the pinned commit with the repository's current main branch. Use `--update` when an update is requested. The helper stages the public archive, validates its paths, runs the upstream Python tests, preserves the licence and updates hashes. It changes only this local skill bundle, never the GitHub repository. If tests fail, keep the previous copy and report the failure.


## A rewrite is a separate artifact

A 5/5 pattern score completes the lint check only. Always distinguish pattern checking, the rewrite draft, rival-model cleanse and the re-check. A copy panel containing only a score is incomplete for a build-and-edit workflow.

Prepare `copy-review.json` at the project root. Use format 1, `source` and `rewritten` objects covering every current text field, `lockedFields` for wording the user asked to preserve, `notes` keyed by changed field ID, and a `cleanse` object with an accurate status, provider and explanation. Perform the three rewrite passes from the SlopMonster instructions, preserve the actual claims, and validate with `tools/copy_review.py` through the project build.

The workspace compares Original and SlopMonster, previews either version on the actual homepage and lets the user save their chosen wording. The project build re-scores both rendered versions and marks the review stale if the saved copy no longer matches its source or rewritten maps. A model review is allowed to leave already-effective lines unchanged. It should not change a user-requested reset merely to create a more dramatic comparison.

A rival cleanse marked pending has not run successfully. If authentication or the provider is unavailable, preserve the usable draft, explain the missing step and leave its status pending. Never display the whole workflow as complete based on a 5/5 regex score.

The Request a fresh rewrite button prepares the task for the conversation. It does not independently call a model from the browser. The assistant refreshes the proposal against the latest source before the user previews or saves it.


## Model disclosure for a rival cleanse

The optional vendored cleanse script runs the configured default of a rival Codex or Claude CLI. The model versions mentioned in comments are not enforced by model flags. Before running it, disclose the actual CLI, configured model and account usage/credits to the user. Never imply that it uses the OS composer model automatically. Record `provider` and the exact `model` in `copy-review.json` under `cleanse`, alongside its status. If the actual model cannot be verified, keep the review marked pending or label the model as not recorded. A local pattern audit needs no model call.
