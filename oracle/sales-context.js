export const SALES_EVENT_TOPICS = ['online','sales','campaign','promotion','migration','ecommerce','black-friday'];
/** A dated confirmed record supplies context, never a causal attribution. */
export function relevantSalesEvent(event, periods, {onlineOnly=false}={}) {
  const tags=(event.tags||[]).map(tag=>String(tag).toLowerCase());
  const start=event.effective_from,end=event.effective_to||(event.date_precision==='day'?start:null);
  return event.kind==='event'&&event.status==='confirmed'&&Boolean(event.id&&event.source_type&&event.source_reference&&start&&end)
    && periods.some(period=>period.start_date&&start<=period.end_date&&end>=period.start_date)
    && tags.some(tag=>SALES_EVENT_TOPICS.includes(tag))
    && (!onlineOnly||!tags.some(tag=>['retail','in-store','pos','square'].includes(tag)));
}
