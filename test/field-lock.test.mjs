import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRevision, proposeRevision, decideRevision, selectConcept, setFieldLock } from '../app/state.mjs';
import { revisionProject, revisionInput } from './revision-state.test.mjs';

test('user locks block proposals and acceptance; unlocking approves nothing and is recorded', () => {
  const project = revisionProject();
  const confirmed = structuredClone(project.concepts);
  setFieldLock(project, { baseVersion: 1, field: 'mechanism', locked: true });
  assert.deepEqual(project.lockedFields, ['mechanism']);
  assert.equal(project.version, 1);
  assert.match(project.actions.at(-1).label, /Lock Participation mechanism/);

  const blocked = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '改为双人参与' });
  assert.throws(() => proposeRevision(project, revisionInput(blocked)), { code: 'FIELD_LOCKED' });
  assert.deepEqual(project.concepts, confirmed);
  project.revisionRequest.status = 'error';

  setFieldLock(project, { baseVersion: 1, field: 'mechanism', locked: false });
  assert.deepEqual(project.lockedFields, []);
  assert.match(project.actions.at(-1).detail, /does not approve a change/);
  assert.deepEqual(project.concepts, confirmed);

  const request = beginRevision(project, { conceptId: 'a', baseVersion: 1, text: '改为双人参与' });
  const pending = proposeRevision(project, revisionInput(request));
  setFieldLock(project, { baseVersion: 1, field: 'mechanism', locked: true });
  assert.throws(() => decideRevision(project, pending.id, 'accept', { baseVersion: 1 }), { code: 'FIELD_LOCKED' });
  assert.deepEqual(project.concepts, confirmed);
  decideRevision(project, pending.id, 'reject', { baseVersion: 1 });
  assert.equal(project.version, 1);
});

test('locks require a selected concept, a current version and an allowed field, and pin the selection', () => {
  const project = revisionProject();
  const actions = project.actions.length;
  for (const input of [{ baseVersion: 0, field: 'mechanism', locked: true }, { baseVersion: 1, field: 'brief', locked: true },
    { baseVersion: 1, field: 'mechanism', locked: 'yes' }, { baseVersion: 1, field: 'mechanism', locked: true, projectId: 'other' }])
    assert.throws(() => setFieldLock(project, input));
  assert.equal(project.lockedFields, undefined); assert.equal(project.actions.length, actions);
  setFieldLock(project, { baseVersion: 1, field: 'productTouchpoints', locked: true });
  setFieldLock(project, { baseVersion: 1, field: 'productTouchpoints', locked: true });
  assert.equal(project.actions.length, actions + 1);
  assert.throws(() => selectConcept(project, { conceptId: 'b', baseVersion: 1 }), { code: 'PENDING_SELECTION_LOCKED' });
  assert.equal(project.selectedConceptId, 'a');
  selectConcept(project, { conceptId: 'a', baseVersion: 1 });
  project.selectedConceptId = null;
  assert.throws(() => setFieldLock(project, { baseVersion: 1, field: 'title', locked: true }), /Select a concept/);
});
