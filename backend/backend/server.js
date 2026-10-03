const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");
const { createReadStream, unlink } = require("fs");
const { promisify } = require("util");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
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
    const second = Number(host.split(".")[1]);

    if (second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
}

function validateUrl(url) {
  if (!url) {
    throw new Error("Missing url parameter.");
  }

  if (!isValidHttpUrl(url)) {
    throw new Error("Invalid HTTP/HTTPS URL.");
  }

  const parsed = new URL(url);

  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("Private/local URLs are not allowed.");
  }

  return parsed;
}

function getPlatform(url) {
  const host = new URL(url).hostname.toLowerCase();

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

  if (host.includes("instagram.com")) {
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
  const platform = getPlatform(url);

  return (
    platform === "youtube" ||
    platform === "instagram" ||
    platform === "tiktok" ||
    platform === "facebook"
  );
}

async function getDirectMediaInfo(url) {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `Remote server returned HTTP ${response.status}.`
    );
  }

  const contentType =
    response.headers.get("content-type") || "";

  const normalizedType =
    contentType.split(";")[0].toLowerCase();

  if (!ALLOWED_DIRECT_TYPES.includes(normalizedType)) {
    return null;
  }

  const contentLength =
    response.headers.get("content-length");

  let size = "Unknown";

  if (contentLength) {
    const bytes = Number(contentLength);

    if (!Number.isNaN(bytes)) {
      size =
        `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }
  }

  const parsed = new URL(url);

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

function getYtDlpOptions(url, forDownload = false) {
  const platform = getPlatform(url);

  const options = {
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true
  };

  if (platform === "youtube") {
    options.jsRuntimes = "node";
    options.remoteComponents = "ejs:npm";
  }

  if (forDownload) {
    if (platform === "facebook") {
      options.format =
        "bestvideo+bestaudio/best";

      options.mergeOutputFormat = "mp4";
    } else {
      options.format =
        "best[ext=mp4]/best";
    }
  }

  return options;
}

async function extractSocialMedia(url) {
  const result = await youtubedl(url, {
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

function runYtDlpProcess(url, options) {
  return new Promise((resolve, reject) => {
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

    subprocess.stderr.on(
      "data",
      (data) => {
        const message = data.toString();

        stderr += message;

        console.error(
          "yt-dlp:",
          message
        );
      }
    );

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
  });
}

app.get("/", (req, res) => {
  res.json({
    service: "SocialToolHub Media API",
    status: "online"
  });
});

app.get("/api/media", async (req, res) => {
  try {
    const url = req.query.url;

    validateUrl(url);

    const directInfo =
      await getDirectMediaInfo(url).catch(
        () => null
      );

    if (directInfo) {
      return res.json(directInfo);
    }

    if (!isSocialMediaUrl(url)) {
      return res.status(415).json({
        error:
          "Please provide a supported public media URL."
      });
    }

    const info =
      await extractSocialMedia(url);

    const title =
      info.title ||
      info.fulltitle ||
      "Social media video";

    const duration =
      typeof info.duration === "number"
        ? `${Math.round(info.duration)} seconds`
        : "Unknown";

    return res.json({
      title,
      contentType: "video/mp4",
      size: "Available on download",
      duration,
      downloadable: true,
      direct: false,
      platform: getPlatform(url)
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
});

app.get("/api/download", async (req, res) => {
  let tempFile = null;

  try {
    const url = req.query.url;

    validateUrl(url);

    const directResponse =
      await fetch(url, {
        redirect: "follow"
      });

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
      ALLOWED_DIRECT_TYPES.includes(directType)
    ) {
      const parsed = new URL(url);

      const filename = (
        decodeURIComponent(
          parsed.pathname.split("/").pop() ||
          "download"
        )
      ).replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );

      res.setHeader(
        "Content-Type",
        directResponse.headers.get(
          "content-type"
        ) ||
          "application/octet-stream"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );

      if (directResponse.body) {
        return Readable.fromWeb(
          directResponse.body
        ).pipe(res);
      }
    }

    if (!isSocialMediaUrl(url)) {
      return res.status(415).json({
        error:
          "This URL is not a supported downloadable media URL."
      });
    }

    const platform = getPlatform(url);

    /*
      Facebook:
      Download video + audio separately,
      merge them into one MP4,
      then send the MP4 to the user.
    */
    if (platform === "facebook") {
      const randomName =
        `socialtoolhub-${crypto.randomUUID()}`;

      const outputTemplate =
        path.join(
          os.tmpdir(),
          `${randomName}.%(ext)s`
        );

      tempFile =
        path.join(
          os.tmpdir(),
          `${randomName}.mp4`
        );

      await runYtDlpProcess(
        url,
        {
          output: outputTemplate,

          ...getYtDlpOptions(
            url,
            true
          )
        }
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="socialtoolhub-facebook-video.mp4"`
      );

      const readStream =
        createReadStream(tempFile);

      readStream.on(
        "error",
        async (error) => {
          console.error(
            "FILE STREAM ERROR:",
            error
          );

          try {
            await unlinkAsync(tempFile);
          } catch {}

          if (!res.headersSent) {
            res.status(500).json({
              error:
                "Unable to send downloaded video."
            });
          }
        }
      );

      readStream.on(
        "close",
        async () => {
          try {
            await unlinkAsync(tempFile);
          } catch {}
        }
      );

      return readStream.pipe(res);
    }

    /*
      Existing TikTok / Instagram / YouTube flow.
    */
    const subprocess =
      youtubedl.exec(
        url,
        {
          output: "-",

          ...getYtDlpOptions(
            url,
            true
          )
        },
        {
          maxBuffer:
            1024 * 1024 * 50
        }
      );

    res.setHeader(
      "Content-Type",
      "video/mp4"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="socialtoolhub-${platform}-video.mp4"`
    );

    subprocess.stdout.pipe(res);

    subprocess.stderr.on(
      "data",
      (data) => {
        console.error(
          "yt-dlp:",
          data.toString()
        );
      }
    );

    subprocess.on(
      "error",
      (error) => {
        console.error(
          "DOWNLOAD ERROR:",
          error
        );

        if (!res.headersSent) {
          res.status(500).json({
            error:
              "Download failed."
          });
        }
      }
    );
  } catch (error) {
    console.error(
      "DOWNLOAD ERROR:",
      error
    );

    if (tempFile) {
      try {
        await unlinkAsync(tempFile);
      } catch {}
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error:
          error.message ||
          "Download failed."
      });
    }

    res.end();
  }
});

app.listen(
  PORT,
  () => {
    console.log(
      `SocialToolHub API running on port ${PORT}`
    );
  }
);
