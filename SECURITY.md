# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in Compose/ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state
- Trace/audit redaction does not sanitize all chat records or workspace files
- Command policy observes events and requests cancellation; it is not pre-execution approval
- Killing the process runner does not guarantee cleanup of every descendant process

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

The local POC launcher probes Landlock for `workspace-write`. If unavailable,
it warns and may fall back inside its disposable Docker/Podman runtime container.
The Compose/ECS image does not run that probe or automatically downgrade the
inner sandbox. Never infer that an unsupported host can safely disable sandboxing
for a direct host process. Neither deployment is hardened tenant isolation.

The runtime receives its model key through the environment and can attempt to
print or transmit it. Redaction of known values and credential patterns is a
defence in depth, not proof that secrets cannot enter events or raw chat output.
Do not share expanded Compose configuration or unreviewed logs/state directories.
