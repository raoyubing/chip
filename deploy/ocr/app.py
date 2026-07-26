from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")

import cv2
import fitz
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from paddleocr import PaddleOCR

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("ppocrv6-service")

MODEL_ROOT = Path(os.getenv("OCR_MODEL_DIR", "/models"))
DETECTION_MODEL_NAME = os.getenv("OCR_DETECTION_MODEL_NAME", "PP-OCRv6_medium_det")
RECOGNITION_MODEL_NAME = os.getenv("OCR_RECOGNITION_MODEL_NAME", "PP-OCRv6_medium_rec")
DETECTION_MODEL_DIR = MODEL_ROOT / DETECTION_MODEL_NAME
RECOGNITION_MODEL_DIR = MODEL_ROOT / RECOGNITION_MODEL_NAME
MAX_INPUT_BYTES = max(1, int(os.getenv("OCR_MAX_INPUT_BYTES", str(50 * 1024 * 1024))))
DEFAULT_MAX_PAGES = max(1, min(20, int(os.getenv("OCR_MAX_PDF_PAGES", "5"))))
PDF_DPI = max(96, min(300, int(os.getenv("OCR_PDF_DPI", "180"))))
PDF_MAX_SIDE = max(960, min(4096, int(os.getenv("OCR_PDF_MAX_SIDE", "2400"))))
MIN_SCORE = max(0.0, min(1.0, float(os.getenv("OCR_MIN_SCORE", "0.45"))))
ENABLE_MKLDNN = os.getenv("OCR_ENABLE_MKLDNN", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}

ocr_engine: PaddleOCR | None = None
ocr_startup_error = ""
ocr_lock = asyncio.Lock()


def require_model_dir(path: Path) -> None:
    required_files = ("inference.json", "inference.pdiparams", "inference.yml")
    missing = [name for name in required_files if not (path / name).is_file()]
    if missing:
        raise RuntimeError(f"OCR model is incomplete: {path} (missing {', '.join(missing)})")


def create_ocr_engine() -> PaddleOCR:
    require_model_dir(DETECTION_MODEL_DIR)
    require_model_dir(RECOGNITION_MODEL_DIR)
    logger.info(
        "Loading PP-OCRv6 models: detection=%s recognition=%s",
        DETECTION_MODEL_DIR,
        RECOGNITION_MODEL_DIR,
    )
    return PaddleOCR(
        device=os.getenv("OCR_DEVICE", "cpu"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=ENABLE_MKLDNN,
        text_det_thresh=float(os.getenv("OCR_TEXT_DET_THRESH", "0.3")),
        text_det_box_thresh=float(os.getenv("OCR_TEXT_DET_BOX_THRESH", "0.5")),
        text_detection_model_name=DETECTION_MODEL_NAME,
        text_detection_model_dir=str(DETECTION_MODEL_DIR),
        text_recognition_model_name=RECOGNITION_MODEL_NAME,
        text_recognition_model_dir=str(RECOGNITION_MODEL_DIR),
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global ocr_engine, ocr_startup_error
    try:
        ocr_engine = await asyncio.to_thread(create_ocr_engine)
        logger.info("PP-OCRv6 service is ready")
    except Exception as error:
        ocr_startup_error = str(error)
        logger.exception("Failed to initialize PP-OCRv6")
    yield


app = FastAPI(title="PP-OCRv6 Service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail=ocr_startup_error or "OCR model is loading")
    return {
        "status": "ok",
        "detectionModel": DETECTION_MODEL_NAME,
        "recognitionModel": RECOGNITION_MODEL_NAME,
    }


def clamp_page_count(value: str | None) -> int:
    try:
        parsed = int(value or DEFAULT_MAX_PAGES)
    except ValueError:
        parsed = DEFAULT_MAX_PAGES
    return max(1, min(DEFAULT_MAX_PAGES, parsed))


def decode_image(data: bytes) -> np.ndarray:
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Unable to decode image")
    return image


def decode_pdf(data: bytes, max_pages: int) -> list[np.ndarray]:
    document = fitz.open(stream=data, filetype="pdf")
    try:
        images: list[np.ndarray] = []
        for page_index in range(min(document.page_count, max_pages)):
            page = document.load_page(page_index)
            scale = min(PDF_DPI / 72, PDF_MAX_SIDE / max(page.rect.width, page.rect.height))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            images.append(decode_image(pixmap.tobytes("png")))
        return images
    finally:
        document.close()


def to_json_value(value: Any) -> Any:
    return value.tolist() if hasattr(value, "tolist") else value


def predict_page(image: np.ndarray, page: int) -> list[dict[str, Any]]:
    if ocr_engine is None:
        raise RuntimeError(ocr_startup_error or "OCR model is not ready")
    prediction = ocr_engine.predict(image)
    if not prediction:
        return []

    payload = prediction[0].json
    if callable(payload):
        payload = payload()
    result = payload.get("res", payload)
    texts = result.get("rec_texts") or []
    scores = result.get("rec_scores") or []
    boxes = result.get("rec_boxes") or []
    lines: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        normalized_text = str(text).strip()
        score = float(scores[index]) if index < len(scores) else 0.0
        if not normalized_text or score < MIN_SCORE:
            continue
        lines.append(
            {
                "text": normalized_text,
                "score": score,
                "box": to_json_value(boxes[index]) if index < len(boxes) else None,
                "page": page,
            }
        )
    return lines


def run_ocr(data: bytes, content_type: str, max_pages: int) -> dict[str, Any]:
    started_at = time.perf_counter()
    is_pdf = content_type.startswith("application/pdf") or data.startswith(b"%PDF")
    images = decode_pdf(data, max_pages) if is_pdf else [decode_image(data)]
    page_lines = [predict_page(image, page_index + 1) for page_index, image in enumerate(images)]
    lines = [line for page in page_lines for line in page]
    text = "\n\n".join("\n".join(line["text"] for line in page) for page in page_lines if page)
    return {
        "text": text,
        "lines": lines,
        "pages": len(images),
        "elapsedMs": round((time.perf_counter() - started_at) * 1000),
        "model": "PP-OCRv6-medium",
    }


@app.post("/ocr")
async def recognize(request: Request) -> dict[str, Any]:
    if ocr_engine is None:
        raise HTTPException(status_code=503, detail=ocr_startup_error or "OCR model is not ready")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="Request body is empty")
    if len(data) > MAX_INPUT_BYTES:
        raise HTTPException(status_code=413, detail=f"OCR input exceeds {MAX_INPUT_BYTES} bytes")

    content_type = request.headers.get("content-type", "application/octet-stream").lower()
    max_pages = clamp_page_count(request.headers.get("x-ocr-max-pages"))
    try:
        async with ocr_lock:
            return await asyncio.to_thread(run_ocr, data, content_type, max_pages)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        logger.exception("OCR request failed")
        raise HTTPException(status_code=500, detail=f"OCR failed: {error}") from error
