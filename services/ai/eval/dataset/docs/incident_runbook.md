# Incident Response Runbook

Runbook RB-1. Owner: Platform team. Applies to Volga Cloud and the online store.

## Severity levels

- SEV-1: Volga Cloud or checkout is down for all customers, or customer data may be exposed. Page the on-call engineer immediately, day or night.
- SEV-2: a major feature is broken or slow for many customers, for example device alerts delayed by more than 10 minutes. Page during business hours, otherwise create an urgent ticket.
- SEV-3: a minor bug with a workaround. Create a ticket; it is handled in normal sprint work.

## First 15 minutes of a SEV-1

1. The on-call engineer acknowledges the page in PagerDuty within 5 minutes and becomes incident commander until handing over.
2. Open the #inc-war-room channel and post the incident summary.
3. Post a first update on status.volgahome.example within 15 minutes, then every 30 minutes until resolved.
4. If customer data may be exposed, add the security officer immediately (see the Information Security Policy).

## Known failure modes

- Primary database unavailable: follow runbook RB-7 (database failover). Failover to the replica takes about 4 minutes; do not restart the primary before the failover completes.
- Payment gateway errors above 5%: follow runbook RB-9. Switch checkout to the backup payment provider and inform Finance.
- MQTT broker overload (devices reconnecting in a storm): follow runbook RB-12 and enable connection rate limiting.

## After the incident

Write a blameless postmortem within 5 business days for every SEV-1 and SEV-2. It must include a timeline, the root cause, the customer impact and action items with owners. Postmortems are reviewed at the Thursday reliability meeting.
