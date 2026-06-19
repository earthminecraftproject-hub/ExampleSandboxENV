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

/* -----------------------------
   Utilities
------------------------------*/

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

/* -----------------------------
   Safe command parser
------------------------------*/

function parseCommand(cmd) {
    const parts = cmd.trim().split(/\s+/);
    return {
        bin: parts[0],
        args: parts.slice(1)
    };
}

/* -----------------------------
   Forbidden commands
------------------------------*/

const FORBIDDEN = new Set([
    "sudo",
    "shutdown",
    "reboot",
    "mkfs",
    "mount",
    "umount",
    "iptables",
    "docker"
]);

function isForbidden(bin) {
    return FORBIDDEN.has(bin);
}

/* -----------------------------
   Executor (spawn-based)
------------------------------*/

function run(bin, args, cwd) {
    return new Promise((resolve) => {

        const start = Date.now();

        const child = spawn(bin, args, {
            cwd,
            shell: false
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", d => stdout += d.toString());
        child.stderr.on("data", d => stderr += d.toString());

        child.on("close", code => {
            resolve({
                stdout,
                stderr,
                exitCode: code,
                durationMs: Date.now() - start
            });
        });

        child.on("error", err => {
            resolve({
                stdout,
                stderr,
                exitCode: 1,
                error: err.message
            });
        });
    });
}

/* -----------------------------
   Auto-heal (basic v1)
------------------------------*/

async function autoHeal(workspace, bin, args, result) {

    const stderr = result.stderr || "";

    // Node missing module
    if (stderr.includes("Cannot find module")) {
        await run("npm", ["install"], workspace);
        return true;
    }

    // Python missing deps
    if (stderr.includes("ModuleNotFoundError")) {
        if (fs.existsSync(path.join(workspace, "requirements.txt"))) {
            await run("pip3", ["install", "-r", "requirements.txt"], workspace);
            return true;
        }
    }

    // Go module missing
    if (stderr.includes("go.mod")) {
        await run("go", ["mod", "init", "sandbox"], workspace);
        return true;
    }

    // Rust rebuild
    if (stderr.includes("cargo")) {
        await run("cargo", ["build"], workspace);
        return true;
    }

    return false;
}

/* -----------------------------
   Runtime router
------------------------------*/

async function execute(runtime, command, workspace) {

    const { bin, args } = parseCommand(command);

    if (isForbidden(bin)) {
        return { error: "Forbidden command" };
    }

    let result = await run(bin, args, workspace);

    const healed = await autoHeal(workspace, bin, args, result);

    if (healed) {
        result = await run(bin, args, workspace);
        result.repaired = true;
    }

    return result;
}

/* -----------------------------
   API: /run
------------------------------*/

app.post("/run", async (req, res) => {

    const {
        runtime = "node",
        command,
        files = []
    } = req.body;

    const workspace = path.join(SANDBOX_ROOT, uuid());
    fs.mkdirSync(workspace, { recursive: true });

    try {
        // Write incoming files
        writeFiles(workspace, files);

        const result = await execute(runtime, command, workspace);

        res.json({
            workspace,
            runtime,
            ...result
        });

    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* -----------------------------
   HTML preview (static)
------------------------------*/

app.use("/preview", express.static(SANDBOX_ROOT));

/* -----------------------------
   Start server
------------------------------*/

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
    console.log("Universal Sandbox (hardened) running");
});