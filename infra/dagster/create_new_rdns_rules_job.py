from dagster import Field, job, op, in_process_executor

from infra.scripts.rdns_rules import (
    DEFAULT_API_BASE,
    DEFAULT_MAX_DOMAINS_PER_REQUEST,
    DEFAULT_MAX_HOSTS_PER_DOMAIN,
    DEFAULT_MIN_CONFIDENCE,
    DEFAULT_MODEL,
    DEFAULT_PGSQL_AUDIT_TABLE,
    DEFAULT_PGSQL_HOSTNAME_TABLE,
    DEFAULT_PGSQL_RULES_TABLE,
    run_generate_new_rdns_rules_pipeline,
)


@op(
    config_schema={
        "model": Field(
            str,
            is_required=False,
            default_value=DEFAULT_MODEL,
            description=f"OpenAI model name (default: {DEFAULT_MODEL}).",
        ),
        "api_base": Field(
            str,
            is_required=False,
            default_value=DEFAULT_API_BASE,
            description=f"OpenAI API base URL (default: {DEFAULT_API_BASE}).",
        ),
        "max_hosts_per_domain": Field(
            int,
            is_required=False,
            default_value=DEFAULT_MAX_HOSTS_PER_DOMAIN,
            description="Max hostnames to send per domain to the LLM.",
        ),
        "max_domains_per_request": Field(
            int,
            is_required=False,
            default_value=DEFAULT_MAX_DOMAINS_PER_REQUEST,
            description="Max domains grouped in a single LLM request.",
        ),
        "min_confidence": Field(
            str,
            is_required=False,
            default_value=DEFAULT_MIN_CONFIDENCE,
            description="Minimum accepted confidence from model output.",
        ),
        "pgsql_hostname_table": Field(
            str,
            is_required=False,
            default_value=DEFAULT_PGSQL_HOSTNAME_TABLE,
            description="PostgreSQL hostname reviews table.",
        ),
        "pgsql_rules_table": Field(
            str,
            is_required=False,
            default_value=DEFAULT_PGSQL_RULES_TABLE,
            description="PostgreSQL generated rules table.",
        ),
        "pgsql_audit_table": Field(
            str,
            is_required=False,
            default_value=DEFAULT_PGSQL_AUDIT_TABLE,
            description="PostgreSQL LLM audit table.",
        ),
        "dry_run": Field(
            bool,
            is_required=False,
            default_value=False,
            description="When true, do not finalize post-LLM classification updates.",
        ),
    }
)
def generate_new_rdns_rules(context):
    metrics = run_generate_new_rdns_rules_pipeline(
        model=context.op_config["model"],
        api_base=context.op_config["api_base"],
        max_hosts_per_domain=context.op_config["max_hosts_per_domain"],
        max_domains_per_request=context.op_config["max_domains_per_request"],
        min_confidence=context.op_config["min_confidence"],
        dry_run=bool(context.op_config["dry_run"]),
        pgsql=None,
        pgsql_hostname_table=context.op_config["pgsql_hostname_table"],
        pgsql_rules_table=context.op_config["pgsql_rules_table"],
        pgsql_audit_table=context.op_config["pgsql_audit_table"],
        log_sink=context.log.info,
    )
    if hasattr(context, "add_output_metadata"):
        metadata = {
            key: value
            for key, value in metrics.items()
            if isinstance(value, (int, float, bool, str))
        }
        if metadata:
            context.add_output_metadata(metadata)

    summary = " ".join(
        f"{key}={metrics[key]}"
        for key in (
            "mode",
            "pending_hosts",
            "matched_by_existing_rules",
            "remaining_for_llm",
            "rules_proposed",
            "rules_accepted",
            "rules_rejected",
            "final_matched",
            "final_unmatched",
            "final_unchecked",
        )
        if key in metrics
    )
    if summary:
        context.log.info(f"generate_new_rdns_rules_done {summary}")
    return metrics


@job(executor_def=in_process_executor)
def create_new_rdns_rules_job():
    generate_new_rdns_rules()
