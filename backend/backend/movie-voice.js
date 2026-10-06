async function generateMovieVoice(script, voice) {
  if (!script || !script.trim()) {
    throw new Error("Script is required.");
  }

  const response = await fetch("/api/movie-voice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      script: script.trim(),
      voice: voice || "en-US-AriaNeural"
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Unable to generate AI voice."
    );
  }

  return data;
}
