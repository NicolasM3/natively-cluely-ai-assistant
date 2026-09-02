import { estimateTokens } from '../../rag/TranscriptPreprocessor';
import { stripHtml } from './localProfileParser';
import type { ParsedProfileFile } from './localProfileParser';

export interface ProfileDocumentChunk {
  label: string;
  text: string;
}

const TARGET_TOKENS = 300;
const MAX_TOKENS = 400;
const MIN_TOKENS = 80;

function normalizeContent(file: ParsedProfileFile): string {
  const name = file.fileName || file.relativePath || '';
  const content = file.content ?? '';
  if (name.endsWith('.html') || name.endsWith('.htm')) {
    return stripHtml(content);
  }
  return content;
}

function splitLongText(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const approxWordsPerChunk = Math.max(40, Math.floor(maxTokens * 0.75));
  const overlap = 15;
  const out: string[] = [];
  for (let i = 0; i < words.length; i += approxWordsPerChunk - overlap) {
    const window = words.slice(i, i + approxWordsPerChunk);
    if (window.length === 0) break;
    out.push(window.join(' '));
    if (i + approxWordsPerChunk >= words.length) break;
  }
  return out;
}

function chunkSingleDocument(file: ParsedProfileFile): ProfileDocumentChunk[] {
  const label = file.relativePath;
  const content = normalizeContent(file).trim();
  if (!content) return [];

  const lines = content.split('\n');
  const headingRe = /^\s*(?:#{1,3}\s+|(?:\d+(?:\.\d+){0,2}\s+))/;
  const pageMarkerRe = /^\s*\[Page\s+\d+\]\s*$/;

  type Section = { heading: string | null; path: string[]; body: string[] };
  const sections: Section[] = [];
  let current: Section = { heading: null, path: [], body: [] };
  const stack: Array<{ level: number; text: string }> = [];

  const headingParts = (line: string): { level: number; text: string } => {
    const atx = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (atx) return { level: atx[1].length, text: atx[2].trim() };
    const num = /^\s*(\d+(?:\.\d+){0,3})\s+(\S.*)$/.exec(line);
    if (num) return { level: num[1].split('.').length, text: `${num[1]} ${num[2].trim()}` };
    return { level: 1, text: line.trim() };
  };

  const flush = () => {
    if (current.heading !== null || current.body.length > 0) sections.push(current);
    current = { heading: null, path: [], body: [] };
  };

  for (const line of lines) {
    if (headingRe.test(line)) {
      flush();
      const h = headingParts(line);
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
      current.path = stack.map((x) => x.text);
      current.heading = line.trim();
    } else if (pageMarkerRe.test(line)) {
      current.body.push(line);
    } else {
      current.body.push(line);
    }
  }
  flush();

  const chunks: ProfileDocumentChunk[] = [];

  const emit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const prefixed = `[${label}]\n${trimmed}`;
    const tokens = estimateTokens(prefixed);
    if (tokens <= MAX_TOKENS) {
      chunks.push({ label, text: prefixed });
      return;
    }
    for (const part of splitLongText(trimmed, TARGET_TOKENS)) {
      const partPrefixed = `[${label}]\n${part}`;
      if (estimateTokens(partPrefixed) >= MIN_TOKENS || chunks.length === 0) {
        chunks.push({ label, text: partPrefixed });
      }
    }
  };

  if (sections.length === 0) {
    emit(content);
    return chunks;
  }

  for (const section of sections) {
    const ctx = section.path.length > 1
      ? `[context: ${section.path.slice(1).join(' > ')}]`
      : '';
    const headingLine = [ctx, section.heading ?? ''].filter(Boolean).join(' ');
    const bodyText = section.body.join('\n').replace(/\s+/g, ' ').trim();
    const fullText = headingLine ? `${headingLine}\n${bodyText}` : bodyText;
    if (!fullText) continue;

    const tokens = estimateTokens(fullText);
    if (tokens <= MAX_TOKENS) {
      emit(fullText);
      continue;
    }
    if (headingLine) {
      for (const part of splitLongText(bodyText || fullText, TARGET_TOKENS)) {
        emit(`${headingLine}\n${part}`);
      }
    } else {
      for (const part of splitLongText(fullText, TARGET_TOKENS)) {
        emit(part);
      }
    }
  }

  return chunks;
}

export function chunkProfileDocuments(files: ParsedProfileFile[]): ProfileDocumentChunk[] {
  const out: ProfileDocumentChunk[] = [];
  for (const file of files) {
    out.push(...chunkSingleDocument(file));
  }
  return out;
}
