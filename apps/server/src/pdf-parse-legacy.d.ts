declare module "pdf-parse/lib/pdf-parse.js" {
  export default function pdfParse(
    dataBuffer: Buffer,
    options?: { max?: number },
  ): Promise<{
    text?: string;
    numpages?: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  }>;
}
