import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";

import type { PersistedGatewayState } from "../types/api.js";

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

const DEFAULT_STATE: PersistedGatewayState = {
  upstreams: [],
  workspaces: [],
  responseRoutes: [],
  sessionRoutes: []
};

export class SecretStore {
  private readonly keyPath: string;
  private readonly statePath: string;

  constructor(private readonly dataDir: string) {
    this.keyPath = path.join(dataDir, "master.key");
    this.statePath = path.join(dataDir, "state.enc.json");
  }

  public getPaths(): { dataDir: string; keyPath: string; statePath: string } {
    return {
      dataDir: this.dataDir,
      keyPath: this.keyPath,
      statePath: this.statePath
    };
  }

  public async load(): Promise<PersistedGatewayState> {
    await this.ensureDataDir();

    try {
      const raw = await readFile(this.statePath, "utf8");
      const payload = JSON.parse(raw) as EncryptedPayload;
      const key = await this.ensureMasterKey();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64")
      );

      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");

      const parsed = JSON.parse(plaintext) as PersistedGatewayState;
      return {
        upstreams: parsed.upstreams ?? [],
        workspaces: parsed.workspaces ?? [],
        responseRoutes: parsed.responseRoutes ?? [],
        sessionRoutes: parsed.sessionRoutes ?? [],
        updatedAt: parsed.updatedAt
      };
    } catch (error) {
      const message = (error as NodeJS.ErrnoException).code;
      if (message === "ENOENT") {
        return DEFAULT_STATE;
      }

      throw error;
    }
  }

  public async save(state: PersistedGatewayState): Promise<void> {
    await this.ensureDataDir();
    const key = await this.ensureMasterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const payloadText = JSON.stringify({
      upstreams: state.upstreams,
      workspaces: state.workspaces,
      responseRoutes: state.responseRoutes ?? [],
      sessionRoutes: state.sessionRoutes ?? [],
      updatedAt: new Date().toISOString()
    });

    const ciphertext = Buffer.concat([cipher.update(payloadText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encryptedPayload: EncryptedPayload = {
      version: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };

    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(encryptedPayload, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempPath, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  private async ensureDataDir(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
  }

  private async ensureMasterKey(): Promise<Buffer> {
    try {
      await stat(this.keyPath);
      return await readFile(this.keyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }

      const key = randomBytes(32);
      await writeFile(this.keyPath, key, { mode: 0o600 });
      await chmod(this.keyPath, 0o600);
      return key;
    }
  }
}
