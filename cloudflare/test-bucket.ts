// An in-memory stand-in for the R2 bucket, for tests.
export class Bucket {
  objects = new Map<string, string>();
  async head(key: string) { return this.objects.has(key) ? { key } : null; }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async put(key: string, value: string, options?: R2PutOptions) {
    if (options?.onlyIf && this.objects.has(key)) return null;
    this.objects.set(key, value);
    return { key };
  }
  async list({ prefix }: R2ListOptions) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix ?? "")).map((key) => ({ key })), truncated: false };
  }
}
