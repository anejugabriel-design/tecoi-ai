#!/usr/bin/env node
// ============================================================
// Tecoi 1.0 CLI — a terminal coding assistant with real access to your
// computer's files, similar in spirit to Claude Code.
// ============================================================
// Setup (pick one):
//   A) One-time env var:
//        export OPENROUTER_API_KEY="sk-or-..."
//   B) Local .env file (recommended if you don't want to export every
//      session) — create a file named .env next to this script:
//        OPENROUTER_API_KEY=sk-or-...
//      This file is YOURS — it stays on your machine, is never read by
//      anything but this script, and should be added to .gitignore so
//      it's never accidentally committed/pushed anywhere.
//   Then:
//   1. cd into the project folder you want Tecoi to work in
//   2. node /path/to/tecoi-cli.js   (or: npm link, then just `tecoi`)
//
// Safety model:
//   - Tecoi can read every file under the current directory (skipping
//     .git, node_modules, and dotfiles) to give itself real project
//     context — this happens automatically, no confirmation needed,
//     since reading is non-destructive.
//   - Tecoi can WRITE/create files — this happens automatically too,
//     since it's easy to review or revert with git, but every write is
//     printed to the terminal as it happens so nothing is silent.
//   - Tecoi can PROPOSE shell commands — these are NEVER run without
//     you explicitly typing "y" to confirm, every single time, no
//     "always allow" setting. This is intentional: letting an LLM run
//     arbitrary shell commands unattended is genuinely dangerous.
// ============================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

// When compiled into a standalone .exe (via pkg), __dirname points inside
// a virtual snapshot, not the real folder the .exe sits in — so .env
// needs to be looked up next to the actual executable instead in that
// case. Plain `node tecoi-cli.js` still uses the script's own folder.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question){
    return new Promise(function(resolve){ rl.question(question, resolve); });
}

// Minimal, dependency-free .env loader — looks for a .env file next to
// this script/exe and loads KEY=value lines into process.env if they
// aren't already set. No third-party package needed for something this
// small.
function loadDotEnv(){
    const envPath = path.join(APP_DIR, ".env");
    if(!fs.existsSync(envPath)) return 0;

    let raw = fs.readFileSync(envPath, "utf8");
    // Notepad on Windows often saves UTF-8 files with a BOM (a few
    // invisible bytes at the very start) — if that lands right before
    // "OPENROUTER_API_KEY" on the first line, the line no longer matches
    // that exact key name and silently fails to load. Strip it.
    if(raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const lines = raw.split(/\r?\n/);
    let loadedCount = 0;
    for(const line of lines){
        const trimmed = line.trim();
        if(!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if(eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if(key){
            if(!(key in process.env)) process.env[key] = value;
            loadedCount++;
        }
    }
    return loadedCount;
}

// Asks for the key interactively on first run (no .env, no env var
// already set) and offers to save it into a .env file right next to the
// exe/script, so this only ever has to happen once.
async function ensureApiKey(){
    const loaded = loadDotEnv();
    if(loaded) console.log("(.env found — loaded " + loaded + " variable" + (loaded === 1 ? "" : "s") + ")");

    if(process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

    console.log("\n👋 First time running Tecoi — it needs an OpenRouter API key.");
    console.log("   Get a free one at https://openrouter.ai/keys\n");
    const key = await ask("Paste your API key here: ");

    if(!key || !key.trim()){
        console.error("\n❌ No key entered — can't continue without one.\n");
        process.exit(1);
    }

    const trimmedKey = key.trim();
    const save = await ask("Save it to a .env file next to Tecoi so you don't have to paste it again? (Y/n): ");
    if(save.trim().toLowerCase() !== "n"){
        const envPath = path.join(APP_DIR, ".env");
        try{
            fs.writeFileSync(envPath, "OPENROUTER_API_KEY=" + trimmedKey + "\n");
            console.log("✅ Saved to " + envPath + "\n");
        }catch(e){
            console.log("⚠️  Couldn't save it (" + e.message + ") — you'll be asked again next time.\n");
        }
    }

    process.env.OPENROUTER_API_KEY = trimmedKey;
    return trimmedKey;
}

const MODEL = process.env.TECOI_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const CWD = process.cwd();
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv"]);
const MAX_CONTEXT_FILES = 200;
const MAX_FILE_BYTES_FOR_CONTEXT = 30000; // don't blow the context window on huge files

// ---- Project file discovery ------------------------------------------
function listProjectFiles(dir, prefix){
    prefix = prefix || "";
    let out = [];
    let entries;
    try{ entries = fs.readdirSync(dir, { withFileTypes:true }); }
    catch(e){ return out; }

    for(const entry of entries){
        if(entry.name.startsWith(".")) continue;
        if(entry.isDirectory()){
            if(IGNORE_DIRS.has(entry.name)) continue;
            out = out.concat(listProjectFiles(path.join(dir, entry.name), path.join(prefix, entry.name)));
        }else{
            out.push(path.join(prefix, entry.name));
        }
        if(out.length >= MAX_CONTEXT_FILES) return out;
    }
    return out;
}

function readFileSafe(relPath){
    try{
        const full = path.join(CWD, relPath);
        const stat = fs.statSync(full);
        if(stat.size > MAX_FILE_BYTES_FOR_CONTEXT) return "(file too large to include in context — " + stat.size + " bytes)";
        return fs.readFileSync(full, "utf8");
    }catch(e){
        return "(couldn't read: " + e.message + ")";
    }
}

// ---- The model call ---------------------------------------------------
async function callModel(messages){
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + process.env.OPENROUTER_API_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: messages })
    });
    const data = await res.json();
    if(!res.ok) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
    return data.choices[0].message.content;
}

