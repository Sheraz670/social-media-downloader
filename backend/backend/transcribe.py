import sys
import json
import os
import subprocess

from faster_whisper import WhisperModel


# Keep CPU/RAM usage low on Render Free
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"


MAX_DURATION = 10 * 60  # 10 minutes


def get_duration(audio_file):
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            audio_file
        ],
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise Exception(
            "Unable to read audio duration."
        )

    return float(result.stdout.strip())


if len(sys.argv) < 2:
    print(json.dumps({
        "error": "Audio file is required."
    }))
    sys.exit(1)


audio_file = sys.argv[1]


try:

    # Check audio duration first
    duration = get_duration(audio_file)

    print(
        f"Audio duration: {duration:.1f} seconds",
        file=sys.stderr
    )

    if duration > MAX_DURATION:

        print(json.dumps({
            "error":
                "This audio is longer than 10 minutes. "
                "Maximum allowed duration is 10 minutes."
        }))

        sys.exit(1)


    print(
        "Loading lightweight Whisper model...",
        file=sys.stderr
    )


    model = WhisperModel(
        "tiny",
        device="cpu",
        compute_type="int8",
        cpu_threads=1,
        num_workers=1
    )


    print(
        "Detecting language and transcribing...",
        file=sys.stderr
    )


    segments, info = model.transcribe(
        audio_file,
        beam_size=1,
        best_of=1,
        temperature=0,
        condition_on_previous_text=False,
        vad_filter=True
    )


    text_parts = []

    for segment in segments:

        text = segment.text.strip()

        if text:
            text_parts.append(text)


    text = " ".join(text_parts).strip()


    language = (
        info.language
        if info and info.language
        else "unknown"
    )


    if not text:

        print(json.dumps({
            "error":
                "No speech was detected in this audio."
        }))

        sys.exit(1)


    print(json.dumps({
        "text": text,
        "language": language
    }, ensure_ascii=False))


except Exception as e:

    print(
        json.dumps({
            "error": str(e)
        }, ensure_ascii=False)
    )

    sys.exit(1)
