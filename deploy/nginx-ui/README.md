# Nginx-UI deployment

This Compose file runs [Nginx-UI](https://nginxui.com/) on the localhost-only
port `19000`. The host Nginx may optionally expose it through the tracked
`deploy/nginx/nginx-ui.conf` route; that route includes the WebSocket upgrade
headers required by the installation self-check and live status pages.

The container receives:

- `/etc/nginx` and `/var/log/nginx` for viewing and editing the host Nginx files;
- `/var/run/docker.sock` for viewing and managing Docker containers, including
  the Cube Compose stack;
- `./data` for the Nginx-UI database, settings, backups, and install secret.

The Docker socket is equivalent to root-level access on the host. Keep the
service bound to localhost and access it through an SSH tunnel unless a
deliberate authenticated reverse-proxy route is configured.

## First login

After `docker compose up -d`, open `http://127.0.0.1:19000` through an SSH
tunnel. The one-time installation secret is stored at
`/opt/nginx-ui/data/.install_secret` on the server and expires after 10 minutes.

## Host Nginx reloads

The host Nginx remains the authoritative 80/443 service. This container is
intentionally not attached to the host PID namespace, so use the host service
manager for a final reload after reviewing a change:

```sh
nginx -t && systemctl reload nginx
```

This keeps the host Nginx process and its PID file isolated from the Nginx
binary bundled in the Nginx-UI image.
