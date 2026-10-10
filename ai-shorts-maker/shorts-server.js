
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3001;

const uploadDir = path.join(__dirname, "uploads");
const clipsDir = path.join(__dirname, "clips");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(clipsDir, { recursive: true });

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
app.use(express.json({ limit: "1mb" }));
app.use("/clips", express.static(clipsDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "shorts-maker.html"));
});

app.get("/api/shorts/health", (req, res) => {
  res.json({
    service: "SocialToolHub AI Shorts Maker",
    status: "online"
  });
});

function runCommand(command, args, maxBuffer = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", data => {
      stdout += data.toString();

      if (stdout.length > maxBuffer) {
        child.kill();
      }
    });

    child.stderr.on("data", data => {
      stderr += data.toString();
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(
          new Error(stderr.slice(-3000) || "Command failed.")
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function getMediaPath(uploadId) {
  if (!/^[a-f0-9]+$/i.test(uploadId)) {
    throw new Error("Invalid upload ID.");
  }

  const mediaPath = path.join(uploadDir, uploadId);

  if (!fs.existsSync(mediaPath)) {
    throw new Error("Uploaded video was not found.");
  }

  return mediaPath;
}

async function transcribeMedia(mediaPath) {
  const python = process.env.PYTHON || "python3";

  const result = await runCommand(python, [
    path.join(__dirname, "transcribe.py"),
    mediaPath
  ]);

  let data;

  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error("Could not read caption results.");
  }

  if (data.error) {
    throw new Error(data.error);
  }

  return data;
}

function formatSrtTime(seconds) {
  const milliseconds = Math.max(
    0,
    Math.round(seconds * 1000)
  );

  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(
    (milliseconds % 3600000) / 60000
  );
  const secs = Math.floor(
    (milliseconds % 60000) / 1000
  );
  const ms = milliseconds % 1000;

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(secs).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

function makeClipSrt(captions, clipStart, clipEnd) {
  const lines = [];
  let number = 1;

  for (const caption of captions) {
    const start = Math.max(caption.start, clipStart);
    const end = Math.min(caption.end, clipEnd);

    if (end <= start || !caption.text) {
      continue;
    }

    lines.push(
      String(number++),
      formatSrtTime(start - clipStart) +
        " --> " +
        formatSrtTime(end - clipStart),
      caption.text.replace(/-->/g, "→"),
      ""
    );
  }

  return lines.join("\n");
}

function escapeFilterPath(filePath) {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

/* ---------------------------------
   STEP 1: UPLOAD VIDEO FILE
---------------------------------- */

app.post("/api/shorts/upload", (req, res) => {
  upload.single("video")(req, res, err => {
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

/* ---------------------------------
   STEP 2: DOWNLOAD FROM VIDEO LINK
   Supported: YouTube and Facebook
---------------------------------- */

app.post("/api/shorts/from-link", async (req, res) => {
  let uploadId;

  try {
    const videoUrl = String(req.body.url || "").trim();

    if (!videoUrl) {
      return res.status(400).json({
        error: "Please paste a video link."
      });
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(videoUrl);
    } catch {
      return res.status(400).json({
        error: "Please enter a valid video URL."
      });
    }

    const host = parsedUrl.hostname.toLowerCase();

    const allowedHost =
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "fb.watch";

    if (
      parsedUrl.protocol !== "https:" ||
      !allowedHost ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      return res.status(400).json({
        error: "Use an HTTPS YouTube or Facebook video link."
      });
    }

    uploadId = crypto.randomBytes(16).toString("hex");

    const outputTemplate = path.join(
      uploadDir,
      uploadId + ".%(ext)s"
    );

    const python = process.env.PYTHON || "python3";

    await runCommand(python, [
      "-m", "yt_dlp",
      "--no-playlist",
        "--extractor-args",
  "youtube:player_client=tv,web_safari",
      "--no-warnings",
      "--max-filesize", "500M",
      "--match-filter", "duration <= 600",
      "--merge-output-format", "mp4",
      "-f", "best[height<=1080]/best",
      "-o", outputTemplate,
      videoUrl
    ]);

    const downloadedFile = fs.readdirSync(uploadDir).find(name =>
      name.startsWith(uploadId + ".") &&
      !name.endsWith(".part") &&
      !name.endsWith(".ytdl")
    );

    if (!downloadedFile) {
      throw new Error("Video download did not produce a file.");
    }

    const downloadedPath = path.join(uploadDir, downloadedFile);
    const mediaPath = path.join(uploadDir, uploadId);

    fs.renameSync(downloadedPath, mediaPath);

    res.json({
      message: "Video link processed successfully.",
      fileName: "Linked video",
      fileSize: fs.statSync(mediaPath).size,
      uploadId
    });

  } catch (error) {
    console.error("LINK VIDEO ERROR:", error.message);

    if (uploadId) {
      try {
        for (const name of fs.readdirSync(uploadDir)) {
          if (name.startsWith(uploadId + ".")) {
            fs.rmSync(path.join(uploadDir, name), {
              force: true
            });
          }
        }

        const mediaPath = path.join(uploadDir, uploadId);

        if (fs.existsSync(mediaPath)) {
          fs.rmSync(mediaPath, { force: true });
        }
      } catch {}
    }

    res.status(500).json({
      error:
        "Could not download this video. Check the link and Render logs. Private, restricted, or unsupported videos may not work."
    });
  }
});

/* ---------------------------------
   STEP 3: GENERATE CAPTIONS
---------------------------------- */

app.post("/api/shorts/transcribe/:uploadId", async (req, res) => {
  try {
    const mediaPath = getMediaPath(req.params.uploadId);
    const result = await transcribeMedia(mediaPath);

    res.json(result);
  } catch (error) {
    console.error("TRANSCRIBE ERROR:", error.message);

    res.status(500).json({
      error: error.message || "Caption processing failed."
    });
  }
});

/* ---------------------------------
   STEP 4: CREATE VERTICAL SHORTS
---------------------------------- */

app.post("/api/shorts/create-clips/:uploadId", async (req, res) => {
  try {
    const uploadId = req.params.uploadId;
    const mediaPath = getMediaPath(uploadId);

    const clipDuration = Number(req.body.clipDuration || 60);
    const clipCount = Number(req.body.clipCount || 5);

    if (![30, 60, 120].includes(clipDuration)) {
      return res.status(400).json({
        error: "Choose a clip duration of 30, 60, or 120 seconds."
      });
    }

    if (
      !Number.isInteger(clipCount) ||
      clipCount < 1 ||
      clipCount > 10
    ) {
      return res.status(400).json({
        error: "Choose between 1 and 10 clips."
      });
    }

    const transcript = await transcribeMedia(mediaPath);
    const totalDuration = Number(transcript.duration);

    if (!totalDuration || totalDuration <= 0) {
      throw new Error("Could not determine video duration.");
    }

    const clips = [];
    const numberToCreate = Math.min(
      clipCount,
      Math.ceil(totalDuration / clipDuration)
    );

    for (let index = 0; index < numberToCreate; index++) {
      const clipStart = index * clipDuration;
      const clipEnd = Math.min(
        clipStart + clipDuration,
        totalDuration
      );

      const clipName = `clip-${uploadId}-${index + 1}.mp4`;
      const outputPath = path.join(clipsDir, clipName);
      const srtPath = path.join(
        clipsDir,
        `clip-${uploadId}-${index + 1}.srt`
      );

      fs.writeFileSync(
        srtPath,
        makeClipSrt(
          transcript.captions || [],
          clipStart,
          clipEnd
        ),
        "utf8"
      );

      const subtitlePath = escapeFilterPath(srtPath);

      const videoFilter =
        "scale=720:1280:force_original_aspect_ratio=increase," +
        "crop=720:1280," +
        `subtitles='${subtitlePath}':` +
        "force_style='FontName=Arial,FontSize=18," +
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000," +
        "BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=100'";

      await runCommand("ffmpeg", [
        "-y",
        "-ss", String(clipStart),
        "-i", mediaPath,
        "-t", String(clipEnd - clipStart),
        "-vf", videoFilter,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath
      ]);

      clips.push({
        number: index + 1,
        start: clipStart,
        duration: Number((clipEnd - clipStart).toFixed(2)),
        url: `/clips/${clipName}`
      });
    }

    res.json({
      message: "Shorts clips created successfully.",
      totalClips: clips.length,
      format: "9:16",
      captionsBurnedIn: true,
      clips
    });
  } catch (error) {
    console.error("CREATE CLIPS ERROR:", error.message);

    res.status(500).json({
      error: error.message || "Could not create video clips."
    });
  }
});

/* ---------------------------------
   ERROR HANDLER
---------------------------------- */

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
                             
