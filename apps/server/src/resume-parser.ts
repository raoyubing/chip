import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ResumeUploadFile {
  name: string;
  type?: string | null;
  size?: number | null;
  text?: string;
  dataBase64?: string | null;
}

type OcrWorker = {
  recognize: (image: Buffer | Uint8Array | string) => Promise<{ data?: { text?: string } }>;
  terminate: () => Promise<unknown>;
};

let ocrWorkerPromise: Promise<OcrWorker> | null = null;

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
    const ocrText = await extractPdfImageText(buffer);
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
    const text = await extractImageText(buffer);
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

async function extractPdfImageText(buffer: Buffer) {
  const tempDir = await mkdtemp(join(tmpdir(), "resume-pdf-ocr-"));
  try {
    const pdfPath = join(tempDir, "resume.pdf");
    const outputPrefix = join(tempDir, "page");
    await writeFile(pdfPath, buffer);
    await runCommand("pdftoppm", [
      "-png",
      "-r",
      "180",
      "-f",
      "1",
      "-l",
      String(getPdfOcrMaxPages()),
      pdfPath,
      outputPrefix,
    ], getPdfOcrTimeoutMs());

    const imageFiles = (await readdir(tempDir))
      .filter((fileName) => /^page-\d+\.png$/i.test(fileName) || /^page\.png$/i.test(fileName))
      .sort((left, right) => left.localeCompare(right, "zh-Hans-CN", { numeric: true }));
    const texts: string[] = [];
    for (const imageFile of imageFiles) {
      const imageBuffer = await readFile(join(tempDir, imageFile));
      const text = await extractImageText(imageBuffer);
      if (text) texts.push(text);
      if (texts.join("\n").length >= 6000) break;
    }
    return normalizeExtractedText(texts.join("\n\n"));
  } catch {
    return "";
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
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

async function extractImageText(buffer: Buffer) {
  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(buffer);
    return normalizeExtractedText(result.data?.text || "");
  } catch {
    return "";
  }
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      return await createWorker("chi_sim+eng") as unknown as OcrWorker;
    })();
  }
  return ocrWorkerPromise;
}

function getPdfOcrMaxPages() {
  const value = Number(process.env.RESUME_PDF_OCR_MAX_PAGES || 2);
  if (!Number.isFinite(value)) return 2;
  return Math.max(1, Math.min(5, Math.round(value)));
}

function getPdfOcrTimeoutMs() {
  const value = Number(process.env.RESUME_PDF_OCR_TIMEOUT_MS || 20000);
  if (!Number.isFinite(value)) return 20000;
  return Math.max(5000, Math.min(60000, Math.round(value)));
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderrChunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} 执行超时`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.from(chunk));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} 执行失败：${Buffer.concat(stderrChunks).toString("utf8").trim() || code}`));
    });
  });
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
