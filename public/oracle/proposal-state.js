/** A proposal becomes saved only after a successful approval acknowledgement. */
export function confirmProposalSaved(wrapper,response) {
  if(response?.success!==true||typeof response.id!=='string'||!response.id)throw new Error('The server did not confirm that this record was saved.');
  wrapper.persisted=true;
  wrapper.saved_id=response.id;
  return response.id;
}
