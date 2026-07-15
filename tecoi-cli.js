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

// ---- Shared API key (optional) -----------------------------------------
// Fill this in with YOUR OpenRouter key to let everyone who downloads
// Tecoi use it without needing their own — they'll never even see the
// key-setup prompt. Leave it blank ("") to require each person to bring
// their own key instead (the original, more secure behavior).
//
// ⚠️ Whatever you put here is PLAIN TEXT inside this file. Anyone who
// downloads Tecoi can open it and read/copy this key directly — this
// key is not protected, hidden, or obfuscated by putting it here. Only
// use a key you're comfortable with total strangers being able to see
// and use however they want, completely outside of Tecoi. If you'd
// rather keep the key itself hidden while still sharing access to it,
// that requires a server-side proxy instead of this — ask if you want
// that built.
const SHARED_API_KEY = "";

// ---- Techia AI account — login + conversation history sync -------------
// Same Supabase project the web app (index.html) uses. Logging in here
// ties Tecoi to a real Techia AI account, and conversation history is
// saved to (and loaded from) that account's techia_chats table, so
// closing and reopening Tecoi picks up right where you left off instead
// of starting blank every time.
const SUPABASE_URL = "https://dutfoujfaqmciucgauvi.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1dGZvdWpmYXFtY2l1Y2dhdXZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNDU0NTUsImV4cCI6MjA5NzkyMTQ1NX0.1y_UP_WD4pfVVrl8sYKLXGel8AHj9Dr7m1NLoy44srU";
const SUPABASE_AUTH = SUPABASE_URL + "/auth/v1";
const SUPABASE_REST = SUPABASE_URL + "/rest/v1";
const SESSION_PATH = path.join(APP_DIR, ".tecoi-session.json");

function loadSession(){
    try{
        if(!fs.existsSync(SESSION_PATH)) return null;
        return JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
    }catch(e){
        return null;
    }
}

function saveSession(session){
    try{
        fs.writeFileSync(SESSION_PATH, JSON.stringify(session));
    }catch(e){
        console.log("⚠️  Couldn't save your login (" + e.message + ") — you'll be asked to log in again next time.");
    }
}

async function loginToTechia(){
    console.log("\n🔐 Log in to your Techia AI account to save conversation history to it.");
    console.log("   (Same email/password as the Techia AI website.)\n");

    const email = await ask("Email: ");
    const password = await ask("Password: ");

    const res = await fetch(SUPABASE_AUTH + "/token?grant_type=password", {
        method: "POST",
        headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password: password })
    });
    const data = await res.json();

    if(!res.ok || !data.access_token){
        console.log("\n❌ Login failed: " + ((data && data.error_description) || (data && data.msg) || "check your email/password") + "\n");
        return null;
    }

    const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user_id: data.user.id,
        email: data.user.email
    };
    saveSession(session);
    console.log("✅ Logged in as " + session.email + "\n");
    return session;
}

