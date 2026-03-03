from dagster import schedule

from infra.dagster.build_asn_data_job import build_asn_data_job
from infra.dagster.create_new_rdns_rules_job import create_new_rdns_rules_job


@schedule(cron_schedule="30 */12 * * *", job=create_new_rdns_rules_job)
def create_new_rdns_rules_hourly_schedule():
    return {}


@schedule(cron_schedule="30 */12 * * *", job=build_asn_data_job)
def build_asn_data_hourly_schedule():
    return {
        "ops": {
            "upload_asn_mmdb_to_s3": {
                "config": {
                    "enabled": True,
                }
            },
            "upload_asn_sqlite_to_s3": {
                "config": {
                    "enabled": True,
                }
            },
        },
        "resources": {
            "paths": {
                "config": {
                    "work_dir": "/var/lib/nossl",
                    "bin_dir": "/opt/nossl/bin",
                }
            }
        },
    }
