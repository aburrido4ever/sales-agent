import {
  buildDebriefTransitionCopy,
  combineDebriefText,
  evaluateVisitObjectives,
} from '../services';
import type {
  Account,
  InterviewQuestion,
  Opportunity,
  VisitObjectiveAssessment,
} from '../types';
import type { AisaContext } from './aisaContext';
import {
  briefingNarrationPrompt,
  debriefQuestionPrompt,
  objectiveAssessmentPrompt,
  repQuestionPrompt,
} from './aisaPrompts';
import { isAiEnabled, requestJson } from './client';

export { isAiEnabled } from './client';
export { buildAisaContext, type AisaContext } from './aisaContext';

export type DebriefTurn = { question: string; answer: string };

// ---------------------------------------------------------------------------
// Part 1 — pre-meeting briefing
// ---------------------------------------------------------------------------

export type BriefingNarration = {
  /** Spoken paragraphs, in the order the admin mandated. Rendered AND read aloud in sequence. */
  paragraphs: string[];
  /** One spoken line per call objective, aligned 1:1 with `context.objectives`. */
  objectiveLines: string[];
  /** The closing "do you need any additional details?" turn. */
  invitation: string;
};

const briefingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paragraphs', 'objectiveLines', 'invitation'],
  properties: {
    paragraphs: { type: 'array', items: { type: 'string' }, minItems: 1 },
    objectiveLines: { type: 'array', items: { type: 'string' } },
    invitation: { type: 'string' },
  },
} as const;

/**
 * AISA's spoken 90-day briefing. Returns `undefined` when the AI path is unavailable — the
 * caller then renders the deterministic copy built by `buildPreMeetingBriefing`.
 */
export const generateBriefingNarration = async (
  context: AisaContext,
): Promise<BriefingNarration | undefined> => {
  if (!isAiEnabled()) return undefined;
  const prompt = briefingNarrationPrompt(context);
  return requestJson<BriefingNarration>({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: briefingSchema as unknown as Record<string, unknown>,
    maxTokens: 2000,
  });
};

const repAnswerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
} as const;

/**
 * AISA answering a free-form question from the rep ("what exactly was that overdue invoice
 * for?"). This has no deterministic equivalent — before the LLM path existed the rep could not
 * ask AISA anything — so the fallback is an honest "not in the CRM" line, never a fabrication.
 */
export const answerRepQuestion = async (
  context: AisaContext,
  question: string,
): Promise<string> => {
  const fallback = `I cannot reach my sources right now, so I do not want to guess. What I have on file for ${context.account.name} is: ${context.account.summary}`;
  if (!isAiEnabled()) return fallback;

  const prompt = repQuestionPrompt(context, question);
  const result = await requestJson<{ answer: string }>({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: repAnswerSchema as unknown as Record<string, unknown>,
    maxTokens: 700,
  });
  return result?.answer?.trim() || fallback;
};

// ---------------------------------------------------------------------------
// Part 2 — post-meeting debrief
// ---------------------------------------------------------------------------

const debriefQuestionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: { prompt: { type: 'string' } },
} as const;

/**
 * The spoken question AISA asks for one objective. `targetObjectiveId` is chosen by the CALLER
 * from the objective list — the model only writes the wording, so the debrief agenda can never
 * drift away from what the CRM computed.
 */
export const askDebriefQuestion = async (
  context: AisaContext,
  targetObjectiveId: string,
  transcript: DebriefTurn[],
  options: { isFollowUp?: boolean; fallbackPrompt: string } ,
): Promise<string> => {
  if (!isAiEnabled()) return options.fallbackPrompt;

  const prompt = debriefQuestionPrompt(context, targetObjectiveId, transcript, Boolean(options.isFollowUp));
  const result = await requestJson<{ prompt: string }>({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: debriefQuestionSchema as unknown as Record<string, unknown>,
    maxTokens: 500,
  });
  return result?.prompt?.trim() || options.fallbackPrompt;
};

const assessmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objectives'],
  properties: {
    objectives: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['met', 'partial', 'missed'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
} as const;

/**
 * LLM replacement for `evaluateVisitObjectives`'s keyword matching.
 *
 * This is NOT optional polish: `services.ts` documents that its objective prompts are written to
 * avoid their own keyword signals, because `combineDebriefText` folds prompts into the matched
 * text. A model-written prompt cannot honour that, so the two paths are mutually exclusive —
 * AI questions are scored by AI, deterministic questions are scored by keywords. Never mixed.
 *
 * Falls back to the keyword evaluation over the same transcript if the call fails.
 */
export const assessObjectives = async (
  context: AisaContext,
  transcript: DebriefTurn[],
  fallbackInput: {
    account: Account;
    opportunity?: Opportunity;
    questions: InterviewQuestion[];
    answers: Record<string, string>;
  },
): Promise<VisitObjectiveAssessment[]> => {
  const fallback = () =>
    evaluateVisitObjectives(
      combineDebriefText(fallbackInput.questions, fallbackInput.answers),
      fallbackInput.account,
      fallbackInput.opportunity,
    );

  if (!isAiEnabled()) return fallback();

  const prompt = objectiveAssessmentPrompt(context, transcript);
  const result = await requestJson<{
    objectives: { id: string; status: VisitObjectiveAssessment['status']; evidence: string }[];
  }>({
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
    schema: assessmentSchema as unknown as Record<string, unknown>,
    maxTokens: 1500,
  });
  if (!result?.objectives?.length) return fallback();

  // The label/detail stay ours; only status and evidence come from the model.
  return context.objectives.map((objective) => {
    const scored = result.objectives.find((item) => item.id === objective.id);
    return {
      id: objective.id,
      label: objective.label,
      detail: objective.detail,
      status: scored?.status ?? 'missed',
      evidence: scored?.evidence ?? 'Not covered in the debrief yet.',
    };
  });
};

/**
 * AISA's "got it, I will log X" line. Deterministic on purpose: the model already writes the
 * NEXT question (which opens with that confirmation, per `debriefQuestionPrompt`), so this is
 * only used on the mock path and as the transition copy while the model call is in flight.
 */
export const debriefTransition = buildDebriefTransitionCopy;
