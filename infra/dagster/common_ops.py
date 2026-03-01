from dagster import op
from datetime import datetime


@op
def build_date_tag(_context):
    return datetime.now().strftime("%Y%m%d")
