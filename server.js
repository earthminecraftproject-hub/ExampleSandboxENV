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

function uuid() {
    return crypto.randomUUID();
}

function writeFiles(workspace, files = []) {
    for (const f of files) {
        const full = path.join(workspace, f.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, f.content);
    }
}

/* -------------------------
   Runtime isolation layer
------------------------- */

function resolveEnv(runtime) {
    switch (runtime) {
        case "java17":
            return {
                ...process.env,
                JAVA_HOME: process.env.JAVA17_HOME,
                PATH: `${process.env.JAVA17_HOME}/bin:${process.env.PATH}`
            };

        case "java21":
            return {
                ...process.env,
                JAVA_HOME: process.env.JAVA21_HOME,
                PATH: `${process.env.JAVA21_HOME}/bin:${process.env.PATH}`
            };

        default:
            return process.env;
    }
}

/* -------------------------
   Command execution (hardened)
------------------------- */

function run(bin, args, cwd, env) {
    return new Promise((resolve) => {

        const child = spawn(bin, args, {
            cwd,
            env,
            shell: false,
            detached: true
        });

        let stdout = "";
        let stderr = "";

        const timeout = setTimeout(() => {
            try {
                process.kill(-child.pid); // kill process group
            } catch {}
            resolve({
                stdout,
                stderr,
                exitCode: 124,
                error: "Timeout"
            });
        }, 15000);

        child.stdout.on("data", d => stdout += d.toString());
        child.stderr.on("data", d => stderr += d.toString());

        child.on("close", code => {
            clearTimeout(timeout);
            resolve({
                stdout,
                stderr,
                exitCode: code,
                durationMs: Date.now()
            });
        });

        child.on("error", err => {
            clearTimeout(timeout);
            resolve({
                stdout,
                stderr,
                exitCode: 1,
                error: err.message
            });
        });
    });
}

/* -------------------------
   Command parsing (minimal safety layer)
------------------------- */

function parseCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    return {
        bin: parts[0],
        args: parts.slice(1)
    };
}

/* -------------------------
   Executor
------------------------- */

async function execute(runtime, command, workspace) {
    const { bin, args } = parseCommand(command);

    const env = resolveEnv(runtime);

    return await run(bin, args, workspace, env);
}

/* -------------------------
   API
------------------------- */

app.post("/run", async (req, res) => {

    const {
        runtime = "node",
        command,
        files = []
    } = req.body;

    const workspace = path.join(SANDBOX_ROOT, uuid());
    fs.mkdirSync(workspace, { recursive: true });

    try {
        writeFiles(workspace, files);

        const result = await execute(runtime, command, workspace);

        res.json({
            workspace,
            runtime,
            ...result
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.use("/preview", express.static(SANDBOX_ROOT));

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
    console.log("Sandbox runtime online");
});