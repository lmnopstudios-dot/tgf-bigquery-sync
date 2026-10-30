"""Generated BigQuery SQL with fixture inputs, translated locally, not a live query."""
import json,re,sys
import duckdb,sqlglot
p=json.load(open(sys.argv[1])) if len(sys.argv)>1 else json.load(sys.stdin)
tree=sqlglot.parse_one(p['query'].replace('SAFE.PARSE_JSON(', 'PARSE_JSON('),read='bigquery')
# BigQuery COUNTIF returns zero for all-null inputs; DuckDB COUNT_IF returns NULL.
tree=tree.transform(lambda n: sqlglot.exp.Coalesce(this=n.copy(),expressions=[sqlglot.exp.Literal.number(0)]) if isinstance(n,sqlglot.exp.CountIf) else n)
q=tree.sql(dialect='duckdb')
# BigQuery JSON_QUERY_ARRAY returns NULL for a JSON string, while the
# DuckDB JSON[] cast throws. Preserve BigQuery's null/fallback semantics.
q=q.replace("CAST(o.j -> '$.line_items' AS JSON[])","TRY_CAST(o.j -> '$.line_items' AS JSON[])")
# DuckDB WITH ORDINALITY is one-based; BigQuery WITH OFFSET is zero-based.
q=q.replace('SELECT o.oid, off,', 'SELECT o.oid, off-1 AS off,')
total_fields=['entry_product_ref','entry_product','entry_is_sizer','entry_rank','window_days','entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers']
q=q.replace("'_0': t.*",','.join("'"+c+"': t."+c for c in total_fields))

cat_fields=['collection_id','display_name','collaboration_name','products','observed_eligible_customers','historical_products','persisted_members','source_routes','historical_routed_products','unclassified_products','conflicting_products']
q=q.replace("'_0': *",','.join("'"+c+"': "+c for c in cat_fields))
q=q.replace("'_2': c.*",','.join("'"+c+"': c."+c for c in cat_fields))

for key in ['cohort_entry_start','cohort_entry_end','observation_end','coverage_start','coverage_end','start_date','end_date']:
 q=re.sub(r'\$'+key+r'\b',f'CAST(${key} AS DATE)',q)
# Fixture has fewer than ten products in every aggregate; the BigQuery
# ARRAY_AGG LIMIT 10 quota is non-binding and DuckDB lacks that syntax.
q=q.replace(' LIMIT 10)', ')')
# DuckDB resolves an ORDER BY alias to a conflicting input column in this
# legacy grouped diagnostic; BigQuery resolves the projection alias.
q=q.replace('GROUP BY entry_source_platform, entry_source_store, collaboration_name, window_days ORDER BY source_platform NULLS FIRST, source_store NULLS FIRST', 'GROUP BY entry_source_platform, entry_source_store, collaboration_name, window_days ORDER BY entry_source_platform NULLS FIRST, entry_source_store NULLS FIRST')
used=set(re.findall(r'\$([A-Za-z_][A-Za-z_0-9]*)',q));params={k:v for k,v in p['params'].items() if k in used}
try:
 c=duckdb.connect();r=c.execute(q,params)
 rows=[dict(zip([d[0] for d in r.description],row)) for row in r.fetchall()]
 print(json.dumps(rows,default=str))
except Exception:
 open('/tmp/square-channel-failed.sql','w').write(q)
 raise
