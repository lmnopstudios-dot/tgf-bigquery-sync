# Private runtime configuration for retained reporting

Both loyalty context resolution and the retained report provider load
LOYALTYLION_CONFIG_PATH at process startup. Without a path they use the
unverified public stub, which cannot activate reporting. A specified file
that is missing or malformed causes a safe startup error; there is no
silent fallback to another programme.

Store the already reviewed account configuration as a private runtime secret
file, not a repository file or a temporary /tmp file. Configure its path on
the web service. A deployment can remove temporary files. The file contains
account/programme/site IDs and review metadata; keep it private. The API key
stays separate and is not needed to read the retained report.

Enable reporting separately using LOYALTYLION_REPORTING_ENABLED=true.
Keep LOYALTYLION_COLLECTION_ENABLED=false. No report performs a collection
or replay. Restart/redeploy after placing the file and setting its path.
Before activation, verify complete retained coverage and unchanged scope.
Only query dates within the verified points coverage; membership/current
tiers are the current successful roster, not a historical reconstruction.

A missing/wrong private file must be fixed before deployment, not by
publishing private identifiers into the stub or dropping the access gate.
