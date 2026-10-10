const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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
  res.sendFile(
    path.join(__dirname, "shorts-maker.html")
  );
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

    return res.json({
      message: "Video uploaded successfully.",
      fileName: req.file.originalname,
      fileSize: req.file.size,
      uploadId: path.basename(req.file.filename)
    });
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
  console.log(
    `AI Shorts Maker listening on port ${PORT}`
  );
});
