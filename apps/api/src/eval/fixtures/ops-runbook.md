# Production Operations Runbook — Aurora Cloud Services

## Incident severity and paging

A Sev1 incident (customer-facing outage) must be acknowledged by the on-call engineer within 5 minutes of the page. Sev2 (degraded service) allows 15 minutes. If the primary on-call does not acknowledge within the window, PagerDuty escalates to the secondary after 15 minutes and to the engineering manager after 30.

## Communication during incidents

For Sev1 incidents, the public status page must be updated every 30 minutes until resolution, even if the update is "still investigating". Internal stakeholders follow the #incident channel; customer communication goes through support, never directly from engineers.

## Rollbacks

Any deploy can be reverted with `deployctl rollback --to previous`, which repoints the service to the prior image and completes in under two minutes. Database migrations are never rolled back automatically; use the paired down-migration and page the data team first.

## Database failover

Postgres failover to the standby replica is automated and takes approximately 90 seconds, during which writes fail and reads are served stale. Applications are expected to retry writes with backoff for at least 3 minutes to ride out a failover window.

## Backups and retention

Write-ahead logs are shipped every hour, and a full base backup is taken nightly at 02:00 UTC. Backups are retained for 35 days. The recovery time objective (RTO) is 1 hour and the recovery point objective (RPO) is 15 minutes. Application logs are retained for 30 days in cold storage.

## Error budgets

Each service has a monthly error budget of 0.1% of requests. When a service exhausts its budget, feature deploys freeze and only reliability work ships until the budget recovers. Budget consumption is reviewed in the Monday ops sync.

## Postmortems

Every Sev1 and any Sev2 lasting over an hour requires a blameless postmortem published within 48 hours of resolution. Action items must have owners and due dates, and are tracked weekly until closed.
