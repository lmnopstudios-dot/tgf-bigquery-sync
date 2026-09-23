export function collectionClassificationPayload(collection, fields) {
  const collectionGroup = fields.group.value;
  const collaborationName = fields.collaborationName.value.trim();
  if (collectionGroup === 'collaboration' && !collaborationName) throw new Error('Collaboration name is required and must be explicitly confirmed.');
  return { collection_id: String(collection.collection_id), collection_title: collection.title || null, collection_group: collectionGroup, collaboration_name: collectionGroup === 'collaboration' ? collaborationName : null, note: fields.note.value.trim() || null };
}

export function createCollectionGovernanceActions({ api, confirmAction, getCollection, fields, refreshDetail, refreshList }) {
  async function save() {
    const collection = getCollection();
    if (!collection) throw new Error('No collection is selected.');
    const payload = collectionClassificationPayload(collection, fields);
    if (!confirmAction(`Save ${payload.collection_group} as the governed human decision for ${collection.title}?`)) return { cancelled: true };
    await api('/collection-classifications/classify', { method: 'POST', body: JSON.stringify(payload) });
    await refreshDetail(collection); await refreshList();
    return { cancelled: false, message: `Saved ${payload.collection_group} classification for ${collection.title}.` };
  }
  async function revoke(classificationId, collection) {
    if (!confirmAction('Revoke this decision? Its audit history will remain visible.')) return { cancelled: true };
    await api('/collection-classifications/revoke', { method: 'POST', body: JSON.stringify({ classification_id: classificationId, collection_id: String(collection.collection_id) }) });
    await refreshDetail(collection); await refreshList();
    return { cancelled: false, message: `Revoked collection classification for ${collection.title}.` };
  }
  return { save, revoke };
}
