
import sys
import json
import os
import subprocess

# Keep CPU and memory usage low
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

from faster_whisper import WhisperModel

MAX_DURATION = 10 * 60


def send_result(data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def get_duration(audio_file):
    result = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audio_file
        ],
        capture_output=True,
        text=True,
        timeout=30
    )

    if result.returncode != 0:
        raise RuntimeError("Unable to read audio duration.")

    output = result.stdout.strip()

    if not output:
        raise RuntimeError("Audio duration could not be detected.")

    return float(output)


def main():
    if len(sys.argv) < 2:
        send_result({"error": "Audio file is required."})
        return 1

    audio_file = sys.argv[1]

    try:
        if not os.path.isfile(audio_file):
            raise RuntimeError("Audio file was not found.")

        duration = get_duration(audio_file)

        print(
            f"Audio duration: {duration:.1f} seconds",
            file=sys.stderr,
            flush=True
        )

        if duration <= 0:
            raise RuntimeError("Audio file is empty or invalid.")

        if duration > MAX_DURATION:
            send_result({
                "error": "Audio is longer than 10 minutes. Maximum allowed duration is 10 minutes."
            })
            return 1

        print(
            "Loading lightweight Whisper model...",
            file=sys.stderr,
            flush=True
        )

        model = WhisperModel(
            "tiny",
            device="cpu",
            compute_type="int8",
            cpu_threads=1,
            num_workers=1
        )

        print(
            "Starting transcription...",
            file=sys.stderr,
            flush=True
        )

        segments, info = model.transcribe(
            audio_file,
            beam_size=1,
            best_of=1,
            temperature=0,
            condition_on_previous_text=False,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 500
            }
        )

        text_parts = []

        for segment in segments:
            segment_text = segment.text.strip()
            if segment_text:
                text_parts.append(segment_text)

        text = " ".join(text_parts).strip()

        if not text:
            send_result({
                "error": "No speech was detected in this audio."
            })
            return 1

        language = (
            info.language
            if info and info.language
            else "unknown"
        )

        send_result({
            "text": text,
            "language": language
        })

        return 0

    except subprocess.TimeoutExpired:
        send_result({
            "error": "Audio duration check timed out. Please try again."
        })
        return 1

    except Exception as e:
        print(
            f"TRANSCRIPTION PYTHON ERROR: {type(e).__name__}: {e}",
            file=sys.stderr,
            flush=True
        )

        send_result({
            "error": f"Transcription failed: {str(e)}"
        })
        return 1


if __name__ == "__main__":
    sys.exit(main())
    
