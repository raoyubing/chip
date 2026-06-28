import json
import os
import sys

from faster_whisper import WhisperModel


MODEL_SIZE = os.environ.get("XIAOSONGSHU_WHISPER_MODEL", "tiny")


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: transcribe_audio.py <input_audio> <output_json>")

    input_audio = sys.argv[1]
    _output_json = sys.argv[2]

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(input_audio, language="zh", vad_filter=True)

    chunks = []
    texts = []
    for segment in segments:
        text = (segment.text or "").strip()
        if not text:
            continue
        texts.append(text)
        chunks.append({
            "text": text,
            "timestamp": [round(float(segment.start), 2), round(float(segment.end), 2)],
        })

    payload = {
        "transcript": "".join(texts).strip(),
        "chunks": chunks,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
