function buildNetworkErrorMessage(url: string) {
  if (url.startsWith("/api/voice")) {
    return "访音解析服务连接失败，请确认本地后端已启动后重试。";
  }
  return "本地服务连接失败，请确认 Node 后端已启动并监听 5175 端口。";
}

function isResumeRequest(url: string) {
  return url === "/api/files/upload"
    || url.startsWith("/api/resumes/")
    || /^\/api\/jobs\/[^/]+\/resumes(?:\?|$)/.test(url);
}

function isHtmlResponse(text: string, contentType = "") {
  const lowerText = text.trim().toLowerCase();
  return contentType.toLowerCase().includes("text/html")
    || lowerText.startsWith("<!doctype html")
    || lowerText.startsWith("<html")
    || lowerText.includes("<body");
}

function buildResumeOverloadMessage() {
  return "哎呀，服务器挤爆啦，请稍后重试。";
}

function buildHttpErrorMessage(url: string, status: number, text: string) {
  const trimmed = text.trim();
  const lowerText = trimmed.toLowerCase();
  const isHtmlError = isHtmlResponse(trimmed);
  const isOverloadError = status === 413 || status === 429 || status === 502 || status === 503 || status === 504;
  if (isResumeRequest(url) && (isHtmlError || isOverloadError)) return buildResumeOverloadMessage();
  const isCloudflareTimeout = status === 524
    || lowerText.includes("cf-error-code 524")
    || lowerText.includes("a timeout occurred")
    || lowerText.includes("cloudflare");
  if (isCloudflareTimeout) {
    if (url.startsWith("/api/salary")) {
      return "薪酬调研外部采集超时，请稍后重试；如果一直失败，建议先减少筛选条件或确认 BOSS 采集服务可用。";
    }
    return "外部服务响应超时，请稍后重试。";
  }
  if (isHtmlError) return "外部服务返回了错误页面，请稍后重试。";
  if (trimmed) return trimmed;
  if (status >= 500) {
    if (url.startsWith("/api/voice")) {
      return "访音解析服务暂时不可用，请确认本地后端已启动，且本地语音模型已安装。";
    }
    return "本地服务暂时不可用，请确认 Node 后端已启动并监听 5175 端口。";
  }
  return `请求失败：${status}`;
}

export async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = options.body && !isFormData ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      ...options,
    });
  } catch {
    throw new Error(buildNetworkErrorMessage(url));
  }
  const text = await response.text();
  if (!response.ok) {
    let message = buildHttpErrorMessage(url, response.status, text);
    try {
      const parsed = JSON.parse(text);
      const isOverloadError = response.status === 413 || response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
      if (parsed?.message && !(isResumeRequest(url) && isOverloadError)) message = String(parsed.message);
    } catch {
      message = buildHttpErrorMessage(url, response.status, text);
    }
    throw new Error(message);
  }
  if (isHtmlResponse(text, response.headers.get("content-type") || "")) {
    throw new Error(isResumeRequest(url) ? buildResumeOverloadMessage() : "服务器返回了异常页面，请稍后重试。");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(isResumeRequest(url) ? buildResumeOverloadMessage() : "服务器返回的数据格式异常，请稍后重试。");
  }
}
