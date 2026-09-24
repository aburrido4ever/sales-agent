# AISA con LLM real — brief de entrada y cuestionario post-visita

## Objetivo

Que AISA **haga las preguntas de verdad** (LLM) en los dos momentos conversacionales del demo,
sin salirse del guion de `docs/Script.md`:

1. **Part 1 — Pre-Meeting Briefing**: AISA narra el resumen de 90 días con las secciones que el
   admin mandató, genera las Call Objectives, y **responde preguntas libres del rep**
   ("What exactly was that overdue invoice for?", "who is the decision-maker?"). Hoy el rep solo
   puede contestar prompts enlatados; AISA nunca responde nada.
2. **Part 2 — Post-Meeting Debrief**: AISA conduce el debrief objetivo por objetivo, repregunta
   cuando la respuesta no cubre el objetivo, confirma qué va a escribir en Salesforce, y evalúa
   el estado de cada objetivo (`met` / `partial` / `missed`) para la visualización de progreso.

## Decisiones tomadas

- **Runtime: navegador directo.** Módulo `src/ai/` que llama a la API de Claude con
  `VITE_ANTHROPIC_API_KEY` + header `anthropic-dangerous-direct-browser-access`. Mismo patrón que
  el ElevenLabs actual en `services.ts`. La key queda en el bundle — **aceptable solo para demo**,
  documentado en `.env.example`. Migrar a `server/` cuando el backend deje de ser un esqueleto.
- **Fidelidad: el guion son los rieles, la IA vive en los bordes.**
  - Los **temas y su orden** los sigue fijando el código determinista: las secciones del brief
    salen del CRM (`buildPreMeetingBriefing`) y los objetivos del debrief de
    `buildVisitObjectives`. El LLM **no inventa objetivos ni reordena el guion**.
  - El LLM aporta: locución natural, comprensión de la respuesta hablada, repreguntas, y
    respuestas a preguntas libres del rep.
  - **Grounding duro**: el prompt lleva el JSON del account/contactos/oportunidad/tareas/
    actividades/señales externas y la regla de no afirmar nada fuera de ese contexto.
- **Degradación**: sin key, sin red, o ante cualquier error → se cae a la ruta determinista
  actual, intacta. El demo nunca se rompe por falta de key.

## Archivos

### Nuevos — `src/ai/`

| Archivo | Responsabilidad |
|---|---|
| `src/ai/client.ts` | POST a `https://api.anthropic.com/v1/messages`. Lee `VITE_ANTHROPIC_API_KEY` / `VITE_ANTHROPIC_MODEL` (default `claude-sonnet-5`). `isAiEnabled()`. Devuelve `undefined` ante cualquier fallo — nunca lanza. Helper `requestJson<T>()` que fuerza salida JSON y la parsea con tolerancia. |
| `src/ai/aisaContext.ts` | `buildAisaContext(account, contacts, opportunity, tasks, activities, briefing)` → objeto serializable que se inyecta al prompt. Único lugar que decide qué datos del CRM ve el LLM. |
| `src/ai/aisaPrompts.ts` | El system prompt de AISA: persona, las 7 secciones mandadas por el admin, la regla de citar la fuente (`Source: Salesforce — …`), el tono del guion, y la prohibición de inventar. Más los prompts por operación. |
| `src/ai/aisa.ts` | Las 4 operaciones públicas (abajo). Cada una `async`, cada una con fallback determinista. |

**Operaciones de `src/ai/aisa.ts`:**

- `generateBriefingNarration(ctx)` → `{ intro, sections[], objectives[] }` — la narración hablada
  del brief. Fallback: el texto armado hoy en `AisaBriefingDialog`.
- `answerRepQuestion(ctx, question, history)` → `string` — **nuevo**, no existe hoy. Responde la
  pregunta libre del rep citando la fuente. Fallback: mensaje de "no tengo ese dato en el CRM".
