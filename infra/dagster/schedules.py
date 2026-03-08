from dagster import schedule

from infra.dagster.build_data_job import geofeed_finder_job, pdb_asn_geo_job
from infra.dagster.build_asn_data_job import build_asn_data_job
from infra.dagster.build_geo_database_job import build_geo_database_job
from infra.dagster.create_new_rdns_rules_job import create_new_rdns_rules_job


@schedule(
    cron_schedule="0 2 * * *",
    execution_timezone="America/Los_Angeles",
    job=geofeed_finder_job,
)
def geofeed_finder_daily_schedule():
    return {
        "ops": {
            "geofeed_finder": {
                "config": {
                    "enable_pgsql": True,
                    "geofeed_limit": 5000,
                }
            }
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


@schedule(
    cron_schedule="0 */12 * * *",
    execution_timezone="America/Los_Angeles",
    job=pdb_asn_geo_job,
)
def pdb_asn_geo_twice_daily_schedule():
    return {
        "resources": {
            "paths": {
                "config": {
                    "work_dir": "/var/lib/nossl",
                    "bin_dir": "/opt/nossl/bin",
                }
            }
        }
    }


@schedule(
    cron_schedule="30 3,16 * * *",
    execution_timezone="America/Los_Angeles",
    job=build_geo_database_job,
)
def build_geo_database_twice_daily_schedule():
    return {
        "ops": {
            "run_rdns_geo": {
                "config": {
                    "unknown_ips_url": "http://nossl.sh/api/unknown",
                    "pgsql": "",
                }
            },
            "upload_geo_mmdb_to_s3": {
                "config": {
                    "enabled": True,
                }
            },
            "upload_geo_mmdb_to_github_release": {
                "config": {
                    "enabled": True,
                    "owner": "shingrus",
                    "repo": "nossl.sh",
                    "asset_name": "ip2geo-nossl-sh.mmdb"
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


@schedule(cron_schedule="30 */4 * * *", job=create_new_rdns_rules_job)
def create_new_rdns_rules_hourly_schedule():
    return {}


@schedule(cron_schedule="15 */12 * * *", job=build_asn_data_job)
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
            "upload_asn_mmdb_to_github_release": {
                "config": {
                    "enabled": True,
                    "owner": "shingrus",
                     "repo": "nossl.sh",
                     "asset_name": "ip2asn-nossl-sh.mmdb"
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
