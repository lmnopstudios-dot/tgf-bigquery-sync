-- REVIEW ONLY. Production mutation requires explicit authorization.
-- Run once, with publishers quiescent, in the SAME dataset as publication.
-- Replace PROJECT and DATASET. Do not use IF NOT EXISTS or append a seed row:
-- an existing table requires inspection, never automatic reseeding.
CREATE TABLE `PROJECT.DATASET.identity_publication_guard`
OPTIONS(description='Unpartitioned singleton serializes identity publication transactions')
AS SELECT 'publication' guard_id, CAST(0 AS INT64) generation;
