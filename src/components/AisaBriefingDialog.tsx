import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { CheckCircle2, Mic, MicOff, MessageCircleQuestion, Route, Sparkles, Target } from 'lucide-solid';
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { answerRepQuestion, buildAisaContext, generateBriefingNarration, isAiEnabled, type BriefingNarration } from '../ai/aisa';
import { SILENCE_ADVANCE_MS, buildSimulatedBriefingReply, buildVisitObjectives, cancelSpeech, matchVoiceNavigationCommand, speakText } from '../services';
import { state } from '../store';
import type { VoiceNavigationCommand } from '../services';
import type { Account, Contact, Opportunity, PreMeetingBriefing, SpeechRecognitionCtorWindow, SpeechRecognitionLike, SpeechRecognitionResultEventLike } from '../types';

export type AisaBriefingStep = 'prompt' | 'summary' | 'qa' | 'ended';

type AisaBriefingDialogProps = {
  briefing: PreMeetingBriefing;
  account: Account;
  opportunity?: Opportunity;
  /** Used to answer the decision-maker follow-up question with the account's real 2nd contact. */
  contacts?: Contact[];
  /** Invoked by the "End briefing" action; the parent decides how to close the sheet. */
  onEndBriefing: () => void;
  /**
   * Optional. When provided, a "Simulate approach" CTA is offered beside "End briefing" at the
   * end of the briefing. The parent owns what it does (route animation) and how the sheet closes
   * — this component only reports the tap and returns to its `ended` step.
   */
  onSimulateApproach?: () => void;
};

type FollowUpExchange = {
  question: string;
  answer: string;
  /**
   * `aisa-asks` — AISA prepping the rep (the original mock flow: AISA's prompt, rep's reply).
   * `rep-asks` — the script's Part 1 Q&A: the rep asks, AISA answers from the CRM.
   */
  direction?: 'aisa-asks' | 'rep-asks';
};

/**
 * Interactive pre-visit AISA dialog. Local `createSignal` state only — nothing here is
 * persisted to `store.ts` or `localStorage`. Props-in / events-out: the parent owns the
 * briefing lookup and the close action.
 *
 * The `qa` step is AISA-led: AISA speaks each `briefing.suggestedQuestions[i]` aloud as a prep
 * prompt directed at the rep, auto-opens the mic to capture the reply into local signal state,
 * and advances. Voice capture here is a simplified ONE-SHOT duplicate of the continuous
 * recognition pattern in `QuestionnaireStepper.tsx` (read-only reference, not imported from) —
 * this is the 2nd occurrence of the pattern; promotion to a shared hook happens on the 3rd, per
 * this repo's architect convention, since the two semantics genuinely differ (continuous capture
 * into store answers with nav commands vs. one-shot capture into a local signal here).
 */
