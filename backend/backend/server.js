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

const YOUTUBE_COOKIES_SOURCE =
  "/etc/secrets/youtube-cookies.txt";

const YOUTUBE_COOKIES_RUNTIME =
  "/tmp/youtube-cookies.txt";


if (existsSync(YOUTUBE_COOKIES_SOURCE)) {
  require("fs").copyFileSync(
    YOUTUBE_COOKIES_SOURCE,
    YOUTUBE_COOKIES_RUNTIME
  );
}


const app = express();

const PORT =
  process.env.PORT || 3000;


app.use(
  cors({
    origin: "*"
  })
);

app.use(
  express.json({
    limit: "10mb"
  })
);


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
  return crypto
    .randomBytes(24)
    .toString("hex");
}


function saveAudioJob(jobId, job) {

  audioJobs.set(jobId, {
    ...job,
    createdAt: Date.now()
  });


  setTimeout(() => {

    const current =
      audioJobs.get(jobId);


    if (!current) {
      return;
    }


    audioJobs.delete(jobId);


    try {

      if (current.tempDir) {

        rmSync(
          current.tempDir,
          {
            recursive: true,
            force: true
          }
        );

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

  const job =
    audioJobs.get(jobId);


  if (!job) {

    throw new Error(
      "Audio file not found or expired. Please submit the video URL again."
    );

  }


  if (
    Date.now() -
    job.createdAt >
    AUDIO_JOB_LIFETIME
  ) {

    audioJobs.delete(jobId);


    try {

      if (job.tempDir) {

        rmSync(
          job.tempDir,
          {
            recursive: true,
            force: true
          }
        );

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

    const u =
      new URL(value);


    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );

  } catch {

    return false;

  }
}


function isPrivateHostname(hostname) {

  const host =
    hostname.toLowerCase();


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
      Number(
        host.split(".")[1]
      );


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


  const parsed =
    new URL(url);


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
    await fetch(
      url,
      {
        method: "HEAD",
        redirect: "follow"
      }
    );


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
      parsed.pathname
        .split("/")
        .pop() ||
      "media-file"
    );


  return {

    title: filename,

    contentType:
      normalizedType,

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

    options.cookies =
      "/tmp/youtube-cookies.txt";


    options.extractorArgs = {

      "youtubepot-bgutilhttp": {

        base_url:
          "http://127.0.0.1:4416"

      }

    };

  }


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
    await youtubedl(
      url,
      {
        dumpSingleJson: true,
        skipDownload: true,
        ...getYtDlpOptions(url)
      }
    );


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

app.get(
  "/",
  (req, res) => {

    res.json({

      service:
        "SocialToolHub Media API",

      status:
        "online"

    });

  }
);


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


      await runYtDlpProcess(
        url,
        {

          output:
            audioTemplate,

          format:
            "bestaudio/best",

          ...getYtDlpOptions(url)

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
PART 1 ENDS HERE
==================================================
*/
/*
==================================================
STEP 4:
AI MOVIE EXPLAINER
==================================================
*/

app.post(
  "/api/movie-explainer",
  async (req, res) => {

    try {

      const input =
  req.body?.movie?.trim() ||
  req.body?.input?.trim();

      const duration =
        Number(
          req.body?.duration || 10
        );

      const language =
        req.body?.language ||
        "English";


      if (!input) {

        return res.status(400).json({

          error:
            "Movie name is required."

        });

      }


      const allowedDurations =
        [5, 8, 10, 12, 15];


      if (
        !allowedDurations.includes(
          duration
        )
      ) {

        return res.status(400).json({

          error:
            "Invalid script duration."

        });

      }


      const allowedLanguages =
        [
          "English",
          "Urdu",
          "Hindi"
        ];


      if (
        !allowedLanguages.includes(
          language
        )
      ) {

        return res.status(400).json({

          error:
            "Invalid language."

        });

      }


      const prompt = `

You are a professional YouTube movie explanation scriptwriter.

Create an ORIGINAL movie explanation script for:

${input}

Language: ${language}

Target duration:
approximately ${duration} minutes.

Requirements:

- Write a complete voiceover narration.
- Start with a strong hook.
- Explain important story events in chronological order.
- Keep the narration engaging and easy to understand.
- Use natural ${language}.
- Do not use headings.
- Do not use bullet points.
- Do not use timestamps.
- Do not reproduce movie dialogue.
- Do not copy the movie screenplay.
- Do not invent characters, scenes, or events.
- Summarize everything in your own words.
- Make the script suitable for a YouTube movie explanation video.
- End naturally.

`;


      let script = "";

      let lastError = "";


      /*
      ================================================
      GROQ
      ================================================
      */

      if (
        process.env.GROQ_API_KEY
      ) {

        try {

          const groqResponse =
            await fetch(
              "https://api.groq.com/openai/v1/chat/completions",
              {

                method:
                  "POST",

                headers: {

                  "Content-Type":
                    "application/json",

                  "Authorization":
                    `Bearer ${process.env.GROQ_API_KEY}`

                },

                body:
                  JSON.stringify({

                    model:
                      "openai/gpt-oss-20b",

                    messages: [

                      {
                        role:
                          "user",

                        content:
                          prompt

                      }

                    ],

                    temperature:
                      0.7

                  })

              }
            );


          const groqData =
            await groqResponse.json();


          if (
            groqResponse.ok
          ) {

            script =
              groqData
                ?.choices?.[0]
                ?.message?.content
                ?.trim() || "";

          } else {

            lastError =
              groqData
                ?.error
                ?.message ||
              "Groq API request failed.";


            console.error(
              "GROQ ERROR:",
              groqData
            );

          }

        } catch (error) {

          lastError =
            error.message;


          console.error(
            "GROQ CONNECTION ERROR:",
            error
          );

        }

      }


      /*
      ================================================
      GEMINI FALLBACK
      ================================================
      */

      if (
        !script &&
        process.env.GEMINI_API_KEY
      ) {

        try {

          const geminiResponse =
            await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
              {

                method:
                  "POST",

                headers: {

                  "Content-Type":
                    "application/json",

                  "x-goog-api-key":
                    process.env.GEMINI_API_KEY

                },

                body:
                  JSON.stringify({

                    contents: [

                      {

                        parts: [

                          {

                            text:
                              prompt

                          }

                        ]

                      }

                    ]

                  })

              }
            );


          const geminiData =
            await geminiResponse.json();


          if (
            geminiResponse.ok
          ) {

            script =
              geminiData
                ?.candidates?.[0]
                ?.content?.parts
                ?.map(
                  part =>
                    part.text || ""
                )
                .join("")
                .trim() || "";

          } else {

            lastError =
              geminiData
                ?.error
                ?.message ||
              "Gemini API request failed.";


            console.error(
              "GEMINI ERROR:",
              geminiData
            );

          }

        } catch (error) {

          lastError =
            error.message;


          console.error(
            "GEMINI CONNECTION ERROR:",
            error
          );

        }

      }


      /*
      ================================================
      FINAL SCRIPT RESULT
      ================================================
      */

      if (!script) {

        return res.status(503).json({

          error:
            "Both AI services are currently unavailable. " +
            (
              lastError ||
              "Please try again later."
            )

        });

      }


      return res.json({

        success:
          true,

        title:
          input,

        duration:
          duration,

        language:
          language,

        script:
          script,

        message:
          "✅ Movie explanation script generated successfully."

      });

    } catch (error) {

      console.error(
        "MOVIE EXPLAINER ERROR:",
        error
      );


      return res.status(500).json({

        error:
          error.message ||
          "Unable to generate movie explanation."

      });

    }

  }
);


/*
==================================================
STEP 5:
AI VOICE
==================================================
*/

app.post(
  "/api/movie-voice",
  async (req, res) => {

    let tempDir = null;

    try {

      const script =
        req.body?.script?.trim();

      const language =
        req.body?.language ||
        "English";

      const movie =
        req.body?.movie?.trim() ||
        "movie-explanation";


      if (!script) {

        return res.status(400).json({

          error:
            "Script is required."

        });

      }


      const allowedLanguages =
        [
          "English",
          "Urdu",
          "Hindi"
        ];


      if (
        !allowedLanguages.includes(
          language
        )
      ) {

        return res.status(400).json({

          error:
            "Invalid voice language."

        });

      }


      const ttsFile =
        path.join(
          __dirname,
          "tts.py"
        );


      if (
        !existsSync(ttsFile)
      ) {

        return res.status(500).json({

          error:
            "tts.py was not found on the server."

        });

      }


      tempDir =
        mkdtempSync(
          path.join(
            os.tmpdir(),
            "movie-voice-"
          )
        );


      const textFile =
        path.join(
          tempDir,
          "script.txt"
        );


      const outputFile =
        path.join(
          tempDir,
          "voice.mp3"
        );


      require("fs").writeFileSync(
        textFile,
        script,
        "utf8"
      );


      console.log(
        "Starting AI voice generation:",
        movie
      );


      let voiceCode =
        "en-US-AriaNeural";


      if (
        language === "Urdu"
      ) {

        voiceCode =
          "ur-PK-UzmaNeural";

      }


      if (
        language === "Hindi"
      ) {

        voiceCode =
          "hi-IN-SwaraNeural";

      }


      const pythonProcess =
        spawn(
          "python3",
          [
            ttsFile,
            textFile,
            outputFile,
            voiceCode
          ]
        );


      let stderr = "";


      pythonProcess.stderr.on(
        "data",
        (data) => {

          stderr +=
            data.toString();


          console.error(
            "TTS:",
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


      if (
        exitCode !== 0
      ) {

        throw new Error(

          stderr.trim() ||
          "AI voice generation failed."

        );

      }


      if (
        !existsSync(outputFile)
      ) {

        throw new Error(
          "AI voice file was not created."
        );

      }


      const stat =
        require("fs")
          .statSync(outputFile);


      if (
        !stat.size
      ) {

        throw new Error(
          "AI voice file is empty."
        );

      }


      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );


      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${movie
          .replace(
            /[^a-z0-9]/gi,
            "_"
          )}-voice.mp3"`
      );


      const stream =
        createReadStream(
          outputFile
        );


      stream.on(
        "close",
        () => {

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

            tempDir = null;

          }

        }
      );


      stream.pipe(res);


    } catch (error) {

      console.error(
        "MOVIE VOICE ERROR:",
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
            "Unable to generate AI voice."

        });

      }

    }

  }
);
/*
==================================================
STEP 5:
AI MOVIE VOICE
==================================================
*/

app.post(
  "/api/movie-voice",
  async (req, res) => {

    let tempDir = null;

    try {

      const script =
        req.body?.script?.trim();

      const language =
        req.body?.language ||
        "English";

      const movie =
        req.body?.movie?.trim() ||
        "movie-explanation";

      const requestedVoice =
        req.body?.voice?.trim();

      if (!script) {

        return res.status(400).json({
          error:
            "Script is required."
        });

      }

      const ttsFile =
        path.join(
          __dirname,
          "tts.py"
        );

      if (!existsSync(ttsFile)) {

        return res.status(500).json({
          error:
            "tts.py was not found on the server."
        });

      }

      const allowedVoices = [
        "en-US-AriaNeural",
        "en-US-GuyNeural",
        "en-US-JennyNeural",
        "en-US-ChristopherNeural",
        "en-US-EricNeural",
        "en-US-MichelleNeural",
        "en-US-RogerNeural",
        "ur-PK-UzmaNeural",
        "hi-IN-SwaraNeural"
      ];

      let defaultVoice =
        "en-US-AriaNeural";

      if (language === "Urdu") {

        defaultVoice =
          "ur-PK-UzmaNeural";

      }

      if (language === "Hindi") {

        defaultVoice =
          "hi-IN-SwaraNeural";

      }

      const voiceCode =
        allowedVoices.includes(
          requestedVoice
        )
          ? requestedVoice
          : defaultVoice;

      tempDir =
        mkdtempSync(
          path.join(
            os.tmpdir(),
            "movie-voice-"
          )
        );

      const textFile =
        path.join(
          tempDir,
          "script.txt"
        );

      const outputFile =
        path.join(
          tempDir,
          "voice.mp3"
        );

      require("fs").writeFileSync(
        textFile,
        script,
        "utf8"
      );

      console.log(
        "Generating AI voice:",
        voiceCode
      );

      const pythonProcess =
        spawn(
          "python3",
          [
            ttsFile,
            textFile,
            outputFile,
            voiceCode
          ]
        );

      let stderr = "";

      if (pythonProcess.stderr) {

        pythonProcess.stderr.on(
          "data",
          (data) => {

            stderr +=
              data.toString();

            console.error(
              "TTS:",
              data.toString()
            );

          }
        );

      }

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
          "AI voice generation failed."
        );

      }

      if (!existsSync(outputFile)) {

        throw new Error(
          "AI voice file was not created."
        );

      }

      const stat =
        require("fs")
          .statSync(outputFile);

      if (!stat.size) {

        throw new Error(
          "AI voice file is empty."
        );

      }

      res.setHeader(
        "Content-Type",
        "audio/mpeg"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${movie
          .replace(
            /[^a-z0-9]/gi,
            "_"
          )}-voice.mp3"`
      );

      const stream =
        createReadStream(
          outputFile
        );

      stream.on(
        "close",
        () => {

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

            tempDir = null;

          }

        }
      );

      stream.pipe(res);

    } catch (error) {

      console.error(
        "MOVIE VOICE ERROR:",
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
            "Unable to generate AI voice."

        });

      }

    }

  }
);


