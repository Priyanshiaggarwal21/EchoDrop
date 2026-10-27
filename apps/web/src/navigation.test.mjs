import test from 'node:test';
import assert from 'node:assert/strict';
import { ENTRY, readNavigation, planNavigation } from './navigation.mjs';
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
function history() {
  let entries = [ENTRY], index = 0;
  return { get current() { return entries[index]; }, get length() { return entries.length; },
    go(screen, mode, id, replace, section, contextId) { const plan = planNavigation(entries[index], screen, mode, id, replace, section, contextId); if (!plan) return; if ('delta' in plan) { index += plan.delta; return; } if (plan.replace) entries[index] = plan.route; else { entries.splice(++index); entries.push(plan.route); } },
    back() { if (index > 0) index--; }, forward() { if (index < entries.length - 1) index++; } };
}
test('Welcome enters Home, returns with Back, and restores with Forward without duplicates', () => {
  const nav = history(); nav.go('Home'); nav.go('Home'); assert.equal(nav.length, 2); nav.back(); assert.equal(nav.current.screen, 'Welcome'); nav.back(); assert.equal(nav.current, ENTRY); nav.forward(); assert.equal(nav.current.screen, 'Home');
});
test('creation confirmation replaces the form; project Back returns to Home', () => {
  const nav = history(); nav.go('Home'); nav.go('Create Project'); nav.go('Project', 'files', firstId, true); assert.equal(nav.length, 3); assert.equal(nav.current.projectId, firstId); nav.back(); assert.equal(nav.current.screen, 'Home'); nav.back(); assert.equal(nav.current.screen, 'Welcome');
});
test('switching projects and visiting existing tools preserves project identity and share mode', () => {
  const nav = history(); nav.go('Home'); nav.go('Project', 'files', firstId); nav.go('Project', 'files', secondId); nav.go('Share', 'project'); nav.go('Connect'); nav.back(); assert.equal(nav.current.mode, 'project'); nav.back(); assert.equal(nav.current.projectId, secondId); nav.back(); assert.equal(nav.current.projectId, firstId);
});
test('Home returns to its existing entry and branching after Back discards stale forward routes', () => {
  const nav = history(); nav.go('Home'); nav.go('Project', 'files', firstId); nav.go('Settings'); nav.go('Home'); assert.equal(nav.current.depth, 1); nav.back(); assert.equal(nav.current.screen, 'Welcome'); nav.go('Home'); assert.equal(nav.length, 2); nav.forward(); assert.equal(nav.current.screen, 'Home');
});
test('reload restores valid project history and invalid routes fall back to Welcome', () => {
  const nav = history(); nav.go('Home'); nav.go('Project', 'files', firstId); assert.equal(readNavigation({ echoNavigation: nav.current }).projectId, firstId);
  for (const value of [null, {}, { ...nav.current, projectId: '../private' }, { ...nav.current, depth: -1 }, { ...nav.current, screen: 'Unknown' }]) assert.equal(readNavigation({ echoNavigation: value }), ENTRY);
  assert.throws(() => planNavigation(ENTRY, 'Project', 'files', '../private'));
});

test('project sections and selected contexts restore through Back, Forward and reload', () => {
  const nav = history(); nav.go('Home'); nav.go('Project', 'files', firstId);
  nav.go('Project', 'files', firstId, false, 'teams');
  nav.go('Project', 'files', firstId, false, 'collaboration', secondId);
  const length = nav.length; nav.go('Project', 'files', firstId, false, 'collaboration', secondId); assert.equal(nav.length, length);
  nav.back(); assert.equal(nav.current.projectSection, 'teams'); nav.forward();
  assert.equal(readNavigation({ echoNavigation: nav.current }).contextId, secondId);
  nav.go('Home'); nav.back(); assert.equal(nav.current.screen, 'Welcome');
});
test('switching projects clears the previous selected context and Back restores it', () => {
  const nav = history(); nav.go('Home'); nav.go('Project', 'files', firstId, false, 'collaboration', secondId);
  nav.go('Project', 'files', secondId); assert.equal(nav.current.contextId, undefined); assert.equal(nav.current.projectSection, 'overview');
  nav.back(); assert.equal(nav.current.projectId, firstId); assert.equal(nav.current.contextId, secondId);
});
test('context routes cannot be attached to unrelated screens or invalid project sections', () => {
  const nav = history(); nav.go('Home');
  assert.throws(() => nav.go('Settings', 'files', undefined, false, 'collaboration', secondId));
  assert.throws(() => nav.go('Project', 'files', firstId, false, 'teams', secondId));
  assert.throws(() => nav.go('Project', 'files', firstId, false, 'unknown'));
  assert.equal(readNavigation({ echoNavigation: { ...nav.current, contextId: secondId, projectSection: 'collaboration' } }), ENTRY);
});
