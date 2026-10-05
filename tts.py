import asyncio
import sys
import edge_tts


async def main():

    if len(sys.argv) != 4:
        print(
            "Usage: python3 tts.py <text_file> <output_file> <voice>",
            file=sys.stderr
        )
        sys.exit(1)

    text_file = sys.argv[1]
    output_file = sys.argv[2]
    voice = sys.argv[3]

    with open(
        text_file,
        "r",
        encoding="utf-8"
    ) as f:
        text = f.read().strip()

    if not text:
        print(
            "Text file is empty.",
            file=sys.stderr
        )
        sys.exit(1)

    communicate = edge_tts.Communicate(
        text,
        voice
    )

    await communicate.save(
        output_file
    )


if __name__ == "__main__":
    asyncio.run(main())
