import sys
import json
import os
import subprocess

# Keep CPU/RAM usage low on Render Free
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"

from faster_whisper import WhisperModel


MAX_DURATION = 10 * 60


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

    output = result.stdout.strip()

    if not output:
        raise Exception(
            "Audio duration could not be detected."
        )

    return float(output)


def send_result(data):
    # IMPORTANT:
    # Only final JSON goes to stdout.
    print(
        json.dumps(
            data,
            ensure_ascii=False
        )
    )


if len(sys.argv) < 2:
    send_result({
        "error": "Audio file is required."
    })
    sys.exit(1)


audio_file = sys.argv[1]


try:

    # Check that audio exists
    if not os.path.exists(audio_file):
        raise Exception(
            "Audio file was not found."
        )


    # Check duration
    duration = get_duration(
        audio_file
    )

    print(
        f"Audio duration: {duration:.1f} seconds",
        file=sys.stderr
    )


    if duration > MAX_DURATION:

        send_result({
            "error":
                "This audio is longer than 10 minutes. "
                "Maximum allowed duration is 10 minutes."
        })

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

        segment_text = (
            segment.text.strip()
        )

        if segment_text:
            text_parts.append(
                segment_text
            )


    text = " ".join(
        text_parts
    ).strip()


    language = (
        info.language
        if info and info.language
        else "unknown"
    )


    if not text:

        send_result({
            "error":
                "No speech was detected in this audio."
        })

        sys.exit(1)


    # IMPORTANT:
    # Only final result goes to stdout.
    send_result({
        "text": text,
        "language": language
    })


except Exception as e:

    print(
        f"TRANSCRIPTION PYTHON ERROR: {e}",
        file=sys.stderr
    )

    send_result({
        "error": str(e)
    })

    sys.exit(1)
