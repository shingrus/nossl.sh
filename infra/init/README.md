# Dagster Agent Provisioning

This directory includes a simple Ubuntu 24.04 bootstrap path for the
Dagster Cloud agent using a native `systemd` service.

## What it installs

- Repo sync into `/opt/nossl/repo`
- Runtime directories:
  - `/opt/nossl/bin`
  - `/opt/nossl/dagster_home`
  - `/var/lib/nossl`
- Systemd unit: `/etc/systemd/system/dagster-cloud-agent.service`
- Env file template: `/etc/dagster-agent.env`
- Dagster config template: `/opt/nossl/dagster_home/dagster.yaml`

The schedules already point Dagster jobs at `/var/lib/nossl` and `/opt/nossl/bin`
in `infra/dagster/schedules.py`, and `geofeed_finder` also reads
`infra/geofeeds.txt` from `/opt/nossl/repo`.

## Use

Run the provisioner as root from a checkout of this repo:

```bash
sudo bash infra/init/provision-dagster-agent-vm.sh
```

Then fill in:

- `/opt/nossl/dagster_home/dagster.yaml`
- `/etc/dagster-agent.env`

Start and inspect the service:

```bash
sudo systemctl start dagster-cloud-agent
sudo systemctl status dagster-cloud-agent
sudo journalctl -u dagster-cloud-agent -n 50 --no-pager
```

## Scope

The provisioner does not install OS packages, build binaries, or create the
Dagster virtualenv. It only creates the expected filesystem layout, copies the
repo, installs the systemd unit, and drops config templates.
