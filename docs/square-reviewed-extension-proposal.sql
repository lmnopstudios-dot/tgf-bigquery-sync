-- PROPOSED ONLY: run only after explicit review/activation approval.
-- No identity snapshot, mapping, ready marker or source table is changed.
CREATE TABLE IF NOT EXISTS `gf-full-data.customer_identity.identity_reporting_extensions` (
 extension_id STRING NOT NULL,
 state STRING NOT NULL,
 reporting_version STRING NOT NULL,
 identity_version STRING NOT NULL,
 base_snapshot STRING NOT NULL
);
BEGIN TRANSACTION;
ASSERT (SELECT COUNT(*)=0 OR (COUNT(*)=1 AND COUNTIF(state='reviewed' AND reporting_version='square_channels_v1' AND identity_version='square_native_email_v1' AND base_snapshot='history-20261022-billing-v3')=1) FROM `gf-full-data.customer_identity.identity_reporting_extensions` WHERE extension_id='square_channels_v1_history_20261022_billing_v3_review_20261103') AS 'Existing extension differs or is duplicated; stop without overwriting it';
INSERT INTO `gf-full-data.customer_identity.identity_reporting_extensions` (extension_id,state,reporting_version,identity_version,base_snapshot)
SELECT 'square_channels_v1_history_20261022_billing_v3_review_20261103','reviewed','square_channels_v1','square_native_email_v1','history-20261022-billing-v3'
FROM UNNEST([1]) AS review_seed
WHERE NOT EXISTS (SELECT 1 FROM `gf-full-data.customer_identity.identity_reporting_extensions` WHERE extension_id='square_channels_v1_history_20261022_billing_v3_review_20261103');
ASSERT (SELECT IF(COUNT(*)=1 AND COUNTIF(state='reviewed' AND reporting_version='square_channels_v1' AND identity_version='square_native_email_v1' AND base_snapshot='history-20261022-billing-v3')=1,TRUE,ERROR('Square reporting extension review unavailable')) FROM `gf-full-data.customer_identity.identity_reporting_extensions` WHERE extension_id='square_channels_v1_history_20261022_billing_v3_review_20261103') AS 'Reviewed extension guard must pass';
COMMIT TRANSACTION;
