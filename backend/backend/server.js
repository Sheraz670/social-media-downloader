const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");

const {
  createReadStream,
  unlink,
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync
} = require("fs");

const { promisify } = require("util");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const youtubedl = require("youtube-dl-exec");

const unlinkAsync = promisify(unlink);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const ALLOWED_DIRECT_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "image/jpeg",
  "image/png",
  "image/webp"
];

/*
==================================================
AUDIO JOB STORAGE
==================================================
*/

const audioJobs = new Map();

const AUDIO_JOB_LIFETIME =
  60 * 60 * 1000;

function createJobId() {
  return crypto.randomBytes(24).toString("hex");
}

function saveAudioJob(jobId, job) {
  audioJobs.set(jobId, {
    ...job,
    createdAt: Date.now()
  });

  setTimeout(() => {
    const current = audioJobs.get(jobId);

    if (!current) {
      return;
    }

    audioJobs.delete(jobId);

    try {
      if (current.tempDir) {
        rmSync(current.tempDir, {
          recursive: true,
          force: true
        });
      }
    } catch (error) {
      console.error(
        "AUDIO CLEANUP ERROR:",
        error
      );
    }
  }, AUDIO_JOB_LIFETIME);
}

function getAudioJob(jobId) {
  const job = audioJobs.get(jobId);

  if (!job) {
    throw new Error(
      "Audio file not found or expired. Please submit the video URL again."
    );
  }

  if (
    Date.now() - job.createdAt >
    AUDIO_JOB_LIFETIME
  ) {
    audioJobs.delete(jobId);

    try {
      if (job.tempDir) {
        rmSync(job.tempDir, {
          recursive: true,
          force: true
        });
      }
    } catch {}

    throw new Error(
      "Audio file has expired. Please submit the video URL again."
    );
  }

  if (!existsSync(job.audioFile)) {
    audioJobs.delete(jobId);

    throw new Error(
      "Audio file is no longer available."
    );
  }

  return job;
}

/*
==================================================
URL HELPERS
==================================================
*/

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1"
  ) {
    return true;
  }

  if (
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }

  if (host.startsWith("172.")) {
    const second =
      Number(host.split(".")[1]);

    if (
      second >= 16 &&
      second <= 31
    ) {
      return true;
    }
  }

  return false;
}

function validateUrl(url) {
  if (!url) {
    throw new Error(
      "Missing url parameter."
    );
  }

  if (!isValidHttpUrl(url)) {
    throw new Error(
      "Invalid HTTP/HTTPS URL."
    );
  }

  const parsed = new URL(url);

  if (
    isPrivateHostname(
      parsed.hostname
    )
  ) {
    throw new Error(
      "Private/local URLs are not allowed."
    );
  }

  return parsed;
}

function getPlatform(url) {
  const host =
    new URL(url)
      .hostname
      .toLowerCase();

  if (
    host.includes("youtube.com") ||
    host === "youtu.be"
  ) {
    return "youtube";
  }

  if (
    host.includes("tiktok.com") ||
    host === "vm.tiktok.com" ||
    host === "vt.tiktok.com"
  ) {
    return "tiktok";
  }

  if (
    host.includes("instagram.com")
  ) {
    return "instagram";
  }

  if (
    host.includes("facebook.com") ||
    host === "fb.watch" ||
    host.endsWith(".facebook.com")
  ) {
    return "facebook";
  }

  return "other";
}

function isSocialMediaUrl(url) {
  const platform =
    getPlatform(url);

  return (
    platform === "youtube" ||
    platform === "instagram" ||
    platform === "tiktok" ||
    platform === "facebook"
  );
}

/*
==================================================
DIRECT MEDIA
==================================================
*/

async function getDirectMediaInfo(url) {
  const response =
    await fetch(url, {
      method: "HEAD",
      redirect: "follow"
    });

  if (!response.ok) {
    throw new Error(
      `Remote server returned HTTP ${response.status}.`
    );
  }

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const normalizedType =
    contentType
      .split(";")[0]
      .toLowerCase();

  if (
    !ALLOWED_DIRECT_TYPES.includes(
      normalizedType
    )
  ) {
    return null;
  }

  const contentLength =
    response.headers.get(
      "content-length"
    );

  let size = "Unknown";

  if (contentLength) {
    const bytes =
      Number(contentLength);

    if (!Number.isNaN(bytes)) {
      size =
        `${(
          bytes /
          (1024 * 1024)
        ).toFixed(2)} MB`;
    }
  }

  const parsed =
    new URL(url);

  const filename =
    decodeURIComponent(
      parsed.pathname.split("/").pop() ||
      "media-file"
    );

  return {
    title: filename,
    contentType: normalizedType,
    size,
    downloadable: true,
    direct: true
  };
}