async function refreshSession(session){
    try{
        const res = await fetch(SUPABASE_AUTH + "/token?grant_type=refresh_token", {
            method: "POST",
            headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        const data = await res.json();
        if(!res.ok || !data.access_token) return null;

        const refreshed = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
            user_id: session.user_id,
            email: session.email
        };
        saveSession(refreshed);
        return refreshed;
    }catch(e){
        return null;
    }
}

// Loads a saved session if there is one (refreshing it if it's stale),
// or prompts to log in. Returns null if the person skips login — Tecoi
// still works without an account, it just won't remember anything
// between runs in that case.
async function ensureTechiaSession(){
    let session = loadSession();

    if(session && session.expires_at < Math.floor(Date.now() / 1000) + 60){
        session = await refreshSession(session);
    }

    if(session) return session;

    const answer = await ask("Log in to Techia AI to save your conversation history to your account? (Y/n): ");
    if(answer.trim().toLowerCase() === "n"){
        console.log("Continuing without an account — conversation history won't be saved this session.\n");
        return null;
    }

    return await loginToTechia();
}

function supabaseHeaders(session){
    return {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + session.access_token,
        "Content-Type": "application/json"
    };
}

// Finds (or creates) the one persistent Tecoi conversation for this
// account — reuses the same techia_chats table the web app's chat
// history uses, tagged with model_id "tecoi-cli" so it doesn't mix with
// web chats.
async function loadOrCreateTecoiChat(session){
    try{
        const res = await fetch(
            SUPABASE_REST + "/techia_chats?select=id,messages&user_id=eq." + session.user_id + "&model_id=eq.tecoi-cli&order=updated_at.desc&limit=1",
            { headers: supabaseHeaders(session) }
        );
        const rows = await res.json();

        if(res.ok && rows.length){
            return { id: rows[0].id, messages: rows[0].messages || [] };
        }

        const createRes = await fetch(SUPABASE_REST + "/techia_chats", {
            method: "POST",
            headers: Object.assign(supabaseHeaders(session), { "Prefer": "return=representation" }),
            body: JSON.stringify({
                user_id: session.user_id,
                title: "Tecoi CLI",
                summary: "Terminal coding sessions",
                model_id: "tecoi-cli",
                messages: []
            })
        });
        const created = await createRes.json();
        if(createRes.ok && created[0]) return { id: created[0].id, messages: [] };
    }catch(e){
        console.log("⚠️  Couldn't reach your Techia AI account (" + e.message + ") — continuing without saved history this session.");
    }
    return null;
}

async function saveTecoiChat(session, chatId, messages){
    try{
        await fetch(SUPABASE_REST + "/techia_chats?id=eq." + chatId, {
            method: "PATCH",
            headers: supabaseHeaders(session),
            body: JSON.stringify({ messages: messages, updated_at: new Date().toISOString() })
        });
    }catch(e){
        // Non-critical — worst case this turn doesn't get saved, next one still tries.
    }
}

// A person's own key (via .env or an env var) always takes priority over
// the shared one above, so anyone who wants to use their own account
// still can.
async function ensureApiKey(){
    const loaded = loadDotEnv();
    if(loaded) console.log("(.env found — loaded " + loaded + " variable" + (loaded === 1 ? "" : "s") + ")");

    if(process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;

    if(SHARED_API_KEY){
        process.env.OPENROUTER_API_KEY = SHARED_API_KEY;
        return SHARED_API_KEY;
    }

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
function printBanner(){
    const width = 26;
    function line(visibleText, styledText){
        const padding = " ".repeat(Math.max(0, width - visibleText.length));
        return "║" + (styledText || visibleText) + padding + "║";
    }
    console.log("");
    console.log("  \x1b[35m╔" + "═".repeat(width) + "╗\x1b[0m");
    console.log("  \x1b[35m" + line("   T E C O I   A I", "   \x1b[1mT E C O I   A I\x1b[0m\x1b[35m") + "\x1b[0m");
    console.log("  \x1b[35m" + line("   terminal coding agent") + "\x1b[0m");
    console.log("  \x1b[35m╚" + "═".repeat(width) + "╝\x1b[0m");
    console.log("");
}

async function main(){
    printBanner();

    await ensureApiKey();

    const session = await ensureTechiaSession();

    console.log("Working in: " + CWD);
    console.log("Model: " + MODEL + "  (override with TECOI_MODEL=...)");
    if(session) console.log("Account: " + session.email + " — conversation history is being saved");
    console.log("Type a request, or \"exit\" to quit.\n");

    const files = listProjectFiles(CWD);
    let conversation = [];
    let cloudChatId = null;

    if(session){
        const chat = await loadOrCreateTecoiChat(session);
        if(chat){
            cloudChatId = chat.id;
            conversation = chat.messages || [];
            if(conversation.length){
                console.log("(picked up where you left off — " + conversation.length + " earlier message" + (conversation.length === 1 ? "" : "s") + " loaded)\n");
            }
        }
    }

    const history = [{ role: "system", content: buildSystemPrompt(files) }].concat(conversation);

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

        if(cloudChatId){
            saveTecoiChat(session, cloudChatId, history.slice(1)); // slice off the system prompt — it's regenerated fresh each run
        }

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
