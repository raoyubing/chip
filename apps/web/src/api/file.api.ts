import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import type { SchemaDTO } from "./dto/schema.dto";
import { request } from "./client";

export const fileApi = {
  uploadFile: (file: File, scene: SchemaDTO.FileUploadScene = "default") => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("scene", scene);
    return request<ResponseDTO.UploadFile>("/api/files/upload", { method: "POST", body: formData });
  },
  deleteFile: (objectKey: string) =>
    request<ResponseDTO.ActionResult>("/api/files", { method: "DELETE", body: JSON.stringify({ object_key: objectKey } satisfies RequestDTO.DeleteFile) }),
  getFileViewUrl: (objectKey: string, payload: { purpose?: "default" | "kkfile" | "markdown"; contentType?: string | null } = {}) => {
    const params = new URLSearchParams({
      object_key: objectKey,
      purpose: payload.purpose || "default",
    } satisfies RequestDTO.GetFileViewUrl);
    if (payload.contentType) params.set("content_type", payload.contentType);
    return request<ResponseDTO.GetFileViewUrl>(`/api/files/view-url?${params.toString()}`);
  },
};
