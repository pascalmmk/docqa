/**
 * Hand-written eval set: 30 Q/A pairs over the fixture docs.
 * `gold` is a distinctive substring of the chunk that should be retrieved —
 * a retrieval hit means some top-8 chunk contains it.
 * `expect` is what a faithful answer must convey (used by the LLM judge).
 */
export interface QAPair {
  doc: string;
  question: string;
  gold: string;
  expect: string;
}

export const QA_PAIRS: QAPair[] = [
  // aurora-handbook.md
  { doc: "aurora-handbook.md", question: "How many vacation days do employees get per year?", gold: "24 days of paid vacation", expect: "24 days" },
  { doc: "aurora-handbook.md", question: "How much unused vacation can roll over to next year?", gold: "up to a maximum of 10 days", expect: "10 days" },
  { doc: "aurora-handbook.md", question: "How long is parental leave and is it paid?", gold: "16 weeks of fully paid parental leave", expect: "16 weeks, fully paid" },
  { doc: "aurora-handbook.md", question: "What is the phased return option after parental leave?", gold: "60% hours at full pay for the first four weeks", expect: "60% hours at full pay for four weeks" },
  { doc: "aurora-handbook.md", question: "What percentage does the pension plan match?", gold: "up to 4% of gross salary", expect: "4%" },
  { doc: "aurora-handbook.md", question: "How much is the on-call stipend?", gold: "€450 per week carried", expect: "€450 per week" },
  { doc: "aurora-handbook.md", question: "What's the meal reimbursement limit for business travel?", gold: "up to €75 per person per day", expect: "€75 per person per day" },
  { doc: "aurora-handbook.md", question: "When are promotion packets due?", gold: "due in March and September", expect: "March and September" },
  { doc: "aurora-handbook.md", question: "How long is the probation period for new hires?", gold: "probation period of 90 days", expect: "90 days" },
  { doc: "aurora-handbook.md", question: "What hardware second factor is required for company systems?", gold: "hardware security key (YubiKey 5C)", expect: "a YubiKey 5C hardware key" },

  // atlas-spec.md
  { doc: "atlas-spec.md", question: "What is the default rate limit for Atlas API keys?", gold: "1,200 requests per minute per API key", expect: "1,200 requests per minute" },
  { doc: "atlas-spec.md", question: "What quota can enterprise contracts get?", gold: "12,000 requests per minute", expect: "12,000 requests per minute" },
  { doc: "atlas-spec.md", question: "What does Atlas return when a caller exceeds quota?", gold: "HTTP 429 with a Retry-After header", expect: "HTTP 429 with Retry-After" },
  { doc: "atlas-spec.md", question: "What is the p99 latency budget for cached routes?", gold: "80 milliseconds at p99 for cached routes", expect: "80 ms at p99" },
  { doc: "atlas-spec.md", question: "How often are HMAC signing keys rotated?", gold: "rotated every 30 days", expect: "every 30 days" },
  { doc: "atlas-spec.md", question: "How long does the old signing key stay valid during rotation?", gold: "48-hour grace window", expect: "48 hours" },
  { doc: "atlas-spec.md", question: "Which TLS versions does Atlas accept?", gold: "TLS 1.3 only", expect: "only TLS 1.3" },
  { doc: "atlas-spec.md", question: "What is the maximum request payload size?", gold: "maximum request payload is 4 MB", expect: "4 MB" },
  { doc: "atlas-spec.md", question: "When does the circuit breaker open?", gold: "more than 50% of requests fail within a 30-second window", expect: ">50% failures in 30 seconds" },
  { doc: "atlas-spec.md", question: "How much traffic does a canary deployment receive and for how long?", gold: "5% of traffic for 30 minutes", expect: "5% for 30 minutes" },

  // ops-runbook.md
  { doc: "ops-runbook.md", question: "How fast must a Sev1 page be acknowledged?", gold: "acknowledged by the on-call engineer within 5 minutes", expect: "within 5 minutes" },
  { doc: "ops-runbook.md", question: "When does PagerDuty escalate to the secondary on-call?", gold: "escalates to the secondary after 15 minutes", expect: "after 15 minutes" },
  { doc: "ops-runbook.md", question: "How often must the status page be updated during a Sev1?", gold: "updated every 30 minutes until resolution", expect: "every 30 minutes" },
  { doc: "ops-runbook.md", question: "What command rolls back a deploy?", gold: "deployctl rollback --to previous", expect: "deployctl rollback --to previous" },
  { doc: "ops-runbook.md", question: "How long does Postgres failover take?", gold: "takes approximately 90 seconds", expect: "about 90 seconds" },
  { doc: "ops-runbook.md", question: "How long are backups retained?", gold: "retained for 35 days", expect: "35 days" },
  { doc: "ops-runbook.md", question: "What are the RTO and RPO?", gold: "recovery time objective (RTO) is 1 hour", expect: "RTO 1 hour, RPO 15 minutes" },
  { doc: "ops-runbook.md", question: "What is the monthly error budget per service?", gold: "monthly error budget of 0.1%", expect: "0.1% of requests" },
  { doc: "ops-runbook.md", question: "What happens when a service exhausts its error budget?", gold: "feature deploys freeze", expect: "feature deploys freeze, only reliability work" },
  { doc: "ops-runbook.md", question: "How soon must a postmortem be published?", gold: "published within 48 hours of resolution", expect: "within 48 hours" },
];
