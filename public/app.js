(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const briefFields = ['request', 'brand', 'goal', 'references', 'venue', 'budget', 'mustKeep', 'avoid'];
  const state = { project: null, config: null, pending: false, pollToken: 0, messageCount: 0 };
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
    insufficient_evidence: '证据不足，先停在这里',
    error: '本轮未完成'
  };
  const unknown = '<span class="unknown-note">未知 · 未返回</span>';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const list = (value) => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const asText = (value) => typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value ?? '');
  const nonempty = (value) => value != null && asText(value).trim() !== '';
  const display = (value) => nonempty(value) ? esc(asText(value)) : unknown;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('服务没有返回可读取的项目记录。'); }
    if (!response.ok) {
      const error = result?.error;
      throw new Error(typeof error === 'string' ? error : error?.message || result?.message || `请求未完成（${response.status}）。`);
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
    const busy = state.pending || state.project?.status?.phase === 'busy';
    const liveAvailable = Boolean(state.config?.modes?.live?.available);
    $('create-project').disabled = busy || ($('mode').value === 'live' && !liveAvailable);
    $('send-message').disabled = busy || !state.project;
    $('message').disabled = busy || !state.project;
    $('mode').disabled = busy;
    $('scenario').disabled = busy || $('mode').value !== 'offline';
    $('load-demo').disabled = busy;
    $('load-ambiguous').disabled = busy;
    $('create-project').firstElementChild.textContent = busy ? '研究进行中…' : state.project ? '以当前输入新建项目' : '开始研究';
    $('message').placeholder = !state.project ? '先开始一份项目，再继续对话' : busy ? '等待当前行动完成…' : '补充条件，或说明需要继续研究什么';
    $('create-note').textContent = state.project ? '此处会新建独立项目；回答追问请使用下方对话。' : '输入会作为客户提供信息保留，未经独立核实。';
  }

  function updateMode() {
    const boardMode = state.project?.mode || $('mode').value;
    const isOffline = boardMode === 'offline';
    $('test-label').textContent = isOffline ? '离线合成验收' : '真实服务';
    $('mode-explanation').textContent = isOffline ? `${state.project ? '当前项目：' : ''}模拟模型与夹具；不是真实 Qloo 查询，不构成客户或效果证据。` : `${state.project ? '当前项目：' : ''}使用模型与 Qloo 服务；请检查每张证据卡的实际来源。`;
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
    const questions = list(project.questions);
    const panel = $('questions-panel');
    panel.hidden = questions.length === 0;
    panel.innerHTML = questions.length ? `<h3 id="questions-heading">下一步需要确认</h3><ul>${questions.map((question) => `<li>${esc(typeof question === 'string' ? question : question.text)}</li>`).join('')}</ul><p>在左侧对话补充答案；智能体会继续当前项目。</p>` : '';
  }

  function entityMarkup(entity, isReturned) {
    const entityId = [entity.id, entity.entity_id, entity.entityId].find(nonempty);
    const returnedFields = Object.entries(entity);
    return `<li><div class="entity-name">${display(entity.name)}${entity.type ? ` <span class="entity-id">/ ${esc(entity.type)}</span>` : ''}</div><p class="entity-id">${nonempty(entityId) ? esc(entityId) : 'ID 未知'}</p>${isReturned ? returnedFields.length ? `<div class="field-list">${returnedFields.map(([key, value]) => `<span class="field-chip">${esc(key)}: ${esc(asText(value))}</span>`).join('')}</div>` : `<p class="unknown-note">实际返回字段：${unknown}</p>` : entity.synthetic ? '<span class="unknown-note">合成输入 · 非 Qloo 实体</span>' : ''}</li>`;
  }

  function renderEvidence(project) {
    const evidence = list(project.evidence);
    $('evidence-count').textContent = evidence.length ? `${evidence.length} 张记录${project.mode === 'offline' ? ' · 合成夹具' : ''}` : '尚无可用证据';
    if (!evidence.length) {
      const blocked = ['insufficient_evidence', 'error'].includes(project.status?.phase);
      $('evidence').innerHTML = `<div class="empty-evidence"><span class="empty-symbol" aria-hidden="true">${blocked ? '—' : '↳'}</span><div><strong>${blocked ? '没有可用于概念的证据' : '先确认输入，再检查返回了什么'}</strong><p>${blocked ? '查询失败或结果不相关时，保留限制与行动记录，不补造文化关联。' : '证据会显示实际输入、返回字段与来源；缺失内容保留为未知。'}</p></div></div>`;
      return;
    }
    $('evidence').innerHTML = evidence.map((item, index) => `<article class="evidence-card" id="evidence-${esc(item.id)}" aria-labelledby="evidence-title-${index}"><div class="evidence-card-header"><h4 class="evidence-title" id="evidence-title-${index}">${esc(item.title || `文化关联记录 ${index + 1}`)}</h4><span class="evidence-badge">${item.synthetic ? '合成夹具 · 非真实证据' : '外部返回'}</span></div><p class="evidence-query">查询问题 · ${display(item.query)}</p><div class="evidence-body"><section class="evidence-block"><h5>实际输入实体</h5><ul class="entity-list">${list(item.inputReferences).length ? list(item.inputReferences).map((entity) => entityMarkup(entity, false)).join('') : `<li>${unknown}</li>`}</ul></section><section class="evidence-block"><h5>实际返回实体 / 字段</h5><ul class="entity-list">${list(item.returnedEntities).length ? list(item.returnedEntities).map((entity) => entityMarkup(entity, true)).join('') : `<li>${unknown}</li>`}</ul></section></div><dl class="evidence-meta"><div><dt>来源</dt><dd>${sourceMarkup(item.source)}</dd></div><div><dt>安全请求引用</dt><dd>${display(item.requestRef)}</dd></div><div><dt>查询时间</dt><dd>${display(item.queriedAt)}</dd></div><div><dt>代理与确认记录</dt><dd>${display(item.proxyConfirmation || item.context?.proxyConfirmation)}</dd></div></dl><details class="evidence-detail"><summary>查看查询与地理上下文</summary><div class="evidence-detail-content">${display(item.context)}</div></details><div class="evidence-boundary"><span class="boundary-label">适用边界</span><span>${display(item.boundary)}</span></div></article>`).join('');
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
      const organization = concept.mechanism?.organization;
      const organizationLabel = organization === 'collective_scheduled' ? '集体 · 定时参与' : organization === 'individual_self_paced' ? '个人 · 自主节奏' : /[\u4e00-\u9fff]/.test(organization || '') ? organization : organization ? '不同参与机制' : '参与方式待确认';
      const linkedEvidence = links.map((link) => {
        const target = list(project.evidence).find((item) => item.id === link.evidenceId);
        return `<div class="inference-item">${target ? `<a class="evidence-link" href="#evidence-${esc(link.evidenceId)}">依据 ${esc(link.evidenceId)} ↗</a>` : '<span class="unknown-note">证据引用未知</span>'}<p class="entity-id">实体 ${display(link.entityId)}</p><p class="field-chip">${display(link.observedField)}: ${display(link.observedValue)}</p><p class="trace-step"><span class="trace-label">返回观察</span>${display(link.observation)}</p><span class="trace-arrow" aria-hidden="true">↓</span><p class="trace-step"><span class="trace-label">设计转译 · 推断</span>${display(link.inspiration)}</p></div>`;
      }).join('');
      return `<article class="concept-card" aria-labelledby="concept-title-${index}"><div class="concept-topline"><span class="concept-letter">概念 ${String.fromCharCode(65 + index)}</span><span class="mechanism-label">${esc(organizationLabel)}</span></div><div class="concept-intro"><h4 class="concept-title" id="concept-title-${index}">${display(concept.title)}</h4>${draftNotice}<p class="concept-claim">${display(concept.coreClaim)}</p></div><section class="concept-part"><h5 class="part-title">参与机制</h5><p class="mechanism-description">${display(concept.mechanism?.description)}</p></section><section class="concept-part"><h5 class="part-title">从到场到离开的体验旅程</h5><ol class="journey">${list(concept.journey).length ? list(concept.journey).map((step) => `<li><span class="journey-stage">${esc(step.stage || '阶段未知')}</span><p class="journey-action">${display(step.action)}</p></li>`).join('') : `<li>${unknown}</li>`}</ol></section><section class="concept-part"><h5 class="part-title">如何接触产品</h5><ul class="touchpoint-list">${list(concept.productTouchpoints).length ? list(concept.productTouchpoints).map((touchpoint) => `<li>${display(touchpoint)}</li>`).join('') : `<li>${unknown}</li>`}</ul></section><section class="concept-part"><h5 class="part-title">从文化观察到设计启发</h5>${linkedEvidence || '<p class="unknown-note">证据不足 · 尚无可追溯的设计关联。</p>'}<p class="inference-warning">设计转译是推断；文化关联不证明机制有效。</p></section><section class="concept-part concept-cautions"><h5 class="part-title">开放问题</h5><ul class="question-list">${list(concept.openQuestions).length ? list(concept.openQuestions).map((question) => `<li>${display(question)}</li>`).join('') : `<li>尚未记录；不代表已完成验证。</li>`}</ul><h5 class="effects-label">未验证的效果</h5><ul class="effects-list">${list(concept.unverifiedEffects).length ? list(concept.unverifiedEffects).map((effect) => `<li>${display(effect)}</li>`).join('') : '<li>吸引力、参与度与转化均未验证。</li>'}</ul></section></article>`;
    }).join('');
  }

  function renderProject(project) {
    state.project = project;
    const phase = project.status?.phase || 'unknown';
    $('project-status').className = `project-status ${Object.keys(phaseLabels).includes(phase) ? phase : ''}`;
    $('project-status').innerHTML = `<span class="phase-mark" aria-hidden="true"></span><div><strong>${esc(phaseLabels[phase] || '项目状态待确认')}</strong><p>${display(project.status?.detail)}</p>${feedbackMarkup(project.runtime?.feedback)}${project.usage ? `<p class="usage-line">模型实际请求 ${esc(project.usage.modelHttpAttempts ?? '未知')} · Qloo 实际请求 ${esc(project.usage.qlooHttpAttempts ?? '未知')} · 工具调用 ${esc(project.usage.toolCalls ?? '未知')}${project.mode === 'offline' ? ' · 离线模拟计数，非真实服务请求' : ''}</p>` : ''}</div>`;
    $('version-stamp').textContent = `项目记录 v${project.version ?? '?'}${project.mode === 'offline' ? ' · 合成' : ''}`;
    $('board-heading').textContent = project.brief?.brand ? '当前项目提案板' : '让设计选择有据可循';
    renderContext(project);
    renderMessages(project);
    renderActions(project);
    renderQuestions(project);
    renderEvidence(project);
    renderConcepts(project);
    updateMode();
  }

  async function readProject(id, token) {
    try {
      const result = await api(`/api/projects/${encodeURIComponent(id)}`);
      if (token !== state.pollToken) return;
      renderProject(result.project);
      showError('');
      if (result.project.status?.phase === 'busy') window.setTimeout(() => readProject(id, token), 850);
    } catch (error) {
      if (token !== state.pollToken) return;
      showError(`项目读取中断：${error.message}`, () => readProject(id, token));
    }
  }

  function startPolling(project) {
    const token = ++state.pollToken;
    if (project.status?.phase === 'busy') window.setTimeout(() => readProject(project.id, token), 650);
  }

  $('load-demo').addEventListener('click', () => {
    fillBrief(demo);
    $('mode').value = 'offline';
    updateMode();
    $('request').focus();
  });
  $('load-ambiguous').addEventListener('click', () => {
    fillBrief({ ...demo, request: '合成验收任务：为虚构运动鞋品牌「未定式」设计快闪。希望保留试穿，用音乐和电影作为研究线索。城市与场地还没想好，请先确认会影响方案的条件。', venue: '', budget: '' });
    $('mode').value = 'offline';
    updateMode();
    $('request').focus();
  });
  $('mode').addEventListener('change', updateMode);
  briefFields.slice(1).forEach((field) => $(field).addEventListener('input', updateOptionalCount));
  $('brief-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.pending || state.project?.status?.phase === 'busy') return;
    const brief = Object.fromEntries(briefFields.map((field) => [field, $(field).value.trim()]));
    if (!brief.request) { $('request').focus(); return; }
    state.pending = true;
    updateControls();
    showError('');
    try {
      const result = await api('/api/projects', { method: 'POST', body: JSON.stringify({ brief, mode: $('mode').value, scenario: $('scenario').value }) });
      state.messageCount = 0;
      renderProject(result.project);
      const url = new URL(window.location.href);
      url.searchParams.set('project', result.project.id);
      history.replaceState(null, '', url);
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
    if (!text || !state.project || state.pending || state.project.status?.phase === 'busy') return;
    state.pending = true;
    updateControls();
    showError('');
    try {
      const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
      $('message').value = '';
      renderProject(result.project);
      startPolling(result.project);
    } catch (error) {
      showError(`回复未发送：${error.message}`);
    } finally {
      state.pending = false;
      updateControls();
    }
  });

  updateMode();
  loadConfig();
  const existingId = new URL(window.location.href).searchParams.get('project');
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
    }).catch((error) => showError(`无法恢复项目：${error.message}`));
  }
})();
