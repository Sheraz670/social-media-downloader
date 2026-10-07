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
GEMINI PRIMARY + GROQ AUTOMATIC FALLBACK
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


      /*
      ==================================================
      VARIABLES
      ==================================================
      */

      let research = "";

      let geminiScript = "";

      let groqScript = "";

      let lastError = "";


      /*
      ==================================================
      HELPER:
      GEMINI REQUEST
      ==================================================
      */

      async function callGemini(
        prompt,
        useSearch = false
      ) {

        const response =
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

                  ],

                  ...(useSearch
                    ? {
                        tools: [
                          {
                            google_search: {}
                          }
                        ]
                      }
                    : {}),

                  generationConfig: {

                    temperature:
                      useSearch
                        ? 0.1
                        : 0.15

                  }

                })

            }
          );


        const data =
          await response.json();


        if (!response.ok) {

          throw new Error(
            data
              ?.error
              ?.message ||
            "Gemini request failed."
          );

        }


        const text =
          data
            ?.candidates?.[0]
            ?.content?.parts
            ?.map(
              part =>
                part.text || ""
            )
            .join("")
            .trim() || "";


        if (!text) {

          throw new Error(
            "Gemini returned an empty response."
          );

        }


        return text;

      }


      /*
      ==================================================
      STEP 4A:
      GEMINI RESEARCH
      ==================================================
      */

      if (
        process.env.GEMINI_API_KEY
      ) {

        try {

          console.log(
            "GEMINI: Starting movie research..."
          );


          const researchPrompt = `

You are a professional movie researcher.

MOVIE:
${input}

Research the EXACT movie using Google Search grounding.

Your task is to create a factual research report
for a movie explanation.

VERIFY:

- Exact movie title
- Release year
- Main characters
- Character relationships
- Beginning
- Major events
- Cause and effect
- Important twists
- Important reveals
- Climax
- Ending
- Post-credit scene if relevant

ACCURACY RULES:

1. Only include events that actually happen.

2. Never invent scenes.

3. Never invent characters.

4. Never invent relationships.

5. Never invent locations.

6. Never invent deaths.

7. Never invent dialogue.

8. Never invent motivations.

9. Never invent twists.

10. Never invent the ending.

11. Do not confuse actors with characters.

12. Do not mix another movie into this movie.

13. Do not treat fan theories as facts.

14. Do not guess.

15. If information is uncertain, mark it UNCERTAIN.

16. Pay special attention to the climax and ending.

17. If the movie has flashbacks, multiple timelines,
dream levels, parallel stories, or time jumps,
keep them correctly separated.

Return ONLY a detailed factual research report.

Do not write the YouTube script yet.

`;


          research =
            await callGemini(
              researchPrompt,
              true
            );


          console.log(
            "GEMINI: Research completed."
          );


        } catch (error) {

          lastError =
            error.message;

          console.error(
            "GEMINI RESEARCH FAILED:",
            error.message
          );

        }

      }


      /*
      ==================================================
      STEP 4B:
      GEMINI INITIAL SCRIPT
      ==================================================
      */

      if (
        process.env.GEMINI_API_KEY &&
        research
      ) {

        try {

          console.log(
            "GEMINI: Creating initial script..."
          );


          const scriptPrompt = `

You are a professional YouTube movie explanation
scriptwriter.

MOVIE:
${input}

LANGUAGE:
${language}

TARGET DURATION:
Approximately ${duration} minutes.

VERIFIED MOVIE RESEARCH:

${research}

Write a movie explanation using ONLY information
supported by the research.

ACCURACY:

- Never invent events.
- Never invent scenes.
- Never invent dialogue.
- Never invent characters.
- Never invent relationships.
- Never invent locations.
- Never invent deaths.
- Never invent twists.
- Never invent motivations.
- Never invent an ending.
- Never change important event order.
- Never confuse actors and characters.
- Never use fan theories as facts.
- Never guess missing information.

STYLE:

Start with an engaging hook.

Explain the actual story naturally.

Follow the movie's events.

Explain important cause and effect.

Explain important character motivations
only when supported.

Explain major twists.

Build toward the climax.

Explain the actual ending.

If the ending is ambiguous, explain only what
the movie actually shows.

FORMAT:

- One continuous voiceover narration.
- No headings.
- No bullet points.
- No timestamps.
- No scene labels.
- No fake dialogue.
- Do not copy movie dialogue.
- Use your own words.
- Natural ${language}.
- Suitable for YouTube narration.
- No filler.

Return ONLY the script.

`;


          geminiScript =
            await callGemini(
              scriptPrompt,
              false
            );


          console.log(
            "GEMINI: Initial script completed."
          );


        } catch (error) {

          lastError =
            error.message;

          console.error(
            "GEMINI SCRIPT FAILED:",
            error.message
          );

        }

      }


      /*
      ==================================================
      STEP 4C:
      GROQ FINAL SCRIPT / AUTOMATIC FALLBACK
      ==================================================
      */

            if (
        process.env.GROQ_API_KEY
      ) {

        try {

          console.log(
            "GROQ: Starting final script generation..."
          );

          let groqPrompt = "";

          if (research) {

            groqPrompt = `

You are the FINAL FACT-CHECKING EDITOR for a
professional YouTube movie explanation.

MOVIE:
${input}

LANGUAGE:
${language}

TARGET DURATION:
Approximately ${duration} minutes.

VERIFIED RESEARCH:
${research}

GEMINI DRAFT:
${geminiScript || "No Gemini draft available."}

Create the FINAL movie explanation script.

The VERIFIED RESEARCH is the primary factual source.

Check the Gemini draft against the research.
Correct anything that conflicts with the research.
Remove anything unsupported.
Remove invented events.
Remove invented characters.
Remove invented relationships.
Remove invented locations.
Remove invented deaths.
Remove invented twists.
Remove invented motivations.
Remove invented dialogue.
Do not change important chronology.
Do not confuse actors and characters.
Do not use fan theories as facts.
Do not guess missing information.
Pay special attention to the climax and ending.

STYLE:

Start with an engaging hook.
Explain the actual movie naturally.
Follow the movie's story.
Explain important cause and effect.
Explain major twists clearly.
Build toward the climax.
Explain the actual ending.

FORMAT:

- One continuous voiceover narration.
- No headings.
- No bullet points.
- No timestamps.
- No scene labels.
- No fake dialogue.
- Do not reproduce movie dialogue.
- Use your own words.
- Natural ${language}.
- Suitable for YouTube narration.
- No filler.

Do not mention Gemini, Groq, AI,
research, sources, or these instructions.

Return ONLY the final script.

`;

          } else {

            groqPrompt = `

You are a professional YouTube movie explanation
scriptwriter.

MOVIE:
${input}

LANGUAGE:
${language}

TARGET DURATION:
Approximately ${duration} minutes.

The primary research service is temporarily
unavailable.

Create the best factual explanation possible
using your knowledge of the EXACT movie.

STRICT ACCURACY:

- Do not invent events.
- Do not invent characters.
- Do not invent relationships.
- Do not invent locations.
- Do not invent deaths.
- Do not invent dialogue.
- Do not invent motivations.
- Do not invent twists.
- Do not invent the climax.
- Do not invent the ending.
- Do not confuse actors and characters.
- Do not mix another movie into this movie.
- Do not use fan theories as facts.
- Do not guess uncertain details.
- If you are not confident about a detail,
leave it out.

STYLE:

Start with an engaging hook.
Explain the actual story naturally.
Follow the movie's chronology.
Explain important cause and effect.
Explain major twists clearly.
Build toward the climax.
Explain the actual ending.

FORMAT:

- One continuous voiceover narration.
- No headings.
- No bullet points.
- No timestamps.
- No scene labels.
- No fake dialogue.
- Do not reproduce movie dialogue.
- Use your own words.
- Natural ${language}.
- Suitable for YouTube narration.
- No filler.

Return ONLY the movie explanation script.

`;

          }


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
                          groqPrompt

                      }

                    ],

                    temperature:
                      0.1,

                    max_tokens:
                      6000

                  })

              }
            );


          const groqData =
            await groqResponse.json();


          console.log(
            "GROQ STATUS:",
            groqResponse.status
          );


          if (!groqResponse.ok) {

            console.error(
              "GROQ API ERROR:",
              JSON.stringify(
                groqData
              )
            );

            throw new Error(
              groqData
                ?.error
                ?.message ||
              "Groq API request failed."
            );

          }


          console.log(
            "GROQ RESPONSE:",
            JSON.stringify(
              groqData
            )
          );


          groqScript =
            groqData
              ?.choices?.[0]
              ?.message
              ?.content
              ?.trim() || "";


          if (!groqScript) {

            throw new Error(
              "Groq returned no usable script content."
            );

          }


          console.log(
            "GROQ: Final script completed."
          );


        } catch (error) {

          lastError =
            error.message;

          console.error(
            "GROQ FAILED:",
            error.message
          );

        }

      }

      /*
      ==================================================
      FINAL SCRIPT SELECTION
      ==================================================
      */

      let script = "";


      /*
      If Groq succeeded, use Groq final version.
      */

      if (groqScript) {

        script =
          groqScript;

      }


      /*
      If Groq failed but Gemini script succeeded,
      use Gemini script.
      */

      else if (geminiScript) {

        script =
          geminiScript;

      }


      /*
      If only Gemini research exists,
      use research as last fallback.
      */

      else if (research) {

        script =
          research;

      }


      /*
      ==================================================
      BOTH SERVICES FAILED
      ==================================================
      */

      if (!script) {

        return res.status(503).json({

          error:
            "Unable to generate movie explanation right now. " +
            (
              lastError ||
              "Gemini and Groq are currently unavailable."
            )

        });

      }


      /*
      ==================================================
      FINAL RESPONSE
      ==================================================
      */

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
          groqScript
            ? (
                research
                  ? "Movie script generated and fact-checked successfully."
                  : "Movie script generated using automatic Groq fallback."
              )
            : "Movie script generated successfully."

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
SAFE VISUALS + AI VOICE + AUTO CAPTIONS
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
          error:
            "Script is required."
        });

      }

      const tmdbToken =
        process.env.TMDB_ACCESS_TOKEN;

      if (!tmdbToken) {

        return res.status(500).json({
          error:
            "TMDB access token is not configured."
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
        path.join(
          tempDir,
          "script.txt"
        );

      const audioFile =
        path.join(
          tempDir,
          "voice.mp3"
        );

      const captionFile =
        path.join(
          tempDir,
          "captions.srt"
        );

      const visualFile =
        path.join(
          tempDir,
          "movie-visual.jpg"
        );

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

      /*
      ==================================================
      STEP 6A:
      GENERATE AI VOICE
      ==================================================
      */

      const ttsFile =
        path.join(
          __dirname,
          "tts.py"
        );

      if (!existsSync(ttsFile)) {

        throw new Error(
          "tts.py was not found."
        );

      }

      console.log(
        "Generating movie voice..."
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

            ttsError +=
              data.toString();

            console.log(
              "TTS:",
              data.toString()
            );

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
          "AI voice generation failed."
        );

      }

      if (!existsSync(audioFile)) {

        throw new Error(
          "Voice file was not created."
        );

      }

      /*
      ==================================================
      STEP 6B:
      FIND MOVIE VISUAL FROM TMDB
      ==================================================
      */

      console.log(
        "Finding safe movie visual:",
        movie
      );

      const searchUrl =
        "https://api.themoviedb.org/3/search/movie" +
        `?query=${encodeURIComponent(movie)}` +
        "&include_adult=false" +
        "&language=en-US" +
        "&page=1";

      const movieResponse =
        await fetch(
          searchUrl,
          {
            headers: {
              Authorization:
                `Bearer ${tmdbToken}`,

              accept:
                "application/json"
            }
          }
        );

      if (!movieResponse.ok) {

        const errorText =
          await movieResponse.text();

        console.error(
          "TMDB SEARCH ERROR:",
          errorText
        );

        throw new Error(
          "Unable to search TMDB for movie visuals."
        );

      }

      const movieData =
        await movieResponse.json();

      const results =
        Array.isArray(movieData.results)
          ? movieData.results
          : [];

      console.log(
        "TMDB RESULTS:",
        results.length
      );

      /*
      Find the first result that actually
      contains a usable image.
      */

      const movieResult =
        results.find(
          (item) =>
            item &&
            (
              item.backdrop_path ||
              item.poster_path
            )
        );

      if (!movieResult) {

        throw new Error(
          `No TMDB visual was found for "${movie}".`
        );

      }

      console.log(
        "TMDB MOVIE FOUND:",
        movieResult.title ||
        movieResult.original_title ||
        movie
      );

      console.log(
        "TMDB BACKDROP:",
        movieResult.backdrop_path
      );

      console.log(
        "TMDB POSTER:",
        movieResult.poster_path
      );

      let visualUrl = null;

      /*
      Prefer landscape backdrop.
      */

      if (
        movieResult.backdrop_path
      ) {

        visualUrl =
          `https://image.tmdb.org/t/p/w1280${movieResult.backdrop_path}`;

      }

      /*
      Use poster if backdrop is unavailable.
      */

      else if (
        movieResult.poster_path
      ) {

        visualUrl =
          `https://image.tmdb.org/t/p/w780${movieResult.poster_path}`;

      }

      if (!visualUrl) {

        throw new Error(
          "TMDB returned the movie but no usable image."
        );

      }

      console.log(
        "Downloading movie visual..."
      );

      const imageResponse =
        await fetch(
          visualUrl
        );

      if (!imageResponse.ok) {

        throw new Error(
          `Unable to download movie visual. HTTP ${imageResponse.status}`
        );

      }

      const imageBuffer =
        Buffer.from(
          await imageResponse.arrayBuffer()
        );

      if (!imageBuffer.length) {

        throw new Error(
          "Downloaded movie visual is empty."
        );

      }

      require("fs").writeFileSync(
        visualFile,
        imageBuffer
      );

      console.log(
        "Movie visual saved successfully."
      );

      /*
==================================================
STEP 6C:
LIGHTWEIGHT AUTOMATIC CAPTIONS
==================================================
*/

console.log(
  "Creating lightweight automatic captions..."
);

const fs =
  require("fs");

const captionText =
  String(script || "").trim();

if (!captionText) {

  throw new Error(
    "Movie script is empty. Cannot create captions."
  );

}


/*
==================================================
GET AUDIO DURATION USING FFPROBE
==================================================
*/

const audioDuration =
  await new Promise(
    (resolve, reject) => {

      const probeProcess =
        spawn(
          "ffprobe",
          [
            "-v",
            "error",

            "-show_entries",
            "format=duration",

            "-of",
            "default=noprint_wrappers=1:nokey=1",

            audioFile
          ]
        );

      let output = "";
      let error = "";

      probeProcess.stdout.on(
        "data",
        (data) => {

          output +=
            data.toString();

        }
      );

      probeProcess.stderr.on(
        "data",
        (data) => {

          error +=
            data.toString();

        }
      );

      probeProcess.on(
        "error",
        reject
      );

      probeProcess.on(
        "close",
        (code) => {

          if (code !== 0) {

            reject(
              new Error(
                error.trim() ||
                "Could not read audio duration."
              )
            );

            return;

          }

          const duration =
            parseFloat(
              output.trim()
            );

          if (
            !Number.isFinite(
              duration
            ) ||
            duration <= 0
          ) {

            reject(
              new Error(
                "Invalid audio duration."
              )
            );

            return;

          }

          resolve(
            duration
          );

        }
      );

    }
  );


console.log(
  "Audio duration:",
  audioDuration,
  "seconds"
);


/*
==================================================
BREAK SCRIPT INTO SMALL CAPTION CHUNKS
==================================================
*/

const words =
  captionText
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .split(" ");


const captionChunks = [];

let currentChunk = [];


/*
Maximum words per caption.
Keeps captions readable.
*/

const MAX_WORDS =
  10;


for (
  const word of words
) {

  currentChunk.push(
    word
  );

  const endsSentence =
    /[.!?]$/.test(
      word
    );

  if (
    currentChunk.length >=
      MAX_WORDS ||
    endsSentence
  ) {

    captionChunks.push(
      currentChunk.join(" ")
    );

    currentChunk = [];

  }

}


if (
  currentChunk.length
) {

  captionChunks.push(
    currentChunk.join(" ")
  );

}


if (
  !captionChunks.length
) {

  throw new Error(
    "Could not create caption chunks."
  );

}


/*
==================================================
CREATE TIMINGS
==================================================
*/

const totalWords =
  words.length;


let currentTime =
  0;


const captionEntries = [];


for (
  let i = 0;
  i < captionChunks.length;
  i++
) {

  const text =
    captionChunks[i];

  const chunkWordCount =
    text
      .split(/\s+/)
      .length;


  let duration =
    audioDuration *
    (
      chunkWordCount /
      totalWords
    );


  /*
  Keep very short captions readable.
  */

  if (
    duration < 1.2
  ) {

    duration =
      1.2;

  }


  const remainingChunks =
    captionChunks.length -
    i -
    1;


  const remainingTime =
    audioDuration -
    currentTime;


  /*
  Prevent the minimum duration
  from exceeding the audio length.
  */

  if (
    remainingChunks === 0
  ) {

    duration =
      Math.max(
        0.5,
        remainingTime
      );

  }
  else {

    const maxAllowed =
      remainingTime -
      (
        remainingChunks *
        0.5
      );

    duration =
      Math.min(
        duration,
        Math.max(
          0.5,
          maxAllowed
        )
      );

  }


  const start =
    currentTime;

  const end =
    Math.min(
      audioDuration,
      currentTime +
        duration
    );


  captionEntries.push(
    {
      index:
        i + 1,

      start,

      end,

      text
    }
  );


  currentTime =
    end;

}


/*
==================================================
SRT TIME FORMAT
==================================================
*/

function srtTime(
  seconds
) {

  seconds =
    Math.max(
      0,
      Number(seconds) || 0
    );


  const hours =
    Math.floor(
      seconds / 3600
    );


  const minutes =
    Math.floor(
      (
        seconds % 3600
      ) / 60
    );


  const secs =
    Math.floor(
      seconds % 60
    );


  const millis =
    Math.floor(
      (
        seconds -
        Math.floor(seconds)
      ) *
      1000
    );


  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(secs).padStart(2, "0") +
    "," +
    String(millis).padStart(3, "0")
  );

}


/*
==================================================
CREATE SRT FILE
==================================================
*/

const srtContent =
  captionEntries
    .map(
      (entry) => {

        return (
          `${entry.index}\n` +
          `${srtTime(entry.start)} --> ${srtTime(entry.end)}\n` +
          `${entry.text}\n\n`
        );

      }
    )
    .join("");


fs.writeFileSync(
  captionFile,
  srtContent,
  "utf8"
);


/*
==================================================
VERIFY CAPTION FILE
==================================================
*/

if (
  !existsSync(
    captionFile
  )
) {

  throw new Error(
    "Caption file was not created."
  );

}


const captionStats =
  fs.statSync(
    captionFile
  );


if (
  !captionStats.size
) {

  throw new Error(
    "Caption file is empty."
  );

}


console.log(
  "Lightweight captions created successfully."
);

console.log(
  "Caption count:",
  captionEntries.length
);

      /*
      ==================================================
      STEP 6D:
      CREATE FINAL VIDEO
      ==================================================
      */

      console.log(
        "Creating final movie explainer video..."
      );

      const videoProcess =
        spawn(
          "ffmpeg",
          [
            "-y",

            "-loop",
            "1",

            "-i",
            visualFile,

            "-i",
            audioFile,

            "-vf",
            `scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,zoompan=z='min(zoom+0.0005,1.12)':d=1:s=1280x720:fps=24,subtitles=${captionFile}:force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=45'`,

            "-c:v",
            "libx264",

            "-preset",
            "veryfast",

            "-tune",
            "stillimage",

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

            videoError +=
              data.toString();

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
          "Final video generation failed."
        );

      }

      if (!existsSync(videoFile)) {

        throw new Error(
          "Final video file was not created."
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

      /*
      ==================================================
      STEP 6E:
      SEND FINAL VIDEO
      ==================================================
      */

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


app.get("/api/movie-info", async (req, res) => {
  try {
    const movie = String(req.query.movie || "").trim();

    if (!movie) {
      return res.status(400).json({
        error: "Movie name is required."
      });
    }

    const apiKey = process.env.TMDB_API_KEY;
const accessToken = process.env.TMDB_ACCESS_TOKEN;

if (!accessToken) {
  return res.status(500).json({
    error: "TMDB access token is not configured."
  });
}

const searchUrl =
  `https://api.themoviedb.org/3/search/movie` +
  `?query=${encodeURIComponent(movie)}` +
  `&include_adult=false` +
  `&language=en-US`;

const response = await fetch(
  searchUrl,
  {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json"
    }
  }
);

    const data = await response.json();

    const results = Array.isArray(data.results)
      ? data.results
      : [];

    if (!results.length) {
      return res.status(404).json({
        error: "Movie not found."
      });
    }

    /*
    ==================================================
    GET DETAILED INFORMATION FOR EACH RESULT
    ==================================================
    */

    const detailedResults = await Promise.all(
      results.slice(0, 10).map(async (item) => {

        try {

          const detailsUrl =
            `https://api.themoviedb.org/3/movie/${item.id}` +
            `?api_key=${encodeURIComponent(apiKey)}` +
            `&language=en-US`;

          const detailsResponse =
            await fetch(detailsUrl);

          if (!detailsResponse.ok) {
            return {
              id: item.id,
              title: item.title,
              releaseDate: item.release_date || "",
              year: item.release_date
                ? item.release_date.slice(0, 4)
                : "",
              overview: item.overview || "",
              posterPath: item.poster_path || null,
              backdropPath: item.backdrop_path || null,
              originalLanguage:
                item.original_language || "",
              genres: [],
              productionCountries: [],
              productionCompanies: [],
              industry: "International"
            };
          }

          const details =
            await detailsResponse.json();

          /*
          ==============================================
          GENRES
          ==============================================
          */

          const genres =
            Array.isArray(details.genres)
              ? details.genres.map(
                  (genre) => genre.name
                )
              : [];

          /*
          ==============================================
          PRODUCTION COUNTRIES
          ==============================================
          */

          const productionCountries =
            Array.isArray(
              details.production_countries
            )
              ? details.production_countries.map(
                  (country) =>
                    country.name
                )
              : [];

          /*
          ==============================================
          PRODUCTION COMPANIES
          ==============================================
          */

          const productionCompanies =
            Array.isArray(
              details.production_companies
            )
              ? details.production_companies
                  .slice(0, 5)
                  .map(
                    (company) =>
                      company.name
                  )
              : [];

          /*
          ==============================================
          INDUSTRY
          ==============================================
          */

          let industry =
            "International";

          const originalLanguage =
            details.original_language || "";

          const countryCodes =
            Array.isArray(
              details.production_countries
            )
              ? details.production_countries.map(
                  (country) =>
                    country.iso_3166_1
                )
              : [];

          if (
            countryCodes.includes("US") &&
            (
              originalLanguage === "en" ||
              countryCodes.length === 1
            )
          ) {
            industry = "Hollywood";
          }

          else if (
            countryCodes.includes("IN")
          ) {

            if (
              originalLanguage === "hi"
            ) {
              industry = "Bollywood";
            }

            else if (
              originalLanguage === "te"
            ) {
              industry = "Telugu Cinema";
            }

            else if (
              originalLanguage === "ta"
            ) {
              industry = "Tamil Cinema";
            }

            else if (
              originalLanguage === "ml"
            ) {
              industry = "Malayalam Cinema";
            }

            else if (
              originalLanguage === "kn"
            ) {
              industry = "Kannada Cinema";
            }

            else {
              industry = "Indian Cinema";
            }
          }

          else if (
            countryCodes.includes("KR")
          ) {
            industry = "Korean Cinema";
          }

          else if (
            countryCodes.includes("JP")
          ) {
            industry = "Japanese Cinema";
          }

          else if (
            countryCodes.includes("CN")
          ) {
            industry = "Chinese Cinema";
          }

          else if (
            countryCodes.includes("FR")
          ) {
            industry = "French Cinema";
          }

          else if (
            countryCodes.includes("GB")
          ) {
            industry = "British Cinema";
          }

          return {
            id: details.id || item.id,

            title:
              details.title ||
              item.title ||
              "",

            originalTitle:
              details.original_title ||
              "",

            releaseDate:
              details.release_date ||
              item.release_date ||
              "",

            year:
              details.release_date
                ? details.release_date.slice(0, 4)
                : (
                    item.release_date
                      ? item.release_date.slice(0, 4)
                      : ""
                  ),

            overview:
              details.overview ||
              item.overview ||
              "",

            posterPath:
              details.poster_path ||
              item.poster_path ||
              null,

            backdropPath:
              details.backdrop_path ||
              null,

            originalLanguage,

            genres,

            productionCountries,

            productionCompanies,

            industry,

            runtime:
              details.runtime || 0,

            voteAverage:
              details.vote_average || 0,

            voteCount:
              details.vote_count || 0,

            popularity:
              details.popularity || 0

          };

        } catch (detailError) {

          console.error(
            "MOVIE DETAIL ERROR:",
            detailError
          );

          return {
            id: item.id,
            title: item.title,
            releaseDate:
              item.release_date || "",
            year:
              item.release_date
                ? item.release_date.slice(0, 4)
                : "",
            overview:
              item.overview || "",
            posterPath:
              item.poster_path || null,
            backdropPath:
              null,
            originalLanguage:
              item.original_language || "",
            genres: [],
            productionCountries: [],
            productionCompanies: [],
            industry: "International"
          };
        }

      })
    );

    return res.json({
      success: true,
      query: movie,
      results: detailedResults
    });

  } catch (error) {

    console.error(
      "MOVIE INFO ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Unable to search movie."
    });
  }
});


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
