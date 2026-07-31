import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RegionNode } from "@xiaosongshu/shared";
import { serverRoot } from "./env.js";

interface GaodeDistrict {
  adcode?: string;
  name?: string;
  level?: string;
  districts?: GaodeDistrict[];
}

interface GaodeAreaPayload {
  status?: string;
  districts?: GaodeDistrict[];
}

interface RegionDirectory {
  source: "gaode-local";
  regions: RegionNode[];
}

const gaodeAreaPath = resolve(serverRoot, "data/gaode-area.json");
let cachedDirectory: RegionDirectory | null = null;

export async function getRegionDirectory(): Promise<RegionDirectory> {
  if (cachedDirectory) return cachedDirectory;

  const payload = JSON.parse(await readFile(gaodeAreaPath, "utf8")) as GaodeAreaPayload;
  if (payload.status !== "1" || !payload.districts?.length) {
    throw new Error("高德行政区划数据无效");
  }

  const country = payload.districts.find((item) => item.level === "country") || payload.districts[0];
  const regions = (country.districts || [])
    .map(normalizeProvince)
    .filter((region): region is RegionNode => Boolean(region));
  if (!regions.length) throw new Error("高德行政区划数据为空");

  cachedDirectory = { source: "gaode-local", regions };
  return cachedDirectory;
}

function normalizeProvince(province: GaodeDistrict): RegionNode | null {
  if (!province.adcode || !province.name) return null;
  const code = province.adcode;
  const name = province.name;
  const children = (province.districts || [])
    .filter((child) => child.level === "city")
    .map((child) => normalizeCity(child, name))
    .filter((region): region is RegionNode => Boolean(region));
  const hasDirectDistrict = (province.districts || []).some((child) => child.level === "district");

  return {
    code,
    name,
    level: "province",
    children: hasDirectDistrict
      ? [{
        code: `${code}-city`,
        name,
        level: "city",
        children: [],
      }]
      : children,
  };
}

function normalizeCity(city: GaodeDistrict, provinceName: string): RegionNode | null {
  if (!city.adcode || !city.name) return null;
  const displayName = city.name.endsWith("城区") && provinceName.endsWith("市") ? provinceName : city.name;
  return {
    code: city.adcode,
    name: displayName,
    level: "city",
    children: [],
  };
}
