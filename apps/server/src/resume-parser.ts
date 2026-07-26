export interface ResumeUploadFile {
  name: string;
  type?: string | null;
  size?: number | null;
  text?: string;
  dataBase64?: string | null;
}

export async function extractResumeTextFromFile(file: ResumeUploadFile) {
  const extension = getFileExtension(file.name);
  const mimeType = (file.type || "").toLowerCase();
  const buffer = file.dataBase64 ? Buffer.from(file.dataBase64, "base64") : null;
  const providedText = normalizeExtractedText(file.text || "");

  if (providedText && isPlainTextLike(extension, mimeType)) {
    return { text: providedText, method: "client-text" as const };
  }

  if (!buffer?.length) {
    return { text: providedText, method: "empty" as const };
  }

  if (extension === "pdf" || mimeType === "application/pdf") {
    const pdfText = await extractPdfText(buffer);
    if (pdfText) return { text: pdfText, method: "pdf" as const };
    const ocrText = await extractPdfImageText(buffer, file.name);
    return { text: ocrText || providedText, method: ocrText ? "image" as const : "pdf" as const };
  }

  if (extension === "docx") {
    const text = await extractDocxText(buffer);
    return { text: text || providedText, method: "docx" as const };
  }

  if (extension === "doc") {
    const text = await extractDocText(buffer);
    return { text: text || providedText, method: "doc" as const };
  }

  if (isImageFile(extension, mimeType)) {
    const text = await extractImageText(buffer, mimeType || "application/octet-stream", file.name);
    return { text: text || providedText, method: "image" as const };
  }

  if (providedText) {
    return { text: normalizeNonBinaryText(providedText, extension), method: "text" as const };
  }

  return { text: "", method: "unknown" as const };
}

function getFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function isPlainTextLike(extension: string, mimeType: string) {
  return Boolean(
    mimeType.startsWith("text/")
      || /json|xml/.test(mimeType)
      || ["txt", "md", "markdown", "csv", "json", "xml", "html", "htm", "rtf"].includes(extension),
  );
}

function isImageFile(extension: string, mimeType: string) {
  return mimeType.startsWith("image/")
    || ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif"].includes(extension);
}

function normalizeNonBinaryText(text: string, extension: string) {
  if (extension === "html" || extension === "htm" || extension === "xml") {
    return normalizeExtractedText(text.replace(/<[^>]+>/g, " "));
  }
  if (extension === "rtf") {
    return normalizeExtractedText(
      text
        .replace(/\\par[d]?/g, "\n")
        .replace(/\\'[0-9a-f]{2}/gi, " ")
        .replace(/\\[a-z]+\d* ?/gi, " ")
        .replace(/[{}]/g, " "),
    );
  }
  return normalizeExtractedText(text);
}

async function extractPdfText(buffer: Buffer) {
  try {
    const pdfParseModule = await import("pdf-parse/lib/pdf-parse.js");
    const pdfParse = (pdfParseModule.default || pdfParseModule) as (dataBuffer: Buffer, options?: { max?: number }) => Promise<{ text?: string }>;
    const result = await pdfParse(buffer);
    return normalizeExtractedText(result.text || "");
  } catch {
    return "";
  }
}

async function extractPdfImageText(buffer: Buffer, fileName: string) {
  return extractImageText(buffer, "application/pdf", fileName, getPdfOcrMaxPages());
}

async function extractDocxText(buffer: Buffer) {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return normalizeExtractedText(result.value || "");
  } catch {
    return "";
  }
}

async function extractDocText(buffer: Buffer) {
  try {
    const module = await import("word-extractor");
    const WordExtractor = (module.default || module) as new () => {
      extract: (input: Buffer) => Promise<{
        getBody: () => string;
        getHeaders?: (options?: unknown) => string;
        getFooters?: () => string;
      }>;
    };
    const extractor = new WordExtractor();
    const document = await extractor.extract(buffer);
    const parts = [
      document.getBody?.() || "",
      document.getHeaders?.({ includeFooters: false }) || "",
      document.getFooters?.() || "",
    ].filter(Boolean);
    return normalizeExtractedText(parts.join("\n\n"));
  } catch {
    return "";
  }
}

async function extractImageText(buffer: Buffer, contentType: string, fileName: string, maxPages = 1) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getOcrRequestTimeoutMs());
    try {
      const response = await fetch(`${getOcrServiceUrl()}/ocr`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          "x-file-name": encodeURIComponent(fileName),
          "x-ocr-max-pages": String(maxPages),
        },
        body: Uint8Array.from(buffer).buffer,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`OCR 服务返回 ${response.status}：${detail}`);
      }
      const result = await response.json() as { text?: unknown };
      return normalizeExtractedText(typeof result.text === "string" ? result.text : "");
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn(`[resume-ocr] ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function getOcrServiceUrl() {
  return (process.env.OCR_SERVICE_URL || "http://127.0.0.1:8019").replace(/\/+$/, "");
}

function getPdfOcrMaxPages() {
  const value = Number(process.env.RESUME_PDF_OCR_MAX_PAGES || 2);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(5, Math.round(value)));
}

function getOcrRequestTimeoutMs() {
  const value = Number(process.env.OCR_REQUEST_TIMEOUT_MS || 180000);
  if (!Number.isFinite(value)) return 180000;
  return Math.max(5000, Math.min(600000, Math.round(value)));
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
