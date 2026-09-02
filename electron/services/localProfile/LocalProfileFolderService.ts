import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { SettingsManager } from '../SettingsManager';
import { SAFE_DOCUMENT_EXTENSIONS, extractSafeDocumentText } from '../SafeDocumentTextExtractor';
import {
  parseLocalProfileFiles,
  type ParsedLocalProfile,
  type ParsedProfileFile,
} from './localProfileParser';

const MAX_FOLDER_FILES = 32;
const MAX_SCAN_DEPTH = 4;
const SKIP_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.obsidian',
  'dist',
  'build',
  '.next',
]);

export interface LocalProfileFolderStatus {
  folderPath: string | null;
  fileCount: number;
  lastSyncedAt: string | null;
  files: string[];
  hasProfile: boolean;
  profileName?: string;
  error?: string;
}

interface PersistedSnapshot {
  folderPath: string;
  lastSyncedAt: string;
  parsed: ParsedLocalProfile;
}

export class LocalProfileFolderService {
  private static instance: LocalProfileFolderService | null = null;

  private parsed: ParsedLocalProfile | null = null;
  private lastParsedFiles: ParsedProfileFile[] = [];
  private folderPath: string | null = null;
  private lastSyncedAt: string | null = null;
  private syncedFiles: string[] = [];
  private lastError: string | null = null;

  static getInstance(): LocalProfileFolderService {
    if (!LocalProfileFolderService.instance) {
      LocalProfileFolderService.instance = new LocalProfileFolderService();
    }
    return LocalProfileFolderService.instance;
  }

  static resetForTest(): void {
    LocalProfileFolderService.instance = null;
  }

  private snapshotPath(): string {
    return path.join(app.getPath('userData'), 'local-profile-folder-snapshot.json');
  }

  async initialize(): Promise<void> {
    const settings = SettingsManager.getInstance();
    const configured = settings.get('localProfileFolderPath');
    const envPath = process.env.NATIVELY_PROFILE_FOLDER?.trim();
    const initialPath = typeof configured === 'string' && configured
      ? configured
      : (envPath || null);

    if (initialPath) {
      this.folderPath = path.resolve(initialPath);
    }

    try {
      const raw = await fs.promises.readFile(this.snapshotPath(), 'utf8');
      const snapshot = JSON.parse(raw) as PersistedSnapshot;
      if (snapshot?.parsed?.structured) {
        this.parsed = snapshot.parsed;
        this.lastSyncedAt = snapshot.lastSyncedAt ?? null;
        this.syncedFiles = snapshot.parsed.structured._source_files ?? [];
        if (!this.folderPath && snapshot.folderPath) {
          this.folderPath = snapshot.folderPath;
        }
      }
    } catch {
      // cold start
    }

    if (this.folderPath && fs.existsSync(this.folderPath)) {
      try {
        await this.syncFolder(this.folderPath, { persistPath: false });
      } catch (err: any) {
        this.lastError = err?.message || String(err);
        console.warn('[LocalProfileFolder] startup sync failed:', this.lastError);
      }
    }
  }

  getParsedProfile(): ParsedLocalProfile | null {
    return this.parsed;
  }

  getLastParsedFiles(): ParsedProfileFile[] {
    return [...this.lastParsedFiles];
  }

  getFolderPath(): string | null {
    return this.folderPath;
  }

  getStatus(): LocalProfileFolderStatus {
    const name = this.parsed?.structured?.identity &&
      typeof this.parsed.structured.identity === 'object'
      ? String((this.parsed.structured.identity as { name?: string }).name || '')
      : '';
    return {
      folderPath: this.folderPath,
      fileCount: this.syncedFiles.length,
      lastSyncedAt: this.lastSyncedAt,
      files: [...this.syncedFiles],
      hasProfile: Boolean(this.parsed?.structured),
      profileName: name || undefined,
      error: this.lastError || undefined,
    };
  }

  async setFolderPath(folderPath: string): Promise<LocalProfileFolderStatus> {
    const resolved = path.resolve(folderPath);
    const stats = await fs.promises.stat(resolved);
    if (!stats.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }
    this.folderPath = resolved;
    SettingsManager.getInstance().set('localProfileFolderPath', resolved);
    return this.syncFolder(resolved);
  }

  async syncFolder(
    folderPath?: string,
    opts?: { persistPath?: boolean },
  ): Promise<LocalProfileFolderStatus> {
    const target = path.resolve(folderPath || this.folderPath || '');
    if (!target) throw new Error('No profile folder configured.');
    if (!fs.existsSync(target)) throw new Error(`Folder not found: ${target}`);

    this.lastError = null;
    const files = await this.collectFiles(target);
    const parsed = parseLocalProfileFiles(files, target);
    if (!parsed) {
      throw new Error('No readable profile documents found in the selected folder.');
    }

    this.parsed = parsed;
    this.lastParsedFiles = files;
    this.folderPath = target;
    this.lastSyncedAt = new Date().toISOString();
    this.syncedFiles = parsed.structured._source_files ?? files.map((f) => f.relativePath);

    if (opts?.persistPath !== false) {
      SettingsManager.getInstance().set('localProfileFolderPath', target);
    }

    await this.persistSnapshot();
    return this.getStatus();
  }

  async clearProfile(): Promise<void> {
    this.parsed = null;
    this.lastParsedFiles = [];
    this.syncedFiles = [];
    this.lastSyncedAt = null;
    this.lastError = null;
    SettingsManager.getInstance().set('localProfileFolderPath', '');
    try {
      await fs.promises.unlink(this.snapshotPath());
    } catch {
      // ignore
    }
  }

  private async persistSnapshot(): Promise<void> {
    if (!this.parsed || !this.folderPath) return;
    const payload: PersistedSnapshot = {
      folderPath: this.folderPath,
      lastSyncedAt: this.lastSyncedAt || new Date().toISOString(),
      parsed: this.parsed,
    };
    await fs.promises.writeFile(this.snapshotPath(), JSON.stringify(payload), 'utf8');
  }

  private async collectFiles(rootDir: string): Promise<ParsedProfileFile[]> {
    const discovered: Array<{ absPath: string; relativePath: string; fileName: string }> = [];

    const walk = async (dir: string, depth: number) => {
      if (depth > MAX_SCAN_DEPTH || discovered.length >= MAX_FOLDER_FILES) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (discovered.length >= MAX_FOLDER_FILES) break;
        if (entry.name.startsWith('.')) continue;
        const absPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name)) continue;
          await walk(absPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SAFE_DOCUMENT_EXTENSIONS.has(ext)) continue;
        discovered.push({
          absPath,
          relativePath: path.relative(rootDir, absPath),
          fileName: entry.name,
        });
      }
    };

    await walk(rootDir, 0);

    const parsedFiles: ParsedProfileFile[] = [];
    for (const file of discovered) {
      try {
        const extracted = await extractSafeDocumentText(file.absPath);
        parsedFiles.push({
          relativePath: file.relativePath,
          fileName: file.fileName,
          content: extracted.content,
        });
      } catch (err: any) {
        console.warn(`[LocalProfileFolder] skipped ${file.relativePath}:`, err?.message || err);
      }
    }
    return parsedFiles;
  }
}
