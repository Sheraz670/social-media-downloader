
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

    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError("Unable to read audio duration.")

    return float(result.stdout.strip())


def main():
    if len(sys.argv) < 2:
        send_result({"error": "Audio file is required."})
        return 1

    audio_file = sys.argv[1]

    try:
        if not os.path.isfile(audio_file):
            raise RuntimeError("Audio file was not found.")

        duration = get_duration(audio_file)

        if duration <= 0:
            raise RuntimeError("Audio file is empty or invalid.")

        if duration > MAX_DURATION:
            send_result({
                "error": "Audio is longer than 10 minutes. Maximum allowed duration is 10 minutes."
            })
            return 1

        model = WhisperModel(
            "tiny",
            device="cpu",
            compute_type="int8",
            cpu_threads=1,
            num_workers=1
        )

        segments, info = model.transcribe(
            audio_file,
            beam_size=1,
            best_of=1,
            temperature=0,
            condition_on_previous_text=False,
            vad_filter=True,
            word_timestamps=True,
            vad_parameters={
                "min_silence_duration_ms": 500
            }
        )

        text_parts = []
        words = []

        for segment in segments:
            segment_text = segment.text.strip()

            if segment_text:
                text_parts.append(segment_text)

            segment_words = getattr(segment, "words", None) or []

            if segment_words:
                for word in segment_words:
                    word_text = (word.word or "").strip()

                    if not word_text:
                        continue

                    start = max(0.0, float(word.start))
                    end = min(duration, float(word.end))

                    if end > start:
                        words.append({
                            "start": round(start, 3),
                            "end": round(end, 3),
                            "text": word_text
                        })

            elif segment_text:
                fallback_words = segment_text.split()
                count = len(fallback_words)
                span = max(0.01, segment.end - segment.start)

                for index, word_text in enumerate(fallback_words):
                    start = segment.start + span * index / count
                    end = segment.start + span * (index + 1) / count

                    words.append({
                        "start": round(max(0.0, start), 3),
                        "end": round(min(duration, end), 3),
                        "text": word_text
                    })

        text = " ".join(text_parts).strip()

        if not text or not words:
            send_result({
                "error": "No speech or word timestamps were detected."
            })
            return 1

        send_result({
            "text": text,
            "language": info.language if info and info.language else "unknown",
            "duration": duration,
            "words": words
        })

        return 0

    except subprocess.TimeoutExpired:
        send_result({
            "error": "Audio duration check timed out. Please try again."
        })
        return 1

    except Exception as error:
        print(
            f"TRANSCRIPTION PYTHON ERROR: {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True
        )

        send_result({
            "error": f"Transcription failed: {str(error)}"
        })
        return 1


if __name__ == "__main__":
    sys.exit(main())
        
