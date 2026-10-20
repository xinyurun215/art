// A model view only. The project and saved official responses remain authoritative.
const PREVIEW_CHARACTERS = 1200;
const EXACT_FIELD_CHARACTERS = 6000;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const entityId = entity => entity.id ?? entity.entity_id;
const serialized = value => JSON.stringify(value) ?? '';
function boundedMetadata(value, depth = 0) {
  if (typeof value === 'string') return value.length <= PREVIEW_CHARACTERS ? value : fieldView(value);
  if (!value || typeof value !== 'object') return value;
  if (depth > 5) return fieldView(value);
  if (Array.isArray(value)) return value.length <= 12 ? value.map(item => boundedMetadata(item, depth + 1))
    : { items: value.slice(0, 12).map(item => boundedMetadata(item, depth + 1)), truncated: true, total: value.length };
  if (depth > 0 && serialized(value).length > PREVIEW_CHARACTERS) return {
    ...Object.fromEntries(['id', 'entity_id', 'entityId', 'name', 'type', 'match', 'status', 'confirmed']
      .filter(key => Object.hasOwn(value, key)).map(key => [key, typeof value[key] === 'object' ? fieldView(value[key]) : boundedMetadata(value[key])])),
    ...fieldView(value) };
  return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, item]) => [key, boundedMetadata(item, depth + 1)])
    .concat(Object.keys(value).length > 48 ? [['omittedFieldCount', Object.keys(value).length - 48]] : []));
}
const workflowView = value => Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, item]) => [key,
  ['feedback', 'schema_version', 'operation', 'status'].includes(key) ? structuredClone(item) : boundedMetadata(item)])
  .concat(Object.keys(value).length > 48 ? [['omittedFieldCount', Object.keys(value).length - 48]] : []));
const identityView = entity => Object.fromEntries(['id', 'entity_id', 'name', 'type']
  .filter(key => Object.hasOwn(entity, key)).map(key => [key, boundedMetadata(entity[key])]));

function fieldView(value, limit = PREVIEW_CHARACTERS) {
  const json = serialized(value);
  return json.length <= limit ? { value: structuredClone(value), exact: true }
    : { preview: json.slice(0, limit), exact: false, truncated: true, serializedCharacters: json.length };
}

export function evidenceView(card, expanded = false, offset = 0) {
  const { rawResult, returnedEntities = [], inputReferences, ...metadata } = card;
  const viewMetadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key,
    serialized(value).length <= PREVIEW_CHARACTERS ? structuredClone(value) : {
      ...fieldView(value), ...(key === 'query' ? { readTool: 'read_project_evidence', field: 'query' } : {}) }]));
  if (Array.isArray(inputReferences)) {
    viewMetadata.inputReferences = inputReferences.slice(0, 12).map(reference => Object.fromEntries(Object.entries(reference)
      .slice(0, 48).map(([key, value]) => [key, serialized(value).length <= PREVIEW_CHARACTERS ? structuredClone(value) : fieldView(value)])));
    if (inputReferences.length > 12) Object.assign(viewMetadata, { inputReferenceCount: inputReferences.length,
      omittedInputReferenceCount: inputReferences.length - 12 });
  } else if (inputReferences !== undefined) viewMetadata.inputReferences = boundedMetadata(inputReferences);
  const { results, ...workflowContext } = rawResult ?? {};
  const context = expanded ? workflowContext : Object.fromEntries(['status', 'interpretation', 'provenance', 'warnings', 'query_intent']
    .filter(key => Object.hasOwn(workflowContext, key)).map(key => [key, workflowContext[key]]));
  return { ...viewMetadata, ...(rawResult ? { workflowContext: workflowView(context), availableWorkflowFields: Object.keys(workflowContext).slice(0, 48),
    ...(Object.keys(workflowContext).length > 48 ? { omittedWorkflowFieldCount: Object.keys(workflowContext).length - 48 } : {}) } : {}),
    projection: { bounded: true, readTool: 'read_project_evidence',
      note: 'Entity identities and field inventory only unless expanded. Only exact:true fields or complete returned fields can be cited; previews cannot.' },
    returnedEntityCount: returnedEntities.length,
    ...(returnedEntities.length > offset + 12 ? { nextEntityOffset: offset + 12 } : {}),
    returnedEntities: returnedEntities.slice(offset, offset + 12).map((entity, index) => {
      const identity = identityView(entity);
      const fields = Object.keys(entity).filter(key => !forbidden.has(key));
      const properties = entity.properties && typeof entity.properties === 'object' ? Object.keys(entity.properties).filter(key => !forbidden.has(key)) : [];
      const inventory = { availableFields: fields.slice(0, 48), propertyFields: properties.slice(0, 48),
        ...(fields.length > 48 ? { omittedFieldCount: fields.length - 48 } : {}),
        ...(properties.length > 48 ? { omittedPropertyFieldCount: properties.length - 48 } : {}) };
      if (!expanded) return { ...identity, ...inventory };
      const selected = expanded && index < 6 ? ['description', 'short_description', 'long_description'].filter(key => Object.hasOwn(entity.properties ?? {}, key)) : [];
      const observed = Object.fromEntries(selected.map(key => [`properties.${key}`, fieldView(entity.properties[key])]));
      for (const key of ['affinity', 'popularity', 'score', 'participation'])
        if (expanded && index < 6 && Object.hasOwn(entity, key)) observed[key] = fieldView(entity[key]);
      // Small fixtures and existing complete entities need no alternate shape.
      if (expanded && serialized(entity).length <= PREVIEW_CHARACTERS) return structuredClone(entity);
      return { ...identity, ...inventory, observedFields: observed,
        projection: { bounded: true, readTool: 'read_project_evidence', evidenceId: card.id, entityId: entityId(entity),
          note: 'Only exact:true values are complete fields. Preview is not an exact evidence value.' } };
    }) };
}

