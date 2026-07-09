function buildNetworkErrorMessage(url: string) {
  if (url.startsWith("/api/voice")) {
    return "访音解析服务连接失败，请确认本地后端已启动后重试。";
  }
  return "本地服务连接失败，请确认 Node 后端已启动并监听 5175 端口。";
}

function buildHttpErrorMessage(url: string, status: number, text: string) {
  const trimmed = text.trim();
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
  if (!response.ok) {
    const text = await response.text();
    let message = buildHttpErrorMessage(url, response.status, text);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) message = String(parsed.message);
    } catch {
      message = buildHttpErrorMessage(url, response.status, text);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
