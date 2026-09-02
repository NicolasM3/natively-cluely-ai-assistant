import { createHash } from 'crypto';
import type { RAGManager } from '../../rag/RAGManager';
import { SettingsManager } from '../SettingsManager';
import { LocalProfileFolderService } from './LocalProfileFolderService';
import {
  flattenSkills,
  profileDisplayName,
  type ParsedLocalProfile,
} from './localProfileParser';
import type { StructuredProfileFacts } from '../../llm/manualProfileIntelligence';
import { profileFactsReady } from '../../llm/manualProfileIntelligence';
import {
  LOCAL_PROFILE_MEETING_ID,
  ProfileFolderIndexer,
  type ProfileVectorIndexStatus,
} from './ProfileFolderIndexer';

type StructuredDocument = {
  id: string;
  source_uri?: string;
  created_at?: string;
  updated_at?: string;
  structured_data?: StructuredProfileFacts & Record<string, unknown>;
  raw_text?: string | null;
};

const VECTOR_RETRIEVE_BUDGET_MS = 2000;

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function isProfileQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(you|your|yourself|my|me|i\b|resume|cv|experience|project|skill|background|introduce|tell me about|fit|role|company|ifood|worked|studied|education)\b/.test(q);
}

export class LocalKnowledgeOrchestrator {
  private knowledgeMode = false;
  private activeResumeDoc: StructuredDocument | null = null;
  private readonly folderService = LocalProfileFolderService.getInstance();
  private readonly profileIndexer = new ProfileFolderIndexer();
  private ragManager: RAGManager | null = null;

  async initialize(): Promise<void> {
    await this.folderService.initialize();
    this.knowledgeMode = SettingsManager.getInstance().get('knowledgeMode') === true;
    this.refreshActiveResumeFromService();
    if (this.activeResumeDoc && this.knowledgeMode === false) {
      this.setKnowledgeMode(true);
    }
    this.scheduleVectorIndexFromService();
  }

  setRAGManager(rag: RAGManager | null): void {
    this.ragManager = rag;
    this.profileIndexer.setRAGManager(rag);
    this.profileIndexer.refreshEmbeddingsReady();
  }

  getVectorIndexStatus(): ProfileVectorIndexStatus {
    return this.profileIndexer.getStatus();
  }

  private refreshActiveResumeFromService(): void {
    const parsed = this.folderService.getParsedProfile();
    if (!parsed) {
      this.activeResumeDoc = null;
      return;
    }
    const now = new Date().toISOString();
    this.activeResumeDoc = {
      id: 'local_profile_folder',
      source_uri: parsed.primarySourceUri,
      created_at: now,
      updated_at: now,
      structured_data: parsed.structured as StructuredProfileFacts & Record<string, unknown>,
      raw_text: parsed.rawText,
    };
  }

  private scheduleVectorIndexFromService(): void {
    const parsed = this.folderService.getParsedProfile();
    const files = this.folderService.getLastParsedFiles();
    if (!parsed || files.length === 0) return;
    this.profileIndexer.scheduleIndex(parsed, files);
  }

  get activeResume(): StructuredDocument | null {
    return this.activeResumeDoc;
  }

  get activeJD(): null {
    return null;
  }

  isKnowledgeMode(): boolean {
    return this.knowledgeMode;
  }

  setKnowledgeMode(enabled: boolean): void {
    this.knowledgeMode = enabled;
    SettingsManager.getInstance().set('knowledgeMode', enabled);
  }

  getStatus() {
    const structured = this.activeResumeDoc?.structured_data;
    const folderStatus = this.folderService.getStatus();
    const vectorIndex = this.profileIndexer.getStatus();
    return {
      hasResume: Boolean(structured),
      activeMode: this.knowledgeMode,
      resumeSummary: structured
        ? {
          name: profileDisplayName(structured),
          role: typeof structured.identity === 'object'
            ? String((structured.identity as { role?: string }).role || '')
            : '',
          totalExperienceYears: undefined,
        }
        : undefined,
      localProfileFolder: folderStatus,
      vectorIndex,
    };
  }

