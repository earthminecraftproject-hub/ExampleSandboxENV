import express from "express";
import cors from "cors";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ------------------------------
// Utility: Run shell commands
// ------------------------------
function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000, shell: "/bin/bash" }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || "",
        stderr: stderr || "",
        error: err ? err.message : null
      });
    });
  });
}

// ------------------------------
// Auto‑Installer: Gradle Wrapper
// ------------------------------
async function ensureGradleWrapper() {
  if (fs.existsSync("gradlew") && fs.existsSync("gradle/wrapper/gradle-wrapper.jar")) {
    return;
  }

  console.log("[AUTO-INSTALL] Generating Gradle wrapper...");

  fs.mkdirSync("gradle/wrapper", { recursive: true });

  // Download wrapper JAR + properties
  await run(`curl -s https://raw.githubusercontent.com/gradle/gradle/master/gradle/wrapper/gradle-wrapper.jar -o gradle/wrapper/gradle-wrapper.jar`);
  await run(`curl -s https://raw.githubusercontent.com/gradle/gradle/master/gradle/wrapper/gradle-wrapper.properties -o gradle/wrapper/gradle-wrapper.properties`);

  // Create gradlew script
  fs.writeFileSync("gradlew", `#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/gradle/wrapper/gradle-wrapper.jar" "$@"`);

  fs.chmodSync("gradlew", 0o755);

  console.log("[AUTO-INSTALL] Gradle wrapper installed.");
}

// ------------------------------
// Auto‑Installer: Node project
// ------------------------------
async function ensureNodeProject() {
  if (!fs.existsSync("package.json")) {
    console.log("[AUTO-INSTALL] Creating package.json...");
    fs.writeFileSync("package.json", JSON.stringify({
      name: "sandbox-project",
      version: "1.0.0",
      dependencies: {}
    }, null, 2));
  }
}

// ------------------------------
// Auto‑Installer: Python project
// ------------------------------
async function ensurePythonProject() {
  if (!fs.existsSync("requirements.txt")) {
    console.log("[AUTO-INSTALL] Creating requirements.txt...");
    fs.writeFileSync("requirements.txt", "");
  }
}

// ------------------------------
// Auto‑Installer: Rust project
// ------------------------------
async function ensureRustProject() {
  if (!fs.existsSync("Cargo.toml")) {
    console.log("[AUTO-INSTALL] Running cargo init...");
    await run("cargo init --quiet");
  }
}

// ------------------------------
// Auto‑Installer: Go project
// ------------------------------
async function ensureGoProject() {
  if (!fs.existsSync("go.mod")) {
    console.log("[AUTO-INSTALL] Running go mod init...");
    await run("go mod init sandbox");
  }
}

// ------------------------------
// Command Interceptor
// ------------------------------
async function autoInstallForCommand(cmd) {
  if (cmd.includes("gradlew")) {
    await ensureGradleWrapper();
  }

  if (cmd.startsWith("npm") || cmd.startsWith("node")) {
    await ensureNodeProject();
  }

  if (cmd.startsWith("python") || cmd.startsWith("pip")) {
    await ensurePythonProject();
  }

  if (cmd.startsWith("cargo")) {
    await ensureRustProject();
  }

  if (cmd.startsWith("go ")) {
    await ensureGoProject();
  }
}

// ------------------------------
// Main /run endpoint
// ------------------------------
app.post("/run", async (req, res) => {
  const { cmd } = req.body;

  console.log("[COMMAND]", cmd);

  // Auto‑installer logic
  await autoInstallForCommand(cmd);

  // Execute command
  const result = await run(cmd);
  res.json(result);
});

// ------------------------------
// Start server
// ------------------------------
app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("Universal Sandbox ready");
});

