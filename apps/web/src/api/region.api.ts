import type { ResponseDTO } from "./dto/response.dto";
import { request } from "./client";

export const regionApi = {
  regions: () => request<ResponseDTO.RegionDirectory>("/api/regions"),
};