  getProfileData() {
    const structured = this.activeResumeDoc?.structured_data;
    if (!structured) return null;
    const experience = Array.isArray(structured.experience) ? structured.experience : [];
    const projects = Array.isArray(structured.projects) ? structured.projects : [];
    const education = Array.isArray(structured.education) ? structured.education : [];
    const identity = typeof structured.identity === 'object' && structured.identity
      ? structured.identity
      : { name: profileDisplayName(structured) };
    const vectorIndex = this.profileIndexer.getStatus();

    return {
      identity,
      skills: structured.skills ?? [],
      skillsFlat: flattenSkills(structured.skills),
      experience,
      projects,
      education,
      experienceCount: experience.length,
      projectCount: projects.length,
      educationCount: education.length,
      nodeCount: vectorIndex.indexedChunks,
      activeJD: null,
      hasActiveJD: false,
      localProfileFolder: this.folderService.getStatus(),
      supplementaryContext: structured.supplementary_context ?? '',
      vectorIndex,
    };
  }

  feedForDepthScoring(_utterance: string): void {
    // no-op for local folder profile
  }

  refreshFromFolderService(): void {
    this.refreshActiveResumeFromService();
    if (this.activeResumeDoc && !this.knowledgeMode) {
      this.setKnowledgeMode(true);
    }
    this.scheduleVectorIndexFromService();
  }

