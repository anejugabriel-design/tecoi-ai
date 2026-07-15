# Tecoi AI — terminal coding assistant

## Easiest way to run it (Windows)

Double-click **`Tecoi AI.bat`** in this folder. That's it — no typing commands, no terminal knowledge needed. It opens its own window titled "Tecoi AI" and starts right up. First time, it'll ask you to paste your OpenRouter API key once, then remember it.

Everything below is for people who want to run it manually, or on Mac/Linux.


Tecoi works like Claude Code: you run it in your **own terminal**, and it gets real access to read and write files in your actual project — not a browser tab pretending to.

## Setup

1. **Node.js 18+** is required (uses the built-in `fetch`). Check with `node -v`.
2. Get a free API key at **https://openrouter.ai/keys**.
3. Set it up one of two ways:

   **Option A — local `.env` file (recommended, no need to `export` every session):**
   Create a file named `.env` in the same folder as `tecoi-cli.js`:
   ```
   OPENROUTER_API_KEY=sk-or-your-key-here
   ```
   This file is yours alone — it stays on your machine, nothing else reads it, and it's already covered by the included `.gitignore` so it can't get accidentally committed or pushed anywhere.

   **Option B — environment variable:**
   ```bash
   export OPENROUTER_API_KEY="sk-or-..."
   ```
   (Add that line to your `~/.bashrc` / `~/.zshrc` to persist it across sessions.)

## Running it

```bash
cd your-project-folder
node tecoi-cli.js
```

Or install it globally so you can just type `tecoi` from anywhere:

```bash
npm link
cd any-project-folder
tecoi
```

Then just talk to it:

```
you> build me a simple Express server with a /health route
tecoi> Sure — here's a minimal Express server...
  ✏️  wrote server.js
  ✏️  wrote package.json

  ▶ Run this command?
    npm install express
    (y/N): y
```

Type `exit` or `quit` to leave.

## What it can actually do

- **Remembers your conversation** — log in with your Techia AI account (same email/password as the website) and Tecoi saves every conversation to that account. Close it, reopen it later, and it picks up right where you left off. Say "n" when asked to log in if you'd rather not — it still works, just without memory between runs.
- **Reads your whole project** (skipping `node_modules`, `.git`, and dotfiles) automatically for real context, so it isn't guessing what already exists.
- **Writes, moves, and deletes files directly** in your project folder — every change is printed to the terminal as it happens (deletions ask for confirmation first, since those aren't easily reversible).
- **Proposes shell commands** (installing dependencies, running tests, etc.) — but **never runs one without you typing `y` to confirm, every single time.** There's no "always allow" setting on purpose. Letting an LLM run arbitrary shell commands unattended is a genuinely bad idea, so this tool doesn't offer that as an option.

## Switching models

By default Tecoi uses a strong free OpenRouter model. To use a different one:

```bash
export TECOI_MODEL="anthropic/claude-sonnet-4"
```

(Any model id from https://openrouter.ai/models works, provided your OpenRouter account has access/credit for it.)

## Safety notes

- Tecoi only writes inside your current project folder — it refuses to write anywhere outside it.
- Nothing is sent anywhere except OpenRouter's API (using your own key) and, if you approve a `RUN` command, your own local shell.
- Review what it writes before committing, same as you would with any AI-generated code.
