from dagster import schedule

from infra.dagster.create_new_rdns_rules_job import create_new_rdns_rules_job


@schedule(cron_schedule="30 */12 * * *", job=create_new_rdns_rules_job)
def create_new_rdns_rules_hourly_schedule():
    return {}
