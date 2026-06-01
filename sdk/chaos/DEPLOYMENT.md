# Chaos Deployment

Chaos now lives in `cookbook` at `sdk/chaos`. Production runs on `trc4` from
`/srv/cookbook/sdk/chaos` as a Docker Compose service named `chaos`.

## Required Gates

Run these before deploying:

```bash
npm --prefix sdk/chaos ci
npm --prefix sdk/chaos test
npm --prefix sdk/chaos run build
```

## Runtime Files

Do not commit production secrets or live source routing.

Production keeps those files outside git:

```text
/etc/chaos/chaos.env
/etc/chaos/config/sources.yaml
```

The deploy workflow creates these from the previous `/opt/chaos` deployment
only when the `/etc/chaos` files do not already exist.

Chaos stores its SQLite database in the `chaos-data` Docker volume mounted at
`/app/data`.

## Deploy

Use `.github/workflows/chaos-deploy.yml`, or run the same commands manually on
`trc4`:

```bash
cd /srv/cookbook
git fetch origin --tags
git checkout main
git pull --ff-only origin main

cd sdk/chaos
sudo ln -sfn /etc/chaos/chaos.env .env
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build chaos
curl -fsS -H "Authorization: Bearer $(sudo sed -n 's/^CHAOS_TELEMETRY_TOKEN=//p' /etc/chaos/chaos.env)" \
  "http://127.0.0.1:3078/api/project-stats" >/dev/null
```

## Rollback

Roll back the cookbook ref, then rebuild the Compose service:

```bash
cd /srv/cookbook
git fetch origin --tags
git checkout main
git reset --hard <known-good-ref>
cd sdk/chaos
sudo docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build chaos
```
