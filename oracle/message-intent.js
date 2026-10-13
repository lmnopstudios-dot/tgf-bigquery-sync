import { explicitKnowledgeSaveIntent } from './clarification-consumption.js';
/** Current-message authority boundary. Supplied material is evidence, not instructions. */
export const DOCUMENT_CLARIFICATION='Would you like me to edit this, use it as context, or propose knowledge records?';
export function messageIntent(message) {
  const text=String(message||'').trim();
  // Explicit containers and email structure delimit payload; no subject-specific rules.
  const boundary=text.search(/^(?:\s*(?:From:|Subject:|Dear\s+\w|Hi\s+\w[^\n]*[,!]|Hello\s+\w[^\n]*[,!])|\s*(?:Email|Document|Quoted text|Context|Source)\s*:|\s*```|\s*>|\s*[“‘"'])/im);
  const introduction=text.match(/^[^\n]*(?:\b(?:below|following|attached|pasted)\s+(?:email|document|text|brief)|\b(?:email|document|text|brief)\s+(?:below|follows))[^\n]*\n/i);
  const offset=boundary>=0?boundary:introduction?introduction[0].length:-1;
  const structuredDocument=offset>=0;
  const instruction=structuredDocument?text.slice(0,offset).replace(/\s*:\s*$/,'').trim():text;
  const actionText=instruction.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]+'(?!\w)/g,'').trim();
  const analytical=/\b(?:compare(?:d)?|contrast|analyse|analyze|calculate|evaluate|assess|show|give|recommend|provide|return|retrieve)\b|^(?:please\s+)?(?:comparison|analysis|report|overview|show|list|what|how|why|which|give|tell me|build|run)\b/i.test(actionText);
  const knowledge=explicitKnowledgeSaveIntent(actionText)||/^(?:please\s+)?(?:propose|ingest)\b/i.test(actionText);
  const editing=/\b(?:edit|rewrite|proofread|summari[sz]e|improve|draft|translate)\b/i.test(actionText);
  const editingOnly=editing&&/^(?:please\s+)?(?:edit|rewrite|proofread|summari[sz]e|improve|draft|translate)\b/i.test(instruction)&&! /\band (?:compare|analyse|analyze|calculate|evaluate|assess)\b/i.test(actionText);
  const analyticalAction=analytical&&!editingOnly;
  const document=structuredDocument||actionText!==instruction&&!analyticalAction&&!knowledge&&!editing;
  const contextOnly=/^(?:for (?:your )?context|context only|use (?:this|it) as context|fyi)\b/i.test(actionText);
  const contextualMention=!document&&!analyticalAction&&!knowledge&&/^(?:for (?:your )?context|context only|fyi|during\b)|\b(?:context only|as context)\b|\b(?:may|might|will|changes?|happens?|needs?|implemented|added)\b[\s\S]*\bduring\b/i.test(actionText);
  return {document,instruction,actionText,content:structuredDocument?text.slice(offset):document?text:null,analytical:analyticalAction,knowledge,editing,contextOnly,blocked:document&&!analyticalAction||knowledge&&!analyticalAction||contextualMention,clarification:document&&!analyticalAction&&!knowledge&&!editing&&!contextOnly?DOCUMENT_CLARIFICATION:null};
}
export function nonAnalyticalResult(message) {
  const intent=messageIntent(message);
  if(!intent.blocked)return null;
  return {answer:intent.clarification||(intent.knowledge?'I can prepare knowledge proposals for your review. Records are saved only after approval.':intent.contextOnly?'I’ll use this as context.':intent.editing?null:'What would you like me to do with this context?'),tools:[]};
}
