import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

export const creationInput = input => ({ ...input, creationKey: input.creationKey ?? randomBytes(32).toString('hex') });

// Existing end-to-end cases explicitly keep their create-then-generate intent.
// The ordinary HTTP helpers retain their original one-request semantics.
export async function createAndStart(call, input) {
  const created = await call('POST', '/api/projects', creationInput(input));
  assert.equal(created.status, 201);
  const project = created.body?.project ?? created.project;
  return call('POST', `/api/projects/${project.id}/start`, {});
}