  async ingestDocument(_filePath: string, _docType: unknown): Promise<{ success: boolean; error?: string }> {
    try {
      const status = await this.folderService.syncFolder();
      this.refreshActiveResumeFromService();
      this.scheduleVectorIndexFromService();
      if (!status.hasProfile) {
        return { success: false, error: 'Folder sync completed but no profile data was extracted.' };
      }
      this.setKnowledgeMode(true);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  deleteDocumentsByType(_docType: unknown): void {
    void this.folderService.clearProfile();
    void this.profileIndexer.clearIndex();
    this.activeResumeDoc = null;
    this.setKnowledgeMode(false);
  }

  isIngesting(_docType?: unknown): boolean {
    return this.profileIndexer.getStatus().indexingInFlight;
  }

  async processQuestion(question: string): Promise<{
    factualRecall?: boolean;
    contextBlock?: string;
    isIntroQuestion?: boolean;
    introResponse?: string;
  } | null> {
    if (!this.knowledgeMode) return null;
    const structured = this.activeResumeDoc?.structured_data;
    if (!structured || !profileFactsReady(structured)) return null;

    const vectorBlock = await this.retrieveVectorBlock(question);

    const { resolveIdentityProbe } = require('../../llm/manualIdentityRouting') as typeof import('../../llm/manualIdentityRouting');
    const identityProbe = resolveIdentityProbe(question, true);
    if (identityProbe.kind === 'assistant_reply') {
      return {
        isIntroQuestion: true,
        introResponse: identityProbe.reply,
        factualRecall: true,
      };
    }
    if (identityProbe.kind === 'candidate_fast_path') {
      return {
        factualRecall: true,
        contextBlock: this.buildContextBlock(structured, question, { vectorBlock }),
      };
    }

    const { planAnswer } = require('../../llm/AnswerPlanner') as typeof import('../../llm/AnswerPlanner');
    const plan = planAnswer({
      question,
      source: 'manual_input',
      speakerPerspective: 'interviewer',
    });
    if (plan.profileContextPolicy === 'forbidden' && !isProfileQuestion(question)) {
      return null;
    }

    return {
      factualRecall: true,
      contextBlock: this.buildContextBlock(structured, question, { vectorBlock }),
    };
  }

  private async retrieveVectorBlock(question: string): Promise<string> {
    if (!this.ragManager?.hasCorpusEmbeddings(LOCAL_PROFILE_MEETING_ID)) {
      return '';
    }

    try {
      const retriever = this.ragManager.getRetriever();
      const retrieveP = retriever.retrieve(question, {
        meetingId: LOCAL_PROFILE_MEETING_ID,
        maxTokens: 800,
        topK: 5,
      });
      const result = await Promise.race([
        retrieveP,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VECTOR_RETRIEVE_BUDGET_MS)),
      ]);
      if (!result || result.chunks.length === 0) return '';

      const lines = result.chunks.map((chunk) => {
        const source = chunk.speaker ? `[${escapeXml(chunk.speaker)}]` : '[profile]';
        return `${source}\n${escapeXml(chunk.text)}`;
      });

      return [
        '<candidate_profile_chunks trust="user_uploaded_data" data_only="true">',
        'Semantically relevant excerpts from the user profile folder:',
        lines.join('\n\n'),
        '</candidate_profile_chunks>',
      ].join('\n');
    } catch (err: unknown) {
      console.warn('[LocalKnowledgeOrchestrator] vector retrieve failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  private buildContextBlock(
    structured: StructuredProfileFacts & { supplementary_context?: string },
    question: string,
    opts?: { vectorBlock?: string },
  ): string {
    const blocks: string[] = [];
    const vectorBlock = opts?.vectorBlock?.trim() ?? '';
    const name = profileDisplayName(structured);
    const role = typeof structured.identity === 'object'
      ? String((structured.identity as { role?: string; summary?: string }).role || '')
      : '';
    const summary = typeof structured.identity === 'object'
      ? String((structured.identity as { summary?: string }).summary || '')
      : '';

    blocks.push([
      '<candidate_profile trust="user_uploaded_data" data_only="true">',
      'Use ONLY the facts below about the candidate. Speak in first person when answering interview questions.',
      'If a detail is absent, say it is not in the loaded profile instead of inventing it.',
      name ? `Name: ${escapeXml(name)}` : '',
      role ? `Role: ${escapeXml(role)}` : '',
      summary ? `Summary: ${escapeXml(summary)}` : '',
      Array.isArray(structured.experience) && structured.experience.length
        ? `Experience:\n${structured.experience.slice(0, 8).map((entry: any, idx: number) =>
          `- ${escapeXml(entry.role || entry.title || 'Role')} @ ${escapeXml(entry.company || entry.organization || 'Company')} (${idx + 1})`,
        ).join('\n')}`
        : '',
      flattenSkills(structured.skills).length
        ? `Skills: ${flattenSkills(structured.skills).slice(0, 24).map(escapeXml).join(', ')}`
        : '',
      '</candidate_profile>',
    ].filter(Boolean).join('\n'));

    if (structured.supplementary_context?.trim()) {
      blocks.push([
        '<candidate_supplementary_notes trust="user_uploaded_data" data_only="true">',
        'Additional personal notes, interview prep, and project stories from the user profile folder:',
        escapeXml(structured.supplementary_context),
        '</candidate_supplementary_notes>',
      ].join('\n'));
    }

    if (vectorBlock) {
      blocks.push(vectorBlock);
    }

    const raw = this.activeResumeDoc?.raw_text?.trim();
    if (!vectorBlock && raw && /tell me about yourself|introduce|background|experience|project|ifood|work/i.test(question)) {
      blocks.push([
        '<candidate_folder_source_text trust="user_uploaded_data" data_only="true">',
        escapeXml(raw.slice(0, 24_000)),
        '</candidate_folder_source_text>',
      ].join('\n'));
    }

    blocks.push('<profile_use_rule>Ground answers in the candidate blocks above. Do not claim you lack access to the user profile.</profile_use_rule>');
    return blocks.join('\n\n');
  }

  getCompanyResearchEngine(): { getCachedDossier: (_company: string) => null } {
    return { getCachedDossier: () => null };
  }
}

export function buildLocalProfileDocumentHash(parsed: ParsedLocalProfile | null): string {
  if (!parsed) return '';
  return createHash('sha256').update(parsed.rawText).digest('hex').slice(0, 16);
}
