(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const briefFields = ['request', 'brand', 'goal', 'references', 'venue', 'budget', 'mustKeep', 'avoid'];
  const state = { project: null, config: null, pending: false, pollToken: 0, messageCount: 0, draftConceptId: null, pendingFeedback: null };
  const storageKey = 'art-current-project';
  const demo = {
    request: '合成验收任务：为虚构运动鞋品牌「未定式」的新日常鞋款设计快闪。希望来访者通过身体参与和试穿理解产品，比较两种实质不同的参与方式。音乐、电影偏好只是待研究信号，不是真实受众画像。',
    brand: '未定式 · 虚构运动鞋品牌（演示输入）',
    goal: '让来访者通过体验理解新鞋款，保留试穿',
    references: '独立音乐、电影叙事；客户提供的研究信号，实体尚未核实',
    venue: '上海，室内约 150 平方米，具体场地未确认',
    budget: '8–12 万元；客户输入，未经报价验证',
    mustKeep: '试穿',
    avoid: '强制注册、未经确认的版权与效果承诺'
  };
  const phaseLabels = {
    busy: '智能体正在处理',
    needs_input: '需要你补充一个条件',
    ready: '两个概念已可比较',
    revision_pending: '修改已提出，等待你审查',
    revision_needs_input: '修改前还需要确认一个条件',
    revision_conflict: '修改与现有条件冲突',
    interrupted: '上次处理已中断',
    insufficient_evidence: '证据不足，先停在这里',
    error: '本轮未完成'
  };
  const unknown = '<span class="unknown-note">未知 · 未返回</span>';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const list = (value) => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const asText = (value) => typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value ?? '');
  const nonempty = (value) => value != null && asText(value).trim() !== '';
  const display = (value) => nonempty(value) ? esc(asText(value)) : unknown;
  const pendingRevision = (project) => list(project?.revisions).findLast((revision) => revision.status === 'pending');
  const isBusy = () => state.pending || state.project?.status?.phase === 'busy' || state.project?.revisionRequest?.status === 'running';
  const conceptLetter = (project, id) => {
    const index = list(project.concepts).findIndex((concept) => concept.id === id);
    return index < 0 ? '未知概念' : `概念 ${String.fromCharCode(65 + index)}`;
  };

  function rememberProject(project) {
    const url = new URL(window.location.href);
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
    try { result = await response.json(); } catch { throw new Error('服务没有返回可读取的项目记录。'); }
    if (!response.ok) {
      const error = result?.error;
      throw Object.assign(new Error(typeof error === 'string' ? error : error?.message || result?.message || `请求未完成（${response.status}）。`), {
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
      button.textContent = '重新读取';
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
    $('create-project').disabled = busy || ($('mode').value === 'live' && !liveAvailable);
    $('send-message').disabled = busy || !state.project || Boolean(pending) || needsSelection;
    $('message').disabled = busy || !state.project || Boolean(pending) || needsSelection;
    $('mode').disabled = busy;
    $('scenario').disabled = busy || $('mode').value !== 'offline';
    $('load-demo').disabled = busy;
    $('load-ambiguous').disabled = busy;
    $('create-project').firstElementChild.textContent = busy ? '研究进行中…' : state.project ? '以当前输入新建项目' : '开始研究';
    $('message').placeholder = !state.project ? '先开始一份项目，再继续对话' : busy ? '等待当前行动完成…' : pending ? '可在右侧待审稿下提交反馈，继续修订' : needsSelection ? '先在提案板选择 A 或 B，再提出修改' : selected ? '修改选定概念，也可使用右侧修改框' : '补充条件，或说明需要继续研究什么';
    $('revision-text').disabled = busy || !selected || Boolean(pending);
    $('submit-revision').disabled = busy || !selected || Boolean(pending);
    $('submit-revision').firstElementChild.textContent = busy ? '正在形成待审修改…' : state.project?.revisionRequest?.status === 'needs_input' ? '补充并继续' : '提出修改';
    document.querySelectorAll('[data-select-concept]').forEach((button) => {
      button.disabled = busy || Boolean(pending && pending.targetConceptId !== button.dataset.selectConcept);
    });
    document.querySelectorAll('[data-revision-decision]').forEach((button) => {
      button.disabled = busy || (button.dataset.revisionDecision === 'accept' && (pending?.baseVersion !== state.project?.version || pending?.targetConceptId !== selected?.id));
    });
    const feedbackText = $('pending-feedback-text');
    if (feedbackText) {
      const stale = pending?.baseVersion !== state.project?.version || pending?.targetConceptId !== selected?.id;
      feedbackText.disabled = busy || stale;
      $('submit-pending-feedback').disabled = busy || stale;
      $('submit-pending-feedback').firstElementChild.textContent = busy ? '正在按反馈修订…' : '提交反馈并修订待审稿';
      $('pending-feedback-form').setAttribute('aria-busy', String(busy));
    }
    $('proposal-board').setAttribute('aria-busy', String(busy));
    $('create-note').textContent = state.project ? '此处会新建独立项目；回答追问请使用下方对话。' : '输入会作为客户提供信息保留，未经独立核实。';
  }

  function updateMode() {
    const boardMode = state.project?.mode || $('mode').value;
    const isOffline = boardMode === 'offline';
    $('test-label').textContent = isOffline ? '离线流程验收' : '真实服务';
    $('mode-explanation').textContent = isOffline ? `${state.project ? '当前项目：' : ''}模拟模型；本轮不调用真实服务。证据可能为合成夹具或历史记录，请按卡片来源区分。` : `${state.project ? '当前项目：' : ''}使用模型与 Qloo 服务；请检查每张证据卡的实际来源。`;
    $('header-mode').textContent = isOffline ? '本地 · 合成验收' : '本地 · 真实服务';
    updateControls();
  }

  async function loadConfig() {
    try {
      const config = await api('/api/config');
      state.config = config;
      const live = config.modes?.live;
      const option = $('mode').querySelector('option[value="live"]');
      option.disabled = !live?.available;
      option.textContent = live?.available ? '真实模型与 Qloo' : '真实服务 · 未就绪';
      $('config-status').textContent = live?.available ? '真实服务已配置。当前仍使用你选择的运行方式。' : `真实模式未就绪${list(live?.missing).length ? ` · ${list(live.missing).length} 项必要服务配置缺失` : ''}。离线模式只用于行为与界面验收。`;
      updateControls();
    } catch (error) {
      $('config-status').textContent = '暂时无法读取服务配置；真实模式不可用。';
      showError(error.message, loadConfig);
    }
  }

  function fillBrief(values) {
    briefFields.forEach((field) => { $(field).value = list(values?.[field]).map(asText).join('；'); });
    updateOptionalCount();
  }

  function updateOptionalCount() {
    const count = briefFields.slice(1).filter((field) => $(field).value.trim()).length;
    $('optional-count').textContent = count ? `已补充 ${count} 项` : '都可以暂时留空';
  }

  function sourceMarkup(source) {
    if (typeof source !== 'string') return display(source);
    try {
      const url = new URL(source);
      if (['https:', 'http:'].includes(url.protocol)) return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source)}</a>`;
    } catch { /* A source may be a label rather than a URL. */ }
    return esc(source);
  }

  function renderContext(project) {
    const brief = project.brief || {};
    const rows = [['活动目标', brief.goal], ['城市 / 场地', brief.venue], ['预算 · 客户输入', brief.budget], ['必须保留', brief.mustKeep], ['禁止 / 避免', brief.avoid], ['文化参考 · 未验证信号', brief.references]];
    $('project-context').innerHTML = `<section class="context-card" aria-label="当前项目需求"><div class="context-lead"><span class="eyebrow">客户提供 · 未独立核实</span><strong>${display(brief.brand)}</strong><p>当前项目记录</p></div><dl class="context-grid">${rows.map(([name, value]) => `<div class="context-item ${nonempty(value) ? '' : 'unknown'}"><dt>${esc(name)}</dt><dd>${nonempty(value) ? esc(list(value).map(asText).join('；')) : '未知 / 待确认'}</dd></div>`).join('')}</dl></section>`;
  }

  function renderMessages(project) {
    const messages = list(project.messages);
    const roles = { user: '你 · 客户输入', assistant: '智能体', tool: '工具返回', system: '项目记录' };
    $('messages').innerHTML = messages.length ? messages.map((message) => `<article class="message message-${message.role === 'user' ? 'user' : 'assistant'}"><p class="message-role">${esc(roles[message.role] || '项目记录')}</p><p class="message-text">${esc(message.text || message.content || '')}</p></article>`).join('') : '<p class="empty-chat">智能体正在读取需求。</p>';
    if (messages.length !== state.messageCount) $('messages').scrollTop = $('messages').scrollHeight;
    state.messageCount = messages.length;
    $('session-label').textContent = '同一项目会话';
  }

  function renderActions(project) {
    const actions = list(project.actions);
    $('action-count').textContent = String(actions.length);
    $('actions').innerHTML = actions.length ? actions.map((action) => `<li><p class="action-name">${esc(action.label || action.type || '行动')}</p><p class="action-detail">${display(action.detail)}</p>${feedbackMarkup(action.feedback)}<p class="action-meta">${esc(action.status || '')}${action.time ? ` · ${esc(new Date(action.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}` : ''}</p></li>`).join('') : '<li class="empty-activity">尚无行动记录。</li>';
  }

  function feedbackMarkup(feedback) {
    if (!feedback) return '';
    const budget = feedback.remainingBudget;
    return `<p class="action-detail">${esc(feedback.code)}${feedback.path ? ` · ${esc(feedback.path)}` : ''}：${esc(feedback.reason)}${feedback.correctable ? ' · 参数可纠正' : ''}</p>${feedback.nextAction ? `<p class="action-detail">${esc(feedback.nextAction)}</p>` : ''}${budget ? `<p class="usage-line">剩余模型请求 ${esc(budget.modelHttpAttempts ?? '未知')} · 剩余 Qloo 请求 ${esc(budget.qlooHttpAttempts ?? '未知')}${budget.queryStopped ? ' · 本轮 Qloo 已停止' : ''}</p>` : ''}`;
  }

  function renderQuestions(project) {
    const reference = list(project.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    const questions = list(project.questions);
    const panel = $('questions-panel');
    if (reference) {
      panel.hidden = false;
      panel.innerHTML = `<h3 id="questions-heading">确认输入文化参考</h3><p>${esc(reference.originalInput)}</p><p>${reference.synthetic ? '以下是明确模拟返回，用于离线流程验收。' : '以下名称与区分字段来自实际工作流返回。'}尚未写入用户确认。</p>${reference.candidates.map(candidate => `<article class="reference-candidate"><h4>${esc(candidate.name)}</h4><p>类型：${display(candidate.type)} · 年份：${display(candidate.release_year)}</p>${candidate.description ? `<p>${esc(candidate.description)}</p>` : ''}<p class="entity-id">${esc(candidate.id)}</p><details><summary>查看实际候选字段</summary><pre class="raw-record">${esc(asText(candidate))}</pre></details><button type="button" data-reference-choice="${esc(candidate.id)}" ${isBusy() ? 'disabled' : ''}>选择此实体</button></article>`).join('')}<p>${reference.status === 'needs_details' ? '参考尚未解决，请补充名称、类型、年份或创作者。' : '只有明确选择当前候选才会写入用户确认。'}推荐与最终设计在此期间暂停。</p>${reference.status === 'pending' ? '<button type="button" data-reference-cancel>取消选择，补充信息</button>' : ''}<form id="reference-details-form"><label for="reference-details">补充或更正这个参考</label><textarea id="reference-details" rows="2" required></textarea><button type="submit">补充并重新核实</button></form>`;
      return;
    }
    panel.hidden = questions.length === 0;
    panel.innerHTML = questions.length ? `<h3 id="questions-heading">下一步需要确认</h3><ul>${questions.map((question) => `<li>${esc(typeof question === 'string' ? question : question.text)}</li>`).join('')}</ul><p>在左侧对话补充答案；智能体会继续当前项目。</p>` : '';
  }

  function entityMarkup(entity, showFields = false) {
    const entityId = [entity.id, entity.entity_id, entity.entityId].find(nonempty);
    return `<li><div class="entity-name">${display(entity.name)}${entity.type ? ` <span class="entity-id">/ ${esc(entity.type)}</span>` : ''}</div>${entity.synthetic ? '<span class="unknown-note">合成输入 · 非 Qloo 实体</span>' : ''}${showFields ? `<p class="entity-id">${nonempty(entityId) ? esc(entityId) : 'ID 未知'}</p><pre class="raw-record">${esc(asText(entity))}</pre>` : ''}</li>`;
  }

  function renderEvidence(project) {
    const evidence = list(project.evidence);
    const historical = evidence.filter((item) => !item.synthetic && project.mode === 'offline').length;
    $('evidence-count').textContent = evidence.length ? `${evidence.length} 张记录${historical ? ` · ${historical} 张历史真实证据` : project.mode === 'offline' ? ' · 合成夹具' : ''}` : '尚无可用证据';
    if (!evidence.length) {
      const blocked = ['insufficient_evidence', 'error'].includes(project.status?.phase);
      $('evidence').innerHTML = `<div class="empty-evidence"><span class="empty-symbol" aria-hidden="true">${blocked ? '—' : '↳'}</span><div><strong>${blocked ? '没有可用于概念的证据' : '先确认输入，再检查返回了什么'}</strong><p>${blocked ? '查询失败或结果不相关时，保留限制与行动记录，不补造文化关联。' : '证据会显示实际输入、返回字段与来源；缺失内容保留为未知。'}</p></div></div>`;
      return;
    }
    $('evidence').innerHTML = evidence.map((item, index) => {
      const workflow = item.query?.workflow;
      const kind = workflow === 'describe' ? '实体描述' : workflow === 'recommend' ? '文化关联' : '文化研究';
      const badge = item.synthetic ? '合成夹具 · 非真实证据' : project.mode === 'offline' ? '历史真实证据 · 本轮未复查' : '真实服务返回';
      return `<article class="evidence-card" id="evidence-${esc(item.id)}" aria-labelledby="evidence-title-${index}">
        <div class="evidence-card-header"><h4 class="evidence-title" id="evidence-title-${index}">${esc(item.title || `${kind}记录 ${index + 1}`)}</h4><span class="evidence-badge">${badge}</span></div>
        <p class="evidence-query">查询问题 · ${display(item.query?.designQuestion || (typeof item.query === 'string' ? item.query : '设计问题未记录'))}</p>
        <div class="evidence-body"><section class="evidence-block"><h5>实际输入实体</h5><ul class="entity-list">${list(item.inputReferences).length ? list(item.inputReferences).map((entity) => entityMarkup(entity)).join('') : `<li>${unknown}</li>`}</ul></section><section class="evidence-block"><h5>${kind}返回 · ${list(item.returnedEntities).length} 个实体</h5><ul class="entity-list">${list(item.returnedEntities).length ? list(item.returnedEntities).map((entity) => entityMarkup(entity)).join('') : `<li>${unknown}</li>`}</ul></section></div>
        <details class="evidence-detail" data-key="evidence-${esc(item.id)}"><summary>查看实际字段、请求引用与原始记录</summary><dl class="evidence-meta"><div><dt>来源</dt><dd>${sourceMarkup(item.source)}</dd></div><div><dt>安全请求引用</dt><dd>${display(item.requestRef)}</dd></div><div><dt>查询时间</dt><dd>${display(item.queriedAt)}</dd></div><div><dt>代理与确认记录</dt><dd>${display(item.proxyConfirmation || item.context?.proxyConfirmation)}</dd></div></dl><div class="evidence-detail-content">查询与地理上下文<pre class="raw-record">${esc(asText({ query: item.query, context: item.context }))}</pre><ul class="entity-list">${list(item.returnedEntities).map((entity) => entityMarkup(entity, true)).join('')}</ul><h5>保存的原始响应</h5><pre class="raw-record">${esc(asText(item.rawResult ?? '未保存原始响应'))}</pre></div></details>
        <div class="evidence-boundary"><span class="boundary-label">适用边界</span><span>${display(item.boundary)}</span></div>
      </article>`;
    }).join('');
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

  function referenceMarkup(project, link, key) {
    const index = list(project.evidence).findIndex((item) => item.id === link.evidenceId);
    const target = list(project.evidence)[index];
    const numeric = link.basis === 'affinity' || /affinity|popularity|score|rank|percentile/i.test(link.observedField || '');
    const description = link.basis === 'description' || (!numeric && /description|biography|synopsis|summary/i.test(link.observedField || ''));
    const basis = numeric ? '文化关联数值' : description ? '实体描述字段' : '实际返回字段';
    const supportingDescriptions = numeric ? descriptionReferences(project, link.entityId) : [];
    return `<div class="inference-item">
      ${target ? `<a class="evidence-link" href="#evidence-${esc(link.evidenceId)}">证据 ${index + 1} · ${basis} ↗</a>` : '<span class="unknown-note">证据引用未知</span>'}
      <p class="trace-step"><span class="trace-label">设计转译 · 推断</span>${display(link.inspiration)}</p>
      ${numeric ? '<p class="inference-warning">这条引用是数值关联，不能单独证明叙事、角色交换或参与机制成立。</p>' : ''}
      <details class="evidence-detail" data-key="reference-${esc(key)}"><summary>核对本条事实与精确引用</summary><div class="evidence-detail-content"><p>${display(link.observation)}</p><p>实体标识符：${display(link.entityId)}</p><p>实际字段：${display(link.observedField)}</p><pre class="raw-record">${esc(asText(link.observedValue))}</pre></div></details>
      ${supportingDescriptions.length ? `<details class="evidence-detail" data-key="description-${esc(key)}"><summary>另见同实体描述来源 · 尚未绑定到本条主张</summary><div class="evidence-detail-content"><p>以下为保存记录中的实际描述，供核对设计推断；没有自动改写原提案的引用。</p>${supportingDescriptions.map((ref) => `<a class="evidence-link" href="#evidence-${esc(ref.card.id)}">实体描述记录 ↗</a><p>${esc(ref.field)}</p><p>${esc(ref.value)}</p>`).join('')}</div></details>` : ''}
    </div>`;
  }

  function organizationText(value) {
    const labels = { collective_scheduled: '集体 · 定时参与', individual_self_paced: '个人 · 自主节奏', paired_45_minute_collaboration: '双人 · 45 分钟协作' };
    if (labels[value]) return labels[value];
    if (/双人/.test(value || '') && /角色交换/.test(value)) return '双人 · 角色交换';
    if (/单人/.test(value || '') && /独立通关/.test(value)) return '单人 · 独立通关';
    if (/[\u4e00-\u9fff]/.test(value || '')) {
      const first = value.split(/[：:＋+；;]/)[0];
      return first.length > 20 ? `${first.slice(0, 19)}…` : first;
    }
    return value ? '参与组织见下方说明' : '参与方式待确认';
  }

  function durationMarkup(concept) {
    const stages = list(concept.journey).map((step) => step.stage || '').join(' ');
    const ranges = [...stages.matchAll(/(\d+(?:\.\d+)?)\s*[–—\-~～至]\s*(\d+(?:\.\d+)?)\s*(?:分钟|min(?:utes?)?)/gi)];
    if (ranges.length && ranges.some((match) => Number(match[1]) === 0)) {
      const total = Math.max(...ranges.map((match) => Number(match[2])));
      return `按旅程推算 ${esc(total)} 分钟（方案设想）`;
    }
    const text = [concept.coreClaim, concept.mechanism?.description, ...list(concept.journey).map((step) => step.action)].join(' ');
    const total = text.match(/(\d+(?:\.\d+)?\s*(?:分钟|小时))\s*一轮/);
    if (total) return `${esc(total[1])}一轮（方案设想）`;
    const durations = [...new Set(text.match(/\d+(?:[–—\-~～至]\d+)?\s*(?:分钟|小时|秒)/g) || [])];
    return durations.length ? `原文时间信息：${esc(durations.join('、'))}（适用环节见旅程）` : '未明确 · 单轮时长与停留时间待确认';
  }

  function renderConcepts(project) {
    const concepts = list(project.concepts);
    if (!concepts.length) {
      const phase = project.status?.phase;
      if (['insufficient_evidence', 'error'].includes(phase)) {
        $('concepts').innerHTML = phase === 'error'
          ? '<div class="no-concepts"><h4>本轮尚无可审阅概念</h4><p>请查看上方具体错误与行动记录；已有证据和需求已保留。</p></div>'
          : '<div class="no-concepts"><h4>证据不足，暂未提出概念</h4><p>请查看证据边界与开放问题，不补造研究依据。</p></div>';
      } else {
        $('concepts').innerHTML = ['A', 'B'].map((letter) => `<article class="concept-placeholder"><span class="concept-letter">${letter}</span><h4>${letter === 'A' ? '第一种参与机制' : '另一种产品互动'}</h4><p>${phase === 'needs_input' ? '补充关键条件后，继续研究与概念探索。' : '等待智能体基于当前项目记录生成可审查概念。'}</p><div class="placeholder-rule"></div><span>${phase === 'busy' ? '正在研究' : '等待关键条件'}</span></article>`).join('');
      }
      return;
    }
    $('concepts').innerHTML = concepts.map((concept, index) => {
      const links = list(concept.evidenceLinks);
      const descriptiveOnly = links.length > 0 && links.every((link) => list(project.evidence).find((item) => item.id === link.evidenceId)?.query?.workflow === 'describe');
      const draftNotice = descriptiveOnly ? '<p class="evidence-boundary"><strong>基于实体描述的讨论草案 · 不构成受众亲和依据</strong></p>' : project.status?.phase === 'insufficient_evidence' ? `<p class="evidence-boundary"><strong>${links.length ? '有限证据支持的讨论草案' : '无证据支持的讨论草案'}</strong></p>` : '';
      const organizationLabel = organizationText(concept.mechanism?.organization);
      const linkedEvidence = links.map((link, linkIndex) => referenceMarkup(project, link, `${concept.id}-${linkIndex}`)).join('');
      const selected = project.selectedConceptId === concept.id;
      return `<article class="concept-card ${selected ? 'concept-selected' : ''}" aria-labelledby="concept-title-${index}">
        <div class="concept-topline"><span class="concept-letter">概念 ${String.fromCharCode(65 + index)}${selected ? ' · 已选' : ''}</span><span class="mechanism-label">${esc(organizationLabel)}</span></div>
        <div class="concept-intro"><h4 class="concept-title" id="concept-title-${index}">${display(concept.title)}</h4>${draftNotice}<p class="concept-claim">${display(concept.coreClaim)}</p></div>
        <section class="concept-part"><h5 class="part-title">参与机制</h5><p class="mechanism-description">${display(concept.mechanism?.description)}</p></section>
        <section class="concept-part"><h5 class="part-title">如何接触产品</h5><ul class="touchpoint-list">${list(concept.productTouchpoints).length ? list(concept.productTouchpoints).map((touchpoint) => `<li>${display(touchpoint)}</li>`).join('') : `<li>${unknown}</li>`}</ul><p class="concept-duration"><span>体验时长</span>${durationMarkup(concept)}</p></section>
        <section class="concept-part concept-cautions"><h5 class="part-title">关键风险 / 待确认</h5><ul class="question-list">${list(concept.openQuestions).length ? list(concept.openQuestions).map((question) => `<li>${display(question)}</li>`).join('') : `<li>尚未记录；不代表已完成验证。</li>`}</ul></section>
        <details class="concept-part concept-detail" data-key="journey-${esc(concept.id)}"><summary>从到场到离开的完整旅程</summary><ol class="journey">${list(concept.journey).length ? list(concept.journey).map((step) => `<li><span class="journey-stage">${esc(step.stage || '阶段未知')}</span><p class="journey-action">${display(step.action)}</p></li>`).join('') : `<li>${unknown}</li>`}</ol></details>
        <details class="concept-part concept-detail" data-key="culture-${esc(concept.id)}"><summary>文化依据与设计推断 · ${links.length} 条引用</summary>${linkedEvidence || '<p class="unknown-note">证据不足 · 尚无可追溯的设计关联。</p>'}<p class="inference-warning">设计转译是推断；结构校验通过不等于设计可行或效果成立。</p><h5 class="effects-label">未验证的效果</h5><ul class="effects-list">${list(concept.unverifiedEffects).length ? list(concept.unverifiedEffects).map((effect) => `<li>${display(effect)}</li>`).join('') : '<li>吸引力、参与度与转化均未验证。</li>'}</ul><details class="evidence-detail" data-key="raw-concept-${esc(concept.id)}"><summary>查看保存的完整概念字段</summary><pre class="raw-record">${esc(asText(concept))}</pre></details></details>
        <div class="concept-select-row"><button type="button" class="select-concept ${selected ? 'selected' : ''}" data-select-concept="${esc(concept.id)}" aria-pressed="${selected}">${selected ? '已选择 · 继续修改此概念' : `选择概念 ${String.fromCharCode(65 + index)} 继续`}</button><p>${selected ? '已确认内容仍在卡片中；修改先进入待审。' : '选定后，用自然语言提出修改。'}</p></div>
      </article>`;
    }).join('');
    $('concept-selection-label').textContent = project.selectedConceptId ? `${conceptLetter(project, project.selectedConceptId)} 已选 · 确认版 v${project.version}` : '选择一个概念，继续修改';
  }

  const revisionFields = {
    title: '概念名称', coreClaim: '核心主张', mechanism: '参与机制', journey: '体验旅程',
    productTouchpoints: '产品接触点', evidenceLinks: '文化依据与设计推断', openQuestions: '开放问题', unverifiedEffects: '未验证效果'
  };

  function fieldValueMarkup(project, field, value, key) {
    if (value === null || value === undefined) return '<p class="unknown-note">原记录未提供</p>';
    if (field === 'mechanism') return `<p class="diff-organization">${esc(organizationText(value.organization))}</p><p>${display(value.description)}</p>`;
    if (field === 'journey') return `<ol class="diff-list">${list(value).map((step) => `<li><strong>${display(step.stage)}</strong><p>${display(step.action)}</p></li>`).join('')}</ol>`;
    if (field === 'evidenceLinks') return list(value).length ? list(value).map((link, index) => referenceMarkup(project, link, `${key}-${index}`)).join('') : '<p>无已记录引用</p>';
    if (Array.isArray(value)) return value.length ? `<ul class="diff-list">${value.map((item) => `<li>${display(item)}</li>`).join('')}</ul>` : '<p>空列表</p>';
    return `<p>${display(value)}</p>`;
  }

  function revisionDiffMarkup(project, changes, key, beforeLabel, afterLabel) {
    return `<div class="field-diffs">${list(changes).map((change, index) => `<article class="field-diff"><h5>${esc(revisionFields[change.field] || change.field)}</h5><div class="diff-columns"><section class="diff-before"><h6>${esc(beforeLabel)}</h6>${fieldValueMarkup(project, change.field, change.before, `${key}-${index}-before`)}</section><section class="diff-after"><h6>${esc(afterLabel)}</h6>${fieldValueMarkup(project, change.field, change.after, `${key}-${index}-after`)}</section></div><div class="diff-reason"><p><strong>修改理由</strong>${display(change.reason)}</p>${list(change.evidenceRefs).length ? `<details class="evidence-detail" data-key="change-evidence-${esc(key)}-${index}"><summary>核对本项依据 · ${change.evidenceRefs.length} 条实际引用</summary>${change.evidenceRefs.map((link, refIndex) => referenceMarkup(project, link, `${key}-${index}-ref-${refIndex}`)).join('')}</details>` : '<p class="unknown-note">本项未附文化证据；须按客户要求或设计推断审查。</p>'}</div></article>`).join('')}</div>`;
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
    $('revision-workspace').hidden = !selected && !pending;
    $('revision-form').hidden = Boolean(pending);
    $('confirmed-version').textContent = `已确认 v${project.version}`;
    $('revision-selection').textContent = selected ? `${conceptLetter(project, selected.id)} · ${selected.title}` : '先选回待审修改所属的概念，再接受修改。';
    $('offline-revision-controls').hidden = project.mode !== 'offline';
    if (state.draftConceptId !== project.selectedConceptId) {
      state.draftConceptId = project.selectedConceptId;
      $('revision-text').value = '';
    }

    const feedback = $('revision-feedback');
    feedback.hidden = true;
    feedback.className = 'revision-feedback';
    if (request && ['running', 'needs_input', 'conflict', 'interrupted', 'error'].includes(request.status)) {
      const labels = feedbackRequest
        ? { running: '正在按你的反馈修订待审稿', needs_input: '修订待审稿前还需要补充条件', conflict: '本次待审反馈存在冲突', interrupted: '上次待审反馈已中断', error: '本次反馈未形成新待审稿' }
        : { running: '正在形成待审修改', needs_input: '还需要确认一个条件', conflict: '修改与现有条件冲突', interrupted: '上次修改已中断', error: '本次修改未完成' };
      feedback.hidden = false;
      feedback.classList.add(request.status);
      feedback.innerHTML = `<strong>${labels[request.status]}</strong><p>${display(request.question || request.detail || '已确认内容保持不变。')}</p>${request.question && request.detail ? `<p>${display(request.detail)}</p>` : ''}<p class="form-note">${feedbackRequest ? request.status === 'running' ? '下方原待审稿仍保留，暂时不能接受或拒绝。确认版保持不变；成功后再审查新稿。' : '下方原待审稿仍保留，确认版未改变。可在该稿的反馈框补充或调整后重试。' : request.status === 'running' ? '等待工具返回。已确认内容保持不变。' : request.status === 'needs_input' ? '在上方修改框补充答案，再继续。' : '检查条件与行动记录后，可重新提出修改；没有自动写入确认版。'}</p>`;
    } else if (!pending && revisions.length) {
      const latest = revisions.at(-1);
      if (['accepted', 'rejected'].includes(latest.status)) {
        feedback.hidden = false;
        feedback.innerHTML = latest.status === 'accepted'
          ? `<strong>修改已明确接受</strong><p>已确认内容更新至 v${esc(latest.confirmedVersion ?? project.version)}；上方概念卡显示当前正式内容。</p>`
          : `<strong>修改已拒绝</strong><p>已确认版本保持 v${esc(project.version)}，概念内容未应用这次待审修改。</p>`;
      }
    }

    if (pending && (state.pendingFeedback?.projectId !== project.id || state.pendingFeedback?.revisionId !== pending.id)) {
      const failedFeedback = feedbackRecords.findLast((record) => record.sourceRevisionId === pending.id && ['error', 'needs_input', 'conflict', 'interrupted'].includes(record.status));
      state.pendingFeedback = { projectId: project.id, revisionId: pending.id, text: failedFeedback?.text || '', error: '' };
    }
    if (!pending) state.pendingFeedback = null;

    $('pending-review').innerHTML = pending ? `<section class="pending-card" aria-labelledby="pending-heading">
      <div class="pending-header"><div><p class="eyebrow">${conceptLetter(project, pending.targetConceptId)} · 基于确认版 v${esc(pending.baseVersion)}</p><h4 id="pending-heading">待审修改 · 第 ${esc(pendingNumber)} 稿</h4></div><span class="evidence-badge">尚未写入确认版</span></div>
      ${pending.synthetic || project.mode === 'offline' ? '<p class="fixture-disclaimer">离线固定测试提案：用于验证流程，不代表模型理解了这段反馈，也不证明方案可行。</p>' : ''}
      <p class="pending-summary">${display(pending.summary)}</p>
      <p class="pending-request"><span>你的修改要求</span>${display(pending.request)}</p>
      ${parent ? `<div class="draft-lineage"><strong>本次反馈修订 · 第 ${esc(parent.revisionNumber || 1)} 稿 → 第 ${esc(pendingNumber)} 稿</strong><p>你的反馈：${display(feedbackRecords.find((record) => record.id === pending.feedbackId)?.text || pending.request)}</p><p>上份待审稿已被替代，保留在修改记录中。</p></div><h5 class="diff-group-title">本次反馈改了什么 · 旧待审稿 → 新待审稿</h5>${revisionDiffMarkup(project, pending.draftDelta, `${pending.id}-draft`, `修订前 · 第 ${parent.revisionNumber || 1} 稿待审稿`, `修订后 · 第 ${pendingNumber} 稿待审稿`)}<details class="consolidated-diff" data-key="consolidated-${esc(pending.id)}"><summary>接受时将写入哪些修改 · 确认版 v${esc(project.version)} → 第 ${esc(pendingNumber)} 稿（${list(pending.changes).length} 项）</summary><p class="form-note">接受会一次应用以下全部差异，包含此前待审稿中保留的修改。</p>${revisionDiffMarkup(project, pending.changes, `${pending.id}-confirmed`, `修改前 · 已确认 v${project.version}`, `接受后 · 第 ${pendingNumber} 稿内容`)}</details>` : `<h5 class="diff-group-title">接受时将写入的修改 · 确认版 → 待审稿</h5>${revisionDiffMarkup(project, pending.changes, pending.id, `修改前 · 已确认 v${project.version}`, '修改后 · 待接受')}`}
      <div class="pending-boundaries"><section><h5>受影响的环节</h5><ul>${list(pending.impact).map((item) => `<li>${display(item)}</li>`).join('') || '<li>未说明</li>'}</ul></section><section><h5>仍然未知</h5><ul>${list(pending.unknowns).map((item) => `<li>${display(item)}</li>`).join('') || '<li>未记录不代表已验证</li>'}</ul></section></div>
      <p class="review-boundary">工具结构校验通过，只说明字段与引用符合约束；设计可行性、预算、版权和效果仍需另行验证。</p>
      ${pending.baseVersion !== project.version || pending.targetConceptId !== project.selectedConceptId ? '<p class="revision-feedback conflict">当前确认版或已选概念已变化。先重新读取并核对；这份待审修改不能直接接受。</p>' : ''}
      <div class="review-actions"><button type="button" class="accept-revision" data-revision-decision="accept" data-revision-id="${esc(pending.id)}">接受第 ${esc(pendingNumber)} 稿，更新确认版</button><button type="button" class="reject-revision" data-revision-decision="reject" data-revision-id="${esc(pending.id)}">拒绝，保留确认版</button></div>
      <form class="pending-feedback-form" id="pending-feedback-form" data-revision-id="${esc(pending.id)}">
        <label class="field-label" for="pending-feedback-text">还没达到预期？继续反馈这份待审稿</label>
        <textarea id="pending-feedback-text" rows="3" aria-describedby="pending-feedback-note pending-feedback-error" placeholder="描述这份待审稿中需要调整的内容、原因或希望保留的部分。">${esc(state.pendingFeedback.text)}</textarea>
        <p class="form-note" id="pending-feedback-note">反馈会交给模型修订当前第 ${esc(pendingNumber)} 稿。确认版与原待审稿会保留，待新稿生成后由你再次审查。</p>
        <p class="pending-feedback-error" id="pending-feedback-error" role="alert"${state.pendingFeedback.error ? '' : ' hidden'}>${esc(state.pendingFeedback.error)}</p>
        <button class="primary-button" id="submit-pending-feedback" type="submit"><span>提交反馈并修订待审稿</span><span aria-hidden="true">↗</span></button>
      </form>
      <details class="evidence-detail" data-key="raw-revision-${esc(pending.id)}"><summary>查看待审记录与版本标识符</summary><pre class="raw-record">${esc(asText(pending))}</pre></details>
    </section>` : '';

    $('revision-history').hidden = revisions.length === 0;
    $('revision-count').textContent = String(revisions.length);
    $('revision-records').innerHTML = [...revisions].reverse().map((revision) => `<article class="revision-record"><p><strong>${esc({ pending: '待审', accepted: '已接受', rejected: '已拒绝', superseded: '已被后续稿替代' }[revision.status] || revision.status)}</strong> · 第 ${esc(revision.revisionNumber || 1)} 稿 · ${conceptLetter(project, revision.targetConceptId)} · 基于 v${esc(revision.baseVersion)}${revision.confirmedVersion ? ` → v${esc(revision.confirmedVersion)}` : ''}</p><p>${display(revision.summary)}</p>${revision.parentRevisionId ? '<p>由上份待审稿按反馈修订，未自动批准。</p>' : ''}<details class="evidence-detail" data-key="history-${esc(revision.id)}"><summary>查看当时的修改与依据</summary>${revisionDiffMarkup(project, revision.changes, `history-${revision.id}`, `当时确认版 v${revision.baseVersion}`, `当时待审第 ${revision.revisionNumber || 1} 稿`)}<pre class="raw-record">${esc(asText(revision))}</pre></details></article>`).join('') + (feedbackRecords.length ? `<h5 class="feedback-history-title">待审稿反馈记录</h5>${[...feedbackRecords].reverse().map((record) => `<article class="revision-record"><p><strong>${esc({ running: '正在修订', completed: '已生成新待审稿', error: '反馈处理失败', needs_input: '需要补充条件', conflict: '存在冲突', interrupted: '处理已中断' }[record.status] || record.status)}</strong> · 针对第 ${esc(record.sourceRevisionNumber || revisions.find((revision) => revision.id === record.sourceRevisionId)?.revisionNumber || 1)} 稿</p><p>你的反馈：${display(record.text)}</p>${record.detail || record.question ? `<p>${display(record.question || record.detail)}</p>` : ''}<details class="evidence-detail" data-key="feedback-history-${esc(record.id)}"><summary>查看反馈与修订标识符</summary><pre class="raw-record">${esc(asText(record))}</pre></details></article>`).join('')}` : '');
  }

  function renderProject(project) {
    const openDetails = new Set([...document.querySelectorAll('details[data-key][open]')].map((element) => element.dataset.key));
    state.project = project;
    const phase = project.status?.phase || 'unknown';
    $('project-status').className = `project-status ${Object.keys(phaseLabels).includes(phase) ? phase : ''}`;
    $('project-status').innerHTML = `<span class="phase-mark" aria-hidden="true"></span><div><strong>${esc(phaseLabels[phase] || '项目状态待确认')}</strong><p>${display(project.status?.detail)}</p><p class="usage-line">真实模型请求 ${project.mode === 'offline' ? '0' : esc(project.usage?.modelHttpAttempts ?? '未知')} · 真实 Qloo 请求 ${project.mode === 'offline' ? '0' : esc(project.usage?.qlooHttpAttempts ?? '未知')}${project.mode === 'offline' ? ' · 本项目当前离线运行' : ''}</p>${project.provenance?.kind === 'historical_copy' ? '<p class="provenance-note">复用历史真实证据和概念；本轮未重查来源。当前请求计数不包含历史运行。</p>' : ''}<details class="evidence-detail" data-key="project-diagnostics"><summary>查看请求计数与校验详情</summary>${feedbackMarkup(project.runtime?.feedback)}<pre class="raw-record">${esc(asText({ usage: project.usage, provenance: project.provenance }))}</pre><p class="form-note">结构与引用校验不证明设计可行、真实受众偏好或活动效果。</p></details></div>`;
    $('version-stamp').textContent = `已确认 v${project.version ?? '?'}${project.mode === 'offline' ? ' · 离线运行' : ''}`;
    $('board-heading').textContent = project.brief?.brand ? '当前项目提案板' : '让设计选择有据可循';
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
      showError(`项目读取中断：${error.message}`, () => readProject(id, token));
    }
  }

  function startPolling(project) {
    const token = ++state.pollToken;
    if (project.status?.phase === 'busy' || project.revisionRequest?.status === 'running') window.setTimeout(() => readProject(project.id, token), 650);
  }

  async function projectAction(path, payload, failureLabel, onSuccess, onFailure) {
    if (!state.project || isBusy()) return;
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
      showError(`${failureLabel}：${error.message}${error.status === 409 ? ' 请核对最新项目状态后重试。' : ''}`, () => readProject(projectId, ++state.pollToken));
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

  $('load-demo').addEventListener('click', () => {
    fillBrief(demo);
    $('mode').value = 'offline';
    updateMode();
    $('request').focus();
  });
  $('questions-panel').addEventListener('click', event => {
    const button = event.target.closest('[data-reference-choice], [data-reference-cancel]');
    const record = list(state.project?.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    if (!button || !record || button.disabled) return;
    projectAction('/messages', { referenceResolution: { resolutionId: record.id, baseVersion: state.project.version,
      action: button.hasAttribute('data-reference-cancel') ? 'cancel' : 'confirm',
      ...(button.dataset.referenceChoice ? { selectedId: button.dataset.referenceChoice } : {}) } }, '实体选择未被接收');
  });
  $('questions-panel').addEventListener('submit', event => {
    if (event.target.id !== 'reference-details-form') return;
    event.preventDefault();
    const record = list(state.project?.referenceResolutions).find(record => ['pending', 'needs_details'].includes(record.status));
    const text = $('reference-details').value.trim();
    if (!record || !text) return;
    projectAction('/messages', { referenceResolution: { resolutionId: record.id, baseVersion: state.project.version,
      action: 'clarify', text } }, '补充信息未被接收');
  });
  $('load-ambiguous').addEventListener('click', () => {
    fillBrief({ ...demo, request: '合成验收任务：为虚构运动鞋品牌「未定式」设计快闪。希望保留试穿，用音乐和电影作为研究线索。城市与场地还没想好，请先确认会影响方案的条件。', venue: '', budget: '' });
    $('mode').value = 'offline';
    updateMode();
    $('request').focus();
  });
  $('mode').addEventListener('change', updateMode);
  $('offline-revision-fixture').addEventListener('change', () => {
    $('offline-revision-note').textContent = $('offline-revision-fixture').value
      ? '当前已选择固定测试回应；它用于流程验收，不代表模型理解任意自然语言，也不证明设计可行。'
      : '离线模式不理解任意反馈；固定回应只用于检查修改、批准与恢复流程。';
  });
  $('concepts').addEventListener('click', (event) => {
    const button = event.target.closest('[data-select-concept]');
    if (!button || button.disabled || !state.project) return;
    projectAction('/select', { conceptId: button.dataset.selectConcept, baseVersion: state.project.version }, '未能选择概念', () => {
      window.setTimeout(() => { $('revision-workspace').scrollIntoView({ block: 'start' }); $('revision-text').focus({ preventScroll: true }); }, 0);
    });
  });
  $('revision-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('revision-text').value.trim();
    if (!text) {
      $('revision-text').setAttribute('aria-invalid', 'true');
      $('revision-feedback').hidden = false;
      $('revision-feedback').className = 'revision-feedback needs_input';
      $('revision-feedback').textContent = '请先填写希望修改的内容。';
      $('revision-text').focus();
      return;
    }
    $('revision-text').removeAttribute('aria-invalid');
    if (!state.project?.selectedConceptId || pendingRevision(state.project)) return;
    const payload = { text, conceptId: state.project.selectedConceptId, baseVersion: state.project.version };
    if (state.project.mode === 'offline' && $('offline-revision-fixture').value) payload.offlineFixture = $('offline-revision-fixture').value;
    projectAction('/revisions', payload, '修改要求未被确认接收', () => { $('revision-text').value = ''; });
  });
  $('revision-text').addEventListener('input', () => {
    if ($('revision-text').getAttribute('aria-invalid') !== 'true') return;
    $('revision-text').removeAttribute('aria-invalid');
    $('revision-feedback').hidden = true;
  });
  $('pending-review').addEventListener('click', (event) => {
    const button = event.target.closest('[data-revision-decision]');
    if (!button || button.disabled || !state.project) return;
    projectAction(`/revisions/${encodeURIComponent(button.dataset.revisionId)}/${button.dataset.revisionDecision}`, { baseVersion: state.project.version }, '审查决定未完成');
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
      $('pending-feedback-error').textContent = '请先写下对这份待审稿的反馈。';
      $('pending-feedback-error').hidden = false;
      $('pending-feedback-text').focus();
      return;
    }
    state.pendingFeedback.text = text;
    state.pendingFeedback.error = '';
    $('pending-feedback-text').removeAttribute('aria-invalid');
    $('pending-feedback-error').hidden = true;
    projectAction(`/revisions/${encodeURIComponent(pending.id)}/feedback`, { baseVersion: state.project.version, text }, '待审稿反馈未被确认接收', null, (error) => {
      if (state.pendingFeedback?.revisionId !== pending.id) return;
      state.pendingFeedback.error = `反馈未被确认接收：${error.message}。原待审稿仍保留；请核对后重试。`;
      renderRevision(state.project);
    });
  });
  briefFields.slice(1).forEach((field) => $(field).addEventListener('input', updateOptionalCount));
  $('brief-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isBusy()) return;
    const brief = Object.fromEntries(briefFields.map((field) => [field, $(field).value.trim()]));
    if (!brief.request) { $('request').focus(); return; }
    state.pending = true;
    updateControls();
    showError('');
    try {
      const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ brief, mode: $('mode').value, scenario: $('scenario').value }) });
      state.messageCount = 0;
      renderProject(result.project);
      startPolling(result.project);
    } catch (error) {
      showError(`项目未建立：${error.message}`);
    } finally {
      state.pending = false;
      updateControls();
    }
  });
  $('message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('message').value.trim();
    if (!text || !state.project || isBusy() || pendingRevision(state.project)) return;
    const selected = state.project.selectedConceptId;
    if (list(state.project.concepts).length && !selected) return;
    const payload = selected ? { text, conceptId: selected, baseVersion: state.project.version } : { text };
    if (selected && state.project.mode === 'offline' && $('offline-revision-fixture').value) payload.offlineFixture = $('offline-revision-fixture').value;
    projectAction(selected ? '/revisions' : '/messages', payload, '回复未发送', () => { $('message').value = ''; });
  });

  updateMode();
  loadConfig();
  let existingId = new URL(window.location.href).searchParams.get('project');
  if (!existingId) { try { existingId = localStorage.getItem(storageKey); } catch { /* A URL can still restore the project. */ } }
  if (existingId) {
    const token = ++state.pollToken;
    api(`/api/projects/${encodeURIComponent(existingId)}`).then(({ project }) => {
      if (token !== state.pollToken) return;
      fillBrief(project.brief);
      $('mode').value = project.mode === 'live' ? 'live' : 'offline';
      $('scenario').value = project.scenario || 'sufficient';
      updateMode();
      renderProject(project);
      startPolling(project);
    }).catch((error) => showError(`无法恢复项目：${error.message} 没有用空白项目覆盖保存记录。`, () => readProject(existingId, token)));
  }
})();
