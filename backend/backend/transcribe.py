import sys
import json
import whisper


if len(sys.argv) < 2:
    print(json.dumps({
        "error": "Audio file is required"
    }))
    sys.exit(1)


audio_file = sys.argv[1]


try:

    print(
        "Loading Whisper tiny model...",
        file=sys.stderr
    )

    model = whisper.load_model(
        "tiny",
        device="cpu"
    )

    print(
        "Detecting language and transcribing...",
        file=sys.stderr
    )

    result = model.transcribe(
        audio_file,
        task="transcribe",
        language=None,
        fp16=False,
        temperature=0,
        verbose=False
    )

    text = (
        result.get("text", "")
        .strip()
    )

    language = (
        result.get("language")
        or "unknown"
    )

    print(json.dumps({
        "text": text,
        "language": language
    }, ensure_ascii=False))


except Exception as e:

    print(json.dumps({
        "error": str(e)
    }, ensure_ascii=False))

    sys.exit(1)
