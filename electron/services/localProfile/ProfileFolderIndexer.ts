import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { RAGManager } from '../../rag/RAGManager';
import type { ParsedLocalProfile, ParsedProfileFile } from './localProfileParser';
import { chunkProfileDocuments } from './profileDocumentChunker';

export const LOCAL_PROFILE_MEETING_ID = 'local-profile-folder';

export interface ProfileVectorIndexStatus {
  indexedChunks: number;
  embeddingsReady: boolean;
  lastIndexedAt: string | null;
  indexingInFlight: boolean;
  contentHash: string | null;
  error?: string;
}

interface PersistedIndexMeta {
  contentHash: string;
  lastIndexedAt: string;
  indexedChunks: number;
}

export class ProfileFolderIndexer {
  private ragManager: RAGManager | null = null;
  private indexingInFlight = false;
  private lastStatus: ProfileVectorIndexStatus = {
    indexedChunks: 0,
    embeddingsReady: false,
    lastIndexedAt: null,
    indexingInFlight: false,
    contentHash: null,
  };

  setRAGManager(rag: RAGManager | null): void {
    this.ragManager = rag;
    this.refreshEmbeddingsReady();
  }

  getStatus(): ProfileVectorIndexStatus {
    return { ...this.lastStatus, indexingInFlight: this.indexingInFlight };
  }

  private metaPath(): string {
    const base = process.env.NATIVELY_TEST_USERDATA?.trim() || app.getPath('userData');
    return path.join(base, 'local-profile-vector-index.json');
  }

  private computeContentHash(parsed: ParsedLocalProfile, files: ParsedProfileFile[]): string {
    const payload = [
      parsed.rawText,
      ...files.map((f) => `${f.relativePath}:${f.content.length}`),
    ].join('\n');
    return createHash('sha256').update(payload).digest('hex');
  }

  private async readMeta(): Promise<PersistedIndexMeta | null> {
    try {
      const raw = await fs.promises.readFile(this.metaPath(), 'utf8');
      return JSON.parse(raw) as PersistedIndexMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(meta: PersistedIndexMeta): Promise<void> {
    await fs.promises.writeFile(this.metaPath(), JSON.stringify(meta), 'utf8');
  }

  async clearIndex(): Promise<void> {
    if (this.ragManager) {
      this.ragManager.deleteMeetingData(LOCAL_PROFILE_MEETING_ID);
    }
    try {
      await fs.promises.unlink(this.metaPath());
    } catch {
      // ignore
    }
    this.lastStatus = {
      indexedChunks: 0,
      embeddingsReady: false,
      lastIndexedAt: null,
      indexingInFlight: false,
      contentHash: null,
    };
  }

  refreshEmbeddingsReady(): void {
    if (!this.ragManager) {
      this.lastStatus.embeddingsReady = false;
      return;
    }
    this.lastStatus.embeddingsReady = this.ragManager.hasCorpusEmbeddings(LOCAL_PROFILE_MEETING_ID);
  }

  scheduleIndex(parsed: ParsedLocalProfile, files: ParsedProfileFile[]): void {
    void this.index(parsed, files).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[ProfileFolderIndexer] index failed:', message);
      this.lastStatus = {
        ...this.lastStatus,
        indexingInFlight: false,
        error: message,
      };
    });
  }

  async index(parsed: ParsedLocalProfile, files: ParsedProfileFile[]): Promise<ProfileVectorIndexStatus> {
    if (this.indexingInFlight) {
      return this.getStatus();
    }
    if (!this.ragManager) {
      this.lastStatus = {
        ...this.lastStatus,
        error: 'RAG pipeline not available',
      };
      return this.getStatus();
    }

    const contentHash = this.computeContentHash(parsed, files);
    const prior = await this.readMeta();
    if (prior?.contentHash === contentHash) {
      this.refreshEmbeddingsReady();
      this.lastStatus = {
        indexedChunks: prior.indexedChunks,
        embeddingsReady: this.lastStatus.embeddingsReady,
        lastIndexedAt: prior.lastIndexedAt,
        indexingInFlight: false,
        contentHash,
      };
      return this.getStatus();
    }

    this.indexingInFlight = true;
    this.lastStatus = { ...this.lastStatus, indexingInFlight: true, error: undefined };

    try {
      const items = chunkProfileDocuments(files);
      const { chunkCount } = await this.ragManager.indexTextCorpus(
        LOCAL_PROFILE_MEETING_ID,
        items.map((item) => ({ label: item.label, text: item.text })),
        { title: 'Local Profile Folder' },
      );

      const now = new Date().toISOString();
      await this.writeMeta({ contentHash, lastIndexedAt: now, indexedChunks: chunkCount });
      this.refreshEmbeddingsReady();
      this.lastStatus = {
        indexedChunks: chunkCount,
        embeddingsReady: this.lastStatus.embeddingsReady,
        lastIndexedAt: now,
        indexingInFlight: false,
        contentHash,
      };
      console.log(`[ProfileFolderIndexer] Indexed ${chunkCount} profile chunks (${LOCAL_PROFILE_MEETING_ID})`);
      return this.getStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastStatus = {
        ...this.lastStatus,
        indexingInFlight: false,
        error: message,
      };
      throw err;
    } finally {
      this.indexingInFlight = false;
    }
  }
}
