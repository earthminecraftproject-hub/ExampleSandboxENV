import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const SANDBOX_ROOT = process.env.SANDBOX_ROOT || "/sandbox";
fs.mkdirSync(SANDBOX_ROOT, { recursive: true });

const uuid = () => crypto.randomUUID();

function writeFiles(workspace, files = []) {
    for (const f of files) {
        const full = path.join(workspace, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
    }
}

/* ---------------- runtime env ---------------- */
function resolveEnv(runtime) {
    switch (runtime) {
        case "java17":
            return { ...process.env, JAVA_HOME: process.env.JAVA17_HOME,
                PATH: `${process.env.JAVA17_HOME}/bin:${process.env.PATH}` };
        case "java21":
            return { ...process.env, JAVA_HOME: process.env.JAVA21_HOME,
                PATH: `${process.env.JAVA21_HOME}/bin:${process.env.PATH}` };
        default:
            return process.env;
    }
}

/* ---------------- exec primitives ---------------- */
function spawnP(bin, args, opts = {}, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, { detached: true, ...opts });
        let stdout = "", stderr = "";
        const t = setTimeout(() => {
            try { process.kill(-child.pid); } catch {}
            resolve({ stdout, stderr, exitCode: 124, error: "Timeout" });
        }, timeoutMs);
        child.stdout?.on("data", d => stdout += d.toString());
        child.stderr?.on("data", d => stderr += d.toString());
        child.on("close", code => { clearTimeout(t); resolve({ stdout, stderr, exitCode: code }); });
        child.on("error", err => { clearTimeout(t); resolve({ stdout, stderr, exitCode: 1, error: err.message }); });
    });
}

// Run a shell command line via bash -lc — supports &&, pipes, env, etc.
function shell(cmd, cwd, env, timeoutMs) {
    return spawnP("bash", ["-lc", cmd], { cwd, env, shell: false }, timeoutMs);
}

/* ---------------- auto-install layer ---------------- */
// Maps a missing binary -> command(s) that install it.
const INSTALL_RECIPES = {
    pnpm:       "npm install -g pnpm",
    yarn:       "npm install -g yarn",
    bun:        "npm install -g bun || curl -fsSL https://bun.sh/install | bash",
    deno:       "curl -fsSL https://deno.land/install.sh | sh && cp /root/.deno/bin/deno /usr/local/bin/deno",
    tsc:        "npm install -g typescript",
    "ts-node":  "npm install -g ts-node typescript",
    vite:       "npm install -g vite",
    nodemon:    "npm install -g nodemon",
    pip:        "apt-get update && apt-get install -y --no-install-recommends python3-pip",
    pipx:       "apt-get update && apt-get install -y --no-install-recommends pipx",
    poetry:     "pip install --break-system-packages poetry || pipx install poetry",
    uv:         "pip install --break-system-packages uv || curl -LsSf https://astral.sh/uv/install.sh | sh",
    psql:       "apt-get update && apt-get install -y --no-install-recommends postgresql-client",
    sqlite3:    "apt-get update && apt-get install -y --no-install-recommends sqlite3",
    redis_cli:  "apt-get update && apt-get install -y --no-install-recommends redis-tools",
    ffmpeg:     "apt-get update && apt-get install -y --no-install-recommends ffmpeg",
    imagemagick:"apt-get update && apt-get install -y --no-install-recommends imagemagick",
    convert:    "apt-get update && apt-get install -y --no-install-recommends imagemagick",
    rsync:      "apt-get update && apt-get install -y --no-install-recommends rsync",
    zip:        "apt-get update && apt-get install -y --no-install-recommends zip unzip",
    unzip:      "apt-get update && apt-get install -y --no-install-recommends unzip",
    htop:       "apt-get update && apt-get install -y --no-install-recommends htop",
    vim:        "apt-get update && apt-get install -y --no-install-recommends vim",
    nano:       "apt-get update && apt-get install -y --no-install-recommends nano",
    gh:         "apt-get update && apt-get install -y --no-install-recommends gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli.gpg && echo 'deb [signed-by=/usr/share/keyrings/githubcli.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh)",
};

function looksLikeMissingBinary(result, cmd) {
    if (result.exitCode !== 127) return null;
    const text = (result.stderr || result.stdout || "").toLowerCase();
    if (!/command not found|not found|no such file/.test(text)) return null;
    const first = cmd.trim().split(/\s+/)[0] || "";
    // strip env assignments like FOO=bar baz
    const real = first.includes("=") ? cmd.trim().split(/\s+/).find(p => !p.includes("=")) : first;
    if (!real) return null;
    return real.replace(/[^a-zA-Z0-9_]/g, "_") in INSTALL_RECIPES
        ? real.replace(/[^a-zA-Z0-9_]/g, "_")
        : real in INSTALL_RECIPES ? real : null;
}

async function execWithAutoInstall(runtime, command, cwd, timeoutMs = 60000) {
    const env = resolveEnv(runtime);
    let result = await shell(command, cwd, env, timeoutMs);
    const missing = looksLikeMissingBinary(result, command);
    if (missing && INSTALL_RECIPES[missing]) {
        const install = await shell(INSTALL_RECIPES[missing], cwd, env, 180000);
        const retry = await shell(command, cwd, env, timeoutMs);
        return {
            ...retry,
            autoInstalled: missing,
            installLog: (install.stdout || "") + (install.stderr ? `\n[stderr]\n${install.stderr}` : ""),
            installExitCode: install.exitCode,
            originalExitCode: result.exitCode,
        };
    }
    return result;
}

