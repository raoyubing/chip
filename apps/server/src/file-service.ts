import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { nanoid } from "nanoid";

export type FileUploadScene = "default" | "resume" | "form_design" | "approval_item_icon" | "system_logo";
export type FileViewPurpose = "default" | "kkfile" | "markdown";

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  content_type?: string | null;
  bucket: string;
  object_key: string;
  url?: string | null;
  view_url?: string | null;
}

export interface FileViewUrl {
  object_key: string;
  url: string;
  expires_in: number;
  mode?: "direct" | "proxy";
}

interface RustFsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
}

let cachedClient: S3Client | null = null;
let cachedClientSignature = "";

function createHttpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function readBooleanEnv(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

function readRustFsConfig(): RustFsConfig {
  const endpoint = process.env.RUSTFS_ENDPOINT;
  const accessKeyId = process.env.RUSTFS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RUSTFS_SECRET_ACCESS_KEY;
  const bucket = process.env.RUSTFS_BUCKET;
  const missing = [
    !endpoint ? "RUSTFS_ENDPOINT" : "",
    !accessKeyId ? "RUSTFS_ACCESS_KEY_ID" : "",
    !secretAccessKey ? "RUSTFS_SECRET_ACCESS_KEY" : "",
    !bucket ? "RUSTFS_BUCKET" : "",
  ].filter(Boolean);

  if (missing.length) {
    throw createHttpError(400, `RustFS 未配置：${missing.join("、")}`);
  }

  return {
    endpoint: endpoint as string,
    region: process.env.RUSTFS_REGION || "us-east-1",
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    bucket: bucket as string,
    forcePathStyle: readBooleanEnv(process.env.RUSTFS_FORCE_PATH_STYLE, true),
  };
}

function getS3Client() {
  const config = readRustFsConfig();
  const signature = JSON.stringify(config);
  if (!cachedClient || cachedClientSignature !== signature) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
    cachedClientSignature = signature;
  }

  return { client: cachedClient, config };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/g, "");
}

function normalizeObjectKey(objectKey: string) {
  const normalized = objectKey.trim().replace(/^\/+/, "");
  if (!normalized.startsWith("uploads/") || normalized.includes("..")) {
    throw createHttpError(403, "无权访问该文件");
  }
  return normalized;
}

function normalizeFileName(name: string) {
  return name
    .trim()
    .replace(/[\\/]+/g, "_")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/\s+/g, " ");
}

function getFileExtension(fileName?: string) {
  if (!fileName) return "";
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex >= 0 ? fileName.slice(lastDotIndex + 1).toLowerCase() : "";
}

function appendUtf8Charset(contentType: string) {
  return /charset=/i.test(contentType) ? contentType : `${contentType}; charset=utf-8`;
}

function resolvePreviewContentType(fileName?: string, fallbackContentType?: string | null) {
  const extension = getFileExtension(fileName);
  if (fallbackContentType) {
    if (fallbackContentType.toLowerCase().startsWith("text/")) {
      return appendUtf8Charset(fallbackContentType);
    }
    return fallbackContentType;
  }

  if (extension === "txt" || extension === "md" || extension === "markdown" || extension === "log") {
    return "text/plain; charset=utf-8";
  }

  return undefined;
}

function getObjectSceneFolder(scene: FileUploadScene) {
  if (scene === "resume") return "resumes";
  if (scene === "form_design") return "form-design";
  if (scene === "approval_item_icon") return "approval-item-icons";
  if (scene === "system_logo") return "system-logos";
  return "default";
}

function getOriginalFileNameFromObjectKey(objectKey: string) {
  const fileName = objectKey.split("/").pop() ?? objectKey;
  return fileName.replace(/^\d+_[^_]+_/, "");
}

function getFileProxyTokenSecret() {
  const secret = process.env.FILE_PROXY_SECRET || process.env.JWT_SECRET || "xiaosongshu-local-file-proxy";
  return crypto.createHash("sha256").update(`${secret}:file-proxy`).digest();
}

function getFileProxyTokenTtlSeconds() {
  const ttl = Number(process.env.FILE_PROXY_TOKEN_TTL_SECONDS || 60 * 10);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 60 * 10;
}

function createFileProxyToken(payload: {
  objectKey: string;
  expiresAt: number;
}) {
  const payloadText = JSON.stringify(payload);
  const signature = crypto
    .createHmac("sha256", getFileProxyTokenSecret())
    .update(payloadText)
    .digest("base64url");

  return `${Buffer.from(payloadText, "utf8").toString("base64url")}.${signature}`;
}

function verifyFileProxyToken(token: string) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    throw createHttpError(401, "文件访问令牌无效");
  }

  const payloadText = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const expectedSignature = crypto
    .createHmac("sha256", getFileProxyTokenSecret())
    .update(payloadText)
    .digest("base64url");

  const providedSignature = Buffer.from(signature);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);
  if (
    providedSignature.length !== expectedSignatureBuffer.length
    || !crypto.timingSafeEqual(providedSignature, expectedSignatureBuffer)
  ) {
    throw createHttpError(401, "文件访问令牌无效");
  }

  let payload: {
    objectKey: string;
    expiresAt: number;
  };

  try {
    payload = JSON.parse(payloadText) as {
      objectKey: string;
      expiresAt: number;
    };
  } catch {
    throw createHttpError(401, "文件访问令牌无效");
  }

  if (!payload.objectKey || !payload.expiresAt) {
    throw createHttpError(401, "文件访问令牌无效");
  }

  if (payload.expiresAt <= Date.now()) {
    throw createHttpError(401, "文件访问令牌已过期");
  }

  return {
    ...payload,
    objectKey: normalizeObjectKey(payload.objectKey),
  };
}

