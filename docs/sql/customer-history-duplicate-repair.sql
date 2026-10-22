-- REVIEW ONLY. Do not run until aggregate production evidence and this exact
-- plan have been reviewed and production mutations explicitly authorized.
-- Quiesce every legacy publisher first; install/validate the guard separately.
-- Bind @snapshot, @expected_marker_rows, @expected_link_rows,
-- @expected_distinct_keys, @expected_ww, @expected_usd, @expected_shopify,
-- @keep_created_at to reviewed values. Never infer
-- unknown counts or choose a timestamp using MIN/MAX. Replace PROJECT/DATASET.
BEGIN TRANSACTION;
ASSERT @snapshot='history-20261022-billing-v3' AS 'Wrong repair target';
ASSERT (SELECT COUNT(*) FROM `PROJECT.DATASET.identity_publication_guard`)=1 AS 'Guard unavailable';
UPDATE `PROJECT.DATASET.identity_publication_guard` SET generation=generation+1
WHERE guard_id='publication' AND generation IS NOT NULL;
ASSERT @@row_count=1 AS 'Guard unavailable';

CREATE TEMP TABLE repair_markers AS SELECT * FROM `PROJECT.DATASET.identity_snapshots` WHERE snapshot_id=@snapshot;
CREATE TEMP TABLE repair_original_links AS SELECT * FROM `PROJECT.DATASET.identity_order_links` WHERE snapshot_id=@snapshot;
ASSERT (SELECT COUNT(*) FROM repair_markers)=@expected_marker_rows AND @expected_marker_rows>=2 AS 'Marker count changed';
ASSERT (SELECT COUNT(*) FROM repair_original_links)=@expected_link_rows AS 'Link count changed';
-- DISTINCT compares every stored mapping field, including NULLs and booleans.
CREATE TEMP TABLE repair_links AS SELECT DISTINCT * FROM repair_original_links;
ASSERT NOT EXISTS(SELECT 1 FROM repair_links GROUP BY source_store,source_order_id HAVING COUNT(*)>1) AS 'Conflicting mapping: stop for evidence review';
ASSERT NOT EXISTS(SELECT 1 FROM repair_links WHERE source_store IS NULL OR source_store NOT IN ('ww','usd','shopify') OR source_order_id IS NULL OR source_order_id='' OR canonical_customer_ref IS NULL OR NOT REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$') OR resolution IS NULL OR resolution NOT IN ('matched','unmatched','ambiguous','unavailable')) AS 'Invalid mapping';
ASSERT (SELECT COUNT(*) FROM repair_links)=@expected_distinct_keys AND @expected_distinct_keys=58465 AS 'Unexpected intended mapping count';
ASSERT (SELECT COUNT(DISTINCT source_store) FROM repair_links)=3 AS 'Missing source';
ASSERT (SELECT COUNT(*) FROM repair_links WHERE source_store='ww')=@expected_ww
  AND (SELECT COUNT(*) FROM repair_links WHERE source_store='usd')=@expected_usd
  AND (SELECT COUNT(*) FROM repair_links WHERE source_store='shopify')=@expected_shopify AS 'Source totals changed';
ASSERT NOT EXISTS(SELECT 1 FROM repair_markers WHERE state IS NULL OR state!='ready' OR start_date IS NULL OR start_date!=DATE '1900-01-01' OR end_date IS NULL OR end_date!=DATE '2026-10-19' OR mapping_count IS NULL OR mapping_count!=@expected_distinct_keys OR created_at IS NULL) AS 'Metadata conflict';
CREATE TEMP TABLE repair_marker AS SELECT DISTINCT * FROM repair_markers WHERE created_at=@keep_created_at;
ASSERT (SELECT COUNT(*) FROM repair_marker)=1 AS 'Reviewed original timestamp missing';

-- All deletes are scoped to this snapshot; no collection/progress tables change.
DELETE FROM `PROJECT.DATASET.identity_order_links` WHERE snapshot_id=@snapshot;
INSERT INTO `PROJECT.DATASET.identity_order_links` SELECT * FROM repair_links;
DELETE FROM `PROJECT.DATASET.identity_snapshots` WHERE snapshot_id=@snapshot;
INSERT INTO `PROJECT.DATASET.identity_snapshots` SELECT * FROM repair_marker;

ASSERT (SELECT COUNT(*) FROM `PROJECT.DATASET.identity_snapshots` WHERE snapshot_id=@snapshot)=1 AS 'Marker postcondition';
ASSERT (SELECT COUNT(*) FROM `PROJECT.DATASET.identity_order_links` WHERE snapshot_id=@snapshot)=@expected_distinct_keys AS 'Link postcondition';
ASSERT NOT EXISTS(SELECT * FROM repair_links EXCEPT DISTINCT SELECT * FROM `PROJECT.DATASET.identity_order_links` WHERE snapshot_id=@snapshot) AS 'Lost mapping';
ASSERT NOT EXISTS(SELECT * FROM `PROJECT.DATASET.identity_order_links` WHERE snapshot_id=@snapshot EXCEPT DISTINCT SELECT * FROM repair_links) AS 'Changed mapping';
COMMIT TRANSACTION;