function buildSystemPrompt(files){
    return (
        "You are Tecoi, a terminal coding assistant with real access to the user's project at " + CWD + ".\n\n" +
        "To create or modify a file, respond with a fenced code block whose info string is exactly:\n" +
        "FILE:relative/path/to/file.ext\n" +
        "followed by the COMPLETE file content (the whole file as it should exist after your change, not a diff " +
        "or a snippet). Multiple FILE blocks are fine in one response.\n\n" +
        "To move, rename, or relocate an EXISTING file (e.g. organizing a folder), use a fenced code block with " +
        "info string exactly:\n" +
        "MOVE:relative/old/path.ext\n" +
        "with the single new relative path as the content, e.g.:\n" +
        "MOVE:report.pdf\n```\ndocuments/2026/report.pdf\n```\n" +
        "Use MOVE (not FILE) whenever the file's content isn't changing — only its location/name is. This applies " +
        "automatically without asking, same as FILE.\n\n" +
        "To delete a file, use a fenced code block with info string exactly:\n" +
        "DELETE:relative/path.ext\n" +
        "with empty content. Unlike FILE and MOVE, the user will be asked to confirm every deletion before it " +
        "happens, since it's not easily reversible.\n\n" +
        "To propose a shell command (installing a dependency, running tests, etc.), use a fenced code block with " +
        "info string exactly:\n" +
        "RUN\n" +
        "containing the exact command. The user will be asked to confirm before it actually runs — never assume " +
        "it already ran, and never combine multiple unrelated commands into one RUN block.\n\n" +
        "When asked to organize/clean up/sort files, use MOVE blocks for every file that needs to move — don't " +
        "just describe a plan in prose, actually do it via the blocks.\n\n" +
        "Prose outside code blocks is shown directly to the user as your explanation — keep it concise, no " +
        "restating what the code blocks already show.\n\n" +
        "Write real, complete, working code — no placeholders, no \"implement this later\" comments.\n\n" +
        "Current project files:\n" + (files.length ? files.join("\n") : "(empty directory)")
    );
}

// ---- Parsing and applying the model's response -------------------------
function extractBlocks(reply){
    const blocks = [];
    const re = /```(FILE:[^\n]+|MOVE:[^\n]+|DELETE:[^\n]+|RUN)\n([\s\S]*?)```/g;
    let match;
    while((match = re.exec(reply)) !== null){
        blocks.push({ tag: match[1].trim(), content: match[2] });
    }
    return blocks;
}

