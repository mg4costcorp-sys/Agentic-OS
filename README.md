# Agentic OS 3.5 + Website OS

The community edition opens with your own workspace. No example website, saved conversations, generated media, API keys or account files are bundled.

## Start locally

Install [Bun](https://bun.sh), open a terminal in this extracted folder, then run:

```sh
bun install --frozen-lockfile
bun run dev
```

Open the local address printed in the terminal. Keep this terminal running. Choose **Website OS** at the bottom of the sidebar, then paste the localhost address of a website you already have running. Full screen keeps the editor inside the OS.

Use a local development machine. This release is a local app with local agent and file tools; do not expose its server to the public internet. The production build is a packaging check, not a hosted replacement for these local tools.

## Connect your website

Start your website in its own folder first. Connect an address such as `http://localhost:3000`. Only HTTP loopback addresses are supported. Some sites block embedding; the connection screen will explain when you need to adjust that site's development settings.

Connecting a URL opens a live preview. Desktop, tablet, mobile, custom widths and rotation let you check the layout. It does not rewrite the website's source files. Where available, it detects the folder of the process on that port and shows it for you to confirm.

Choose **Enable editing**, confirm the source folder, then **Open in agent**. This places a setup request into the OS composer for you to review. Select your connected agent/model and send it when ready. Your agent uses `skills/website-os/SKILL.md` to connect real page content, design tokens and graphics while preserving the website's framework and appearance. No message or paid generation is submitted by the connection button.

The agent must complete and test this one-time integration before source editing, preview/apply and undo work. An already configured Website OS editor can connect directly. Python 3.10+ is needed for the included static HTML editing helper. Framework applications keep their own development server and source integration.

## Generation models

Website OS image regeneration uses **OpenArt / Nano Banana 2** (`nano-banana-2`), with the provider's **1K default**. Video regeneration uses **OpenArt / Seedance 2 Fast** (`byte-plus-seedance-2-fast`) at **720p**. The editor fits the result to the existing asset's dimensions. It keeps the original available while you preview the alternative and decide whether to save it.

Media generation requires your own OpenArt CLI connection and credits. No credentials or credits are included. The model and provider are shown before generation. Changing text, copy or code uses the agent/model you select in the OS composer; you choose that model before sending. The optional SlopMonster rival cleanse is separate: its script uses the configured default model of a rival Codex or Claude CLI, with that account's usage or credits. The agent must disclose the actual CLI and model before running it and record them with the review. The script does not pin a model version. Other OS tools may have their own model selectors.

## First-run scope

The quick start seeds an empty local data file. Run the broader setup, aggregation or scheduled routines only if you want those separate OS features. They are not required to connect a website preview. See [the full OS guide](docs/FULL-OS-GUIDE.md) for those optional features. Connect your own agent account before sending an editing request.

## Sharing and privacy

Distribute the clean release ZIP. Your working copy can accumulate website assets, conversations, generated files and local history after you use it. Those belong to you and should be removed before redistributing your own copy. Legacy Colour Lab and Transition Lab now open with an empty local clip preview; personal footage and licensed demo packs are excluded. The original creator attribution and third-party licences are retained.

See [release checks](RELEASE-CHECK.md) for the tested scope and limitations.
