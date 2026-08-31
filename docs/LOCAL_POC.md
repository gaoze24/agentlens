# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the Volcengine Ark model API is remote.

## Start

Use the [reviewer runbook](RUNBOOK.md#3a-real-agent-execution-linuxmacos-local-poc)
for installation, private credential input, data locations, verification and
shutdown. This document contains only additional engine setup and troubleshooting.
The POC launcher reads exported shell variables, not `.env`. Colima uses the
Docker CLI; select Podman with `CONTAINER_ENGINE=podman`.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Return to the runbook's local POC
instructions and select `CONTAINER_ENGINE=podman` after entering credentials.

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
export CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential'
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Before starting through the runbook, the optional value above adds tools to the
runtime image. For troubleshooting, check engine and image readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
```

Check the public API health route with `curl http://127.0.0.1:3000/api/health`
after startup. A healthy API is not proof of working model credentials.
`/api/system` additionally requires the shared token when configured; inspect it
through the unlocked UI rather than displaying a token in a recorded terminal.

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
