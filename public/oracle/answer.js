import { renderMarkdown } from './markdown.js';
import { placeInlineChart } from './inline-chart.js';

/** The same display path is used for immediate answers and recovered results. */
export function renderAnalyticalAnswer(target, message, result) {
  renderMarkdown(target, result.answer);
  const charts=Array.isArray(result.charts)&&result.charts.length?result.charts:[result.inline_chart];
  for(const chart of charts) {
    try { placeInlineChart(target,message,chart); }
    catch { /* Optional chart failure must leave the primary answer readable. */ }
  }
}
