const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3001;

const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype || !file.mimetype.startsWith("video/")) {
      return callback(new Error("Please upload a video file."));
    }
    callback(null, true);
  }
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "shorts-maker.html"));
});

app.get("/api/shorts/health", (req, res) => {
  res.json({
    service: "SocialToolHub AI Shorts Maker",
    status: "online"
  });
});

app.post("/api/shorts/upload", (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: err.message || "Video upload failed."
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: "Please select a video file."
      });
    }

    res.json({
      message: "Video uploaded successfully.",
      fileName: req.file.originalname,
      fileSize: req.file.size,
      uploadId: req.file.filename
    });
  });
});

app.post("/api/shorts/transcribe/:uploadId", (req, res) => {
  const uploadId = req.params.uploadId;

  if (!/^[a-f0-9]+$/i.test(uploadId)) {
    return res.status(400).json({
      error: "Invalid upload ID."
    });
  }

  const mediaPath = path.join(uploadDir, uploadId);

  if (!fs.existsSync(mediaPath)) {
    return res.status(404).json({
      error: "Uploaded video was not found."
    });
  }

  const python = process.env.PYTHON || "python3";

  const child = spawn(python, [
    path.join(__dirname, "transcribe.py"),
    mediaPath
  ]);

  let stdout = "";
  let stderr = "";
  let finished = false;

  child.stdout.on("data", data => {
    stdout += data.toString();

    if (stdout.length > 5 * 1024 * 1024) {
      child.kill();
    }
  });

  child.stderr.on("data", data => {
    stderr += data.toString();
  });

  child.on("error", error => {
    if (finished) return;
    finished = true;

    res.status(500).json({
      error: "Could not start Python. Check the Python setup.",
      details: error.message
    });
  });

  child.on("close", code => {
    if (finished || res.headersSent) return;
    finished = true;

    let result;
    console.error("TRANSCRIBE EXIT CODE:", code);
console.error("TRANSCRIBE STDOUT:", stdout.slice(-2000));
console.error("TRANSCRIBE STDERR:", stderr.slice(-2000));

    try {
      result = JSON.parse(stdout);
    } catch {
      return res.status(500).json({
        error: "Caption processing failed.",
        details: stderr.slice(-1000)
      });
    }

    if (code !== 0 || result.error) {
      return res.status(500).json({
        error: result.error || "Caption processing failed.",
        details: stderr.slice(-1000)
      });
    }

    res.json(result);
  });
});

app.use((err, req, res, next) => {
  console.error("AI SHORTS ERROR:", err.message);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: err.message || "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("AI Shorts Maker listening on port " + PORT);
});