function createFileProxyUrl(params: {
  objectKey: string;
  fileName: string;
  contentType?: string | null;
  baseUrl?: string;
}) {
  const expiresIn = getFileProxyTokenTtlSeconds();
  const token = createFileProxyToken({
    objectKey: params.objectKey,
    expiresAt: Date.now() + expiresIn * 1000,
  });
  const fileStreamParams = new URLSearchParams({
    token,
    fullfilename: params.fileName,
  });
  if (params.contentType) {
    fileStreamParams.set("content_type", params.contentType);
  }
  const fileStreamPath = `/api/files/stream?${fileStreamParams.toString()}`;

  return {
    url: params.baseUrl
      ? new URL(fileStreamPath, params.baseUrl).toString()
      : fileStreamPath,
    expiresIn,
  };
}

function buildObjectUrl(config: RustFsConfig, objectKey: string) {
  return `${trimSlash(config.endpoint)}/${config.bucket}/${objectKey}`;
}

async function uploadObject(params: {
  objectKey: string;
  body: Buffer;
  contentType?: string | null;
}) {
  const { client, config } = getS3Client();
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: params.objectKey,
    Body: params.body,
    ContentType: params.contentType ?? undefined,
  }));

  return {
    bucket: config.bucket,
    objectKey: params.objectKey,
    url: buildObjectUrl(config, params.objectKey),
  };
}

async function deleteObject(objectKey: string) {
  const { client, config } = getS3Client();
  await client.send(new DeleteObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
  }));
}

async function getObjectStream(params: {
  objectKey: string;
  fileName?: string;
  contentType?: string | null;
}) {
  const { client, config } = getS3Client();
  const encodedFileName = params.fileName ? encodeURIComponent(params.fileName) : undefined;
  const responseContentType = resolvePreviewContentType(params.fileName, params.contentType);
  const command = new GetObjectCommand({
    Bucket: config.bucket,
    Key: params.objectKey,
    ResponseContentDisposition: encodedFileName
      ? `inline; filename*=UTF-8''${encodedFileName}`
      : undefined,
    ResponseContentType: responseContentType,
  });

  return client.send(command);
}

async function responseBodyToBuffer(body: unknown) {
  if (!body) throw createHttpError(404, "文件不存在");
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }

  const chunks: Buffer[] = [];
  if (body instanceof Readable) {
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  throw createHttpError(500, "文件流读取失败");
}

export const fileService = {
  async uploadFile(params: {
    scene: FileUploadScene;
    name: string;
    buffer: Buffer;
    contentType?: string | null;
  }): Promise<UploadedFile> {
    if (params.buffer.byteLength === 0) {
      throw createHttpError(400, "上传文件不能为空");
    }

    const { config } = getS3Client();
    const originalFileName = normalizeFileName(params.name) || `file_${nanoid(8)}`;
    const objectKey = `uploads/${getObjectSceneFolder(params.scene)}/public/${Date.now()}_${nanoid(10)}_${originalFileName}`;
    const result = await uploadObject({
      objectKey,
      body: params.buffer,
      contentType: params.contentType,
    });
    const view = createFileProxyUrl({
      fileName: originalFileName,
      objectKey: result.objectKey,
      contentType: params.contentType,
    });

    return {
      id: nanoid(18),
      name: originalFileName,
      size: params.buffer.byteLength,
      content_type: params.contentType ?? null,
      bucket: config.bucket,
      object_key: result.objectKey,
      url: result.url,
      view_url: view.url,
    };
  },

  async deleteFile(objectKey: string) {
    await deleteObject(normalizeObjectKey(objectKey));
    return { success: true };
  },

  getFileViewUrl(params: {
    objectKey: string;
    purpose?: FileViewPurpose;
    publicBaseUrl?: string;
    contentType?: string | null;
  }): FileViewUrl {
    const objectKey = normalizeObjectKey(params.objectKey);
    const fileName = getOriginalFileNameFromObjectKey(objectKey);
    const view = createFileProxyUrl({
      objectKey,
      fileName,
      contentType: params.contentType,
      baseUrl: params.purpose === "kkfile"
        ? (process.env.KKFILE_OA_BASE_URL || params.publicBaseUrl)
        : undefined,
    });

    return {
      object_key: objectKey,
      url: view.url,
      expires_in: view.expiresIn,
      mode: params.purpose === "kkfile" ? "proxy" : "direct",
    };
  },

  async getFileStream(params: {
    token: string;
    contentType?: string | null;
  }) {
    const payload = verifyFileProxyToken(params.token);
    const fileName = getOriginalFileNameFromObjectKey(payload.objectKey);
    const result = await getObjectStream({
      objectKey: payload.objectKey,
      fileName,
      contentType: params.contentType,
    });

    if (!result.Body) {
      throw createHttpError(404, "文件不存在");
    }

    return {
      body: result.Body,
      contentType: result.ContentType ?? "application/octet-stream",
      contentLength: result.ContentLength,
      lastModified: result.LastModified,
      eTag: result.ETag,
      fileName,
    };
  },

  async readFileBuffer(objectKey: string) {
    const normalizedObjectKey = normalizeObjectKey(objectKey);
    const result = await getObjectStream({
      objectKey: normalizedObjectKey,
      fileName: getOriginalFileNameFromObjectKey(normalizedObjectKey),
    });
    return responseBodyToBuffer(result.Body);
  },
};
