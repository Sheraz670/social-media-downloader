const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");
const youtubedl = require("youtube-dl-exec");

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
    return u.protocol === "http:" || u.protocol === "https:";
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

function isSocialMediaUrl(url) {
  const host = new URL(url).hostname.toLowerCase();

  return (
    host.includes("youtube.com") ||
    host === "youtu.be" ||
    host.includes("instagram.com") ||
    host.includes("tiktok.com")
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

async function extractSocialMedia(url) {
  const result = await youtubedl(url, {
    dumpSingleJson: true,
    noWarnings: true,
    noCallHome: true,
    noCheckCertificates: true,
    skipDownload: true,
    noPlaylist: true,

    // Let yt-dlp select an appropriate format.
    format: "best[ext=mp4]/best"
  });

  if (!result) {
    throw new Error(
      "Unable to extract media information."
    );
  }

  return result;
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

    // Direct media URL
    const directInfo =
      await getDirectMediaInfo(url).catch(
        () => null
      );

    if (directInfo) {
      return res.json(directInfo);
    }

    // Supported social-media URL
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
      direct: false
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
  try {
    const url = req.query.url;

    validateUrl(url);

    // Direct media URL
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

    // Social-media URL
    if (!isSocialMediaUrl(url)) {
      return res.status(415).json({
        error:
          "This URL is not a supported downloadable media URL."
      });
    }

    const subprocess =
      youtubedl.exec(
        url,
        {
          output: "-",

          format:
            "best[ext=mp4]/best",

          noWarnings: true,
          noCallHome: true,
          noCheckCertificates: true,
          noPlaylist: true
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
      'attachment; filename="socialtoolhub-video.mp4"'
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

    if (!res.headersSent) {
      res.status(500).json({
        error:
          error.message ||
          "Download failed."
      });
    }
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
