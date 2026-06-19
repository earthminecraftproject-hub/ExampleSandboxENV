import express from "express";
import { exec } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/run", (req, res) => {
  const { cmd } = req.body;

  exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
    res.json({
      stdout: stdout || "",
      stderr: stderr || "",
      error: err ? err.message : null
    });
  });
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("Sandbox ready");
});
