import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import { request } from "./client";

export const salaryApi = {
  researchSalary: (filters: RequestDTO.SalaryResearch) =>
    request<ResponseDTO.SalaryResearch>("/api/salary/research", { method: "POST", body: JSON.stringify(filters) }),
};