- `askDebriefQuestion(ctx, objectives, history)` → `{ objectiveId, prompt, isFollowUp }` — la
  siguiente pregunta del debrief. El LLM elige **sólo entre los `objectiveId` abiertos** que le
  pasamos. Fallback: `objectiveQuestionCopy[objectiveId]`.
- `assessObjectives(ctx, objectives, transcript)` → `VisitObjectiveAssessment[]`. Fallback:
  `evaluateVisitObjectives` (keyword matching actual).

### Modificados

- `src/components/AisaBriefingDialog.tsx` — dos modos de turno: AISA pregunta al rep (como hoy) y
  **el rep pregunta a AISA** (nuevo; el transcript ya distingue pregunta/respuesta). La narración
  del `summary` pasa por `generateBriefingNarration` cuando la IA está activa.
- `src/components/QuestionnaireStepper.tsx` — la pregunta actual deja de salir sólo del
  `snapshot` estático: cuando la IA está activa se pide a `askDebriefQuestion` y se inserta en el
  snapshot antes de avanzar.
- `src/store.ts` — `questionnaire.snapshot` deja de ser inmutable tras `beginQuestionnaire`:
  nuevas acciones `setQuestionPrompt(questionId, prompt)` (AISA reformula una pregunta) y
  `appendAiFollowUp(afterQuestionId, question)` (repregunta insertada). `buildReview` acepta un
  `objectiveChecklist?` opcional que sólo llega por la ruta IA; sin key el comportamiento es
  idéntico al de hoy.
- `src/services.ts` — sin cambios de lógica. `evaluateVisitObjectives` y `objectiveQuestionCopy`
  se quedan **exactamente como están**: son el fallback.
- `src/types.ts` — `InterviewQuestion` gana `source?: 'objective' | 'ai-followup'`.
- `.env.example` — documenta `VITE_ANTHROPIC_API_KEY` y `VITE_ANTHROPIC_MODEL`.

## Caveat crítico del keyword namespace

`CLAUDE.md` advierte que `combineDebriefText` concatena **prompt + respuesta** de cada pregunta
contestada, y que `evaluateVisitObjectives` hace keyword matching sobre ese texto — por eso
`objectiveQuestionCopy` está escrito evitando deliberadamente sus propias señales.

**Un prompt escrito por el LLM no puede respetar esa restricción.** Por eso las dos rutas son
excluyentes, nunca híbridas:

- IA **activa** → preguntas del LLM **y** evaluación por LLM (`assessObjectives`). El keyword
  matching no se ejecuta, así que no hay colisión posible.
- IA **inactiva** → preguntas deterministas **y** keyword matching, igual que hoy.

Nunca preguntas del LLM evaluadas por keywords.

## Notas de implementación

- Modelo por defecto `claude-opus-5` con `output_config.effort: 'low'` — el turno es hablado y
  el rep está manejando; la latencia importa más que la profundidad.
- Salida forzada con `output_config.format` (`json_schema`), sin streaming: cada operación
  devuelve un objeto pequeño y el TTS necesita el texto completo antes de hablar.
- **No** se activaron los refusal fallbacks del SDK: el contenido es CRM de un demo de ventas,
  el riesgo de rechazo es nulo, y mantenerlos obligaría a mover todo al namespace beta. Se
  maneja `stop_reason === 'refusal'` cayendo al path determinista, que es suficiente aquí.

## Verificación

- `npm run build` (type-check + bundle).
- Sin `VITE_ANTHROPIC_API_KEY`: el flujo completo debe comportarse exactamente como hoy.
- Con key, cuenta **Apex Construction** (`acct-urban-foods`, ya tiene en `data.ts` el credit hold
  de $4,200/45 días, el invoice de HST3 del Downtown Plaza, los dos superintendentes de LinkedIn
  y el Riverfront): recorrer Part 1 y Part 2 del guion y contrastar contra `docs/Script.md`.
