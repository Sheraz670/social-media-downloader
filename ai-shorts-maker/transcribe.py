import sys
import json
import os
import subprocess

os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"

from faster_whisper import WhisperModel

MAX_DURATION = 600


def get_duration(media_file):
    result = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            media_file
        ],
        capture_output=True,
        text=True,
        check=True
    )
    return float(result.stdout.strip())


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Media file path is required."
        }))
        sys.exit(1)

    media_file = sys.argv[1]

    if not os.path.isfile(media_file):
        print(json.dumps({
            "error": "Media file does not exist."
        }))
        sys.exit(1)

    try:
        duration = get_duration(media_file)

        if duration <= 0 or duration > MAX_DURATION:
            raise ValueError(
                "Video must be between 1 second and 10 minutes."
            )

        model = WhisperModel(
            "tiny",
            device="cpu",
            compute_type="int8",
            cpu_threads=1,
            num_workers=1
        )

        segments, info = model.transcribe(
            media_file,
            beam_size=1,
            vad_filter=True
        )

        captions = []

        for segment in segments:
            captions.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip()
            })

        print(json.dumps({
            "language": info.language,
            "duration": round(duration, 2),
            "captions": captions
        }))

    except Exception as error:
        print(json.dumps({
            "error": str(error)
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