/*
==================================================
YT-DLP OPTIONS
==================================================
*/

function getYtDlpOptions(
  url,
  forDownload = false
) {
  const platform =
    getPlatform(url);

  const options = {
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true
  };

  /*
  ================================================
  YOUTUBE
  ================================================
  */

  if (platform === "youtube") {
  options.jsRuntimes = "node";
  }
    /*
      EJS is installed through requirements.txt:
        yt-dlp-ejs

      Do NOT use:
        remoteComponents: "ejs:npm"

      with Node.

  /*
  ================================================
  DOWNLOAD FORMAT
  ================================================
  */

  if (forDownload) {

    if (platform === "facebook") {

      options.format =
        "bestvideo+bestaudio/best";

      options.mergeOutputFormat =
        "mp4";

    } else {

      options.format =
        "best[ext=mp4]/best";
    }
  }

  return options;
}
/*
==================================================
SOCIAL MEDIA INFO
==================================================
*/

async function extractSocialMedia(url) {
  const result =
    await youtubedl(url, {
      dumpSingleJson: true,
      skipDownload: true,
      ...getYtDlpOptions(url)
    });

  if (!result) {
    throw new Error(
      "Unable to extract media information."
    );
  }

  return result;
}

/*
==================================================
RUN YT-DLP
==================================================
*/

function runYtDlpProcess(
  url,
  options
) {
  return new Promise(
    (resolve, reject) => {

      const subprocess =
        youtubedl.exec(
          url,
          options,
          {
            maxBuffer:
              1024 * 1024 * 50
          }
        );

      let stderr = "";

      if (subprocess.stderr) {
        subprocess.stderr.on(
          "data",
          (data) => {

            const message =
              data.toString();

            stderr += message;

            console.error(
              "yt-dlp:",
              message
            );
          }
        );
      }

      subprocess.on(
        "error",
        reject
      );

      subprocess.on(
        "close",
        (code) => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                stderr.trim() ||
                `yt-dlp exited with code ${code}.`
              )
            );
          }

        }
      );

    }
  );
}

/*
==================================================
FIND DOWNLOADED AUDIO
==================================================
*/

function findDownloadedFile(
  directory,
  prefix
) {
  const files =
    readdirSync(directory);

  const match =
    files.find(
      (file) =>
        file.startsWith(prefix)
    );

  if (!match) {
    throw new Error(
      "yt-dlp did not create the expected audio file."
    );
  }

  return path.join(
    directory,
    match
  );
}

/*
==================================================
RUN FFMPEG
==================================================
*/

function runFfmpeg(
  inputFile,
  outputFile
) {
  return new Promise(
    (resolve, reject) => {

      const ffmpeg =
        spawn(
          "ffmpeg",
          [
            "-y",

            "-i",
            inputFile,

            "-ac",
            "1",

            "-ar",
            "16000",

            "-b:a",
            "64k",

            outputFile
          ]
        );

      let stderr = "";

      ffmpeg.stderr.on(
        "data",
        (data) => {
          stderr +=
            data.toString();
        }
      );

      ffmpeg.on(
        "error",
        reject
      );

      ffmpeg.on(
        "close",
        (code) => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                stderr.trim() ||
                "FFmpeg audio conversion failed."
              )
            );
          }

        }
      );

    }
  );
}

/*
==================================================
HOME
==================================================
*/

app.get("/", (req, res) => {
  res.json({
    service:
      "SocialToolHub Media API",
    status: "online"
  });
});

/*
==================================================
MEDIA INFO
==================================================
*/

app.get(
  "/api/media",
  async (req, res) => {

    try {

      const url =
        req.query.url;

      validateUrl(url);

      const directInfo =
        await getDirectMediaInfo(
          url
        ).catch(
          () => null
        );

      if (directInfo) {
        return res.json(
          directInfo
        );
      }

      if (
        !isSocialMediaUrl(url)
      ) {
        return res.status(415).json({
          error:
            "Please provide a supported public media URL."
        });
      }

      const info =
        await extractSocialMedia(
          url
        );

      const title =
        info.title ||
        info.fulltitle ||
        "Social media video";

      const duration =
        typeof info.duration ===
        "number"
          ? `${Math.round(
              info.duration
            )} seconds`
          : "Unknown";

      return res.json({
        title,
        contentType:
          "video/mp4",
        size:
          "Available on download",
        duration,
        downloadable: true,
        direct: false,
        platform:
          getPlatform(url)
      });

    } catch (error) {

      console.error(
        "MEDIA ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to inspect this media URL."
      });

    }

  }
);

