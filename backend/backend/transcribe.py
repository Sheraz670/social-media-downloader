import sys
import json
import whisper

if len(sys.argv) < 2:
    print(json.dumps({"error": "Audio file is required"}))
    sys.exit(1)

audio_file = sys.argv[1]

try:
    model = whisper.load_model("tiny")
    result = model.transcribe(audio_file)

    print(json.dumps({
        "text": result.get("text", "").strip()
    }))

except Exception as e:
    print(json.dumps({
        "error": str(e)
    }))
    sys.exit(1)
