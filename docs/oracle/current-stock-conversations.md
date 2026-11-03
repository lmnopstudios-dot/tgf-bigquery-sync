# Conversational product inventory

Current-stock requests resolve through transitionAnalysisContext, the governed stock route, createCurrentStockService, and native Shopify reads. The previous scope regex retained output instructions in entity_query and treated every location as one exact location name. Both supplied failures are retained verbatim in test/current-stock-conversation.test.js.

The shared stock_scope contract separates location names/groups, workshop exclusion, variant detail, layout and output format. Product identity remains in entity_query and the existing validated candidate selection. Fresh named-product requests reset old scope; anchored location/format refinements retain the existing product. Context serialization validates the new fields.

Each explicit location resolves independently to active native Shopify IDs. Online selects the unique exact Online Ready to Ship location, otherwise the existing configured fulfilment selector. The POS alias uses TGF's Kings Cross, Shoreditch and Soho names; not every active location is retail. Missing or duplicate names remain failures. Workshops are excluded when requested.

Exact title/group resolution remains first. Failed title searches can read up to two bounded catalogue pages for spelling suggestions. Edit distance offers actual catalogue identities for confirmation; it never auto-selects a typo or certifies exhaustive discovery. Offered choices retain location scope. Product not resolved is distinct from retrieval failure; neither means zero inventory. Existing product, variant, page and request bounds remain visible and unchanged.

Matrix output presents available quantities once per variant with a column per location. Excel refinements reuse workbook integrity, unchanged storage-size limits, owner-scoped export persistence and authenticated download. Refinements perform fresh read-only retrieval rather than promising cached quantities. No stock, product, tag, mapping or identity changes occur.

HTTP regressions exercise the real authenticated chat/session, dispatcher, service and download. The durable-job regression checks scope serialization and polling. Shopify/persistence transports are mocked, not live-store validation. See the PR for actual release-gate results. Deploy context readers and workers together: older workers do not recognize stock_scope.
