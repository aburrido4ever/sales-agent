import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { AlertCircle, Bot, CheckCircle2, ChevronLeft, ChevronRight, Circle, ClipboardCheck, LoaderCircle, Mic, MicOff, Sparkles } from 'lucide-solid';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { assessObjectives, askDebriefQuestion, buildAisaContext, isAiEnabled, type DebriefTurn } from '../ai/aisa';
import { getVisitAccount } from '../selectors';
import { SILENCE_ADVANCE_MS, buildDebriefTransitionCopy, buildSimulatedObjectiveAnswer, buildVisitObjectives, cancelSpeech, combineDebriefText, evaluateVisitObjectives, matchVoiceNavigationCommand, speakText } from '../services';
import { actions, state } from '../store';
import type { VoiceNavigationCommand } from '../services';
import type { InterviewQuestion, SpeechRecognitionCtorWindow, SpeechRecognitionLike, SpeechRecognitionResultEventLike, VisitObjectiveAssessment } from '../types';

const aiReviewSteps = [
  'Reading captured conversation',
  'Checking interview objectives',
  'Finding Opportunity, Task, Meeting, Contact, and Risk signals',
  'Ready for objective review',
];

const objectiveStatusLabels = {
  met: 'Met',
  partial: 'Needs review',
  missed: 'Missing',
};