function AisaBriefingDialog(props: AisaBriefingDialogProps) {
  const [step, setStep] = createSignal<AisaBriefingStep>('prompt');
  const [promptIndex, setPromptIndex] = createSignal(0);
  const [reachedEnd, setReachedEnd] = createSignal(false);
  const [exchanges, setExchanges] = createSignal<FollowUpExchange[]>([]);
  const [isListening, setIsListening] = createSignal(false);
  const [interimTranscript, setInterimTranscript] = createSignal('');
  const [isVoiceDisabled, setIsVoiceDisabled] = createSignal(false);
  const [voiceNotice, setVoiceNotice] = createSignal<string | undefined>(undefined);

  let recognition: SpeechRecognitionLike | undefined;
  let nativeListening = false;
  let nativeStateListener: PluginListenerHandle | undefined;
  let speechToken = 0;
  let turnTranscript = '';
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };

  const objectives = createMemo(() => buildVisitObjectives(props.account, props.opportunity));
  const questions = () => props.briefing.suggestedQuestions;
  const currentQuestion = () => questions()[promptIndex()];
  const isLastPrompt = () => promptIndex() >= questions().length - 1;

  /**
   * With a key configured the `qa` step INVERTS: instead of AISA quizzing the rep with
   * `suggestedQuestions`, AISA narrates the 90-day brief and then answers whatever the rep asks
   * — which is what `docs/Script.md` Part 1 actually is. Without a key the original mock flow
   * runs untouched.
   */
  const aiMode = () => isAiEnabled();
  const [narration, setNarration] = createSignal<BriefingNarration | undefined>(undefined);
  const [isAisaThinking, setIsAisaThinking] = createSignal(false);

  const aisaContext = createMemo(() =>
    buildAisaContext({
      account: props.account,
      contacts: props.contacts ?? [],
      opportunity: props.opportunity,
      tasks: state.crm.tasks.filter((task) => task.accountId === props.account.id),
      activities: state.crm.activities.filter((activity) => activity.accountId === props.account.id),
      objectives: objectives(),
      briefing: props.briefing,
    }));

  const getSpeechCtor = () =>
    (globalThis as unknown as SpeechRecognitionCtorWindow).SpeechRecognition
      ?? (globalThis as unknown as SpeechRecognitionCtorWindow).webkitSpeechRecognition;
  const speechSupported = () => Capacitor.isNativePlatform() || Boolean(getSpeechCtor());
  const getNativeSpeechLanguage = () => {
    const language = globalThis.navigator?.language || 'en-US';
    return language.toLowerCase().startsWith('es') ? 'es-US' : language;
  };
  const getNativeSpeechErrorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (/no speech input/i.test(message)) return 'No voice was detected. Tap the mic and speak closer to the emulator microphone.';
    if (/network/i.test(message)) return 'Speech recognition needs network access on this emulator.';
    if (/permission/i.test(message)) return 'Microphone permission is required for listening.';
    return message || 'Microphone could not start. Use Simulate answer.';
  };

  const clearNativeListeners = () => {
    void nativeStateListener?.remove().catch(() => undefined);
    nativeStateListener = undefined;
  };
  const stopVoiceCapture = () => {
    clearSilenceTimer();
    turnTranscript = '';
    setIsListening(false);
    recognition?.stop?.();
    recognition = undefined;
    if (nativeListening) void SpeechRecognition.stop().catch(() => undefined);
    nativeListening = false;
    clearNativeListeners();
    setInterimTranscript('');
  };

  const goNext = () => {
    if (isLastPrompt()) {
      setReachedEnd(true);
      return;
    }
    setPromptIndex((index) => index + 1);
  };
  const goPrevious = () => {
    setReachedEnd(false);
    setPromptIndex((index) => Math.max(0, index - 1));
  };

  const recordReply = (answer: string) => {
    const question = currentQuestion();
    if (!question) return;
    setExchanges((current) => [...current.filter((exchange) => exchange.question !== question), { question, answer }]);
    goNext();
  };

  const handleVoiceCommand = (command: VoiceNavigationCommand) => {
    if (aiMode()) {
      // There is no prompt list to step through in AI mode — only "finish" means anything.
      if (command === 'finish') setReachedEnd(true);
      return;
    }
    if (command === 'previous') {
      goPrevious();
      return;
    }
    if (command === 'next') {
      goNext();
      return;
    }
    setReachedEnd(true);
  };
  /** AI mode: the rep just asked AISA something. Answer from the CRM, speak it, listen again. */
  const handleRepQuestion = async (question: string) => {
    setIsAisaThinking(true);
    try {
      const answer = await answerRepQuestion(aisaContext(), question);
      setExchanges((current) => [...current, { question, answer, direction: 'rep-asks' }]);
      speechToken += 1;
      const currentToken = speechToken;
      const listenAgain = () => {
        if (currentToken !== speechToken || isVoiceDisabled()) return;
        startVoiceCapture();
      };
      const spoke = speakText(answer, 'en-US', listenAgain);
      if (!spoke && speechSupported()) listenAgain();
    } finally {
      setIsAisaThinking(false);
    }
  };

  const handleCapturedSpeech = (text: string) => {
    const command = matchVoiceNavigationCommand(text);
    if (command) {
      handleVoiceCommand(command);
      return;
    }
    if (aiMode()) {
      void handleRepQuestion(text);
      return;
    }
    recordReply(text);
  };
  /**
   * Fires after `SILENCE_ADVANCE_MS` of no new speech — advances to the next AISA question
   * without requiring an explicit "next"/"finish" command, matching QuestionnaireStepper's
   * conversational turn-taking pause.
   */
  const commitSpokenTurn = () => {
    clearSilenceTimer();
    const text = (turnTranscript || interimTranscript()).trim();
    turnTranscript = '';
    setInterimTranscript('');
    if (!text) return;
    stopVoiceCapture();
    handleCapturedSpeech(text);
  };
  const scheduleSilenceCommit = () => {
    clearSilenceTimer();
    silenceTimer = setTimeout(commitSpokenTurn, SILENCE_ADVANCE_MS);
  };

  const startNativeVoiceCapture = async () => {
    if (nativeListening || isListening()) return;

    try {
      const availability = await SpeechRecognition.available();
      if (!availability.available) {
        setIsVoiceDisabled(true);
        setVoiceNotice('Native speech recognition is not available on this device.');
        return;
      }

      const permissions = await SpeechRecognition.checkPermissions();
      const permissionState = permissions.speechRecognition === 'granted'
        ? permissions.speechRecognition
        : (await SpeechRecognition.requestPermissions()).speechRecognition;
      if (permissionState !== 'granted') {
        setIsVoiceDisabled(true);
        setVoiceNotice('Microphone permission is required for listening.');
        return;
      }

      clearNativeListeners();
      setInterimTranscript('');
      nativeStateListener = await SpeechRecognition.addListener('listeningState', (data) => {
        if (data.status === 'started') {
          nativeListening = true;
          setIsListening(true);
          return;
        }
        nativeListening = false;
        setIsListening(false);
        setInterimTranscript('');
      });

      setIsVoiceDisabled(false);
      nativeListening = true;
      setIsListening(true);
      setInterimTranscript('Listening...');
      const result = await SpeechRecognition.start({
        language: getNativeSpeechLanguage(),
        maxResults: 5,
        partialResults: false,
        popup: false,
        prompt: "Answer AISA's question — I'll continue automatically. Say previous or finish to override.",
      });
      const bestFinalMatch = result.matches?.find((match) => match.trim());
      if (bestFinalMatch) {
        handleCapturedSpeech(bestFinalMatch);
      } else {
        setVoiceNotice('No voice was detected. Try again or use Simulate answer.');
      }
    } catch (error) {
      setVoiceNotice(getNativeSpeechErrorMessage(error));
    } finally {
      nativeListening = false;
      setIsListening(false);
      setInterimTranscript('');
      clearNativeListeners();
    }
  };
  const startVoiceCapture = () => {
    if (Capacitor.isNativePlatform()) {
      void startNativeVoiceCapture();
      return;
    }

    const SpeechCtor = getSpeechCtor();
    if (!SpeechCtor || recognition || isListening()) return;

    recognition = new SpeechCtor();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event: SpeechRecognitionResultEventLike) => {
      let finalTranscript = '';
      let interim = '';
      const startIndex = event.resultIndex ?? 0;

      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript?.trim() ?? '';
        if (!text) continue;
        if (result.isFinal) {
          finalTranscript = `${finalTranscript}${finalTranscript ? ' ' : ''}${text}`;
        } else {
          interim = `${interim}${interim ? ' ' : ''}${text}`;
        }
      }

      setInterimTranscript(interim);
      if (finalTranscript) turnTranscript = `${turnTranscript}${turnTranscript ? ' ' : ''}${finalTranscript}`;
      if (finalTranscript || interim) scheduleSilenceCommit();
    };
    recognition.onerror = () => {
      stopVoiceCapture();
      setVoiceNotice('Listening failed. Use Simulate answer instead.');
    };
    recognition.onend = () => {
      recognition = undefined;
      setIsListening(false);
    };

    try {
      setIsVoiceDisabled(false);
      recognition.start();
      setIsListening(true);
    } catch {
      recognition = undefined;
      setVoiceNotice('Microphone could not start. Use Simulate answer instead.');
    }
  };

  /**
   * Speaks the whole brief as one TTS turn (paragraphs, then one line per call objective, then
   * the "need anything else?" invitation), and opens the mic when it lands so the rep can ask
   * their follow-ups — the beat where Marcus asks about the invoice in the script.
   */
  const narrateBriefing = async () => {
    setIsAisaThinking(true);
    try {
      const result = await generateBriefingNarration(aisaContext());
      if (!result) return;
      setNarration(result);
      speechToken += 1;
      const currentToken = speechToken;
      const listenForQuestions = () => {
        if (currentToken !== speechToken || isVoiceDisabled()) return;
        startVoiceCapture();
      };
      const spoken = [...result.paragraphs, ...result.objectiveLines, result.invitation].join(' ');
      const spoke = speakText(spoken, 'en-US', listenForQuestions);
      if (!spoke && speechSupported()) listenForQuestions();
    } finally {
      setIsAisaThinking(false);
    }
  };

  const startBriefing = () => {
    setPromptIndex(0);
    setReachedEnd(false);
    setExchanges([]);
    setNarration(undefined);
    setStep('qa');
    if (aiMode()) void narrateBriefing();
  };

  const handleSimulateAnswer = () => {
    setVoiceNotice(undefined);
    recordReply(buildSimulatedBriefingReply(promptIndex(), props.account, props.opportunity, props.contacts ?? []));
  };
  const handleSkip = () => {
    setVoiceNotice(undefined);
    goNext();
  };
  const handleNext = () => {
    setVoiceNotice(undefined);
    goNext();
  };
  const handlePrevious = () => {
    setVoiceNotice(undefined);
    goPrevious();
  };

  const endBriefing = () => {
    setExchanges([]);
    setNarration(undefined);
    setPromptIndex(0);
    setReachedEnd(false);
    setStep('ended');
    props.onEndBriefing();
  };

  const simulateApproach = () => {
    setExchanges([]);
    setNarration(undefined);
    setPromptIndex(0);
    setReachedEnd(false);
    setStep('ended');
    props.onSimulateApproach?.();
  };

  createEffect(() => {
    if (step() !== 'qa') return;
    // AI mode drives its own speech from `narrateBriefing` / `handleRepQuestion`; there is no
    // scripted prompt list to walk here.
    if (aiMode()) return;
    const question = currentQuestion();
    if (!question || reachedEnd()) return;
    stopVoiceCapture();
    cancelSpeech();
    setVoiceNotice(undefined);
    speechToken += 1;
    const currentToken = speechToken;
    const autoStartListening = () => {
      if (currentToken !== speechToken) return;
      if (isVoiceDisabled()) return;
      startVoiceCapture();
    };
    const spoke = speakText(question, 'en-US', autoStartListening);
    if (!spoke && speechSupported()) autoStartListening();
    if (!speechSupported()) setVoiceNotice('Voice recognition is not available in this browser. Use Simulate answer to continue.');
  });

  onCleanup(() => {
    stopVoiceCapture();
    cancelSpeech();
  });

  return (
    <div class="aisa-dialog">
      <Show when={step() === 'prompt'}>
        <div class="assistant-briefing-copy">
          <Sparkles size={17} />
          <div>
            <p>
              AISA here. You are {props.briefing.etaMinutes} minutes out from {props.account.name}.
            </p>
            <p>I pulled the briefing for this visit. Want me to walk you through it?</p>
          </div>
        </div>
        <button class="aisa-primary-action" onClick={startBriefing}>
          Yes, let&apos;s hear it
        </button>
      </Show>

      <Show when={step() === 'summary' || step() === 'qa'}>
        <div class="assistant-briefing-copy">
          <Sparkles size={17} />
          <div>
            <Show
              when={narration()}
              fallback={
                <>
                  <p>{props.briefing.executiveSummary}</p>
                  <Show when={props.briefing.opportunitySummary}>
                    {(summary) => <p>{summary()}</p>}
                  </Show>
                  <Show when={props.briefing.blockers.length > 0}>
                    <p>Watch out for: {props.briefing.blockers.join('; ')}.</p>
                  </Show>
                  <Show when={props.briefing.recentTopics.length > 0}>
                    <p>Recent threads: {props.briefing.recentTopics.join(' | ')}</p>
                  </Show>
                  <Show when={aiMode() && isAisaThinking()}>
                    <p>Pulling your 90-day summary…</p>
                  </Show>
                </>
              }
            >
              {(spoken) => <For each={spoken().paragraphs}>{(paragraph) => <p>{paragraph}</p>}</For>}
            </Show>
          </div>
        </div>

        <section class="aisa-section">
          <span class="eyebrow">
            <Target size={13} /> Call objectives
          </span>
          <div class="visit-objective-list">
            <For each={objectives()}>
              {(objective, index) => (
                <div class="visit-objective-item">
                  <CheckCircle2 size={15} />
                  <div>
                    <span>{objective.label}</span>
                    <p>{narration()?.objectiveLines[index()] ?? objective.detail}</p>
                  </div>
                </div>
              )}
            </For>
          </div>
        </section>

        <Show when={exchanges().length > 0}>
          <section class="aisa-section aisa-transcript">
            <For each={exchanges()}>
              {(exchange) => (
                <div class="aisa-exchange">
                  <p class="aisa-exchange-question">
                    {exchange.direction === 'rep-asks' ? 'You: ' : ''}{exchange.question}
                  </p>
                  <p class="aisa-exchange-answer">
                    {exchange.direction === 'rep-asks' ? 'AISA: ' : ''}{exchange.answer}
                  </p>
                </div>
              )}
            </For>
          </section>
        </Show>

        <Show when={aiMode() && !reachedEnd()}>
          <section class="aisa-section">
            <span class="eyebrow">
              <MessageCircleQuestion size={13} /> Ask AISA anything
            </span>
            <p class="aisa-exchange-question">
              {narration()?.invitation ?? 'Do you need any additional details on this account?'}
            </p>
            <div class="voice-transcript" aria-live="polite">
              <span class="eyebrow">
                {isListening() ? <Mic size={13} /> : <MicOff size={13} />}
                {isListening() ? 'Listening…' : 'Your question'}
              </span>
              <p>
                {isAisaThinking()
                  ? 'AISA is checking the CRM…'
                  : interimTranscript() || 'Ask about the invoice, the opportunity, the contacts — anything on file. Say "finish" when you are done.'}
              </p>
            </div>
            <div class="voice-action-row">
              <button class="secondary-action wide" onClick={() => setReachedEnd(true)}>
                Done asking
              </button>
            </div>
            <Show when={voiceNotice()}>
              <p class="assistant-demo-note" aria-live="polite">{voiceNotice()}</p>
            </Show>
          </section>
        </Show>

        <Show when={!aiMode() && !reachedEnd() && currentQuestion()}>
          {(question) => (
            <section class="aisa-section">
              <span class="eyebrow">
                <MessageCircleQuestion size={13} /> AISA is asking
              </span>
              <p class="aisa-exchange-question">{question()}</p>
              <div class="voice-transcript" aria-live="polite">
                <span class="eyebrow">
                  {isListening() ? <Mic size={13} /> : <MicOff size={13} />}
                  {isListening() ? 'Listening…' : 'Your answer'}
                </span>
                <p>{interimTranscript() || 'Say your answer, or use Simulate answer below.'}</p>
              </div>
              <div class="voice-action-row">
                <button class="secondary-action wide" onClick={handlePrevious}>
                  Previous
                </button>
                <button class="secondary-action wide" onClick={handleNext}>
                  Next
                </button>
              </div>
              <div class="voice-action-row">
                <button class="secondary-action wide" onClick={handleSimulateAnswer}>
                  <Sparkles size={18} />
                  Simulate answer
                </button>
                <button class="secondary-action wide" onClick={handleSkip}>
                  Skip
                </button>
              </div>
              <Show when={voiceNotice()}>
                <p class="assistant-demo-note" aria-live="polite">{voiceNotice()}</p>
              </Show>
            </section>
          )}
        </Show>

        <div class="aisa-dialog-actions">
          <Show when={props.onSimulateApproach}>
            <button class="aisa-primary-action" onClick={simulateApproach}>
              <Route size={15} />
              Simulate approach
            </button>
          </Show>
          <button class="details-toggle" onClick={endBriefing}>
            End briefing
          </button>
        </div>
      </Show>

      <Show when={step() === 'ended'}>
        <div class="assistant-briefing-copy">
          <Sparkles size={17} />
          <div>
            <p>Briefing closed. Good luck in there.</p>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default AisaBriefingDialog;
