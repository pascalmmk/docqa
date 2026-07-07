# Atlas API Gateway — Technical Specification (v2.3)

## Overview

Atlas is the edge gateway fronting all public Aurora Robotics APIs. It terminates TLS, authenticates callers, enforces quotas, and routes to internal services in two regions: eu-central-1 (primary) and us-east-2 (secondary).

## Rate limiting

The default quota is 1,200 requests per minute per API key, enforced with a sliding-window counter in the gateway's Redis cluster. Enterprise contracts can raise the quota to 12,000 requests per minute. When a caller exceeds quota, Atlas returns HTTP 429 with a Retry-After header and a machine-readable problem+json body.

## Latency budgets

The end-to-end latency budget is 80 milliseconds at p99 for cached routes and 250 milliseconds at p99 for uncached routes. The routing layer itself must add no more than 3 milliseconds at p50. Budgets are tracked per route in Grafana and breaching a budget for 3 consecutive days opens an automatic ticket.

## Authentication

Callers authenticate with HMAC-SHA256 request signatures. Signing keys are rotated every 30 days automatically; the previous key remains valid for a 48-hour grace window during rotation. Internal service-to-service calls use mutual TLS with SPIFFE identities instead of HMAC.

## Transport

Atlas accepts TLS 1.3 only; TLS 1.2 support was removed in v2.0. The maximum request payload is 4 MB; larger uploads must use the dedicated ingest service with presigned URLs.

## Resilience

Each upstream has a circuit breaker that opens when more than 50% of requests fail within a 30-second window, and half-opens after 20 seconds. The retry budget is 2 attempts per request with exponential backoff and jitter; retries are disabled for non-idempotent methods.

## Deployments

Atlas deploys through a canary pipeline: new versions receive 5% of traffic for 30 minutes before full rollout. Rollbacks are automatic if the canary's error rate exceeds twice the baseline. Gateway configuration lives in etcd and is watched live; config changes do not require a redeploy.
