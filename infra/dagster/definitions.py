from dagster import Definitions

from infra.dagster.build_data_job import geofeed_finder_job, pdb_asn_geo_job, paths
from infra.dagster.build_asn_data_job import build_asn_data_job
from infra.dagster.build_geo_database_job import build_geo_database_job
from infra.dagster.create_new_rdns_rules_job import create_new_rdns_rules_job
from infra.dagster.schedules import (
    build_asn_data_hourly_schedule,
    create_new_rdns_rules_hourly_schedule,
)


defs = Definitions(
    jobs=[
        geofeed_finder_job,
        pdb_asn_geo_job,
        build_asn_data_job,
        build_geo_database_job,
        create_new_rdns_rules_job,
    ],
    resources={"paths": paths},
    schedules=[
        build_asn_data_hourly_schedule,
        create_new_rdns_rules_hourly_schedule,
    ],
)