/*
==================================================
GLOBAL ERROR HANDLER
==================================================
*/

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


    if (
      res.headersSent
    ) {

      return next(error);

    }


    return res.status(500).json({

      error:
        error.message ||
        "Internal server error."

    });

  }
);

/*
==================================================
STEP 6:
AI MOVIE VIDEO
==================================================
*/

app.post(
  "/api/movie-video",
  async (req, res) => {

    let tempDir = null;

    try {

      const script =
        req.body?.script?.trim();

      const movie =
        req.body?.movie?.trim() ||
        "movie-explanation";

      const voice =
        req.body?.voice?.trim() ||
        "en-US-AriaNeural";

      if (!script) {
        return res.status(400).json({
          error: "Script is required."
        });
      }

      tempDir =
        mkdtempSync(
          path.join(
            os.tmpdir(),
            "movie-video-"
          )
        );

      const textFile =
        path.join(tempDir, "script.txt");

      const audioFile =
        path.join(tempDir, "voice.mp3");

      const videoFile =
        path.join(
          tempDir,
          "movie-explanation.mp4"
        );

      require("fs").writeFileSync(
        textFile,
        script,
        "utf8"
      );

      const ttsFile =
        path.join(
          __dirname,
          "tts.py"
        );

      const ttsProcess =
        spawn(
          "python3",
          [
            ttsFile,
            textFile,
            audioFile,
            voice
          ]
        );

      let ttsError = "";

      if (ttsProcess.stderr) {

        ttsProcess.stderr.on(
          "data",
          (data) => {
            ttsError += data.toString();
          }
        );

      }

      const ttsExitCode =
        await new Promise(
          (resolve, reject) => {

            ttsProcess.on(
              "error",
              reject
            );

            ttsProcess.on(
              "close",
              resolve
            );

          }
        );

      if (ttsExitCode !== 0) {

        throw new Error(
          ttsError.trim() ||
          "Voice generation failed."
        );

      }

      if (!existsSync(audioFile)) {

        throw new Error(
          "Voice file was not created."
        );

      }

      const videoProcess =
        spawn(
          "ffmpeg",
          [
            "-y",
            "-f",
"lavfi",
"-i",
"color=c=0x111827:s=1920x1080:r=24",
            "-i",
            audioFile,
            "-vf",
            "drawtext=text='AI MOVIE EXPLANATION':fontcolor=white:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            videoFile
          ]
        );

      let videoError = "";

      if (videoProcess.stderr) {

        videoProcess.stderr.on(
          "data",
          (data) => {
            videoError += data.toString();
            console.log(
              "FFMPEG:",
              data.toString()
            );
          }
        );

      }

      const videoExitCode =
        await new Promise(
          (resolve, reject) => {

            videoProcess.on(
              "error",
              reject
            );

            videoProcess.on(
              "close",
              resolve
            );

          }
        );

      if (videoExitCode !== 0) {

        throw new Error(
          videoError.trim() ||
          "Video generation failed."
        );

      }

      if (!existsSync(videoFile)) {

        throw new Error(
          "Video file was not created."
        );

      }

      const stat =
        require("fs")
          .statSync(videoFile);

      if (!stat.size) {

        throw new Error(
          "Generated video is empty."
        );

      }

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${movie
          .replace(
            /[^a-z0-9]/gi,
            "_"
          )}-video.mp4"`
      );

      const stream =
        createReadStream(
          videoFile
        );

      stream.on(
        "close",
        () => {

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

            tempDir = null;

          }

        }
      );

      stream.pipe(res);

    } catch (error) {

      console.error(
        "MOVIE VIDEO ERROR:",
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
            "Unable to generate movie video."
        });

      }

    }

  }
);


/*
==================================================
START SERVER
==================================================
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `SocialToolHub API running on port ${PORT}`
    );

  }
);
