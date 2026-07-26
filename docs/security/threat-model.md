# Phase-one threat model

This document defines the implemented security boundary and its limits. Read it
with the [runtime architecture](../architecture/runtime-kernel.md) and
[deployment guide](../operations/deployment-topologies.md).

## Security posture and trust boundaries

Phase one assumes administrators, Main processes, configured drivers, and
artifact trust configuration are trusted. Plugin manifests and artifact bytes
are untrusted input until validation completes. Remote Worker network input is
untrusted until the authenticated session is ready. Plugin JavaScript is not
assumed safe enough to run in the Main process, but the runtime does not claim
to contain hostile native code or a compromised host.

The principal trust boundaries are:

| Boundary | Implemented checks | Limit |
| --- | --- | --- |
| Artifact ingress | deterministic archive parsing, path and size limits, SHA-256 identity, data-only manifest validation, compatibility checks | A valid plugin still contains executable JavaScript |
| Signing | optional Ed25519 signature verification against configured trust keys | The default CLI-composed runtime has optional trust with no configured keys |
| Deployment | requested permission envelope, granted subset, capability resolution, placement, executor support | Grants are application policy, not host sandbox policy |
| Component RPC | exact message shapes, capability schemas, permission checks, bounded payloads | Direct Node.js APIs available inside plugin code are outside these RPC checks |
| Child process | authenticated framed channel, empty configured environment, secret redaction from retained stderr | The child shares the host user, filesystem namespace, and kernel |
| Worker session | separate bootstrap credential, identity-bound proof, sequence and replay checks, bounded frames, heartbeat and epoch fencing | A bootstrap credential is a bearer secret; built-in listening is plain WebSocket |
| PostgreSQL | shared persistence, advisory-lock leadership, fencing epochs, CAS revisions | Database credentials and transport security are deployment responsibilities |

This phase is not an operating-system sandbox. It does not provide multi-tenant
host isolation, container policy, syscall filtering, or native-code
containment.

## Permission model and limits

A manifest requests a maximum envelope. A deployment grants a subset. Granting
anything outside the request blocks the deployment before component import.
The supported permission kinds are:

- `capability`: exact capability names and methods;
- `executor`: process, remote, or thread;
- `filesystem`: absolute logical POSIX roots and read/write access;
- `network`: exact DNS names, ports, and HTTP methods;
- `secret`: exact secret names;
- `environment`: exact environment-variable names;
- `worker`: required labels and CPU, memory, and storage ceilings.

Capability and secret calls made through the component context are checked
against both requested and granted permissions. Executor and Worker grants
participate in placement. Capability requests and responses also pass their
registered runtime schemas.

The filesystem, network, and environment permission contracts establish
validation and authorization points, but phase one does not interpose on every
direct Node.js builtin call made by plugin code. Packaging allows static imports
of Node builtins. Therefore a permission grant is not proof that the operating
system has denied all other access. Deploy higher-risk code only inside an
additional host-level isolation boundary.

## Thread, process, and remote isolation

Thread execution is explicitly not a security boundary. A Worker Thread shares
the Main process, user privileges, and process resources. It is useful for
placement and concurrency, not hostile-code containment.

Process execution has a separate address space, an authenticated IPC protocol,
and a child environment configured as empty by the built-in process host. The
executor reports security isolation, but it is not an operating-system sandbox:
the child still runs as the same host user and can use allowed Node builtins.

Remote execution separates Main and Worker hosts. Its actual isolation depends
on how the Worker host, operating-system account, network, and artifact cache
are provisioned. The protocol fences sessions and attempt state; it does not
attest the remote machine.

The runtime placement preference starts with process, then thread, then remote.
An explicit manifest declaration and deployment grant are still required.

## Secrets

Secrets enter through the bootstrap-only `SecretProvider`. Plugin contexts can
request only exact names allowed by both the manifest and deployment. The
provider's backing configuration is not serialized into plugin context or wire
contracts.

`@tegojs/drivers-local` supplies `DevelopmentSecretProvider`, which is marked
development-only. Do not treat it as a production secret manager. Process
stderr collection redacts secret values observed through the provider and
common credential-shaped fields, but logs are not a safe secret transport.

Worker bootstrap credentials must be passed separately from WebSocket URLs.
The CLI rejects URLs containing username or password fields. Protect
credentials in a secret manager, rotate them after exposure, and avoid command
history or logs.

## Network exposure

The local control endpoint is a Unix-domain socket or Windows named pipe, not an
HTTP server. Its parent directory must be private, and each connection carries
one bounded request.

Worker transport accepts `ws:` and `wss:` for outbound connections. The
built-in Main listener uses a WebSocket upgrade on `node:http`, so deployments
that cross an untrusted network need external TLS termination or an equivalent
protected network path. Authentication does not provide confidentiality.

Protocol limits bound control frames, binary payloads and chunks, sequence
gaps, replay retention, pending correlations, and in-flight requests.
Heartbeat expiry removes a Worker from placement. Never expose PostgreSQL or a
Worker listener broadly without network policy and database TLS appropriate to
the environment.

## Deferred security capabilities

Phase one defers:

- an HTTP authentication or authorization service;
- OS-grade plugin sandboxing, containers, seccomp, and Kubernetes policy;
- arbitrary-language or native-code plugins;
- production secret-manager integrations;
- certificate issuance, TLS termination, and Worker attestation;
- Tego 1.x ACL compatibility.

Production release also remains gated on Node.js 26 reaching LTS. The current
packages are unpublished and their APIs are still evolving.