function QuestionnaireStepper() {
  const review = () => state.questionnaire.review;
  const visit = () => state.questionnaire.visitId ? state.visits.find((item) => item.id === state.questionnaire.visitId) : undefined;
  const account = () => {
    const currentVisit = visit();
    return currentVisit ? getVisitAccount(currentVisit) : undefined;
  };
  const opportunity = () => {
    const currentAccount = account();
    return currentAccount ? state.crm.opportunities.find((item) => item.accountId === currentAccount.id) : undefined;
  };

  const snapshot = () => state.questionnaire.snapshot;
  const totalQuestions = () => snapshot().length;
  const activeIndex = () => state.questionnaire.currentQuestionIndex;
  const activeQuestion = () => snapshot()[activeIndex()];
  const isLastQuestion = () => activeIndex() >= totalQuestions() - 1;
  const answer = () => state.questionnaire.answers[activeQuestion()?.id ?? ''] ?? '';
  const hasAnyAnswer = () => Object.values(state.questionnaire.answers).some((value) => value.trim());

  /**
   * AI path: statuses come from `assessObjectives` (the model reads the transcript).
   * Mock path: the original keyword matching. Never mixed — see `assessObjectives`' doc comment
   * for why a model-written prompt breaks the keyword namespace `services.ts` relies on.
   */
  const [aiObjectives, setAiObjectives] = createSignal<VisitObjectiveAssessment[] | undefined>(undefined);
  const aiMode = () => isAiEnabled();

  const objectives = createMemo(() => {
    const currentAccount = account();
    if (!currentAccount) return [];
    const scored = aiObjectives();
    if (aiMode() && scored?.length) return scored;
    if (aiMode()) {
      // Before the first answer there is nothing to score — show the agenda as untouched.
      return buildVisitObjectives(currentAccount, opportunity()).map((objective) => ({
        ...objective,
        status: 'missed' as const,
        evidence: 'Not covered in the debrief yet.',
      }));
    }
    return evaluateVisitObjectives(
      combineDebriefText(snapshot(), state.questionnaire.answers),
      currentAccount,
      opportunity(),
    );
  });

  /** The CRM slice AISA is allowed to speak from. Rebuilt whenever the visit's account changes. */
  const aisaContext = createMemo(() => {
    const currentAccount = account();
    if (!currentAccount) return undefined;
    return buildAisaContext({
      account: currentAccount,
      contacts: state.crm.contacts.filter((contact) => contact.accountId === currentAccount.id),
      opportunity: opportunity(),
      tasks: state.crm.tasks.filter((task) => task.accountId === currentAccount.id),
      activities: state.crm.activities.filter((activity) => activity.accountId === currentAccount.id),
      objectives: buildVisitObjectives(currentAccount, opportunity()),
    });
  });

  /** What AISA and the rep have actually said so far — the model's only memory of the debrief. */
  const debriefTranscript = (): DebriefTurn[] =>
    snapshot()
      .map((question) => ({ question: question.prompt, answer: (state.questionnaire.answers[question.id] ?? '').trim() }))
      .filter((turn) => turn.answer);

  const objectiveIdOf = (question: InterviewQuestion) => question.objectiveId ?? question.id;

  /** Maps a checklist row to the snapshot slot that asks about it — AI follow-ups shift indices. */
  const questionIndexForObjective = (objectiveId: string, fallbackIndex: number) => {
    const index = snapshot().findIndex((question) => objectiveIdOf(question) === objectiveId);
    return index < 0 ? fallbackIndex : index;
  };

  const [isListening, setIsListening] = createSignal(false);
  const [isAnalyzing, setIsAnalyzing] = createSignal(false);
  const [aiStepIndex, setAiStepIndex] = createSignal(0);
  const [interimTranscript, setInterimTranscript] = createSignal('');
  const [isVoiceDisabled, setIsVoiceDisabled] = createSignal(false);
  const [transitionCopy, setTransitionCopy] = createSignal<string | undefined>(undefined);
  const [isTransitioning, setIsTransitioning] = createSignal(false);
  /** True while a model call is in flight, so the mic stays shut and the UI can say so. */
  const [isAisaThinking, setIsAisaThinking] = createSignal(false);
  /** Question ids AISA has already phrased, so re-entering a question does not re-ask the model. */
  const phrasedQuestionIds = new Set<string>();
  let recognition: SpeechRecognitionLike | undefined;
  let nativeListening = false;
  let nativeStateListener: PluginListenerHandle | undefined;
  const aiTimers: ReturnType<typeof setTimeout>[] = [];
  const transitionTimers: ReturnType<typeof setTimeout>[] = [];
  let turnTranscript = '';
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = undefined;
  };

  const clearAiTimers = () => {
    aiTimers.forEach((timer) => clearTimeout(timer));
    aiTimers.length = 0;
  };
  const clearTransitionTimers = () => {
    transitionTimers.forEach((timer) => clearTimeout(timer));
    transitionTimers.length = 0;
  };
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
    return message || 'Microphone could not start. Use demo notes.';
  };

  const handleVoiceCommand = (command: VoiceNavigationCommand) => {
    if (command === 'previous') {
      actions.previousQuestion();
      return;
    }
    if (command === 'next') {
      handleNext();
      return;
    }
    startAiReview();
  };
  const appendAnswerText = (value: string) => {
    const cleanValue = value.trim();
    if (!cleanValue) return;
    const question = activeQuestion();
    if (!question) return;
    const current = (state.questionnaire.answers[question.id] ?? '').trim();
    actions.updateAnswer(question.id, `${current}${current ? ' ' : ''}${cleanValue}`);
  };
  const handleCapturedSpeech = (text: string) => {
    const command = matchVoiceNavigationCommand(text);
    if (command) {
      handleVoiceCommand(command);
      return;
    }
    appendAnswerText(text);
  };
  /**
   * Fires after `SILENCE_ADVANCE_MS` of no new speech — the rep no longer has to say
   * "next"/"finish" out loud; a natural pause is the cue to continue, same as talking to a person.
   */
  const commitSpokenTurn = () => {
    clearSilenceTimer();
    const text = (turnTranscript || interimTranscript()).trim();
    turnTranscript = '';
    setInterimTranscript('');
    if (!text) return;
    stopVoiceCapture();
    const command = matchVoiceNavigationCommand(text);
    if (command) {
      handleVoiceCommand(command);
      return;
    }
    appendAnswerText(text);
    handleNext();
  };
  const scheduleSilenceCommit = () => {
    clearSilenceTimer();
    silenceTimer = setTimeout(commitSpokenTurn, SILENCE_ADVANCE_MS);
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
  const disableVoiceCapture = () => {
    setIsVoiceDisabled(true);
    stopVoiceCapture();
  };
  const startNativeVoiceCapture = async () => {
    if (nativeListening || isListening()) return;

    try {
      const availability = await SpeechRecognition.available();
      if (!availability.available) {
        setIsVoiceDisabled(true);
        actions.showToast('Native speech recognition is not available on this device.');
        return;
      }

      const permissions = await SpeechRecognition.checkPermissions();
      const permissionState = permissions.speechRecognition === 'granted'
        ? permissions.speechRecognition
        : (await SpeechRecognition.requestPermissions()).speechRecognition;
      if (permissionState !== 'granted') {
        setIsVoiceDisabled(true);
        actions.showToast('Microphone permission is required for listening.');
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
        prompt: "Answer the question — I'll continue automatically. Say previous or finish to override.",
      });
      const bestFinalMatch = result.matches?.find((match) => match.trim());
      if (bestFinalMatch) {
        handleCapturedSpeech(bestFinalMatch);
        actions.showToast('Answer captured.');
      } else {
        actions.showToast('No voice was detected. Try again or simulate the answer.');
      }
    } catch (error) {
      actions.showToast(getNativeSpeechErrorMessage(error));
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
      actions.showToast('Listening failed. Simulate the answer instead.');
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
      actions.showToast('Microphone could not start. Simulate the answer instead.');
    }
  };
  const handleSimulateAnswer = () => {
    const currentAccount = account();
    const question = activeQuestion();
    if (!currentAccount || !question) return;
    actions.updateAnswer(question.id, buildSimulatedObjectiveAnswer(question.id, currentAccount, opportunity()));
    actions.showToast('Simulated answer captured.');
  };
  const startAiReview = (precomputed?: VisitObjectiveAssessment[]) => {
    if (isAnalyzing() || !hasAnyAnswer()) {
      if (!hasAnyAnswer()) actions.showToast('Answer at least one question before finishing.');
      return;
    }
    stopVoiceCapture();
    cancelSpeech();
    clearAiTimers();
    setIsAnalyzing(true);
    setAiStepIndex(0);
    actions.showToast('AI is checking interview objectives...');

    aiReviewSteps.slice(1).forEach((_, index) => {
      aiTimers.push(setTimeout(() => setAiStepIndex(index + 1), 720 * (index + 1)));
    });

    // The mock path keeps its scripted 720ms-per-step pacing; the AI path scores the transcript
    // for real and lands whenever the model answers, using the last assessment as the floor.
    const finish = (assessment?: VisitObjectiveAssessment[]) => {
      actions.buildReview(assessment);
      clearAiTimers();
    };

    if (!aiMode()) {
      aiTimers.push(setTimeout(() => finish(), 720 * aiReviewSteps.length));
      return;
    }

    const context = aisaContext();
    const currentAccount = account();
    if (precomputed?.length || !context || !currentAccount) {
      aiTimers.push(setTimeout(() => finish(precomputed), 720 * aiReviewSteps.length));
      return;
    }
    void assessObjectives(context, debriefTranscript(), {
      account: currentAccount,
      opportunity: opportunity(),
      questions: snapshot(),
      answers: state.questionnaire.answers,
    }).then((assessment) => {
      setAiObjectives(assessment);
      finish(assessment);
    });
  };
  /**
   * The AI debrief turn: score what the rep just said, and if the objective is still short, have
   * AISA drill into it instead of moving on — the script's "did she give you a timeline?" beat.
   * A follow-up is inserted at most once per objective so a vague rep can never loop the demo.
   */
  const handleAiNext = async (question: InterviewQuestion, currentAccount: NonNullable<ReturnType<typeof account>>) => {
    const context = aisaContext();
    if (!context) {
      actions.nextQuestion();
      return;
    }

    const objectiveId = objectiveIdOf(question);
    setTransitionCopy(buildDebriefTransitionCopy(objectiveId, currentAccount, opportunity()));
    setIsTransitioning(true);
    setIsAisaThinking(true);
    stopVoiceCapture();

    try {
      const assessment = await assessObjectives(context, debriefTranscript(), {
        account: currentAccount,
        opportunity: opportunity(),
        questions: snapshot(),
        answers: state.questionnaire.answers,
      });
      setAiObjectives(assessment);

      const answered = (state.questionnaire.answers[question.id] ?? '').trim();
      const scored = assessment.find((item) => item.id === objectiveId);
      const alreadyDrilled = snapshot().some(
        (item) => item.source === 'ai-followup' && item.objectiveId === objectiveId,
      );

      if (answered && scored && scored.status !== 'met' && !alreadyDrilled) {
        const prompt = await askDebriefQuestion(context, objectiveId, debriefTranscript(), {
          isFollowUp: true,
          fallbackPrompt: `Before we move on — ${scored.evidence.toLowerCase()} Can you fill that in?`,
        });
        actions.appendAiFollowUp(question.id, {
          id: `${objectiveId}-followup`,
          prompt,
          isActive: true,
          order: question.order + 1,
          category: question.category,
          answerType: 'text',
          source: 'ai-followup',
          objectiveId,
        });
        actions.nextQuestion();
        return;
      }

      if (isLastQuestion()) {
        startAiReview(assessment);
        return;
      }
      actions.nextQuestion();
    } finally {
      setIsAisaThinking(false);
      setIsTransitioning(false);
      setTransitionCopy(undefined);
    }
  };

  const handleNext = () => {
    if (isTransitioning()) return;
    const currentAccount = account();
    const question = activeQuestion();

    if (aiMode() && currentAccount && question) {
      void handleAiNext(question, currentAccount);
      return;
    }
    if (isLastQuestion()) {
      startAiReview();
      return;
    }
    if (!currentAccount || !question) {
      actions.nextQuestion();
      return;
    }
    setTransitionCopy(buildDebriefTransitionCopy(question.id, currentAccount, opportunity()));
    setIsTransitioning(true);
    transitionTimers.push(setTimeout(() => {
      setIsTransitioning(false);
      setTransitionCopy(undefined);
      actions.nextQuestion();
    }, 900));
  };

  let speechToken = 0;
  createEffect(() => {
    if (review()) return;
    const question = activeQuestion();
    if (!question) return;
    stopVoiceCapture();
    cancelSpeech();
    speechToken += 1;
    const currentToken = speechToken;
    const autoStartListening = () => {
      if (currentToken !== speechToken) return;
      if (review() || isVoiceDisabled()) return;
      startVoiceCapture();
    };
    const speakPrompt = (prompt: string) => {
      if (currentToken !== speechToken) return;
      if (state.questionnaire.mode !== 'voice') return;
      const spoke = speakText(prompt, 'en-US', autoStartListening);
      if (!spoke && speechSupported()) autoStartListening();
    };

    const context = aisaContext();
    // Follow-ups arrive already worded by the model; objective questions get re-worded once, so
    // AISA asks in its own voice instead of reading `objectiveQuestionCopy` verbatim.
    const needsPhrasing = aiMode()
      && context
      && question.source !== 'ai-followup'
      && !phrasedQuestionIds.has(question.id);

    if (!needsPhrasing || !context) {
      speakPrompt(question.prompt);
      return;
    }

    phrasedQuestionIds.add(question.id);
    setIsAisaThinking(true);
    void askDebriefQuestion(context, objectiveIdOf(question), debriefTranscript(), {
      fallbackPrompt: question.prompt,
    })
      .then((prompt) => {
        if (currentToken !== speechToken) return;
        actions.setQuestionPrompt(question.id, prompt);
        speakPrompt(prompt);
      })
      .finally(() => setIsAisaThinking(false));
  });

  onCleanup(() => {
    stopVoiceCapture();
    cancelSpeech();
    clearAiTimers();
    clearTransitionTimers();
  });

  return (
    <Show when={state.questionnaire.visitId && !review()}>
      <section class="panel questionnaire-panel stepper-panel voice-debrief-panel">
        <div class="questionnaire-topbar">
          <div>
            <span class="eyebrow">Guided debrief</span>
            <h2>{account()?.name ?? 'Customer meeting'} interview</h2>
          </div>
        </div>

        <div class="question-progress">
          <span style={{ width: `${totalQuestions() ? ((activeIndex() + 1) / totalQuestions()) * 100 : 0}%` }} />
        </div>
        <p>Question {activeIndex() + 1} of {totalQuestions()}</p>

        <Show when={activeIndex() === 0 && !transitionCopy()}>
          <div class="assistant-briefing-copy">
            <Sparkles size={17} />
            <div>
              <p>Hey AISA, can we update my account?</p>
              <p>Sure — let&apos;s walk through what happened on this visit.</p>
            </div>
          </div>
        </Show>

        <Show when={transitionCopy()}>
          {(copy) => (
            <div class="assistant-briefing-copy" aria-live="polite">
              <Sparkles size={17} />
              <div>
                <p>{copy()}</p>
                <Show when={isAisaThinking()}>
                  <p>Checking the objective and lining up the next question…</p>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <div class="objective-review-card">
          <div class="objective-review-header">
            <strong>Objective checklist</strong>
            <span>Updates after every answer.</span>
          </div>
          <div class="objective-review-list">
            <For each={objectives()}>
              {(item, index) => (
                <button
                  type="button"
                  class={`objective-review-item ${item.status}${activeQuestion() && objectiveIdOf(activeQuestion()!) === item.id ? ' active' : ''}`}
                  onClick={() => actions.goToQuestion(questionIndexForObjective(item.id, index()))}
                >
                  <div class="objective-review-icon">
                    <Show
                      when={item.status === 'met'}
                      fallback={item.status === 'partial' ? <AlertCircle size={17} /> : <Circle size={17} />}
                    >
                      <CheckCircle2 size={17} />
                    </Show>
                  </div>
                  <div>
                    <div class="objective-review-title">
                      <strong>{item.label}</strong>
                      <span>{objectiveStatusLabels[item.status]}</span>
                    </div>
                    <p>{item.detail}</p>
                  </div>
                </button>
              )}
            </For>
          </div>
        </div>

        <nav class="segmented-control" aria-label="Answer mode">
          <button
            type="button"
            class={state.questionnaire.mode === 'manual' ? 'selected' : ''}
            aria-pressed={state.questionnaire.mode === 'manual'}
            onClick={() => actions.setQuestionnaireMode('manual')}
          >
            Text
          </button>
          <button
            type="button"
            class={state.questionnaire.mode === 'voice' ? 'selected' : ''}
            aria-pressed={state.questionnaire.mode === 'voice'}
            onClick={() => actions.setQuestionnaireMode('voice')}
          >
            Voice
          </button>
        </nav>

        <div class="question-card">
          <Show when={state.questionnaire.mode === 'manual'}>
            <span class="eyebrow">The assistant asks</span>
            <h2>{activeQuestion()?.prompt}</h2>
          </Show>

          <Show
            when={state.questionnaire.mode === 'manual'}
            fallback={
              <div class="voice-panel">
                <div class="voice-transcript" aria-live="polite">
                  <span class="eyebrow">Captured answer</span>
                  <p>{interimTranscript() || answer() || 'Your spoken answer will appear here.'}</p>
                </div>
                <div class="voice-action-row">
                  <button
                    class={isListening() ? 'secondary-action wide' : 'primary-action wide'}
                    aria-pressed={isListening()}
                    disabled={!speechSupported() || isAnalyzing()}
                    onClick={() => (isListening() ? disableVoiceCapture() : startVoiceCapture())}
                  >
                    {isListening() ? <MicOff size={18} /> : <Mic size={18} />}
                    {isListening() ? 'Pause listening' : 'Start listening'}
                  </button>
                  <button class="secondary-action wide" disabled={isListening() || isAnalyzing()} onClick={handleSimulateAnswer}>
                    <Sparkles size={18} />
                    Simulate answer
                  </button>
                </div>
                <Show when={!speechSupported()}>
                  <p class="assistant-demo-note">Voice recognition is not available in this browser. Use the simulated answer to run the demo.</p>
                </Show>
                <Show when={isVoiceDisabled()}>
                  <p class="assistant-demo-note">Microphone unavailable. Use the simulated answer to continue.</p>
                </Show>
              </div>
            }
          >
            <label class="field">
              <span>Your answer</span>
              <textarea
                rows={5}
                value={answer()}
                disabled={isAnalyzing()}
                onInput={(event) => {
                  const question = activeQuestion();
                  if (question) actions.updateAnswer(question.id, event.currentTarget.value);
                }}
              />
            </label>
            <button class="secondary-action wide" disabled={isAnalyzing()} onClick={handleSimulateAnswer}>
              <Sparkles size={18} />
              Simulate answer
            </button>
          </Show>
        </div>

        <Show when={isAnalyzing()}>
          <div class="ai-review-card" aria-live="polite">
            <div class="ai-review-header">
              <Bot size={20} />
              <div>
                <span class="eyebrow">AI extraction</span>
                <strong>{aiReviewSteps[aiStepIndex()]}</strong>
              </div>
              <LoaderCircle size={18} class="sync-spinner" />
            </div>
            <div class="ai-review-steps">
              <For each={aiReviewSteps}>
                {(step, index) => (
                  <div class={index() <= aiStepIndex() ? 'ai-step active' : 'ai-step'}>
                    {index() <= aiStepIndex() ? <CheckCircle2 size={15} /> : <Sparkles size={15} />}
                    <span>{step}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="question-action-bar">
          <button class="secondary-action" disabled={activeIndex() === 0 || isAnalyzing() || isTransitioning()} onClick={() => actions.previousQuestion()}>
            <ChevronLeft size={18} />
            Previous
          </button>
          <button class="primary-action" disabled={isAnalyzing() || isTransitioning() || (isLastQuestion() && !hasAnyAnswer())} onClick={handleNext}>
            <Show when={isLastQuestion()} fallback={<><ChevronRight size={18} />Next</>}>
              {isAnalyzing() ? <LoaderCircle size={18} class="sync-spinner" /> : <ClipboardCheck size={18} />}
              {isAnalyzing() ? 'Checking objectives' : 'Finish debrief'}
            </Show>
          </button>
        </div>

        <button class="secondary-action wide" disabled={!hasAnyAnswer() || isAnalyzing() || isTransitioning()} onClick={() => startAiReview()}>
          <ClipboardCheck size={18} />
          Finish debrief now
        </button>
      </section>
    </Show>
  );
}

export default QuestionnaireStepper;
