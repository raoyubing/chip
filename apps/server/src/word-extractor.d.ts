declare module "word-extractor" {
  export default class WordExtractor {
    extract(input: string | Buffer): Promise<{
      getBody(): string;
      getHeaders(options?: unknown): string;
      getFooters(): string;
    }>;
  }
}