/*
==================================================
STEP 1:
VIDEO URL -> AUDIO FILE
==================================================
*/

app.post(
  "/api/prepare-audio",
  async (req, res) => {

    let tempDir = null;

    try {

      const url =
        req.body?.url;

      validateUrl(url);

      if (
        !isSocialMediaUrl(url)
      ) {
        return res.status(415).json({
          error:
            "Please provide a supported YouTube, TikTok, Instagram, or Facebook URL."
        });
      }

      tempDir =
        mkdtempSync(
          path.join(
            os.tmpdir(),
            "socialtoolhub-audio-"
          )
        );

      const audioPrefix =
        "source-audio";

      const audioTemplate =
        path.join(
          tempDir,
          `${audioPrefix}.%(ext)s`
        );

      const finalAudio =
        path.join(
          tempDir,
          "speech.mp3"
        );

      console.log(
        "Preparing audio from:",
        url
      );

      /*
        Only bestaudio is downloaded.
        Full video is NOT downloaded.
      */

      await runYtDlpProcess(
        url,
        {
          output:
            audioTemplate,

          format:
            "bestaudio/best",

          ...getYtDlpOptions(
            url
          )
        }
      );

      const originalAudio =
        findDownloadedFile(
          tempDir,
          audioPrefix
        );

      console.log(
        "Audio extracted:",
        originalAudio
      );

      console.log(
        "Converting audio for Whisper..."
      );

      await runFfmpeg(
        originalAudio,
        finalAudio
      );

      try {
        if (
          existsSync(
            originalAudio
          )
        ) {
          await unlinkAsync(
            originalAudio
          );
        }
      } catch {}

      if (
        !existsSync(finalAudio)
      ) {
        throw new Error(
          "FFmpeg did not create the final audio file."
        );
      }

      const jobId =
        createJobId();

      /*
        Get title separately.
        If metadata fails, audio still remains usable.
      */

      const info =
        await extractSocialMedia(
          url
        ).catch(
          () => ({})
        );

      const title =
        info.title ||
        info.fulltitle ||
        "Social media audio";

      saveAudioJob(
        jobId,
        {
          url,
          title,
          audioFile:
            finalAudio,
          tempDir
        }
      );

      /*
        Keep tempDir alive because
        Whisper needs the audio later.
      */

      tempDir = null;

      return res.json({
        success: true,

        jobId,

        title,

        audioUrl:
          `/api/audio/${jobId}`,

        transcriptUrl:
          `/api/transcribe/${jobId}`,

        message:
          "Audio is ready. Press Transcript to generate the script."
      });

    } catch (error) {

      console.error(
        "PREPARE AUDIO ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to prepare audio."
      });

    } finally {

      if (tempDir) {

        try {
          rmSync(
            tempDir,
            {
              recursive: true,
              force: true
            }
          );
        } catch {}

      }

    }

  }
);

/*
==================================================
STEP 2:
SERVE AUDIO FILE
==================================================
*/

app.get(
  "/api/audio/:jobId",
  async (req, res) => {

    try {

      const job =
        getAudioJob(
          req.params.jobId
        );

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Disposition",
        'inline; filename="socialtoolhub-audio.mp3"'
      );

      return createReadStream(
        job.audioFile
      ).pipe(res);

    } catch (error) {

      console.error(
        "AUDIO ERROR:",
        error
      );

      return res.status(404).json({
        error:
          error.message ||
          "Audio file unavailable."
      });

    }

  }
);

/*
==================================================
STEP 3:
AUDIO -> WHISPER -> TRANSCRIPT
==================================================
*/