export function readProjectEvidence(project, { evidenceId, entityId: requestedEntity, field, offset = 0 }) {
  const card = project.evidence.find(card => card.id === evidenceId && card.projectId === project.id);
  if (!card) return { status: 'missing', evidenceId, exact: false };
  if (requestedEntity === undefined && field === undefined) {
    const view = evidenceView(card, false, Number.isSafeInteger(offset) && offset >= 0 ? offset : 0);
    return { status: 'index', evidenceId, total: view.returnedEntityCount, nextOffset: view.nextEntityOffset ?? null,
      entities: view.returnedEntities };
  }
  if (field === undefined || requestedEntity === undefined && !/^query(?:\.|$)/.test(field))
    return { status: 'invalid_input', evidenceId, exact: false };
  const parts = typeof field === 'string' ? field.split('.') : [];
  if (!parts.length || field.length > 256 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part) && !forbidden.has(part)))
    return { status: 'invalid_path', exact: false };
  const entity = card?.returnedEntities?.find(entity => entityId(entity) !== undefined && entityId(entity) === requestedEntity);
  let value = requestedEntity === undefined ? card : entity;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return { status: 'missing', evidenceId, entityId: requestedEntity, field, exact: false };
    value = value[part];
  }
  const result = fieldView(value, EXACT_FIELD_CHARACTERS);
  return { status: result.exact ? 'ok' : 'too_large', evidenceId, entityId: requestedEntity, field, ...result,
    ...(result.exact ? {} : { note: 'The full saved field exceeds the local read limit; do not cite this preview as the exact value.' }) };
}

export function qlooResultView(result, project, expanded = true) {
  const card = project.evidence.find(card => card.id === result.artEvidence?.id && card.projectId === project.id);
  if (card) {
    const view = evidenceView(card, expanded);
    const { returnedEntities, returnedEntityCount, nextEntityOffset } = view;
    // Preserve query and resolution context; only the returned entity view changes.
    const { results, artEvidence, ...allContext } = result;
    const context = expanded ? allContext : Object.fromEntries(['schema_version', 'operation', 'status', 'feedback', 'interpretation', 'provenance', 'warnings', 'query_intent']
      .filter(key => Object.hasOwn(allContext, key)).map(key => [key, allContext[key]]));
    return { ...workflowView(context), ...(!expanded ? { availableWorkflowFields: Object.keys(allContext).slice(0, 48),
      ...(Object.keys(allContext).length > 48 ? { omittedWorkflowFieldCount: Object.keys(allContext).length - 48 } : {}) } : {}), results: returnedEntities, artEvidence: {
      id: card.id, projectId: card.projectId, source: card.source, synthetic: card.synthetic, relevant: card.relevant,
      boundary: card.boundary, returnedEntityCount, ...(nextEntityOffset === undefined ? {} : { nextEntityOffset }) } };
  }
  // needs_input resolution is authoritative input for entity confirmation, never summarized.
  const { results, ...rest } = result;
  return { ...workflowView(rest), ...(Array.isArray(results) ? { results: evidenceView({ returnedEntities: results }, expanded).returnedEntities,
    returnedEntityCount: results.length, ...(results.length > 12 ? { omittedEntityCount: results.length - 12 } : {}) } : {}) };
}

export function compactToolMessages(messages, project) {
  return messages.map(message => {
    if (message.role !== 'toolResult' || !['qloo_describe', 'qloo_recommend'].includes(message.toolName)) return message;
    const value = JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    return { ...message, content: [{ type: 'text', text: serialized(qlooResultView(value, project, false)) }] };
  });
}

