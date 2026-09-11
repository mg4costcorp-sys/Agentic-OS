# Website OS

Your actual homepage, with four small tabs for Website, Design, Graphics and Copy. Ask the conversation for an edit and see it change the website.

This combines Four Systems with the editing model from Claude CMS. SlopMonster is included at commit f261dbf11c2a206ecd8780c070a46dae64edd8be, verified against the repository on September 10, 2026.

## Use it

Select Website OS in the desktop skill picker, or invoke `$website-os` in Codex. A portable installation keeps this entire folder together in a supported skill directory.

For a tool-enabled ChatGPT session, attach or extract the package and ask it to read `website-os/SKILL.md`. The assistant also needs access to the website source. A ZIP upload provides the workflow for that session; it does not by itself install a persistent ChatGPT web plugin. See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills).

## Start with your homepage

```text
Use Website OS on this website: [URL or source folder]. Put the actual live homepage in the Website tab. Add small Design, Graphics and Copy tabs using that site's real tokens, assets and words. Preserve the current design and motion. Make it editable through this conversation.
```

```text
Make the headline say “Learn AI. Build real things.” Keep the animated sphere and the rest of the design. Preview it, save it, and check the result.
```

```text
Make the canvas a warm ivory. Keep the text readable and update the Design tab to match.
```

```text
Undo the last change.
```

## The included workspace

`templates/workspace/` contains the small editor around the homepage. It does not contain a replacement homepage. The assistant connects your existing site's source using [Existing homepage integration](references/06-existing-homepage.md).

The local server saves typed edits to source and keeps version history. The hosted static workspace previews edits and copies a structured request back to the conversation, where the assistant can save and publish using the project's existing workflow. There is no extra chatbot or model API key.

No example website or personal media is bundled. Start with your own localhost URL.

## Source and compatibility

Owner-requested design and layout edits are supported. Existing framework apps keep their architecture. The Python helper is for static HTML and requires Python 3.10 or later. There is no automatic importer for arbitrary URLs.

`SOURCES.json` records the source ZIPs and the current SlopMonster vendor hashes. Its licence is retained. The GitHub source repository was not modified.
