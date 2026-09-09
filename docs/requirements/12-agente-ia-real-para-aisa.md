# RQ-12 — Agente de IA real para AISA (briefing y debrief), manteniendo alcance de demo

Fecha: 2026-09-08
Autor: Claude Code, a petición de René Trejo.
**Naturaleza de este documento**: a diferencia de RQ-01–RQ-11 (derivados de los PDFs de negocio y del código existente, per [00-README.md](00-README.md)), este es un **requerimiento técnico nuevo**, solicitado directamente por el dueño del producto para resolver la pregunta abierta dejada en [RQ-05 §9](05-asistente-ia-briefing-y-debrief-por-voz.md#9-preguntas-abiertas--decisiones-pendientes): *"Proveedor de LLM/voz real: no definido en ningún documento formal"*. No sustituye a RQ-05/RQ-06 — los complementa con la capa de implementación (modelo, prompt, cuota, despliegue) que aquellos dejan sin resolver.

**Estado en el demo (antes de este requerimiento):** Todo el contenido "generado" por AISA es lógica determinística de palabras clave, sin llamada a ningún LLM — `buildSimulatedObjectiveAnswer`, `buildBriefingFollowUpAnswer`, `evaluateVisitObjectives`, `combineDebriefText`, `interpretVisitAnswers` en [`src/services.ts`](../../src/services.ts).
**Código relacionado:** [`src/components/AisaBriefingDialog.tsx`](../../src/components/AisaBriefingDialog.tsx), [`src/components/AssistantNotificationSheet.tsx`](../../src/components/AssistantNotificationSheet.tsx), [`src/components/QuestionnaireStepper.tsx`](../../src/components/QuestionnaireStepper.tsx), acciones de `assistant`/`questionnaire` en [`src/store.ts`](../../src/store.ts).
**Backend relacionado:** `server/src/SalesAgent.Api` no tiene hoy ningún endpoint ni paquete relacionado con un proveedor de LLM (verificado por grep — cero resultados para `Anthropic`/`OpenAI`/`LLM` bajo `server/`).

## 1. Resumen / objetivo

Reemplazar la lógica determinística que hoy simula a AISA por un agente de IA real (Claude, vía la API de Anthropic) que genere el contenido del briefing pre-visita y sostenga el intercambio de preguntas/respuestas del debrief post-visita — **sin dejar de ser una demo**: sin SLA de producción, sin infraestructura de escalado, con datos de cuenta que siguen siendo los de `src/data.ts`/el backend demo, y con capacidad de apagar el modelo real y caer de vuelta al mock en cualquier momento.

## 2. Alcance

**Dentro de alcance:**
- Generación del contenido del pre-visit briefing (resumen ejecutivo, focos sugeridos, preguntas sugeridas) a partir del contexto de cuenta/oportunidad/tareas ya disponible en el demo.
- Las respuestas conversacionales de AISA dentro de `AisaBriefingDialog` (Q&A durante el briefing) y del debrief post-visita (`QuestionnaireStepper`/objective walkthrough).
- La interpretación de la respuesta libre del representante para marcar un objetivo como `met`/`partial`/`unmet` (hoy resuelto por keyword-matching en `evaluateVisitObjectives`).

**Fuera de alcance de este requerimiento** (quedan como están, mock, o son de otro RQ):
- Voz real (TTS/STT) — el demo sigue usando Web Speech API tal cual; este requerimiento cubre el *contenido* que se habla/lee, no el pipeline de audio.
- RAG contra fuentes externas reales (internet, LinkedIn) mencionado en RQ-05 §4 — el contexto sigue siendo 100% los datos ya presentes en el demo (CRM local + backend), no búsqueda externa.
- Writeback real a Salesforce (RQ-09) — sigue simulado.
- Cualquier infraestructura de producción (auto-scaling, multi-tenant real, SLA) — explícitamente no se pretende dejar de ser demo.

## 3. Modelo

- **RF-IAREAL-01**: El proveedor debe ser la API de Anthropic (Claude), consistente con el resto de este entorno de desarrollo. Modelo por defecto propuesto: **Claude Haiku 4.5** para las respuestas conversacionales de bajo costo/alta frecuencia (Q&A durante briefing, follow-ups del debrief) y **Claude Sonnet 5** para la generación del resumen ejecutivo/briefing inicial (una sola vez por visita, más tolerante a latencia, se beneficia de mejor razonamiento sobre el contexto de cuenta).
- **RF-IAREAL-02**: El modelo exacto por tipo de llamada debe ser configurable (appsettings/env var), no hardcodeado — para poder bajar de nivel (a Haiku en todo) si el costo de demo lo amerita, sin tocar código.
- **RF-IAREAL-03**: Debe usarse la Anthropic Messages API estándar (no Agent SDK ni computer-use) — el caso de uso es generación de texto + extracción estructurada, no un agente con herramientas/loop autónomo.

## 4. Arquitectura de servicio

- **RF-IAREAL-04**: El modelo **nunca se invoca desde el cliente SolidJS** — regla ya establecida como no-negociable en [RQ-05 §4](05-asistente-ia-briefing-y-debrief-por-voz.md#4-reglas-de-negocio). Toda llamada pasa por un nuevo recurso en `server/src/SalesAgent.Api` (candidato: `AisaAssistant`), siguiendo el patrón de feature no-CRUD (`rx-api-feature`: architect → tester → developer → auditor) ya usado en este repo — la API key de Anthropic vive solo en el servidor (variable de entorno / user-secrets, nunca en `appsettings.json` versionado ni en el repo).
- **RF-IAREAL-05**: Endpoints mínimos: (a) generar briefing pre-visita a partir de `accountId`/`visitId`, (b) responder una pregunta puntual del representante durante el briefing (Q&A), (c) evaluar una respuesta libre de debrief contra un objetivo y devolver `met`/`partial`/`unmet` + follow-up sugerido si aplica.
- **RF-IAREAL-06**: El cliente SolidJS consume estos endpoints igual que consumiría cualquier otro recurso de `src/api/` (ver convención de `rx-ui-architect`) — el store (`store.ts`) reemplaza la llamada a la función local determinística por una llamada async a este cliente, con el mismo shape de retorno que hoy producen `buildSimulatedObjectiveAnswer`/`buildBriefingFollowUpAnswer`, para minimizar el cambio en los componentes consumidores.
- **RF-IAREAL-07**: Debe existir un **feature flag** (config de backend, no build-time) para alternar entre "AISA real" (llama a Claude) y "AISA mock" (lógica determinística actual) sin redeploy de frontend — necesario para seguir demostrando el flujo sin gastar cuota, o si el servicio de Anthropic no está disponible.

## 5. Prompt y contexto

- **RF-IAREAL-08**: El contexto enviado al modelo en cada llamada debe construirse server-side a partir de los mismos datos que hoy alimentan la lógica mock: cuenta, contacto primario, oportunidades activas, tareas pendientes, historial de interacciones reciente, y — para el debrief — la pregunta del objetivo actual y la transcripción de la respuesta del representante. Nunca se envían datos que no formen ya parte del contexto de la visita (sin islas de PII adicionales).
- **RF-IAREAL-09**: El system prompt de AISA debe fijar explícitamente: tono conversacional/profesional (RF-IA-06 de RQ-05), el orden de priorización de contenido (RF-IA-05), y la instrucción de citar el dato CRM concreto que sustenta cada afirmación (regla de citación de fuente mencionada en RQ-05 §0/Script.md) — para que el resultado sea auditable, no una alucinación libre.
- **RF-IAREAL-10**: La salida del modelo para evaluación de objetivos y extracción de datos estructurados debe forzarse a **JSON con schema fijo** (tool use / structured output de la API de Anthropic), replicando el contrato de tipos ya definido en `types.ts` (`VisitObjectiveAssessment`, `PostMeetingExtraction`) — el parseo del lado del backend debe rechazar/reintentar una respuesta que no calce el schema, nunca reenviar texto libre sin validar al store.
- **RF-IAREAL-11**: Debe definirse (antes de implementar) el **esquema JSON exacto de extracción** — ítem ya señalado como pendiente en RQ-05 §9 ("Definición exacta del esquema JSON de extracción... mencionado como pendiente explícito en `botui.md`") — este requerimiento lo hace explícito como bloqueante de la Fase de implementación, no algo a resolver ad-hoc en código.

## 6. Cuota y costo

- **RF-IAREAL-12**: Debe existir un límite de uso configurable por sesión de demo (ej. N llamadas por visita, M llamadas por representante por día) que, al alcanzarse, cae automáticamente al fallback mock (RF-IAREAL-07) en vez de fallar la UI — el usuario nunca debe ver un error de cuota agotada, ve el mismo flujo con contenido determinístico.
- **RF-IAREAL-13**: El backend debe loguear tokens de entrada/salida y costo estimado por llamada (mínimo: log estructurado; sin necesidad de dashboard) — suficiente para que el dueño del producto pueda estimar costo real de una demo antes de decidir si escala.
- **RF-IAREAL-14**: Dado que es demo (no multi-tenant real), un límite global simple (contador en memoria o en la tabla de sesión existente) es aceptable — no se requiere un sistema de rate-limiting distribuido ni de facturación por cliente.
- **RF-IAREAL-15**: Debe fijarse un presupuesto explícito de tokens de contexto por llamada (ej. tope de tokens para el bloque de contexto de cuenta/historial) para que una cuenta con mucho historial no dispare un costo desproporcionado — trunca/resume el contexto en vez de enviarlo completo sin límite.

## 7. Despliegue (sigue siendo demo)

- **RF-IAREAL-16**: No se introduce infraestructura de producción — el servicio corre igual que hoy corre `SalesAgent.Api` (local vía `dotnet run`, Postgres local vía docker-compose). Este requerimiento no incluye CI/CD nuevo, autoscaling, ni ambiente cloud dedicado.
- **RF-IAREAL-17**: La API key de Anthropic se provee vía variable de entorno / .NET user-secrets en desarrollo — nunca committeada. Debe documentarse en `server/README.md` junto con el resto de la configuración local (siguiendo el patrón ya existente para otras configuraciones sensibles del proyecto).
- **RF-IAREAL-18**: Si en el futuro se necesita compartir la demo con alguien fuera de la máquina local, la única extensión de despliegue esperada es exponer el mismo backend (ya sea túnel local o un único deploy no productivo) — no se diseña para múltiples entornos (staging/prod) todavía.

## 8. Requerimientos no funcionales

- Latencia aceptable en demo: unos pocos segundos por respuesta es tolerable (no aplica el NFR de RQ-05 de "<5s generación de briefing" con rigor de producción, pero es una buena referencia de UX a no violar groseramente).
- Resiliencia: cualquier error del proveedor (timeout, 429, 500) debe hacer fallback silencioso al mock (RF-IAREAL-07), nunca romper el flujo de visita.
- No se requiere cifrado adicional más allá de HTTPS estándar del backend — no hay dato de voz real siendo procesado (fuera de alcance, ver §2).

## 9. Fuera de alcance (explícito)

- TTS/STT reales, RAG contra fuentes externas (internet/LinkedIn), writeback real a Salesforce, cualquier SLA/infraestructura de producción, rate-limiting distribuido, dashboard de costos, soporte multi-tenant.

## 10. Preguntas abiertas / decisiones pendientes

- **Confirmar modelo por tipo de llamada** (propuesta: Haiku 4.5 para Q&A/debrief, Sonnet 5 para el resumen inicial) — decisión de costo vs. calidad que le corresponde al dueño del producto antes de fijar el default.
- **Definir el esquema JSON exacto de extracción/evaluación** (RF-IAREAL-11) — bloqueante antes de que `rx-api-architect` pueda escribir el Feature Brief.
- **Definir los límites numéricos de cuota** (RF-IAREAL-12): ¿cuántas llamadas por visita/día se consideran razonables para una demo?
- **¿El feature flag (RF-IAREAL-07) es por-ambiente (todo o nada) o por-usuario/sesión?** — afecta si vive en `appsettings` o en una tabla de configuración.
- Este documento no resuelve el nombre de marca del asistente ("Sandy" vs "AISA") — sigue pendiente en RQ-05 §9.
