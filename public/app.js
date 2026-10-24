(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const briefFields = ['request', 'brand', 'goal', 'references', 'venue', 'budget', 'mustKeep', 'avoid'];
  const state = { project: null, config: null, pending: false, pollToken: 0, messageCount: 0, draftConceptId: null, pendingFeedback: null };
  let modeChosen = false;
  const storageKey = 'art-current-project';
  const creationStorageKey = 'art-pending-creation';
  const demo = {
    request: 'Synthetic demo: design a pop-up for the fictional sneaker brand Weiding. Visitors should understand the new everyday shoe by taking part and trying it on. Compare two substantively different ways to participate. Music and film preferences are research signals, not a real audience profile.',
    brand: 'Weiding · fictional sneaker brand (demo input)',
    goal: 'Let visitors understand the new shoe by experiencing it. Keep the try-on.',
    references: ['independent music', 'film narrative'],
    venue: 'Shanghai, about 150 square meters indoors. The exact venue is not confirmed.',
    budget: '80,000–120,000 CNY; client input, not a verified quote',
    mustKeep: 'try-on',
    avoid: 'forced signup, and unconfirmed claims about rights or results'
  };
  const phaseLabels = {
    created: 'The project is saved and ready to start',
    busy: 'The agent is working',
    needs_input: 'One condition still needs you',
    ready: 'Two concepts are ready to compare',
    revision_pending: 'A change is waiting for your review',
    revision_needs_input: 'One condition must be confirmed before the change',
    revision_conflict: 'The change conflicts with an existing condition',
    interrupted: 'The last run was interrupted',
    insufficient_evidence: 'Not enough evidence. Stopping here.',
    error: 'This round did not finish'
  };
  const unknown = '<span class="unknown-note">Unknown · not returned</span>';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const list = (value) => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const asText = (value) => typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value ?? '');
  const nonempty = (value) => value != null && asText(value).trim() !== '';
  const display = (value) => nonempty(value) ? esc(asText(value)) : unknown;
  // Polling re-renders often; identical markup must not restart entrance animations or reset inputs.
  const rendered = new WeakMap();
  const setHTML = (element, markup) => {
    if (rendered.get(element) === markup) return;
    rendered.set(element, markup);
    element.innerHTML = markup;
  };
  const organizationLabels = { collective_scheduled: 'Group · scheduled', individual_self_paced: 'Individual · own pace', paired_45_minute_collaboration: 'Pair · 45 minutes' };
  const toolLabels = { qloo_recommend: 'Look up cultural associations', qloo_describe: 'Look up an entity description', read_project_evidence: 'Read saved evidence', propose_design_response: 'Submit a design proposal', propose_concept_revision: 'Propose a partial change' };
  const entityTypes = { artist: 'artist', movie: 'movie', tv_show: 'series', book: 'book', brand: 'brand', place: 'place', destination: 'destination', person: 'person', actor: 'actor', director: 'director', podcast: 'podcast', video_game: 'game', album: 'album', author: 'author' };
  const pendingRevision = (project) => list(project?.revisions).findLast((revision) => revision.status === 'pending');
  const production = () => state.config?.production === true;
  const isCase = (project = state.project) => project?.provenance?.kind === 'completed_case';
  const readOnly = (project = state.project) => isCase(project) || (state.config?.production !== false && project && project.mode !== 'live');
  const isBusy = () => state.pending || (!readOnly() && (state.project?.status?.phase === 'busy' || state.project?.revisionRequest?.status === 'running'));
  const conceptLetter = (project, id) => {
    const index = list(project.concepts).findIndex((concept) => concept.id === id);
    return index < 0 ? 'Unknown concept' : `Concept ${String.fromCharCode(65 + index)}`;
  };

  function rememberProject(project) {
    if (isCase(project)) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('case');
    url.searchParams.delete('new');
    url.searchParams.set('project', project.id);
    history.replaceState(null, '', url);
    try { localStorage.setItem(storageKey, project.id); } catch { /* URL restoration still works without local storage. */ }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('The service did not return a readable project record.'); }
    if (!response.ok) {
      const error = result?.error;
      throw Object.assign(new Error(typeof error === 'string' ? error : error?.message || result?.message || `The request did not finish (${response.status}).`), {
        status: response.status, code: result?.code || error?.code, path: result?.path || error?.path
      });
    }
    return result;
  }

  function showError(message, retry) {
    const area = $('connection-error');
    area.replaceChildren();
    if (!message) { area.hidden = true; return; }
    const text = document.createElement('span');
    text.textContent = message;
    area.append(text);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Read again';
      button.addEventListener('click', retry);
      area.append(button);
    }
    area.hidden = false;
  }

  function updateControls() {
    const busy = isBusy();
    const selected = list(state.project?.concepts).find((concept) => concept.id === state.project?.selectedConceptId);
    const pending = pendingRevision(state.project);
    const needsSelection = list(state.project?.concepts).length > 0 && !selected;
    const liveAvailable = Boolean(state.config?.modes?.live?.available);
    const viewOnly = readOnly();
    const generationUnavailable = viewOnly || (state.project?.mode === 'live' && !liveAvailable);
    const awaitingStart = state.project?.status?.phase === 'created';
    $('create-project').disabled = isCase() || busy || ($('mode').value === 'live' && !liveAvailable);
    $('start-project').hidden = !awaitingStart || viewOnly;
    $('start-project').disabled = busy || generationUnavailable;
    $('send-message').disabled = busy || !state.project || awaitingStart || Boolean(pending) || needsSelection || generationUnavailable;
    $('message').disabled = busy || !state.project || awaitingStart || Boolean(pending) || needsSelection || generationUnavailable;
    $('mode').disabled = busy;
    $('load-demo').disabled = busy;
    $('load-ambiguous').disabled = busy;
    $('create-project').firstElementChild.textContent = busy ? 'Research in progress…' : state.project ? 'Start a new project from this input' : 'Start research';
    $('message').placeholder = !state.project ? 'Start a project before continuing the conversation' : busy ? 'Wait for the current action to finish…' : viewOnly ? 'This saved record is read only.' : generationUnavailable ? 'Live research is unavailable. You can still read saved work and review a pending draft.' : pending ? 'Send feedback under the pending draft on the right to revise it' : needsSelection ? 'Choose A or B on the board before proposing a change' : selected ? 'Change the selected concept, or use the revision box on the right' : 'Add a condition, or say what to research next';
    $('revision-text').disabled = busy || !selected || Boolean(pending) || generationUnavailable;
    $('submit-revision').disabled = busy || !selected || Boolean(pending) || generationUnavailable;
    $('revision-note').textContent = viewOnly ? 'This saved record is read only. Create a separate live project to continue.' : generationUnavailable ? 'Live research is unavailable, so a new change cannot be generated. Confirmed content can still be read. When service returns, a change still needs your review.' : 'A change becomes a pending proposal first. It is written into the confirmed version only when you accept it.';
    $('submit-revision').firstElementChild.textContent = busy ? 'Preparing the pending change…' : state.project?.revisionRequest?.status === 'needs_input' ? 'Add the answer and continue' : 'Propose a change';
    document.querySelectorAll('[data-select-concept]').forEach((button) => {
      button.disabled = busy || viewOnly || Boolean(pending && pending.targetConceptId !== button.dataset.selectConcept);
    });
    const lockedFields = list(state.project?.lockedFields);
    document.querySelectorAll('[data-revision-decision]').forEach((button) => {
      button.disabled = busy || viewOnly || (button.dataset.revisionDecision === 'accept' && (pending?.baseVersion !== state.project?.version || pending?.targetConceptId !== selected?.id
        || list(pending?.changes).some((change) => lockedFields.includes(change.field))));
    });
    document.querySelectorAll('[data-lock-field]').forEach((button) => {
      button.disabled = busy || viewOnly || state.project?.revisionRequest?.status === 'running';
    });
    document.querySelectorAll('[data-reference-choice]').forEach((button) => {
      button.disabled = busy || generationUnavailable;
    });
    const feedbackText = $('pending-feedback-text');
    if (feedbackText) {
      const stale = pending?.baseVersion !== state.project?.version || pending?.targetConceptId !== selected?.id;
      feedbackText.disabled = busy || stale || generationUnavailable;
      $('submit-pending-feedback').disabled = busy || stale || generationUnavailable;
      $('pending-feedback-note').textContent = viewOnly ? 'This saved record is read only. Review decisions and feedback cannot change it.' : generationUnavailable ? 'Live research is unavailable. After you check the version and selection, you can accept or reject the pending draft. A feedback revision cannot be generated now.' : `Feedback goes to the ${state.project?.mode === 'offline' ? 'offline simulation' : 'model'} to revise draft ${pending?.revisionNumber || 1}. The confirmed version and the original draft stay until you review the new draft.`;
      $('submit-pending-feedback').firstElementChild.textContent = busy ? 'Revising from your feedback…' : 'Send feedback and revise the draft';
      $('pending-feedback-form').setAttribute('aria-busy', String(busy));
    }
    $('export-proposal').hidden = !list(state.project?.concepts).length;
    $('export-proposal').disabled = busy;
    $('proposal-board').setAttribute('aria-busy', String(busy));
    $('create-note').textContent = state.project ? 'This starts a separate project. Answer questions in the conversation below.' : 'What you type is kept as client-provided information. It has not been independently verified.';
  }

  function updateMode() {
    if (production() || !state.config) $('mode').value = 'live';
    document.querySelectorAll('[data-development-control]').forEach(element => { element.hidden = state.config?.production !== false; });
    const boardMode = state.project?.mode || $('mode').value;
    const isOffline = boardMode === 'offline';
    const live = state.config?.modes?.live;
    const serviceLabel = !live ? 'Live service status is not confirmed yet' : !live.enabled ? 'Live service is off' : live.available ? 'Live service is on' : 'Live service is not ready';
    $('test-label').textContent = serviceLabel;
    $('mode-explanation').textContent = isCase() ? `Recorded completed case · read only. Recorded ${state.project?.provenance?.recordedAt || 'Unknown'}. No new requests run when viewing it.`
      : readOnly() ? 'This saved synthetic project is read only. You can read or export it, or start a separate live project.'
      : isOffline ? 'Offline simulation: synthetic data walks through the flow and does not call a live service.'
      : state.project ? `Saved project from live generation.${live?.available ? '' : ' Live service is unavailable. You can still read the work and review a pending draft.'}` : 'This will call the live model and Qloo cultural data.';
    const option = $('mode').querySelector('option[value="live"]');
    option.disabled = !live?.available;
    option.textContent = live?.available ? 'Live research · model + Qloo' : serviceLabel;
    document.body?.setAttribute('data-mode', boardMode);
    document.body?.setAttribute('data-service', live?.available ? 'on' : 'off');
    updateControls();
  }

  async function loadConfig() {
    try {
      state.config = await api('/api/config');
    } catch (error) {
      state.config = null;
      showError(error.message, loadConfig);
    }
    if (!state.project && !modeChosen) $('mode').value = production() || !state.config || state.config.modes?.live?.available ? 'live' : 'offline';
    if (production() && !isCase() && !state.config.modes?.live?.available)
      showError(`Live generation is unavailable: ${state.config.modes?.live?.enabled ? 'required provider configuration is missing' : 'the live service is disabled'}. Saved projects remain readable. Try again when service is available.`, loadConfig);
    if (state.project) renderProject(state.project); else updateMode();
  }

  function fillBrief(values) {
    briefFields.forEach((field) => { $(field).value = list(values?.[field]).map(asText).join('; '); });
    updateOptionalCount();
  }

  function updateOptionalCount() {
    const count = briefFields.slice(1).filter((field) => $(field).value.trim()).length;
    $('optional-count').textContent = count ? `${count} added` : 'All of these can stay empty';
  }

  function sourceMarkup(source) {
    if (typeof source !== 'string') return display(source);
    if (/^local:/.test(source)) return 'Local demo data';
    try {
      const url = new URL(source);
      if (['https:', 'http:'].includes(url.protocol)) return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a>`;
    } catch { /* A source may be a label rather than a URL. */ }
    return esc(source);
  }

  function formatTime(value) {
    if (!nonempty(value)) return unknown;
    const date = new Date(value);
    return esc(Number.isNaN(date.getTime()) ? asText(value) : date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
  }

  function renderContext(project) {
    const brief = project.brief || {};
    const rows = [['Activity goal', brief.goal], ['City / venue', brief.venue], ['Budget · client input', brief.budget], ['Must keep', brief.mustKeep], ['Do not / avoid', brief.avoid], ['Cultural references · unverified signals', brief.references]];
    setHTML($('project-context'), `<details class="context-disclosure" data-key="context-${esc(project.id)}"><summary><strong>Brief and limits</strong><span>${list(brief.mustKeep).length ? `Must keep: ${esc(list(brief.mustKeep).join(' · '))}` : 'See the client input and open conditions'}</span></summary><section class="context-card" aria-label="Current project brief"><div class="context-lead"><span class="eyebrow">Provided by the client · not independently verified</span><p>${display(brief.request)}</p></div><dl class="context-grid">${rows.map(([name, value]) => `<div class="context-item ${nonempty(value) ? '' : 'unknown'}"><dt>${esc(name)}</dt><dd>${nonempty(value) ? esc(list(value).map(asText).join('; ')) : 'Unknown / to be confirmed'}</dd></div>`).join('')}</dl></section></details>`);
  }

  function renderMessages(project) {
    const messages = list(project.messages);
    const roles = { user: 'You · client input', assistant: 'Agent', tool: 'Tool result', system: 'Project record' };
    const messageMarkup = (message) => `<article class="message message-${message.role === 'user' ? 'user' : 'assistant'}"><p class="message-role">${esc(roles[message.role] || 'Project record')}</p><p class="message-text">${esc(message.text || message.content || '')}</p></article>`;
    setHTML($('messages'), messages.length ? `<div class="latest-message"><span class="eyebrow">${esc(roles[messages.at(-1).role] || 'Project record')} · latest</span><p class="message-preview">${esc(messages.at(-1).text || messages.at(-1).content || '')}</p></div><details class="conversation-history" data-key="conversation-history"><summary>Full conversation <span>${messages.length}</span></summary><div class="history-log">${messages.map(messageMarkup).join('')}</div></details>` : isCase(project) ? '<p class="empty-chat">Recorded case. The original private conversation is not included, and no live conversation is running.</p>' : '<p class="empty-chat">The agent is reading the brief.</p>');
    if (messages.length !== state.messageCount) $('messages').scrollTop = $('messages').scrollHeight;
    state.messageCount = messages.length;
    $('session-label').textContent = isCase(project) ? 'Recorded case · read only' : 'Same project';
  }

  function renderActions(project) {
    const actions = list(project.actions);
    $('action-count').textContent = String(actions.length);
    const statusLabels = { running: 'In progress', done: 'Done', error: 'Not finished' };
    const markup = (action) => {
      const tool = action.type === 'tool';
      const name = tool ? toolLabels[action.label] || (/^qloo_/.test(action.label || '') ? 'Cultural data query' : 'Tool call') : action.label || 'Action';
      const detail = tool ? action.status === 'error' ? 'It did not succeed and was not used as evidence.' : '' : action.detail;
      const time = action.time ? new Date(action.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      return `<li class="action-${esc(action.status || 'done')}"><p class="action-name">${esc(name)}</p>${nonempty(detail) ? `<p class="action-detail">${esc(asText(detail))}</p>` : ''}<p class="action-meta">${esc([statusLabels[action.status] || 'Done', time].filter(Boolean).join(' · '))}</p></li>`;
    };
    setHTML($('actions'), actions.length ? actions.map(markup).join('') : isCase(project) ? '<li class="empty-activity">Private runtime logs are not part of this recorded snapshot.</li>' : '<li class="empty-activity">No activity yet.</li>');
  }

  function renderQuestions(project) {
    const reference = list(project.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    const questions = list(project.questions);
    const panel = $('questions-panel');
    if (reference) {
      panel.hidden = false;
      setHTML(panel, `<h3 id="questions-heading">Which one did you mean</h3><p>${esc(reference.originalInput)}</p><p>${reference.synthetic ? 'These are simulated demo candidates. ' : 'These candidates came back from Qloo. '}Nothing is confirmed until you choose.</p>${reference.candidates.map(candidate => `<article class="reference-candidate"><h4>${esc(candidate.name)}</h4><p>${esc(entityTypeLabel(candidate.type) || 'Unknown type')} · ${nonempty(candidate.release_year) ? esc(candidate.release_year) : 'Year unknown'}</p>${candidate.description ? `<p>${esc(candidate.description)}</p>` : ''}<button type="button" data-reference-choice="${esc(candidate.id)}" ${isBusy() ? 'disabled' : ''}>Choose this entity</button></article>`).join('')}<p>${reference.status === 'needs_details' ? 'This reference is still unresolved. Add a name, type, year, or creator.' : 'Only an explicit choice among the current candidates is recorded as your confirmation.'}Recommendations and the final design stay paused until then.</p>${reference.status === 'pending' ? '<button type="button" data-reference-cancel>Cancel the choice and add detail</button>' : ''}<form id="reference-details-form"><label for="reference-details">Add or correct this reference</label><textarea id="reference-details" rows="2" required></textarea><button type="submit">Add detail and check again</button></form>`);
      return;
    }
    panel.hidden = questions.length === 0;
    const question = questions[0];
    const fieldLabel = { request: 'Original request', brand: 'Brand', goal: 'Goal', references: 'Cultural references', venue: 'City and venue', budget: 'Budget', mustKeep: 'Must-keep items', avoid: 'Avoid items' }[question?.field];
    const value = project.brief?.[question?.field];
    const targets = question?.field === 'request' ? '<label for="clarification-update-field">Which condition this answer changes</label><select id="clarification-update-field"><option value="request">Add to or revise the original request</option><option value="venue">City and venue</option><option value="budget">Budget</option><option value="mustKeep">Must-keep items</option><option value="avoid">Avoid items</option></select>' : '';
    setHTML(panel, questions.length ? `<h3 id="questions-heading">Confirm this next</h3><ul>${questions.map((question) => `<li>${esc(typeof question === 'string' ? question : question.text)}</li>`).join('')}</ul><p>Answer in the conversation on the left. The original request and existing conditions stay.</p>${fieldLabel ? `<details><summary>This answer includes an explicit change</summary><label><input id="clarification-revise" type="checkbox">${question.field === 'request' ? 'Record this answer as an explicit change to the original request. Keep the original text and conditions you did not mention.' : `Explicitly update ${fieldLabel}, replacing the current value with the complete value below`}</label>${targets}<label id="clarification-value-label" for="clarification-value"${targets ? ' hidden' : ''}>Updated ${fieldLabel}${Array.isArray(value) ? ' (one item per line; empty means these items are explicitly removed)' : ''}</label><textarea id="clarification-value" rows="3"${targets ? ' hidden' : ''}>${targets ? '' : esc(Array.isArray(value) ? value.join('\n') : value)}</textarea></details>` : ''}` : '');
  }

  function entityTypeLabel(type) {
    if (typeof type !== 'string' || /^synthetic:/.test(type)) return '';
    const key = type.replace(/^urn:entity:/, '');
    return entityTypes[key] || key.replace(/_/g, ' ');
  }

  function entityMarkup(entity) {
    const type = entityTypeLabel(entity.type);
    return `<li><span class="entity-name">${display(entity.name)}</span>${entity.synthetic ? '<span class="entity-type synthetic">Synthetic</span>' : type ? `<span class="entity-type">${esc(type)}</span>` : ''}</li>`;
  }

  function evidenceContext(item) {
    const known = value => typeof value === 'string' && value.trim() && !/^(unknown|未知)$/i.test(value.trim()) ? value : 'Unknown';
    const input = item.query?.input;
    const fields = ['entity', 'type', 'signals', 'target_type', 'limit', 'signal_location', 'filter_location',
      'signal_tags', 'signal_tags_operator', 'demographic', 'include_tags', 'include_tags_operator',
      'exclude_tags', 'exclude_tags_operator', 'explain'];
    const scalar = value => ['string', 'number', 'boolean'].includes(typeof value);
    const queryInput = input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field,
        scalar(input[field]) || (Array.isArray(input[field]) && input[field].every(scalar)) ? input[field] : 'Unknown'])) : {};
    const filter = known(typeof input?.filter_location === 'string' && input.filter_location.trim()
      ? input.filter_location : item.context?.geographicFilter);
    const notApplied = ['Not applied', 'Not applied; venue text is not an applied geographic filter',
      '未应用', '未应用；场地文字不等于适用地理筛选'].includes(filter);
    const requestRef = typeof item.requestRef === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(item.requestRef)
      ? item.requestRef : 'Unknown';
    return [
      ['Workflow / operation', known(item.query?.workflow ?? item.query?.operation)],
      ['Safe request reference', requestRef],
      ['Query time', typeof item.queriedAt === 'string' && !Number.isNaN(Date.parse(item.queriedAt)) ? item.queriedAt : 'Unknown'],
      ['Venue', known(item.context?.venue)],
      ['Geographic filter', notApplied ? 'Not applied' : filter === 'Unknown' ? 'Unknown' : `Applied: ${filter}`],
      ['Reference / resolution status', known(item.context?.referenceStatus)],
      ['Query input', Object.keys(queryInput).length ? JSON.stringify(queryInput) : 'Unknown'],
    ];
  }

  function renderEvidence(project) {
    const evidence = list(project.evidence);
    const historical = evidence.filter((item) => !item.synthetic && project.mode === 'offline').length;
    $('evidence-count').textContent = evidence.length ? `${evidence.length}${historical ? ` · ${historical}  historical live evidence` : project.mode === 'offline' ? ' · synthetic data' : ''}` : 'No usable evidence yet';
    if (!evidence.length) {
      const blocked = ['insufficient_evidence', 'error'].includes(project.status?.phase);
      setHTML($('evidence'), `<div class="empty-evidence"><span class="empty-symbol" aria-hidden="true">${blocked ? '—' : '↳'}</span><div><strong>${blocked ? 'No evidence that can support a concept' : 'Confirm the input, then see what came back'}</strong><p>${blocked ? 'When a query fails or the result is irrelevant, the limits and activity stay. Cultural associations are not invented.' : 'Evidence shows the actual input, what came back, and the source. Missing content stays unknown.'}</p></div></div>`);
      return;
    }
    setHTML($('evidence'), evidence.map((item, index) => {
      const workflow = item.query?.workflow;
      const kind = workflow === 'describe' ? 'Entity description' : workflow === 'recommend' ? 'Cultural association' : 'Cultural research';
      const badge = item.synthetic ? 'Synthetic · not live evidence' : project.mode === 'offline' ? 'Earlier live evidence · not rechecked this round' : 'Returned by Qloo';
      const proxy = item.proxyConfirmation || item.context?.proxyConfirmation;
      return `<article class="evidence-card" id="evidence-${esc(item.id)}" aria-labelledby="evidence-title-${index}">
        <div class="evidence-card-header"><span class="evidence-index">${index + 1}</span><h4 class="evidence-title" id="evidence-title-${index}">${esc(item.title || `${kind} record`)}</h4><span class="evidence-badge${item.synthetic ? ' synthetic' : ''}">${badge}</span></div>
        <p class="evidence-query">${display(item.query?.designQuestion || (typeof item.query === 'string' ? item.query : 'Design question was not recorded'))}</p>
        <div class="evidence-body"><section class="evidence-block"><h5>Input</h5><ul class="entity-list">${list(item.inputReferences).length ? list(item.inputReferences).map(entityMarkup).join('') : `<li>${unknown}</li>`}</ul></section><section class="evidence-block"><h5>${kind} returned · ${list(item.returnedEntities).length}</h5><ul class="entity-list">${list(item.returnedEntities).length ? list(item.returnedEntities).map(entityMarkup).join('') : `<li>${unknown}</li>`}</ul></section></div>
        <div class="evidence-boundary"><span class="boundary-label">Boundary</span><span>${display(item.boundary)}</span></div>
        <dl class="evidence-meta"><div><dt>Source</dt><dd>${sourceMarkup(item.source)}</dd></div><div><dt>Queried</dt><dd>${formatTime(item.queriedAt)}</dd></div>${nonempty(proxy) ? `<div><dt>Proxy and confirmation</dt><dd>${esc(asText(proxy))}</dd></div>` : ''}</dl>
        <details class="evidence-detail" data-key="query-${esc(item.id)}"><summary>Query context</summary><dl class="evidence-meta">${evidenceContext(item).map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></details>
      </article>`;
    }).join(''));
  }

  function descriptionReferences(project, entityId) {
    const references = [];
    for (const card of list(project.evidence)) {
      const entity = list(card.returnedEntities).find((item) => (item.id ?? item.entity_id ?? item.entityId) === entityId);
      if (!entity) continue;
      const visit = (value, path = '') => {
        for (const [key, child] of Object.entries(value || {})) {
          const field = path ? `${path}.${key}` : key;
          if (typeof child === 'string' && /description|biography|synopsis|summary/i.test(key)) references.push({ card, field, value: child });
          else if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, field);
        }
      };
      visit(entity);
    }
    return references;
  }

  function savedReference(project, link) {
    const index = list(project.evidence).findIndex((item) => item.id === link.evidenceId);
    const card = list(project.evidence)[index];
    let value = list(card?.returnedEntities).find(entity => (entity.id ?? entity.entity_id) === link.entityId);
    let valid = Boolean(card && card.projectId === project.id && card.relevant !== false && value
      && typeof link.observedField === 'string' && link.observedField.trim());
    if (valid) for (const part of link.observedField.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) { valid = false; break; }
      value = value[part];
    }
    const exactValue = JSON.stringify(value);
    valid = valid && exactValue !== undefined && exactValue === JSON.stringify(link.observedValue);
    return { card, index, valid, exactValue: valid ? exactValue : null, label: !valid ? 'Unverified proposal statement'
      : card.synthetic ? 'Synthetic exact field · not live evidence' : 'Data fact · exact stored field' };
  }

  function referenceMarkup(project, link, key, compact = false) {
    const { card: target, index, valid, exactValue, label } = savedReference(project, link);
    const numeric = link.basis === 'affinity' || /affinity|popularity|score|rank|percentile/i.test(link.observedField || '');
    const description = link.basis === 'description' || (!numeric && /description|biography|synopsis|summary/i.test(link.observedField || ''));
    const basis = numeric ? 'Cultural association value' : description ? 'Entity description field' : 'Returned field';
    const supportingDescriptions = numeric && valid ? descriptionReferences(project, link.entityId) : [];
    const exact = valid ? `<div class="exact-evidence"><p class="trace-step fact"><span class="trace-label">${label}</span></p><p class="ref-field">Entity <code>${esc(link.entityId)}</code> · Field <code>${esc(link.observedField)}</code></p><pre class="exact-value">${esc(exactValue)}</pre></div>` : '';
    return `<div class="inference-item">
      ${target ? `<a class="evidence-link" href="#evidence-${esc(link.evidenceId)}">Evidence ${index + 1} · ${valid ? basis : 'record · claim unverified'} ↗</a>` : '<span class="unknown-note">Evidence reference unknown</span>'}
      ${compact && valid ? `<details class="evidence-detail" data-key="exact-${esc(key)}"><summary>Exact saved field and value</summary>${exact}</details>` : exact}
      <p class="trace-step"><span class="trace-label">${valid ? 'Proposal summary / interpretation' : label}</span>${display(link.observation)}</p>
      ${compact ? '' : `<p class="trace-step"><span class="trace-label">Design decision · proposal judgment</span>${display(link.inspiration)}</p>`}
      ${target?.synthetic ? `<p class="inference-warning">${display(target.boundary || 'Synthetic data; not live Qloo evidence or proof of effects.')}</p>` : ''}
      ${numeric ? '<p class="inference-warning">This is a numeric association. By itself it does not prove a story or a way of participating.</p>' : ''}
      ${!compact && !valid && nonempty(link.observedField) ? `<p class="ref-field">Unverified reference field <code>${esc(link.observedField)}</code></p>` : ''}
      ${!compact && supportingDescriptions.length ? `<details class="evidence-detail" data-key="description-${esc(key)}"><summary>Description of the same entity · not tied to this claim</summary><div class="evidence-detail-content">${supportingDescriptions.map((ref) => `<a class="evidence-link" href="#evidence-${esc(ref.card.id)}">Entity description ↗</a><p>${esc(ref.value)}</p>`).join('')}</div></details>` : ''}
    </div>`;
  }

  function referenceMarkdown(project, link, withJudgment = true) {
    const text = value => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : 'Unknown';
    const { card, index, valid, exactValue, label } = savedReference(project, link);
    const trace = card ? `[Evidence ${index + 1}](#evidence-${encodeURIComponent(card.id)})${valid
      ? ` · entity ${text(link.entityId)} · field ${text(link.observedField)}` : ' · record exists; claim unverified'}` : 'Unknown · no saved evidence link';
    const numeric = link.basis === 'affinity' || /affinity|popularity|score|rank|percentile/i.test(link.observedField || '');
    return `${valid ? `- ${label}\n  Source: ${trace}\n\n\`\`\`json\n${exactValue}\n\`\`\`\n- Proposal summary / interpretation: ${text(link.observation)}`
      : `- ${label}: ${text(link.observation)}\n  Source: ${trace}`}${withJudgment ? `\n- Design judgment: ${text(link.inspiration)}` : ''}${card?.synthetic
      ? `\n- Synthetic boundary: ${text(card.boundary || 'Synthetic data; not live Qloo evidence or proof of effects.')}` : ''}${numeric
      ? '\n- This is a numeric association. By itself it does not prove a story or a way of participating.' : ''}`;
  }

  function organizationText(value) {
    if (organizationLabels[value]) return organizationLabels[value];
    if (/双人/.test(value || '') && /角色交换/.test(value)) return 'Pair · role swap';
    if (/单人/.test(value || '') && /独立通关/.test(value)) return 'Individual · independent run';
    if (/[\u4e00-\u9fff]/.test(value || '')) {
      const first = value.split(/[：:＋+；;]/)[0];
      return first.length > 20 ? `${first.slice(0, 19)}…` : first;
    }
    return value || 'Participation is not confirmed';
  }

  function renderConcepts(project) {
    const concepts = list(project.concepts);
    if (!concepts.length) {
      const phase = project.status?.phase;
      if (['insufficient_evidence', 'error'].includes(phase)) {
        setHTML($('concepts'), phase === 'error'
          ? '<div class="no-concepts"><h4>Nothing to review this round</h4><p>See the note above and the activity on the left. Existing evidence and the brief were kept.</p></div>'
          : '<div class="no-concepts"><h4>Not enough evidence to propose concepts</h4><p>See the evidence boundary and open questions. Research is not invented.</p></div>');
      } else {
        setHTML($('concepts'), ['A', 'B'].map((letter) => `<article class="concept-placeholder"><span class="concept-letter">${letter}</span><h4>${letter === 'A' ? 'One way to participate' : 'Another way to meet the product'}</h4><p>${phase === 'needs_input' ? 'After the missing condition, research and concepts continue.' : 'The agent will propose concepts that can be reviewed from the current project record.'}</p><div class="placeholder-rule"></div><span>${phase === 'busy' ? 'Researching' : 'Waiting for a key condition'}</span></article>`).join(''));
      }
      return;
    }
    setHTML($('concepts'), concepts.map((concept, index) => {
      const links = list(concept.evidenceLinks);
      const validLinks = links.filter(link => savedReference(project, link).valid);
      const descriptiveOnly = links.length > 0 && validLinks.length === links.length && validLinks.every(link => savedReference(project, link).card.query?.workflow === 'describe');
      const draftNotice = descriptiveOnly ? '<p class="evidence-boundary"><strong>Discussion draft from an entity description · not audience-affinity evidence</strong></p>' : project.status?.phase === 'insufficient_evidence' ? `<p class="evidence-boundary"><strong>${validLinks.length ? 'Discussion draft with limited evidence' : 'Discussion draft without supporting evidence'}</strong></p>` : '';
      const organizationLabel = organizationText(concept.mechanism?.organization);
      const linkedEvidence = links.map((link, linkIndex) => referenceMarkup(project, link, `${concept.id}-${linkIndex}`)).join('');
      const selected = project.selectedConceptId === concept.id;
      return `<article class="concept-card ${selected ? 'concept-selected' : ''}" aria-labelledby="concept-title-${index}">
        <div class="concept-topline"><span class="concept-letter">${String.fromCharCode(65 + index)}</span><span class="concept-sheet-label">${selected ? 'Selected direction' : 'Concept direction'}<span class="mechanism-label">${esc(organizationLabel)}</span></span><span class="concept-state">${selected ? 'Selected' : ''}</span></div>
        <div class="concept-intro"><h4 class="concept-title" id="concept-title-${index}">${display(concept.title)}</h4>${draftNotice}</div>
        <div class="concept-select-row"><button type="button" class="select-concept ${selected ? 'selected' : ''}" data-select-concept="${esc(concept.id)}" aria-pressed="${selected}">${selected ? 'Selected · open the revision' : `Choose concept ${String.fromCharCode(65 + index)}`}<span aria-hidden="true">↗</span></button></div>
        <section class="concept-part concept-outcome"><h5 class="part-title">Cultural evidence</h5>${links.map((link, linkIndex) => referenceMarkup(project, link, `${concept.id}-main-${linkIndex}`, true)).join('') || '<p class="unknown-note">Unknown · no saved evidence link. The proposal is unverified.</p>'}</section>
        <section class="concept-part concept-outcome"><h5 class="part-title">Design decision · proposal judgment</h5>${links.map(link => `<p class="trace-step">${display(link.inspiration)}</p>`).join('')}<p class="mechanism-description">${display(concept.mechanism?.description)}</p><p class="concept-duration">Organization: ${display(organizationLabels[concept.mechanism?.organization] || concept.mechanism?.organization)}. This is a proposal judgment, not a design proved by Qloo.</p></section>
        <section class="concept-part concept-outcome"><h5 class="part-title">What visitors do</h5><ol class="journey">${list(concept.journey).map(step => `<li><span class="journey-stage">${display(step.stage)}</span><p class="journey-action">${display(step.action)}</p></li>`).join('') || `<li>${unknown}</li>`}</ol></section>
        <section class="concept-part concept-outcome"><h5 class="part-title">Product experience</h5><p class="mechanism-description"><span class="trace-label">Intended product understanding</span>${display(concept.coreClaim)}</p><ul class="touchpoint-list">${list(concept.productTouchpoints).map(contact => `<li>${display(contact)}</li>`).join('') || `<li>${unknown}</li>`}</ul><p class="concept-duration">This is an intended experience, not a demonstrated effect.</p></section>
        <details class="concept-full" data-key="full-${esc(concept.id)}"><summary>Read the full concept<span>Mechanism · journey · risks</span></summary>
          <section class="concept-part"><h5 class="part-title">Core claim</h5><p class="mechanism-description">${display(concept.coreClaim)}</p></section>
          <section class="concept-part"><h5 class="part-title">Participation mechanism</h5><p class="mechanism-description">${display(concept.mechanism?.description)}</p></section>
          <section class="concept-part"><h5 class="part-title">Participation and timing</h5><p class="mechanism-description">${display(organizationLabels[concept.mechanism?.organization] || concept.mechanism?.organization)}</p><p class="concept-duration">The timing is a proposal, not something that has been tried.</p></section>
          <section class="concept-part"><h5 class="part-title">How people meet the product</h5><ul class="touchpoint-list">${list(concept.productTouchpoints).length ? list(concept.productTouchpoints).map((touchpoint) => `<li>${display(touchpoint)}</li>`).join('') : `<li>${unknown}</li>`}</ul></section>
          <section class="concept-part"><h5 class="part-title">The journey from arrival to leaving</h5><ol class="journey">${list(concept.journey).length ? list(concept.journey).map((step) => `<li><span class="journey-stage">${esc(step.stage || 'Stage unknown')}</span><p class="journey-action">${display(step.action)}</p></li>`).join('') : `<li>${unknown}</li>`}</ol></section>
          <section class="concept-part concept-cautions"><h5 class="part-title">Key risks / still to confirm</h5><ul class="question-list">${list(concept.openQuestions).length ? list(concept.openQuestions).map((question) => `<li>${display(question)}</li>`).join('') : `<li>Not recorded. That does not mean it was verified.</li>`}</ul></section>
        </details>
        <details class="concept-part concept-detail" data-key="culture-${esc(concept.id)}"><summary>Cultural basis and design inference · ${links.length} citations</summary>${linkedEvidence || '<p class="unknown-note">Not enough evidence · no traceable design link yet.</p>'}<h5 class="effects-label">Unverified effects</h5><ul class="effects-list">${list(concept.unverifiedEffects).length ? list(concept.unverifiedEffects).map((effect) => `<li>${display(effect)}</li>`).join('') : '<li>Appeal, participation, and conversion are all unverified.</li>'}</ul></details>
      </article>`;
    }).join(''));
    $('concept-selection-label').textContent = project.selectedConceptId ? `${conceptLetter(project, project.selectedConceptId)} selected · v${project.version}` : 'Choose a direction to revise';
  }

  const revisionFields = {
    title: 'Concept name', coreClaim: 'Core claim', mechanism: 'Participation mechanism', journey: 'Experience journey',
    productTouchpoints: 'Product contact', evidenceLinks: 'Cultural basis and design inference', openQuestions: 'Open questions', unverifiedEffects: 'Unverified effects'
  };

  function fieldValueMarkup(project, field, value, key) {
    if (value === null || value === undefined) return '<p class="unknown-note">The saved record did not include this</p>';
    if (field === 'mechanism') return `<p class="diff-organization">${display(value.organization)}</p><p>${display(value.description)}</p>`;
    if (field === 'journey') return `<ol class="diff-list">${list(value).map((step) => `<li><strong>${display(step.stage)}</strong><p>${display(step.action)}</p></li>`).join('')}</ol>`;
    if (field === 'evidenceLinks') return list(value).length ? list(value).map((link, index) => referenceMarkup(project, link, `${key}-${index}`)).join('') : '<p>No recorded citation</p>';
    if (Array.isArray(value)) return value.length ? `<ul class="diff-list">${value.map((item) => `<li>${display(item)}</li>`).join('')}</ul>` : '<p>Empty list</p>';
    return `<p>${display(value)}</p>`;
  }

  function revisionDiffMarkup(project, changes, key, beforeLabel, afterLabel) {
    return `<div class="field-diffs">${list(changes).map((change, index) => `<article class="field-diff"><h5>${esc(revisionFields[change.field] || change.field)}</h5><div class="diff-columns"><section class="diff-before"><h6>${esc(beforeLabel)}</h6>${fieldValueMarkup(project, change.field, change.before, `${key}-${index}-before`)}</section><section class="diff-after"><h6>${esc(afterLabel)}</h6>${fieldValueMarkup(project, change.field, change.after, `${key}-${index}-after`)}</section></div><div class="diff-reason"><p><strong>Reason</strong>${display(change.reason)}</p>${list(change.evidenceRefs).length ? `<details class="evidence-detail" data-key="change-evidence-${esc(key)}-${index}"><summary>Check this evidence · ${change.evidenceRefs.length} citations</summary>${change.evidenceRefs.map((link, refIndex) => referenceMarkup(project, link, `${key}-${index}-ref-${refIndex}`)).join('')}</details>` : '<p class="unknown-note">This item cites no cultural evidence. Review it as a client request or a design inference.</p>'}</div></article>`).join('')}</div>`;
  }

  function revisionBoundariesMarkup(revision) {
    return `<div class="pending-boundaries"><section><h5>What this affects</h5><ul>${list(revision.impact).map((item) => `<li>${display(item)}</li>`).join('') || '<li>Not stated</li>'}</ul></section><section><h5>Still unknown</h5><ul>${list(revision.unknowns).map((item) => `<li>${display(item)}</li>`).join('') || '<li>Unrecorded does not mean verified</li>'}</ul></section></div>`;
  }

  function changeAfterSummary(change) {
    let value = change.after;
    if (change.field === 'mechanism') value = value?.description ?? value?.organization;
    else if (change.field === 'journey') value = list(value).map(step => `${step.stage || 'Unknown'}: ${step.action || 'Unknown'}`).join('; ');
    else if (change.field === 'evidenceLinks') value = `${list(value).length} recorded citation entries; check the full difference`;
    else if (Array.isArray(value)) value = value.join('; ');
    return typeof value === 'string' && value.trim() ? value.slice(0, 240) + (value.length > 240 ? '…' : '') : 'Not recorded';
  }

  function changeSummaryMarkup(revision) {
    return `<div class="change-summary"><h5>What changed</h5><ul>${list(revision.changes).map(change => `<li><strong>${esc(revisionFields[change.field] || change.field)}</strong>: ${esc(changeAfterSummary(change))}</li>`).join('') || '<li>No field differences were recorded.</li>'}</ul></div>`;
  }

  function currentRequirementsMarkup(project) {
    return `<div class="current-requirements"><h5>Still required · current client requirements</h5><ul>${list(project.brief?.mustKeep).map(item => `<li>${display(item)}</li>`).join('') || '<li>No must-keep items recorded.</li>'}</ul><h5>Current locks</h5><ul>${list(project.lockedFields).map(field => `<li>${esc(revisionFields[field] || field)}</li>`).join('') || '<li>No current locks recorded.</li>'}</ul><p class="form-note">These are current requirements and locks, not a claim that feasibility or effects have been verified.</p></div>`;
  }

  function renderRevision(project) {
    const selected = list(project.concepts).find((concept) => concept.id === project.selectedConceptId);
    const revisions = list(project.revisions);
    const pending = pendingRevision(project);
    const request = project.revisionRequest;
    const feedbackRecords = list(project.revisionFeedback);
    const parent = pending && revisions.find((revision) => revision.id === pending.parentRevisionId);
    const pendingNumber = pending?.revisionNumber || 1;
    const feedbackRequest = request?.kind === 'pending_feedback';
    const generationUnavailable = readOnly(project) || (project.mode === 'live' && !state.config?.modes?.live?.available);
    $('revision-workspace').hidden = !selected && !pending;
    $('revision-workspace').className = `revision-section${pending ? ' has-pending' : ''}`;
    $('revision-heading').textContent = pending ? 'You decide this change.' : generationUnavailable ? 'Selected direction and revision history' : 'Keep shaping this direction';
    $('revision-form').hidden = Boolean(pending);
    $('confirmed-version').textContent = `Confirmed v${project.version}`;
    $('revision-selection').textContent = selected ? `${conceptLetter(project, selected.id)} · ${selected.title}` : 'Select the concept this draft belongs to before accepting it.';
    const locked = list(project.lockedFields);
    const lockedChanges = list(pending?.changes).filter((change) => locked.includes(change.field));
    $('lock-panel').hidden = !selected;
    setHTML($('lock-panel'), selected ? `<p class="field-label">Lock confirmed content<span>Once locked, no draft can change this field</span></p><div class="lock-fields">${Object.entries(revisionFields).map(([field, label]) => `<button type="button" class="lock-field${locked.includes(field) ? ' locked' : ''}" data-lock-field="${esc(field)}" aria-pressed="${locked.includes(field)}"><span class="lock-icon" aria-hidden="true"></span>${esc(label)}</button>`).join('')}</div>` : '');
    $('offline-revision-controls').hidden = state.config?.production !== false || project.mode !== 'offline';
    if (state.draftConceptId !== project.selectedConceptId) {
      state.draftConceptId = project.selectedConceptId;
      $('revision-text').value = '';
    }

    const feedback = $('revision-feedback');
    feedback.hidden = true;
    feedback.className = 'revision-feedback';
    feedback.innerHTML = '';
    if (request && ['running', 'needs_input', 'conflict', 'interrupted', 'error'].includes(request.status)) {
      const labels = feedbackRequest
        ? { running: 'Revising the pending draft from your feedback', needs_input: 'One condition is still needed before revising the draft', conflict: 'This feedback conflicts with an existing condition', interrupted: 'The last feedback revision was interrupted', error: 'This feedback did not produce a new draft' }
        : { running: 'Preparing the pending change', needs_input: 'One condition still needs confirmation', conflict: 'The change conflicts with an existing condition', interrupted: 'The last change was interrupted', error: 'This change did not finish' };
      feedback.hidden = false;
      feedback.classList.add(request.status);
      feedback.innerHTML = `<strong>${labels[request.status]}</strong><p>${display(request.question || request.detail || 'Confirmed content stays unchanged.')}</p>${request.question && request.detail ? `<p>${display(request.detail)}</p>` : ''}<p class="form-note">${generationUnavailable && request.status !== 'running' ? `Live research is unavailable, so this cannot be retried now. Saved records can still be read${pending ? ', and you can review the pending draft below' : ''}.` : feedbackRequest ? request.status === 'running' ? 'The original pending draft stays. You cannot accept or reject it yet. The confirmed version is unchanged. Review the new draft after it succeeds.' : 'The original pending draft stays and the confirmed version is unchanged. You can adjust the feedback on that draft and try again.' : request.status === 'running' ? 'Waiting for the tool. Confirmed content stays unchanged.' : request.status === 'needs_input' ? 'Add the answer in the revision box above, then continue.' : 'Check the conditions and activity, then propose the change again. Nothing was written into the confirmed version automatically.'}</p>`;
    } else if (!pending && revisions.length && project.status?.phase === 'ready') {
      const latest = revisions.at(-1);
      if (['accepted', 'rejected'].includes(latest.status)) {
        feedback.hidden = false;
        feedback.innerHTML = latest.status === 'accepted'
          ? `<strong>Change accepted</strong><p>Confirmed content is now v${esc(latest.confirmedVersion ?? project.version)}. The concept card above shows the current confirmed content.</p>${changeSummaryMarkup(latest)}${currentRequirementsMarkup(project)}`
          : `<strong>Change rejected</strong><p>The confirmed version stays at v${esc(project.version)}. This pending change was not applied to the concept.</p>`;
      }
    }

    if (pending && (state.pendingFeedback?.projectId !== project.id || state.pendingFeedback?.revisionId !== pending.id)) {
      const failedFeedback = feedbackRecords.findLast((record) => record.sourceRevisionId === pending.id && ['error', 'needs_input', 'conflict', 'interrupted'].includes(record.status));
      state.pendingFeedback = { projectId: project.id, revisionId: pending.id, text: failedFeedback?.text || '', error: '' };
    }
    if (!pending) state.pendingFeedback = null;

    setHTML($('pending-review'), pending ? `<section class="pending-card" aria-labelledby="pending-heading">
      <div class="pending-header"><div><p class="eyebrow">${conceptLetter(project, pending.targetConceptId)} · based on confirmed v${esc(pending.baseVersion)}</p><h4 id="pending-heading">Pending change · draft ${esc(pendingNumber)}</h4></div><span class="evidence-badge">Not written into the confirmed version</span></div>
      ${pending.synthetic || project.mode === 'offline' ? '<p class="fixture-disclaimer">Demo mode: this is a preset revision. It shows the review flow. It does not mean a model understood your words.</p>' : ''}
      <p class="pending-summary">${display(pending.summary)}</p>
      <div class="change-summary"><span>This draft changes</span>${list(pending.changes).map((change) => `<span class="change-field${locked.includes(change.field) ? ' locked' : ''}">${locked.includes(change.field) ? 'Locked · ' : ''}${esc(revisionFields[change.field] || change.field)}</span>`).join('')}<strong>Confirmed v${esc(project.version)} stays unchanged</strong></div>
      ${lockedChanges.length ? `<p class="revision-feedback conflict">This draft changes locked fields: ${lockedChanges.map((change) => esc(revisionFields[change.field] || change.field)).join(', ')}. Unlock them above before accepting, or reject the draft and keep the confirmed version.</p>` : ''}
      <div class="review-actions"><button type="button" class="accept-revision" data-revision-decision="accept" data-revision-id="${esc(pending.id)}">Accept draft ${esc(pendingNumber)} and update the confirmed version</button><button type="button" class="reject-revision" data-revision-decision="reject" data-revision-id="${esc(pending.id)}">Reject and keep the confirmed version</button></div>
      <p class="pending-request"><span>Your requested change</span>${display(pending.request)}</p>
      <details class="review-comparison" data-key="review-comparison-${esc(pending.id)}"><summary><strong>Compare before and after</strong><span>${list(pending.changes).length} changes · ${list(pending.impact).length} effects · ${list(pending.unknowns).length} unknowns</span></summary><div class="comparison-body">
      ${parent ? `<div class="draft-lineage"><strong>This feedback revises draft ${esc(parent.revisionNumber || 1)} into draft ${esc(pendingNumber)}</strong><p>Your feedback: ${display(feedbackRecords.find((record) => record.id === pending.feedbackId)?.text || pending.request)}</p><p>The previous draft was replaced and kept in the history.</p></div><h5 class="diff-group-title">What this feedback changed · previous draft to new draft</h5>${revisionDiffMarkup(project, pending.draftDelta, `${pending.id}-draft`, `Before · draft ${parent.revisionNumber || 1}`, `After · draft ${pendingNumber}`)}<details class="consolidated-diff" data-key="consolidated-${esc(pending.id)}"><summary>What acceptance will write · confirmed v${esc(project.version)} to draft ${esc(pendingNumber)} (${list(pending.changes).length} changes)</summary><p class="form-note">Accepting applies every difference below, including changes kept from the earlier draft.</p>${revisionDiffMarkup(project, pending.changes, `${pending.id}-confirmed`, `Before · confirmed v${project.version}`, `After acceptance · draft ${pendingNumber}`)}</details>` : `<h5 class="diff-group-title">What acceptance will write · confirmed version to pending draft</h5>${revisionDiffMarkup(project, pending.changes, pending.id, `Before · confirmed v${project.version}`, 'After · pending acceptance')}`}
      ${revisionBoundariesMarkup(pending)}
      <p class="review-boundary">Format and citations were checked. Feasibility, budget, rights, and effects still need a separate check.</p>
      </div></details>
      ${pending.baseVersion !== project.version || pending.targetConceptId !== project.selectedConceptId ? '<p class="revision-feedback conflict">The confirmed version or the selected concept has changed. Read it again before accepting. This pending change cannot be accepted directly.</p>' : ''}
      <form class="pending-feedback-form" id="pending-feedback-form" data-revision-id="${esc(pending.id)}">
        <label class="field-label" for="pending-feedback-text">Not there yet? Send more feedback on this draft</label>
        <textarea id="pending-feedback-text" rows="3" aria-describedby="pending-feedback-note pending-feedback-error" placeholder="Say what in this draft should change, why, or what should stay.">${esc(state.pendingFeedback.text)}</textarea>
        <p class="form-note" id="pending-feedback-note">Feedback goes to the model to revise draft ${esc(pendingNumber)}. The confirmed version and the original draft stay until you review the new draft.</p>
        <p class="pending-feedback-error" id="pending-feedback-error" role="alert"${state.pendingFeedback.error ? '' : ' hidden'}>${esc(state.pendingFeedback.error)}</p>
        <button class="primary-button" id="submit-pending-feedback" type="submit"><span>Send feedback and revise the draft</span><span aria-hidden="true">↗</span></button>
      </form>
    </section>` : '');

    $('revision-history').hidden = revisions.length === 0;
    $('revision-count').textContent = String(revisions.length);
    setHTML($('revision-records'), [...revisions].reverse().map((revision) => `<article class="revision-record"><p><strong>${esc({ pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Replaced by a later draft' }[revision.status] || revision.status)}</strong> · draft ${esc(revision.revisionNumber || 1)} · ${conceptLetter(project, revision.targetConceptId)} · based on v${esc(revision.baseVersion)}${revision.confirmedVersion ? ` → v${esc(revision.confirmedVersion)}` : ''}</p><p>${display(revision.summary)}</p>${revision.status === 'accepted' ? changeSummaryMarkup(revision) : ''}${revision.parentRevisionId ? '<p>Revised from the previous draft using feedback. It was not approved automatically.</p>' : ''}<details class="evidence-detail" data-key="history-${esc(revision.id)}"><summary>See the change and its basis at the time</summary><p class="form-note">This is the record from that time. Accepting a change does not mean its effects were tried or that unknowns were resolved.</p>${revisionBoundariesMarkup(revision)}${revisionDiffMarkup(project, revision.changes, `history-${revision.id}`, `Confirmed then, v${revision.baseVersion}`, `Pending draft ${revision.revisionNumber || 1}`)}</details></article>`).join('') + (feedbackRecords.length ? `<h5 class="feedback-history-title">Feedback on pending drafts</h5>${[...feedbackRecords].reverse().map((record) => `<article class="revision-record"><p><strong>${esc({ running: 'Revising', completed: 'A new draft was created', error: 'Feedback failed', needs_input: 'A condition is needed', conflict: 'There is a conflict', interrupted: 'Interrupted' }[record.status] || record.status)}</strong> · on draft ${esc(record.sourceRevisionNumber || revisions.find((revision) => revision.id === record.sourceRevisionId)?.revisionNumber || 1)}</p><p>Your feedback: ${display(record.text)}</p>${record.detail || record.question ? `<p>${display(record.question || record.detail)}</p>` : ''}</article>`).join('')}` : ''));
  }

  // Exports confirmed content, pending drafts and evidence summaries; raw provider responses stay out.
  function proposalMarkdown(project) {
    const line = (value) => (value === null || value === undefined || value === '' ? 'Unknown'
      : typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/\s+/g, ' ').trim();
    const items = (values, empty = 'None') => list(values).length ? list(values).map((value) => `- ${line(value)}`).join('\n') : `- ${empty}`;
    const joined = (values, empty = 'Unknown') => list(values).map(line).join('; ') || empty;
    const entity = (item) => `${line(item.name)} (${line(item.id ?? item.entity_id ?? item.entityId)}${item.type ? ` · ${line(item.type)}` : ''})`;
    const fieldText = (field, value) => field === 'mechanism' ? `${line(value?.organization)} · ${line(value?.description)}`
      : field === 'journey' ? list(value).map(step => `${line(step.stage)}: ${line(step.action)}`).join('; ') || 'Unknown'
        : field === 'evidenceLinks' ? list(value).map(link => referenceMarkdown(project, link)).join('\n') || 'No recorded citation'
          : Array.isArray(value) ? joined(value, 'Empty list') : line(value);
    const changesText = revision => list(revision.changes).map(change => `- ${revisionFields[change.field] || change.field}\n  Before: ${fieldText(change.field, change.before)}\n  After: ${fieldText(change.field, change.after)}\n  Reason: ${line(change.reason)}\n  Change evidence references:\n${list(change.evidenceRefs).map(link => referenceMarkdown(project, link)).join('\n') || '  None recorded; this does not mean the change was verified.'}`).join('\n') || '- No field differences recorded';
    const brief = project.brief || {};
    const locked = list(project.lockedFields);
    const pending = pendingRevision(project);
    const status = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', superseded: 'Replaced by a later draft' };
    const sections = [
      `# TasteStage · ${line(brief.brand || 'Brand pop-up')} · early experience proposal`,
      `- Project: ${line(project.id)}\n- Confirmed version: v${line(project.version)}\n- Current status: ${line(phaseLabels[project.status?.phase])}\n- Mode: ${project.mode === 'offline' ? 'Offline simulation with synthetic fixtures. Not a live model or Qloo result.' : 'Live model and Qloo'}\n- Exported: ${new Date().toISOString()}\n- Nature: an early experience proposal, not a build plan. It does not guarantee budget, venue safety, rights, or results.`,
      `## Brief and limits (client-provided, not independently verified)\nOptional fields below show separately recorded details. Empty fields do not establish that the original request or clarifications contain no conditions.\n- Original request: ${line(brief.request)}\n- Brand / product: ${line(brief.brand)}\n- Activity goal: ${line(brief.goal)}\n- Cultural references (signals to research, not an audience profile): ${joined(brief.references)}\n- City / venue: ${line(brief.venue)}\n- Budget: ${line(brief.budget)}\n- Must keep: ${joined(brief.mustKeep, 'No items recorded here; review the original request and clarifications.')}\n- Do not / avoid: ${joined(brief.avoid, 'No items recorded here; review the original request and clarifications.')}`,
    ];
    if (isCase(project)) sections.splice(1, 0, `## Recorded completed case · read only\n- Recorded generation date: ${line(project.provenance.recordedAt)}\n- Accepted at: ${line(project.provenance.acceptedAt)}\n${line(project.provenance.description)}\n${line(project.provenance.presentationNote)}\n${line(project.provenance.scopeNote)}`);
    if (list(project.clarifications).length) sections.push(`## Clarifications\n${project.clarifications.map((record) => `- Question: ${line(record.question)}\n  Answer: ${line(record.answer)}`).join('\n')}`);
    sections.push(`## Open questions\n${items(list(project.questions).map((question) => typeof question === 'string' ? question : question.text))}`);
    list(project.concepts).forEach((concept, index) => {
      const selected = concept.id === project.selectedConceptId;
      const links = list(concept.evidenceLinks);
      const cultural = links.map(link => referenceMarkdown(project, link, false)).join('\n') || '- Unknown · no saved evidence link; the proposal is unverified.';
      sections.push([`## Concept ${String.fromCharCode(65 + index)} · ${line(concept.title)}${selected ? ' (selected)' : ''}`,
        selected && locked.length ? `Locked fields: ${locked.map((field) => revisionFields[field] || field).join(', ')}` : '',
        `**Cultural evidence**\n${cultural}`,
        `**Design decision · proposal judgment**\n${links.map(link => `- Design inference: ${line(link.inspiration)}`).join('\n')}\n- Participation decision: ${line(concept.mechanism?.description)}\n- Organization: ${line(organizationLabels[concept.mechanism?.organization] || concept.mechanism?.organization)}\n- This is a proposal judgment, not a design proved by Qloo.`,
        `**What visitors do**\n${list(concept.journey).map((step) => `- ${line(step.stage)}: ${line(step.action)}`).join('\n') || '- Unknown'}`,
        `**Product experience**\n- Intended product understanding: ${line(concept.coreClaim)}\n${items(concept.productTouchpoints)}\n- This is an intended experience, not a demonstrated effect.`,
        `**Open questions / risks**\n${items(concept.openQuestions)}`,
        `**Unverified effects**\n${items(concept.unverifiedEffects)}`].filter(Boolean).join('\n\n'));
    });
    if (pending) sections.push(`## Pending change (not written into the confirmed version)\n- Draft ${line(pending.revisionNumber || 1)} · ${conceptLetter(project, pending.targetConceptId)} · based on v${line(pending.baseVersion)}\n- Requested change: ${line(pending.request)}\n- Summary: ${line(pending.summary)}\n- Fields: ${list(pending.changes).map((change) => revisionFields[change.field] || change.field).join(', ')}\n### Recorded before, pending after and reasons\n${changesText(pending)}\n- Still unknown:\n${list(pending.unknowns).map((item) => `  - ${line(item)}`).join('\n') || '  - Not recorded'}`);
    const accepted = list(project.revisions).findLast(revision => revision.status === 'accepted');
    if (accepted) sections.push(`## What changed · accepted record for confirmed v${line(accepted.confirmedVersion)}\n${changesText(accepted)}\n### Still required · current client requirements\n${items(brief.mustKeep, 'No must-keep items recorded')}\n### Current locks\n${items(locked.map(field => revisionFields[field] || field), 'No current locks recorded')}\nThese are current requirements and locks, not a claim that feasibility or effects have been verified.`);
    sections.push(`## Version history\n${[...list(project.versionHistory).map((record) => `- v${line(record.version)} confirmed at ${line(record.confirmedAt)}${record.revisionId ? ', created from an accepted change' : ''}`),
      ...list(project.revisions).map((revision) => `- Draft ${line(revision.revisionNumber || 1)}: ${status[revision.status] || line(revision.status)}${revision.confirmedVersion ? ` → v${revision.confirmedVersion}` : ''} · ${line(revision.summary)}`)].join('\n') || '- None'}`);
    sections.push(`## Cultural evidence\n${list(project.evidence).map((item, index) => `<a id="evidence-${encodeURIComponent(item.id)}"></a>\n### Evidence ${index + 1}${item.synthetic ? ' (synthetic fixture, not live evidence)' : ''}\n- Evidence id: ${line(item.id)}\n- Query question: ${line(item.query?.designQuestion)}\n- Input entities: ${list(item.inputReferences).map(entity).join('; ') || 'Unknown'}\n- Returned entities: ${list(item.returnedEntities).map(entity).join('; ') || 'Unknown'}\n- Source: ${line(item.source)}\n${evidenceContext(item).map(([label, value]) => `- ${label}: ${line(value)}`).join('\n')}\n- Boundary: ${line(item.boundary)}`).join('\n\n') || 'No evidence yet'}`);
    sections.push('## Limits of use\n- Cultural affinity is only the association in this request. It is not an aesthetic score, a quality score, or an effect prediction.\n- This file does not include the raw Qloo response.');
    return `${sections.join('\n\n')}\n`;
  }

  function renderProject(project) {
    const openDetails = new Set([...document.querySelectorAll('details[data-key][open]')].map((element) => element.dataset.key));
    const changedProject = state.project?.id !== project.id;
    const versionChanged = !changedProject && state.project?.version !== project.version;
    state.project = project;
    $('brief-disclosure').hidden = isCase(project);
    $('view-completed-case').hidden = isCase(project);
    $('create-own-project').hidden = !isCase(project);
    $('case-provenance').hidden = !isCase(project);
    setHTML($('case-provenance'), isCase(project) ? `<h3>Recorded completed case · read only</h3><p>Recorded ${esc(project.provenance.recordedAt)} · accepted ${esc(project.provenance.acceptedAt)}</p><p>${display(project.provenance.description)}</p><p>${display(project.provenance.presentationNote)}</p><p>${display(project.provenance.scopeNote)}</p><a href="/?new=1">Create your own project ↗</a>` : '');
    document.body?.classList.add('has-project');
    if (changedProject) $('brief-disclosure').open = false;
    const phase = project.status?.phase || 'unknown';
    const pending = pendingRevision(project);
    const hasConcepts = list(project.concepts).length > 0;
    const generationUnavailable = readOnly(project) || (project.mode === 'live' && !state.config?.modes?.live?.available);
    const accepted = !pending && phase === 'ready' && list(project.revisions).at(-1)?.status === 'accepted';
    const next = pending ? ['#pending-review', 'Review the pending change'] : project.selectedConceptId
      ? generationUnavailable ? ['#concepts', 'View the confirmed proposal'] : ['#revision-workspace', 'Keep revising the selected direction'] : hasConcepts ? ['#concepts', 'Compare and choose a direction']
        : phase === 'needs_input' && !generationUnavailable ? ['#questions-panel', 'Add the missing condition'] : ['#evidence', 'Check the research basis'];
    const guidance = isCase(project) ? 'Read the recorded evidence, proposal judgments and accepted differences below. This read-only record is not a new generation or proof of effects.'
      : readOnly(project) ? 'This saved synthetic project is read only. Read or export it, or create a separate live project. Further synthetic generation is unavailable.'
      : pending ? 'Read the difference, then decide whether to update the confirmed version.'
      : phase === 'ready' ? project.selectedConceptId ? generationUnavailable ? 'The confirmed content and selected direction were kept. Live service is unavailable. You can still read the proposal, evidence, and revision history.' : 'The selected direction was kept. The next change will be pending first.' : 'Compare participation, product contact, and evidence, then choose a direction.'
        : phase === 'busy' ? 'The current request is being handled. Confirmed content stays unchanged.' : project.status?.detail;
    $('project-status').className = `project-status ${Object.keys(phaseLabels).includes(phase) ? phase : ''}`;
    setHTML($('project-status'), `<div class="status-overview"><span class="phase-mark" aria-hidden="true"></span><div class="status-copy"><strong>${esc(isCase(project) ? 'Recorded completed case · read only' : readOnly(project) ? 'Saved synthetic project · read only' : accepted ? `Change accepted · confirmed v${project.version}` : phaseLabels[phase] || 'Project status is not confirmed yet')}</strong><p>${display(guidance)}</p></div>${phase !== 'busy' ? `<a class="next-action" href="${next[0]}">${next[1]}<span aria-hidden="true">↗</span></a>` : '<span class="busy-caption">Please wait</span>'}</div>${project.provenance?.kind === 'historical_copy' ? '<p class="provenance-note">This reuses earlier live evidence and concepts. Nothing was queried again this round.</p>' : ''}${phase === 'busy' ? '<span class="busy-bar" aria-hidden="true"></span>' : ''}`);
    $('version-stamp').textContent = `v${project.version ?? '?'} confirmed`;
    if (versionChanged && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) $('version-stamp').animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.23,1,.32,1)' });
    $('board-heading').textContent = project.brief?.brand || 'Current project proposal';
    $('board-subtitle').textContent = project.brief?.goal || 'Compare design directions so every change can be reviewed.';
    renderContext(project);
    renderMessages(project);
    renderActions(project);
    renderQuestions(project);
    renderEvidence(project);
    renderConcepts(project);
    renderRevision(project);
    document.querySelectorAll('details[data-key]').forEach((element) => { if (openDetails.has(element.dataset.key)) element.open = true; });
    rememberProject(project);
    updateMode();
  }

  async function readProject(id, token) {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}`);
      if (token !== state.pollToken) return;
      renderProject(result.project);
      showError('');
      if (result.project.status?.phase === 'busy' || result.project.revisionRequest?.status === 'running') window.setTimeout(() => readProject(id, token), 850);
    } catch (error) {
      if (token !== state.pollToken) return;
      showError(`Reading the project was interrupted: ${error.message}`, () => readProject(id, token));
    }
  }

  function startPolling(project) {
    const token = ++state.pollToken;
    if (project.status?.phase === 'busy' || project.revisionRequest?.status === 'running') window.setTimeout(() => readProject(project.id, token), 650);
  }

  async function readCompletedCase() {
    try {
      const { project } = await api('/api/cases/completed');
      ++state.pollToken;
      renderProject(project);
      showError('');
    } catch (error) { showError(`The recorded case could not be read: ${error.message}`, readCompletedCase); }
  }

  async function projectAction(path, payload, failureLabel, onSuccess, onFailure) {
    if (!state.project || isBusy()) return;
    if (readOnly()) { showError('This saved record is read only. Create a separate live project to continue.'); return; }
    const projectId = state.project.id;
    state.pending = true;
    updateControls();
    showError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(projectId)}${path}`, { method: 'POST', body: JSON.stringify(payload) });
      if (onSuccess) onSuccess(result.project);
      renderProject(result.project);
      startPolling(result.project);
    } catch (error) {
      if (onFailure) onFailure(error);
      showError(`${failureLabel}: ${error.message}${error.status === 409 ? ' Check the latest project state and try again.' : ''}`, () => readProject(projectId, ++state.pollToken));
      if (error.status === 409) {
        try {
          const result = await api(`/api/projects/${encodeURIComponent(projectId)}`);
          renderProject(result.project);
          startPolling(result.project);
        } catch { /* Keep the original conflict visible until the user retries. */ }
      }
    } finally {
      state.pending = false;
      updateControls();
    }
  }

  function pendingCreation() {
    try { return JSON.parse(localStorage.getItem(creationStorageKey)); } catch { return null; }
  }

  async function startSavedProject() {
    await projectAction('/start', {}, 'The generation result is not confirmed. Read the saved project before continuing');
  }

  async function recoverCreation(start = false) {
    const pending = pendingCreation();
    if (!pending || state.pending) return;
    state.pending = true;
    updateControls();
    showError('');
    let created = false;
    try {
      const result = await api('/api/projects', { method: 'POST', body: JSON.stringify(pending) });
      state.messageCount = 0;
      renderProject(result.project);
      // Confirm the browser can read this identity before discarding its recovery secret.
      const saved = await api(`/api/projects/${encodeURIComponent(result.project.id)}`);
      renderProject(saved.project);
      localStorage.removeItem(creationStorageKey);
      created = true;
    } catch (error) {
      showError(`The creation result is not confirmed: ${error.message} The original request is kept for recovery.`, () => recoverCreation());
    } finally {
      state.pending = false;
      updateControls();
    }
    if (created && start && !readOnly() && state.project.status.phase === 'created') await startSavedProject();
    else if (created) startPolling(state.project);
  }

  $('load-demo').addEventListener('click', () => {
    if (state.config?.production !== false) return;
    fillBrief(demo);
    $('mode').value = 'offline';
    modeChosen = true;
    updateMode();
    $('request').focus();
  });
  $('questions-panel').addEventListener('click', event => {
    const button = event.target.closest('[data-reference-choice], [data-reference-cancel]');
    const record = list(state.project?.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    if (!button || !record || button.disabled) return;
    projectAction('/messages', { referenceResolution: { resolutionId: record.id, baseVersion: state.project.version,
      action: button.hasAttribute('data-reference-cancel') ? 'cancel' : 'confirm',
      ...(button.dataset.referenceChoice ? { selectedId: button.dataset.referenceChoice } : {}) } }, 'The entity choice was not received');
  });
  $('questions-panel').addEventListener('submit', event => {
    if (event.target.id !== 'reference-details-form') return;
    event.preventDefault();
    const record = list(state.project?.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    const text = $('reference-details').value.trim();
    if (!record || !text) return;
    projectAction('/messages', { referenceResolution: { resolutionId: record.id, baseVersion: state.project.version,
      action: 'clarify', text } }, 'The added detail was not received');
  });
  $('questions-panel').addEventListener('change', event => {
    if (event.target.id !== 'clarification-update-field') return;
    const field = event.target.value, value = state.project.brief[field];
    $('clarification-value').hidden = $('clarification-value-label').hidden = field === 'request';
    $('clarification-value').value = Array.isArray(value) ? value.join('\n') : value;
    $('clarification-value-label').textContent = `Updated ${event.target.selectedOptions[0].textContent}${Array.isArray(value) ? ' (one item per line; empty means these items are explicitly removed)' : ''}`;
  });
  $('load-ambiguous').addEventListener('click', () => {
    if (state.config?.production !== false) return;
    fillBrief({ ...demo, request: 'Synthetic demo: design a pop-up for the fictional sneaker brand Weiding. Keep the try-on, and use music and film as research signals. The city and venue are not decided. Confirm the condition that would change the proposal.', venue: '', budget: '' });
    $('mode').value = 'offline';
    modeChosen = true;
    updateMode();
    $('request').focus();
  });
  $('mode').addEventListener('change', () => { modeChosen = true; updateMode(); });
  $('offline-revision-fixture').addEventListener('change', () => {
    $('offline-revision-note').textContent = $('offline-revision-fixture').value
      ? 'Demo mode does not understand free text. A preset revision only shows the review flow.'
      : 'Without a preset, demo mode pauses and says why.';
  });
  $('concepts').addEventListener('click', (event) => {
    const button = event.target.closest('[data-select-concept]');
    if (!button || button.disabled || !state.project) return;
    projectAction('/select', { conceptId: button.dataset.selectConcept, baseVersion: state.project.version }, 'The concept was not selected', () => {
      window.setTimeout(() => { $('revision-workspace').scrollIntoView({ block: 'start' }); $('revision-text').focus({ preventScroll: true }); }, 0);
    });
  });
  $('export-proposal').addEventListener('click', () => {
    if (!state.project) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([proposalMarkdown(state.project)], { type: 'text/markdown;charset=utf-8' }));
    link.download = `tastestage-proposal-${state.project.id.slice(0, 8)}-v${state.project.version}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  $('lock-panel').addEventListener('click', (event) => {
    const button = event.target.closest('[data-lock-field]');
    if (!button || button.disabled || !state.project) return;
    projectAction('/locks', { baseVersion: state.project.version, field: button.dataset.lockField,
      locked: button.getAttribute('aria-pressed') !== 'true' }, 'The lock was not updated');
  });
  $('revision-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('revision-text').value.trim();
    if (!text) {
      $('revision-text').setAttribute('aria-invalid', 'true');
      $('revision-feedback').hidden = false;
      $('revision-feedback').className = 'revision-feedback needs_input';
      $('revision-feedback').textContent = 'Write what you want changed first.';
      $('revision-text').focus();
      return;
    }
    $('revision-text').removeAttribute('aria-invalid');
    if (!state.project?.selectedConceptId || pendingRevision(state.project)) return;
    const payload = { text, conceptId: state.project.selectedConceptId, baseVersion: state.project.version };
    if (state.project.mode === 'offline' && $('offline-revision-fixture').value) payload.offlineFixture = $('offline-revision-fixture').value;
    projectAction('/revisions', payload, 'The change request was not confirmed', () => { $('revision-text').value = ''; });
  });
  $('revision-text').addEventListener('input', () => {
    if ($('revision-text').getAttribute('aria-invalid') !== 'true') return;
    $('revision-text').removeAttribute('aria-invalid');
    $('revision-feedback').hidden = true;
  });
  $('pending-review').addEventListener('click', (event) => {
    const button = event.target.closest('[data-revision-decision]');
    if (!button || button.disabled || !state.project) return;
    projectAction(`/revisions/${encodeURIComponent(button.dataset.revisionId)}/${button.dataset.revisionDecision}`, { baseVersion: state.project.version }, 'The review decision did not finish');
  });
  $('pending-review').addEventListener('input', (event) => {
    if (event.target.id !== 'pending-feedback-text' || !state.pendingFeedback) return;
    state.pendingFeedback.text = event.target.value;
    state.pendingFeedback.error = '';
    event.target.removeAttribute('aria-invalid');
    $('pending-feedback-error').hidden = true;
  });
  $('pending-review').addEventListener('submit', (event) => {
    if (event.target.id !== 'pending-feedback-form') return;
    event.preventDefault();
    const pending = pendingRevision(state.project);
    if (!pending || isBusy() || event.target.dataset.revisionId !== pending.id) return;
    const text = $('pending-feedback-text').value;
    if (!text.trim()) {
      $('pending-feedback-text').setAttribute('aria-invalid', 'true');
      $('pending-feedback-error').textContent = 'Write feedback on this draft first.';
      $('pending-feedback-error').hidden = false;
      $('pending-feedback-text').focus();
      return;
    }
    state.pendingFeedback.text = text;
    state.pendingFeedback.error = '';
    $('pending-feedback-text').removeAttribute('aria-invalid');
    $('pending-feedback-error').hidden = true;
    projectAction(`/revisions/${encodeURIComponent(pending.id)}/feedback`, { baseVersion: state.project.version, text }, 'Feedback on the pending draft was not confirmed', null, (error) => {
      if (state.pendingFeedback?.revisionId !== pending.id) return;
      state.pendingFeedback.error = `Feedback was not confirmed: ${error.message}. The original draft is still here. Check it and try again.`;
      renderRevision(state.project);
    });
  });
  briefFields.slice(1).forEach((field) => $(field).addEventListener('input', updateOptionalCount));
  $('start-project').addEventListener('click', startSavedProject);
  $('brief-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isCase()) return;
    if (isBusy()) return;
    const brief = Object.fromEntries(briefFields.map((field) => [field, field === 'request' ? $(field).value : $(field).value.trim()]));
    if (!brief.request.trim()) { $('request').focus(); return; }
    if (pendingCreation()) {
      showError('An earlier creation result is still unconfirmed. Recover that saved request before starting a new project.', () => recoverCreation());
      return;
    }
    try {
      const creationKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(creationStorageKey, JSON.stringify({ creationKey, brief, mode: production() ? 'live' : $('mode').value,
        ...(production() ? {} : { scenario: 'sufficient' }) }));
    } catch (error) {
      showError(`The recovery request could not be saved: ${error.message} No creation request was sent.`);
      return;
    }
    await recoverCreation(true);
  });
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value;
    if (!text.trim() || !state.project || isBusy() || pendingRevision(state.project)) return;
    const selected = state.project.selectedConceptId;
    if (list(state.project.concepts).length && !selected) return;
    const payload = selected ? { text, conceptId: selected, baseVersion: state.project.version } : { text };
    const question = state.project.status.phase === 'needs_input' && state.project.questions?.length === 1 ? state.project.questions[0] : null;
    if (!selected && question && !list(state.project.referenceResolutions).some(record => ['pending', 'needs_details'].includes(record.status))) {
      payload.clarification = { questionId: question.id, baseVersion: state.project.version };
      if ($('clarification-revise')?.checked) {
        if (question.field === 'request') payload.clarification.reviseRequest = true;
        const field = question.field === 'request' ? $('clarification-update-field').value : question.field;
        if (field !== 'request') {
          const value = $('clarification-value').value;
          payload.briefUpdate = { field, value: ['references', 'mustKeep', 'avoid'].includes(field)
            ? value.split(/[\n,，;；]/).map(item => item.trim()).filter(Boolean) : value.trim() };
        }
      }
    }
    if (selected && state.project.mode === 'offline' && $('offline-revision-fixture').value) payload.offlineFixture = $('offline-revision-fixture').value;
    projectAction(selected ? '/revisions' : '/messages', payload, 'The reply was not sent', () => { $('message').value = ''; });
  });

  updateMode();
  loadConfig();
  const entry = new URL(window.location.href).searchParams;
  const caseRequested = entry.has('case');
  const newEntry = entry.get('new') === '1';
  let existingId = !caseRequested && !newEntry ? entry.get('project') : null;
  if (!caseRequested && !newEntry && !existingId) { try { existingId = localStorage.getItem(storageKey); } catch { /* A URL can still restore the project. */ } }
  if (caseRequested) {
    if (entry.get('case') === 'completed') readCompletedCase();
    else showError('This recorded case is not available. Create your own project or open the completed case.');
  } else if (pendingCreation()) {
    recoverCreation();
  } else if (existingId) {
    const token = ++state.pollToken;
    api(`/api/projects/${encodeURIComponent(existingId)}`).then(({ project }) => {
      if (token !== state.pollToken) return;
      fillBrief(project.brief);
      $('mode').value = project.mode === 'live' ? 'live' : 'offline';
      updateMode();
      renderProject(project);
      startPolling(project);
    }).catch((error) => showError(`The project could not be restored: ${error.message} The saved record was not replaced with an empty project.`, () => readProject(existingId, token)));
  }
})();
