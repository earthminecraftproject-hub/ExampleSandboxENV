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

function uuid() { return crypto.randomUUID(); }

function writeFiles(workspace, files = []) {
    for (const f of files) {
        const full = path.join(workspace, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
    }
}

/* ------------------------- Runtime env ------------------------- */
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

/* ------------------------- Command exec ------------------------- */
function run(bin, args, cwd, env, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const child = spawn(bin, args, { cwd, env, shell: false, detached: true });
        let stdout = "", stderr = "";
        const timeout = setTimeout(() => {
            try { process.kill(-child.pid); } catch {}
            resolve({ stdout, stderr, exitCode: 124, error: "Timeout" });
        }, timeoutMs);
        child.stdout.on("data", d => stdout += d.toString());
        child.stderr.on("data", d => stderr += d.toString());
        child.on("close", code => { clearTimeout(timeout); resolve({ stdout, stderr, exitCode: code }); });
        child.on("error", err => { clearTimeout(timeout); resolve({ stdout, stderr, exitCode: 1, error: err.message }); });
    });
}

function parseCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    return { bin: parts[0], args: parts.slice(1) };
}

async function execute(runtime, command, workspace, timeoutMs) {
    const { bin, args } = parseCommand(command);
    return await run(bin, args, workspace, resolveEnv(runtime), timeoutMs);
}

/* ------------------------- Standard /run ------------------------- */
app.post("/run", async (req, res) => {
    const { runtime = "node", command, files = [] } = req.body;
    const workspace = path.join(SANDBOX_ROOT, uuid());
    fs.mkdirSync(workspace, { recursive: true });
    try {
        writeFiles(workspace, files);
        const result = await execute(runtime, command, workspace);
        res.json({ workspace, runtime, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use("/preview", express.static(SANDBOX_ROOT));

/* =========================================================
   Mistral-powered Installation Agent
   - Users bring their OWN Mistral API key + model.
   - /agent/test  : MUST pass before /agent/install is allowed.
   - /agent/install: loops the model with a `run_command` tool
     inside a fresh sandbox workspace to install/scaffold things.
   ========================================================= */

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

async function mistralChat({ apiKey, model, messages, tools, tool_choice }) {
    const body = { model, messages };
    if (tools) body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
    const r = await fetch(MISTRAL_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: r.status, ok: r.ok, json };
}

/* ---- /agent/test : validate key + model with a tiny ping ---- */
app.post("/agent/test", async (req, res) => {
    const { apiKey, model } = req.body || {};
    if (!apiKey || !model) {
        return res.status(400).json({ ok: false, error: "apiKey and model are required" });
    }
    try {
        const { status, ok, json } = await mistralChat({
            apiKey, model,
            messages: [
                { role: "system", content: "Reply with the single word: PONG" },
                { role: "user", content: "ping" },
            ],
        });
        if (!ok) {
            return res.status(status).json({
                ok: false,
                error: json?.error?.message || json?.message || `Mistral returned ${status}`,
                model,
            });
        }
        const reply = json?.choices?.[0]?.message?.content ?? "";
        const passed = /pong/i.test(reply);
        return res.json({
            ok: passed,
            model,
            reply,
            note: passed
                ? "Key + model verified. You may now call /agent/install."
                : "Model responded but did not follow the trivial instruction. Pick a model that supports tool-use / instruction following.",
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

/* ---- /agent/install : agentic loop with run_command tool ----
   Body: { apiKey, model, instruction, files?, runtime?, maxSteps? }
   Each step the model may call run_command({command}) which we
   execute in the workspace. Stops when the model returns a final
   message with no tool calls, or maxSteps reached.
------------------------------------------------------------- */
app.post("/agent/install", async (req, res) => {
    const {
        apiKey, model, instruction,
        files = [], runtime = "node",
        maxSteps = 12,
    } = req.body || {};
    if (!apiKey || !model || !instruction) {
        return res.status(400).json({ error: "apiKey, model, and instruction are required" });
    }

    // Re-verify before doing real work (cheap insurance)
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
            description: "Execute a shell command inside the sandbox workspace. Use this to install packages, scaffold files, run build steps, etc.",
            parameters: {
                type: "object",
                properties: {
                    command: { type: "string", description: "Full command line, e.g. 'npm install express'" },
                },
                required: ["command"],
            },
        },
    }];

    const messages = [
        {
            role: "system",
            content:
                "You are an installation agent running inside an ephemeral Linux sandbox at /sandbox. " +
                "Use the run_command tool to install dependencies and scaffold what the user asks. " +
                "Each command has a 60s timeout. When finished, reply with a short summary and DO NOT call any more tools.",
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
        if (!msg) {
            return res.status(500).json({ error: "No message from model", json, transcript, workspace });
        }
        messages.push(msg);

        const calls = msg.tool_calls || [];
        if (calls.length === 0) {
            finalMessage = msg.content || "";
            break;
        }
        for (const call of calls) {
            let parsed = {};
            try { parsed = JSON.parse(call.function?.arguments || "{}"); } catch {}
            const cmd = parsed.command || "";
            const result = await execute(runtime, cmd, workspace, 60000);
            transcript.push({ step, command: cmd, ...result });
            messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function?.name,
                content: JSON.stringify({
                    stdout: result.stdout?.slice(-4000) ?? "",
                    stderr: result.stderr?.slice(-4000) ?? "",
                    exitCode: result.exitCode,
                    error: result.error,
                }),
            });
        }
    }

    res.json({ workspace, runtime, finalMessage, steps: transcript.length, transcript });
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
    console.log("Sandbox runtime online (with Mistral install agent)");
});
