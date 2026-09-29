/** Small policy documents: short enough to index in a second, specific enough for a checkable cited answer. */
export const REFUND_POLICY = {
  filename: "refund-policy.txt",
  body: `Refund and returns policy

Customers can request a full refund within 30 days of delivery. The item must be unused and in its original packaging.
After 30 days and up to 90 days, we offer store credit instead of a refund.
Refunds are paid to the original payment method within 5 business days of the returned item arriving at the warehouse.`,
};

export const REFUND_QUESTION = "How many days do customers have to request a refund?";

export const SAMPLE_DOCS = [
  REFUND_POLICY,
  {
    filename: "shipping-and-delivery.txt",
    body: `Shipping and delivery

Orders placed before 14:00 ship the same business day from the Kazan warehouse.
Standard delivery takes 2-4 business days; express next-day delivery is available in Moscow and Saint Petersburg.
Shipping is free for orders over 5,000 RUB.`,
  },
  {
    filename: "expense-approval.txt",
    body: `Expense approval

Expenses up to 10,000 RUB are approved by the team lead.
Expenses from 10,000 to 100,000 RUB need approval from the department head.
Anything above 100,000 RUB, and all software subscriptions, must be approved by the CFO.`,
  },
  {
    filename: "support-incident-runbook.txt",
    body: `Support incident runbook

Severity 1: the checkout or payment flow is down. Page the on-call engineer immediately.
Severity 2: a feature is degraded for many customers. Notify the team lead within 30 minutes.
Severity 3: a single customer is affected. Handle in the normal support queue.`,
  },
];
