import { formatCurrency } from '../services';
import type {
  Account,
  ActivityEvent,
  Contact,
  Opportunity,
  PreMeetingBriefing,
  Task,
  VisitObjectiveItem,
} from '../types';

/**
 * The CRM slice AISA is allowed to see and speak about. This is the ONLY place that decides what
 * leaves the app for the model — the system prompt forbids stating anything that is not in here,
 * so anything missing from this object is something AISA will (correctly) say it does not know.
 */
export type AisaContext = {
  today: string;
  account: {
    name: string;
    industry: string;
    type?: string;
    tier?: string;
    address: string;
    status: string;
    summary: string;
    risks: string[];
    nextAction?: string;
    lastInteractionDate?: string;
    engagementRisk?: string;
    creditHold?: {
      amount: string;
      overdueDays: number;
      invoiceReason: string;
    };
    externalSignals: { source: string; summary: string; detectedAt: string }[];
  };
  contacts: { name: string; role: string; email: string; phone: string }[];
  opportunity?: {
    name: string;
    stage: string;
    amount: string;
    probability: number;
    nextStep: string;
  };
  openTasks: { title: string; dueDate: string; owner: string; priority?: string }[];
  recentActivities: { title: string; date: string; notes: string }[];
  briefing?: {
    etaMinutes: number;
    executiveSummary: string;
    recentTopics: string[];
    blockers: string[];
    riskLevel: string;
  };
  objectives: { id: string; label: string; detail: string }[];
};

export const buildAisaContext = (input: {
  account: Account;
  contacts: Contact[];
  opportunity?: Opportunity;
  tasks: Task[];
  activities: ActivityEvent[];
  objectives: VisitObjectiveItem[];
  briefing?: PreMeetingBriefing;
}): AisaContext => ({
  today: new Date().toISOString().slice(0, 10),
  account: {
    name: input.account.name,
    industry: input.account.industry,
    type: input.account.type,
    tier: input.account.tier,
    address: input.account.address,
    status: input.account.status,
    summary: input.account.summary,
    risks: input.account.risks,
    nextAction: input.account.nextAction,
    lastInteractionDate: input.account.lastInteractionDate,
    engagementRisk: input.account.engagementRisk,
    creditHold: input.account.creditHold
      ? {
          amount: formatCurrency(input.account.creditHold.amount),
          overdueDays: input.account.creditHold.overdueDays,
          invoiceReason: input.account.creditHold.invoiceReason,
        }
      : undefined,
    externalSignals: (input.account.externalSignals ?? []).map((signal) => ({
      source: signal.source,
      summary: signal.summary,
      detectedAt: signal.detectedAt,
    })),
  },
  contacts: input.contacts.map((contact) => ({
    name: contact.name,
    role: contact.role,
    email: contact.email,
    phone: contact.phone,
  })),
  opportunity: input.opportunity
    ? {
        name: input.opportunity.name,
        stage: input.opportunity.stage,
        amount: formatCurrency(input.opportunity.amount),
        probability: input.opportunity.probability,
        nextStep: input.opportunity.nextStep,
      }
    : undefined,
  openTasks: input.tasks
    .filter((task) => task.status === 'Open')
    .map((task) => ({
      title: task.title,
      dueDate: task.dueDate,
      owner: task.owner,
      priority: task.priority,
    })),
  recentActivities: [...input.activities]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 5)
    .map((activity) => ({ title: activity.title, date: activity.date, notes: activity.notes })),
  briefing: input.briefing
    ? {
        etaMinutes: input.briefing.etaMinutes,
        executiveSummary: input.briefing.executiveSummary,
        recentTopics: input.briefing.recentTopics,
        blockers: input.briefing.blockers,
        riskLevel: input.briefing.riskLevel,
      }
    : undefined,
  objectives: input.objectives.map((objective) => ({
    id: objective.id,
    label: objective.label,
    detail: objective.detail,
  })),
});

export const serializeContext = (context: AisaContext) => JSON.stringify(context, null, 2);