app.post(
  "/api/transcribe/:jobId",
  async (req, res) => {

    try {

      const job =
        getAudioJob(
          req.params.jobId
        );

      console.log(
        "Starting Whisper transcription..."
      );

      const pythonFile =
        path.join(
          __dirname,
          "transcribe.py"
        );

      if (
        !existsSync(pythonFile)
      ) {
        throw new Error(
          "transcribe.py was not found on the server."
        );
      }

      const pythonProcess =
        spawn(
          "python3",
          [
            pythonFile,
            job.audioFile
          ]
        );

      let stdout = "";
      let stderr = "";

      pythonProcess.stdout.on(
        "data",
        (data) => {
          stdout +=
            data.toString();
        }
      );

      pythonProcess.stderr.on(
        "data",
        (data) => {

          stderr +=
            data.toString();

          console.error(
            "Whisper:",
            data.toString()
          );

        }
      );

      const exitCode =
        await new Promise(
          (resolve, reject) => {

            pythonProcess.on(
              "error",
              reject
            );

            pythonProcess.on(
              "close",
              resolve
            );

          }
        );

      if (exitCode !== 0) {

        throw new Error(
          stderr.trim() ||
          "Whisper transcription failed."
        );

      }

      let result;

      try {

        result =
          JSON.parse(
            stdout.trim()
          );

      } catch {

        throw new Error(
          "Invalid response received from Whisper."
        );

      }

      if (result.error) {
        throw new Error(
          result.error
        );
      }

      if (!result.text) {
        throw new Error(
          "No speech was detected in this audio."
        );
      }

      return res.json({

        success: true,

        language:
          result.language ||
          "unknown",

        text:
          result.text,

        title:
          job.title

      });

    } catch (error) {

      console.error(
        "TRANSCRIPTION ERROR:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to generate script."
      });

    }

  }
);

/*
==================================================
DOWNLOAD
==================================================
*/

app.get(
  "/api/download",
  async (req, res) => {

    let tempDir = null;

    try {

      const url =
        req.query.url;

      validateUrl(url);

      /*
        First check if this is a direct media URL.
      */

      const directResponse =
        await fetch(
          url,
          {
            redirect: "follow"
          }
        );

      const directType =
        (
          directResponse.headers.get(
            "content-type"
          ) || ""
        )
          .split(";")[0]
          .toLowerCase();

      if (
        directResponse.ok &&
        ALLOWED_DIRECT_TYPES.includes(
          directType
        )
      ) {

        const parsed =
          new URL(url);

        const filename =
          (
            decodeURIComponent(
              parsed.pathname
                .split("/")
                .pop() ||
                "download"
            )
          ).replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );

        res.setHeader(
          "Content-Type",
          directType
        );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );

        if (
          directResponse.body
        ) {

          return Readable.fromWeb(
            directResponse.body
          ).pipe(res);

        }

      }

      if (
        !isSocialMediaUrl(url)
      ) {

        return res.status(415).json({
          error:
            "This URL is not a supported downloadable media URL."
        });

      }

      /*
        Download social media video.
      */

      tempDir =
        mkdtempSync(
          path.join(
            os.tmpdir(),
            "socialtoolhub-download-"
          )
        );

      const outputTemplate =
        path.join(
          tempDir,
          "video.%(ext)s"
        );

      const platform =
        getPlatform(url);

      await runYtDlpProcess(
        url,
        {
          output:
            outputTemplate,

          ...getYtDlpOptions(
            url,
            true
          )
        }
      );

      const files =
        readdirSync(tempDir);

      const downloadedFile = files.find((file) => file.startsWith("video."));
      if (!downloadedFile) {
  throw new Error(
    "Downloaded video file was not found."
  );
}

const downloadedPath = path.join(
  tempDir,
  downloadedFile
);

const extension = path.extname(
  downloadedPath
).toLowerCase();

let contentType = "video/mp4";

if (extension === ".webm") {
  contentType = "video/webm";
}

if (extension === ".mov") {
  contentType = "video/quicktime";
}

const safeName =
  platform === "facebook"
    ? "socialtoolhub-facebook-video"
    : `socialtoolhub-${platform}-video`;

res.setHeader(
  "Content-Type",
  contentType
);

res.setHeader(
  "Content-Disposition",
  `attachment; filename="${safeName}${extension}"`
);

const readStream =
  createReadStream(downloadedPath);

readStream.on(
  "error",
  (error) => {
    console.error(
      "DOWNLOAD STREAM ERROR:",
      error
    );

    if (!res.headersSent) {
      res.status(500).json({
        error:
          "Unable to stream downloaded media."
      });
    } else {
      res.destroy(error);
    }
  }
);

readStream.on(
  "close",
  () => {
    try {
      if (tempDir) {
        rmSync(
          tempDir,
          {
            recursive: true,
            force: true
          }
        );

        tempDir = null;
      }
    } catch {}
  }
);

return readStream.pipe(res);

} catch (error) {
  console.error(
    "DOWNLOAD ERROR:",
    error
  );

  if (tempDir) {
    try {
      rmSync(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }

  if (!res.headersSent) {
    return res.status(500).json({
      error:
        error.message ||
        "Unable to download this media."
    });
  }
}
});

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    return res.status(500).json({
      error:
        error.message ||
        "Internal server error."
    });
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `SocialToolHub API running on port ${PORT}`
    );
  }
);
