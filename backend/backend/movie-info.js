async function searchMovie(movieName) {
  const name = String(movieName || "").trim();

  if (!name) {
    throw new Error("Please enter a movie name.");
  }

  const response = await fetch(
    `/api/movie-info?movie=${encodeURIComponent(name)}`
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Unable to find movie information."
    );
  }

  return data;
}
