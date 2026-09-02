import type { StructuredProfileFacts } from '../../llm/manualProfileIntelligence';

export interface ParsedProfileFile {
  relativePath: string;
  fileName: string;
  content: string;
}

export interface ParsedLocalProfile {
  structured: StructuredProfileFacts & {
    supplementary_context?: string;
    _extraction_mode?: 'heuristic' | 'basic' | 'llm';
    _source_files?: string[];
  };
  rawText: string;
  primarySourceUri: string;
}

const SKIP_FILE_NAMES = new Set([
  'hr-about-yourself-template.md',
  'claude.md',
]);

const MAX_SUPPLEMENTARY_CHARS = 120_000;

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?><\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function tryHeuristicExtract(text: string): StructuredProfileFacts | null {
  try {
    const { heuristicResumeExtract } = require('../../../premium/electron/knowledge/HeuristicExtractor');
    const result = heuristicResumeExtract(text);
    return result && typeof result === 'object' ? result : null;
  } catch {
    try {
      const { heuristicResumeExtract } = require('../../../dist-electron/premium/electron/knowledge/HeuristicExtractor.js');
      const result = heuristicResumeExtract(text);
      return result && typeof result === 'object' ? result : null;
    } catch {
      return null;
    }
  }
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractNameFromHtml(html: string): string {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) {
    const cleaned = stripHtml(h1[1]).trim();
    if (cleaned.length >= 4 && cleaned.length <= 80) return cleaned;
  }
  return '';
}

function extractNameFromText(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (line.length < 4 || line.length > 80) continue;
    if (/^(summary|experience|education|skills|projects|contact|professional)/i.test(line)) continue;
    if (/^\d/.test(line)) continue;
    if (/@|https?:|linkedin|github|phone|email/i.test(line)) continue;
    if (/^[A-Z][a-z]+(?: [A-Z][a-z]+){1,4}$/.test(line)) return line;
    if (/^[A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){1,5}$/.test(line)) return line;
  }
  return '';
}

function extractRoleFromText(text: string): string {
  const match = text.match(/\b(Software Engineer|Developer|Engineer|Backend Developer|Full[- ]Stack Developer)\b/i);
  return match ? match[0] : '';
}


function extractExperienceBlocks(text: string): Array<Record<string, unknown>> {
  const experiences: Array<Record<string, unknown>> = [];
  const companyRoleRe = /([A-Z][A-Za-z0-9&.\- ]{2,40})\s+(?:—|–|-|\|)\s+([A-Za-z /]+(?:Engineer|Developer|Intern|Lead|Manager)[A-Za-z /]*)/g;
  let match: RegExpExecArray | null;
  while ((match = companyRoleRe.exec(text)) !== null && experiences.length < 8) {
    experiences.push({
      company: match[1].trim(),
      role: match[2].trim(),
      bullets: [],
    });
  }
  if (experiences.length > 0) return experiences;

  const atRe = /(?:^|\n)([A-Za-z /]+(?:Engineer|Developer|Intern|Lead|Manager)[A-Za-z /]*)\s+at\s+([A-Z][A-Za-z0-9&.\- ]{2,40})/gi;
  while ((match = atRe.exec(text)) !== null && experiences.length < 8) {
    experiences.push({
      role: match[1].trim(),
      company: match[2].trim(),
      bullets: [],
    });
  }
  return experiences;
}

function extractSkills(text: string): string[] {
  const skills = new Set<string>();
  const known = [
    'Go', 'Golang', 'Kotlin', 'Rust', 'Python', 'TypeScript', 'JavaScript', 'Flutter', 'Dart',
    'Kafka', 'Kubernetes', 'AWS', 'PostgreSQL', 'Redis', 'LangChain', 'RAG', 'Microservices',
    'Node.js', 'React', 'SQL', 'Docker', 'SQS', 'SNS',
  ];
  for (const skill of known) {
    const re = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) skills.add(skill === 'Golang' ? 'Go' : skill);
  }
  return [...skills];
}

function pickPrimaryFile(files: ParsedProfileFile[]): ParsedProfileFile | null {
  if (files.length === 0) return null;
  const ranked = [...files].sort((a, b) => {
    const score = (f: ParsedProfileFile) => {
      let s = 0;
      if (/resume|curriculum|cv|oliveira/i.test(f.fileName)) s += 8;
      if (f.fileName.endsWith('.html') || f.fileName.endsWith('.htm')) s += 6;
      if (f.fileName.endsWith('.pdf')) s += 4;
      if (f.fileName.endsWith('.md')) s += 2;
      if (/template|claude\.md/i.test(f.fileName)) s -= 10;
      s += Math.min(3, Math.floor(f.content.length / 5000));
      return s;
    };
    return score(b) - score(a);
  });
  return ranked[0] ?? null;
}

