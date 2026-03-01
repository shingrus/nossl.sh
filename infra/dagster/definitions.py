from dagster import Definitions

from infra.dagster.build_data_job import geofeed_finder_job, pdb_asn_geo_job, paths
from infra.dagster.build_databases_job import build_databases_job


defs = Definitions(
    jobs=[geofeed_finder_job, pdb_asn_geo_job, build_databases_job],
    resources={"paths": paths},
)
