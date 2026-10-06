async function generateMovieScript(movieInfo) {
  if (!movieInfo || !movieInfo.title) {
    throw new Error("Movie information is required.");
  }

  const response = await fetch("/api/movie-script", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      movie: movieInfo
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Unable to generate movie script."
    );
  }

  return data.script;
}
