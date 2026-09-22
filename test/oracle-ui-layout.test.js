import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { appendToConversation, isNearConversationEnd, updateConversationContent } from '../public/oracle/scroll.js';

test('conversation follow logic scrolls near-bottom readers but preserves an intentional older position', () => {
  const nearBottom = { scrollHeight: 1000, scrollTop: 430, clientHeight: 500, append() { this.scrollHeight += 300; } };
  assert.equal(isNearConversationEnd(nearBottom), true);
  assert.equal(appendToConversation(nearBottom, {}), true);
  assert.equal(nearBottom.scrollTop, 1300);

  const readingHistory = { scrollHeight: 1000, scrollTop: 100, clientHeight: 500, append() { this.scrollHeight += 300; } };
  assert.equal(isNearConversationEnd(readingHistory), false);
  assert.equal(appendToConversation(readingHistory, {}), false);
  assert.equal(readingHistory.scrollTop, 100);

  let updated = false;
  updateConversationContent(readingHistory, () => { updated = true; readingHistory.scrollHeight += 800; });
  assert.equal(updated, true);
  assert.equal(readingHistory.scrollTop, 100);
});

test('Oracle layout makes the thread the vertical scroller and lets messages and proposals grow', async () => {
  const css = await readFile(new URL('../public/oracle/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.messages\{[^}]*min-height:0[^}]*overflow-x:hidden[^}]*overflow-y:auto/);
  assert.match(css, /\.message\{[^}]*flex:0 0 auto[^}]*overflow:visible/);
  assert.match(css, /\.proposal-group\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.message table\{[^}]*overflow-x:auto[^}]*overflow-y:visible/);
  assert.match(css, /#composer\{[^}]*position:sticky[^}]*bottom:0/);
  assert.doesNotMatch(css, /\.message\{[^}]*(?:max-height|overflow-y:auto)/);
  assert.match(css, /@media\(max-width:700px\)/);
});


test('report controls grow naturally without a nested vertical scroller',async()=>{
  const css = await readFile(new URL('../public/oracle/app.css', import.meta.url), 'utf8');
  assert.match(css,/\.report-controls\{[^}]*flex:0 0 auto[^}]*height:auto[^}]*max-height:none[^}]*overflow:visible/);
  assert.doesNotMatch(css,/\.report-controls\{[^}]*overflow-y:auto/);
});
