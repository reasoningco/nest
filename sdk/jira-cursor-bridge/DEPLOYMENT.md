# Jira Cursor Bridge Deployment

The bridge now lives in `cookbook` at `sdk/jira-cursor-bridge`. Production runs
on `trc4` from `/srv/cookbook/sdk/jira-cursor-bridge` under the
`jira-cursor-bridge` systemd unit.

## Required Gates

Run these before deploying:

```bash
npm --prefix sdk/jira-cursor-bridge ci
npm --prefix sdk/jira-cursor-bridge run typecheck
npm --prefix sdk/jira-cursor-bridge test
```

## Runtime Files

Production secrets stay outside git:

```text
/etc/jira-cursor-bridge.env
```

Durable SQLite state should live outside the checkout. The production env file
sets `DATA_DIR`, currently expected to point at `/var/lib/jira-cursor-bridge`.

## Deploy

Use `.github/workflows/jira-cursor-bridge-deploy.yml`, or run the same commands
manually on `trc4`:

```bash
cd /srv/cookbook
git fetch origin --tags
git checkout main
git pull --ff-only origin main

npm --prefix sdk/jira-cursor-bridge ci
npm --prefix sdk/jira-cursor-bridge run typecheck
npm --prefix sdk/jira-cursor-bridge test
sudo install -m 0644 sdk/jira-cursor-bridge/deploy/systemd/jira-cursor-bridge.service \
  /etc/systemd/system/jira-cursor-bridge.service
sudo systemctl daemon-reload
sudo systemctl restart jira-cursor-bridge
curl -fsS http://127.0.0.1:8787/healthz >/dev/null
```

## Rollback

Roll back the cookbook ref, reinstall dependencies, and restart the service:

```bash
cd /srv/cookbook
git fetch origin --tags
git checkout main
git reset --hard <known-good-ref>
npm --prefix sdk/jira-cursor-bridge ci
sudo systemctl restart jira-cursor-bridge
```