/* ---------------- /run (back-compat + auto-install) ---------------- */
app.post("/run", async (req, res) => {
    const { runtime = "node", command, files = [], timeoutMs } = req.body || {};
    if (!command) return res.status(400).json({ error: "command required" });
    const workspace = path.join(SANDBOX_ROOT, uuid());
    fs.mkdirSync(workspace, { recursive: true });
    try {
        writeFiles(workspace, files);
        const result = await execWithAutoInstall(runtime, command, workspace, timeoutMs ?? 15000);
        res.json({ workspace, runtime, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use("/preview", express.static(SANDBOX_ROOT));

/* ====================================================
   Mistral-powered Installation Agent
   ==================================================== */
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

async function mistralChat({ apiKey, model, messages, tools, tool_choice }) {
    const body = { model, messages };
    if (tools) body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
    const r = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, ok: r.ok, json };
}

/* /agent/test : trivial PONG check */
app.post("/agent/test", async (req, res) => {
    const { apiKey, model } = req.body || {};
    if (!apiKey || !model) return res.status(400).json({ ok: false, error: "apiKey and model are required" });
    try {
        const { status, ok, json } = await mistralChat({
            apiKey, model,
            messages: [
                { role: "system", content: "Reply with the single word: PONG" },
                { role: "user", content: "ping" },
            ],
        });
        if (!ok) return res.status(status).json({ ok: false, error: json?.error?.message || `Mistral returned ${status}`, model });
        const reply = json?.choices?.[0]?.message?.content ?? "";
        const passed = /pong/i.test(reply);
        return res.json({
            ok: passed, model, reply,
            note: passed
                ? "Key + model verified. /agent/install is unlocked."
                : "Model responded but did not follow the trivial instruction. Pick a model with better instruction-following / tool-use.",
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

/* /agent/install : agent loop with run_command tool + auto-install */
app.post("/agent/install", async (req, res) => {
    const { apiKey, model, instruction, files = [], runtime = "node", maxSteps = 12 } = req.body || {};
    if (!apiKey || !model || !instruction) {
        return res.status(400).json({ error: "apiKey, model, and instruction are required" });
    }
    // Cheap re-verify
    const ping = await mistralChat({
        apiKey, model,
        messages: [
            { role: "system", content: "Reply with the single word: PONG" },
            { role: "user", content: "ping" },
        ],
    });
    if (!ping.ok || !/pong/i.test(ping.json?.choices?.[0]?.message?.content ?? "")) {
        return res.status(400).json({
            error: "Mistral key/model failed verification. Call /agent/test first.",
            detail: ping.json?.error?.message || ping.json,
        });
    }

    const workspace = path.join(SANDBOX_ROOT, uuid());
    fs.mkdirSync(workspace, { recursive: true });
    writeFiles(workspace, files);

    const tools = [{
        type: "function",
        function: {
            name: "run_command",
            description:
                "Run a shell command (bash -lc) in the sandbox workspace. If a required CLI is missing, the sandbox will try to auto-install it via apt-get/npm/pip and retry once. Use this to install dependencies, scaffold files, or run build steps.",
            parameters: {
                type: "object",
                properties: { command: { type: "string", description: "Full bash command line." } },
                required: ["command"],
            },
        },
    }];

    const messages = [
        {
            role: "system",
            content:
                "You are an installation agent inside an ephemeral Linux sandbox (Debian + Node 20, Python 3, Go, Rust, Java 17/21 preinstalled). " +
                "You have a single tool: run_command. The sandbox auto-installs common missing CLIs (pnpm, bun, deno, ts-node, ffmpeg, psql, sqlite3, etc.) and retries the command — so just run what you need; if the result reports autoInstalled, take the retry result as truth. " +
                "Cap each command to ~60s of work. When finished, reply with a short summary and stop calling tools.",
        },
        { role: "user", content: instruction },
    ];

    const transcript = [];
    let finalMessage = "";

    for (let step = 0; step < maxSteps; step++) {
        const { ok, status, json } = await mistralChat({
            apiKey, model, messages, tools, tool_choice: "auto",
        });
        if (!ok) {
            return res.status(status).json({
                error: json?.error?.message || `Mistral returned ${status}`,
                transcript, workspace,
            });
        }
        const msg = json?.choices?.[0]?.message;
        if (!msg) return res.status(500).json({ error: "No message from model", json, transcript, workspace });
        messages.push(msg);

        const calls = msg.tool_calls || [];
        if (calls.length === 0) { finalMessage = msg.content || ""; break; }

        for (const call of calls) {
            let parsed = {};
            try { parsed = JSON.parse(call.function?.arguments || "{}"); } catch {}
            const cmd = parsed.command || "";
            const result = await execWithAutoInstall(runtime, cmd, workspace, 60000);
            transcript.push({ step, command: cmd, ...result });
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function?.name,
                content: JSON.stringify({
                    stdout: result.stdout?.slice(-4000) ?? "",
                    stderr: result.stderr?.slice(-4000) ?? "",
                    exitCode: result.exitCode,
                    autoInstalled: result.autoInstalled,
                    error: result.error,
                }),
            });
        }
    }

    res.json({ workspace, runtime, finalMessage, steps: transcript.length, transcript });
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
    console.log("Sandbox runtime online (auto-install + Mistral install agent)");
});