export function unresolvedResearch(messages, previous = []) {
  const calls = new Map();
  const unresolved = new Map(previous.map(item => [serialized({ name: item.tool, id: item.observationId }), item]));
  for (const item of messages) {
    if (item.role === 'assistant') for (const block of item.content.filter(block => block.type === 'toolCall')) calls.set(block.id, block);
    if (item.role !== 'toolResult' || !['qloo_describe', 'qloo_recommend'].includes(item.toolName)) continue;
    let result = item.details;
    if (!result) try { result = JSON.parse(item.content.filter(block => block.type === 'text').map(block => block.text).join('')); } catch { continue; }
    const call = calls.get(item.toolCallId);
    const key = serialized({ name: item.toolName, id: item.toolCallId });
    if (result.status === 'needs_input') unresolved.set(key, { tool: item.toolName, observationId: item.toolCallId,
      input: serialized(call?.arguments).length <= PREVIEW_CHARACTERS ? structuredClone(call?.arguments) : fieldView(call?.arguments),
      status: 'needs_input', confirmed: false, note: 'Historical unresolved workflow observation; later query success does not establish user confirmation.',
      result: qlooResultView(result, { evidence: [] }) });
  }
  return [...unresolved.values()];
}

export function assembleContext(messages, snapshot, message, priorResearch = []) {
  const user = messages.findLast(item => item.role === 'user');
  if (message === undefined && user) {
    try { message = JSON.parse(typeof user.content === 'string' ? user.content : user.content.filter(block => block.type === 'text').map(block => block.text).join('')).message; }
    catch { message = typeof user.content === 'string' ? user.content : user.content.filter(block => block.type === 'text').map(block => block.text).join(''); }
  }
  const assistantIndex = messages.findLastIndex(item => item.role === 'assistant' && item.content?.some(block => block.type === 'toolCall'));
  const unresolved = unresolvedResearch(messages, priorResearch);
  if (unresolved.length) snapshot = { ...snapshot, openResearchQuestions: unresolved.slice(-12),
    ...(unresolved.length > 12 ? { omittedResearchQuestionCount: unresolved.length - 12 } : {}) };
  const recent = [];
  if (assistantIndex >= 0 && assistantIndex > messages.findLastIndex(item => item.role === 'user')) {
    const assistant = messages[assistantIndex];
    const calls = assistant.content.filter(block => block.type === 'toolCall');
    const results = messages.slice(assistantIndex + 1).filter(item => item.role === 'toolResult');
    if (new Set(calls.map(call => call.id)).size !== calls.length || results.length !== calls.length
      || !calls.every(call => results.filter(result => result.toolCallId === call.id).length === 1))
      throw Object.assign(new Error('当前工具调用与结果不完整、重复或未配对；保留会话并停止模型请求。'), { code: 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE' });
    {
      // Usage belongs to the former prefix, not this rebuilt view. Content is opaque.
      const copy = { ...assistant, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      recent.push(copy, ...results.filter(result => calls.some(call => call.id === result.toolCallId)));
    }
  } else if (messages.slice(messages.findLastIndex(item => item.role === 'user') + 1).some(item => item.role === 'toolResult')) {
    throw Object.assign(new Error('当前工具结果没有对应调用；保留会话并停止模型请求。'), { code: 'MODEL_CONTEXT_PROTOCOL_INCOMPLETE' });
  }
  return [{ ...(user ?? { role: 'user', timestamp: Date.now() }), content: [{ type: 'text', text: serialized({ project: snapshot, message }) }] }, ...recent];
}

// Offline character estimate, not a provider tokenizer or measured token usage.
export function estimateSerializedTokens(value) {
  const text = serialized(value);
  let ascii = 0, other = 0;
  for (const character of text) character.charCodeAt(0) < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 4) + other;
}

export function requestBudget(payload, { contextWindow, maxTokens }) {
  if (Object.hasOwn(payload, 'systemPrompt')) {
    // Agent tool-result details are persisted metadata, never provider input.
    payload = { messages: [{ role: 'system', content: payload.systemPrompt }, ...(payload.messages ?? []).map(message => ({
      role: message.role, content: message.content,
      ...(message.role === 'toolResult' ? { toolCallId: message.toolCallId, toolName: message.toolName } : {}) }))],
    tools: (payload.tools ?? []).map(({ name, description, parameters }) => ({ name, description, parameters })) };
  }
  const { messages = [], tools = [], systemPrompt, ...wrappers } = payload;
  const system = [...messages.filter(message => ['system', 'developer'].includes(message.role)),
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : [])];
  const work = messages.filter(message => message.role === 'user');
  const history = messages.filter(message => !['system', 'developer', 'user'].includes(message.role));
  const components = { system: estimateSerializedTokens(system), work: estimateSerializedTokens(work),
    history: estimateSerializedTokens(history), tools: estimateSerializedTokens(tools), wrappers: estimateSerializedTokens(wrappers) };
  const estimatedInputTokens = estimateSerializedTokens(payload);
  return { contextWindow, estimatedInputTokens, estimateMethod: 'offline-serialized-ascii4-other1', components,
    safetyTokens: 4096, reservedOutputTokens: maxTokens,
    largestComponent: Object.keys(components).reduce((largest, key) => components[key] > components[largest] ? key : largest, 'system'),
    overByTokens: Math.max(0, estimatedInputTokens + 4096 + maxTokens - contextWindow),
    fits: estimatedInputTokens + 4096 + maxTokens <= contextWindow };
}