// Resolves a relative path against the project root and refuses to touch
// anything outside it (e.g. "../../../etc/passwd") — used by every
// operation that touches the real filesystem.
function safeResolve(relPath){
    const fullPath = path.join(CWD, relPath);
    if(!fullPath.startsWith(CWD)) return null;
    return fullPath;
}

async function applyBlocks(blocks){
    for(const block of blocks){
        if(block.tag.startsWith("FILE:")){
            const relPath = block.tag.slice(5).trim();
            const fullPath = safeResolve(relPath);
            if(!fullPath){
                console.log("  ⚠️  skipped " + relPath + " — path escapes the project folder");
                continue;
            }

            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, block.content.replace(/\n$/, "") + "\n");
            console.log("  ✏️  wrote " + relPath);

        }else if(block.tag.startsWith("MOVE:")){
            const fromRel = block.tag.slice(5).trim();
            const toRel = block.content.trim();
            const fromPath = safeResolve(fromRel);
            const toPath = safeResolve(toRel);

            if(!fromPath || !toPath){
                console.log("  ⚠️  skipped move of " + fromRel + " — path escapes the project folder");
                continue;
            }
            if(!fs.existsSync(fromPath)){
                console.log("  ⚠️  skipped move — " + fromRel + " doesn't exist");
                continue;
            }

            fs.mkdirSync(path.dirname(toPath), { recursive: true });
            fs.renameSync(fromPath, toPath);
            console.log("  📦 moved " + fromRel + " → " + toRel);

        }else if(block.tag.startsWith("DELETE:")){
            const relPath = block.tag.slice(7).trim();
            const fullPath = safeResolve(relPath);

            if(!fullPath){
                console.log("  ⚠️  skipped delete of " + relPath + " — path escapes the project folder");
                continue;
            }
            if(!fs.existsSync(fullPath)){
                console.log("  ⚠️  skipped delete — " + relPath + " doesn't exist");
                continue;
            }

            const answer = await ask("  🗑️  Delete this file? " + relPath + " (y/N): ");
            if(answer.trim().toLowerCase() === "y"){
                fs.unlinkSync(fullPath);
                console.log("  🗑️  deleted " + relPath);
            }else{
                console.log("  ⏭️  skipped");
            }

        }else if(block.tag === "RUN"){
            const cmd = block.content.trim();
            const answer = await ask("  ▶ Run this command?\n    " + cmd + "\n    (y/N): ");
            if(answer.trim().toLowerCase() === "y"){
                try{
                    const output = execSync(cmd, { cwd: CWD, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
                    if(output) console.log(output);
                }catch(e){
                    console.log("  ❌ command failed: " + e.message);
                }
            }else{
                console.log("  ⏭️  skipped");
            }
        }
    }
}

// ---- Main REPL loop -----------------------------------------------------
async function main(){
    console.log("\n🛠️  Tecoi AI — terminal coding assistant");

    await ensureApiKey();

    console.log("Working in: " + CWD);
    console.log("Model: " + MODEL + "  (override with TECOI_MODEL=...)");
    console.log("Type a request, or \"exit\" to quit.\n");

    const files = listProjectFiles(CWD);
    const history = [{ role: "system", content: buildSystemPrompt(files) }];

    while(true){
        const input = await ask("you> ");
        const trimmed = input.trim();
        if(!trimmed) continue;
        if(trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") break;

        history.push({ role: "user", content: trimmed });

        console.log("tecoi> thinking...");

        let reply;
        try{
            reply = await callModel(history);
        }catch(e){
            console.log("tecoi> ❌ " + e.message);
            history.pop(); // don't poison history with a failed turn
            continue;
        }

        history.push({ role: "assistant", content: reply });

        const blocks = extractBlocks(reply);
        const prose = reply.replace(/```(FILE:[^\n]+|MOVE:[^\n]+|DELETE:[^\n]+|RUN)\n[\s\S]*?```/g, "").trim();

        console.log("tecoi>" + (prose ? " " + prose : "") + "\n");

        if(blocks.length){
            await applyBlocks(blocks);
            console.log("");
        }
    }

    rl.close();
    console.log("👋 bye");
}

main().catch(function(e){
    console.error("Fatal error: " + e.message);
    process.exit(1);
});