function buildSupplementaryContext(files: ParsedProfileFile[], primary: ParsedProfileFile | null): string {
  const chunks: string[] = [];
  for (const file of files) {
    if (primary && file.relativePath === primary.relativePath) continue;
    if (SKIP_FILE_NAMES.has(file.fileName.toLowerCase())) continue;
    const header = `## ${file.relativePath}`;
    const body = file.content.trim();
    if (!body) continue;
    chunks.push(`${header}\n${body}`);
  }
  const combined = chunks.join('\n\n').trim();
  if (combined.length <= MAX_SUPPLEMENTARY_CHARS) return combined;
  return `${combined.slice(0, MAX_SUPPLEMENTARY_CHARS).trimEnd()}\n\n[truncated]`;
}

function basicProfileExtract(primaryText: string, files: ParsedProfileFile[]): StructuredProfileFacts & {
  supplementary_context?: string;
  _extraction_mode: 'basic';
  _source_files: string[];
} {
  const primary = pickPrimaryFile(files);
  const name = extractNameFromText(primaryText);
  const role = extractRoleFromText(primaryText);
  const experience = extractExperienceBlocks(primaryText);
  const skills = extractSkills(primaryText);
  const summaryMatch = primaryText.match(/(?:summary|professional summary)[:\s]*([\s\S]{40,500}?)(?:\n\n|\n[A-Z])/i);
  const summary = summaryMatch?.[1]?.trim() || primaryText.slice(0, 400).trim();

  return {
    identity: {
      name: name || undefined,
      summary,
      role: role || undefined,
    } as StructuredProfileFacts['identity'],
    experience,
    projects: [],
    education: [],
    skills,
    supplementary_context: buildSupplementaryContext(files, primary),
    _extraction_mode: 'basic',
    _source_files: files.map((f) => f.relativePath),
  };
}

export function parseLocalProfileFiles(
  files: ParsedProfileFile[],
  folderPath: string,
): ParsedLocalProfile | null {
  const usable = files
    .filter((f) => f.content.trim().length > 0)
    .filter((f) => !SKIP_FILE_NAMES.has(f.fileName.toLowerCase()) || /about-yourself|projects/i.test(f.fileName));
  if (usable.length === 0) return null;

  const primary = pickPrimaryFile(usable);
  const primaryHtmlName = primary && (primary.fileName.endsWith('.html') || primary.fileName.endsWith('.htm'))
    ? extractNameFromHtml(primary.content)
    : '';
  const primaryText = primary
    ? (primary.fileName.endsWith('.html') || primary.fileName.endsWith('.htm')
      ? stripHtml(primary.content)
      : primary.content)
    : usable.map((f) => f.content).join('\n\n');

  const heuristic = tryHeuristicExtract(primaryText);
  const structured = heuristic
    ? {
      ...heuristic,
      identity: {
        ...(typeof heuristic.identity === 'object' ? heuristic.identity : {}),
        name: primaryHtmlName || (typeof heuristic.identity === 'object' ? (heuristic.identity as { name?: string }).name : undefined),
      },
      supplementary_context: buildSupplementaryContext(usable, primary),
      _extraction_mode: 'heuristic' as const,
      _source_files: usable.map((f) => f.relativePath),
    }
    : (() => {
      const basic = basicProfileExtract(primaryText, usable);
      if (primaryHtmlName) {
        basic.identity = { ...(basic.identity as object), name: primaryHtmlName };
      }
      return basic;
    })();

  const rawText = usable
    .map((f) => {
      const body = f.fileName.endsWith('.html') || f.fileName.endsWith('.htm')
        ? stripHtml(f.content)
        : f.content;
      return `# ${f.relativePath}\n${body}`;
    })
    .join('\n\n')
    .slice(0, MAX_SUPPLEMENTARY_CHARS);

  return {
    structured,
    rawText,
    primarySourceUri: primary ? `${folderPath}/${primary.relativePath}` : folderPath,
  };
}

export function flattenSkills(skills: unknown): string[] {
  if (Array.isArray(skills)) return skills.map(String).filter(Boolean);
  if (skills && typeof skills === 'object') {
    return Object.values(skills as Record<string, unknown>)
      .flatMap((v) => (Array.isArray(v) ? v.map(String) : []))
      .filter(Boolean);
  }
  return [];
}

export function profileDisplayName(structured: StructuredProfileFacts | null | undefined): string {
  if (!structured) return '';
  const identity = structured.identity as Record<string, unknown> | undefined;
  return firstNonEmpty(identity?.name, structured.name);
}
