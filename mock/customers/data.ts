// Seed data for the mock customer service. In-memory only — restarting the
// service wipes any state (there is none today; all reads).
//
// Two cohorts live here:
//
//   1. The Refund Eligibility demo fixtures (+1415555010{1,2,3} and the
//      gift-order email purchaser@example.com). These keep their original
//      orderId / age / status / amount so the procedure's three branches
//      (eligible / >30d / not-delivered) still fire as before.
//
//   2. Dana Demo (+15551239999) — the calling-to-check-on-orders demo
//      customer, with three interactions chosen to give the LLM something
//      to talk about: one refund-eligible delivered order, one shipped,
//      one pending. Number is in the 555 reserved range so it can never
//      collide with a real subscriber anywhere.

export interface Interaction {
  orderId: string;
  date: string;        // ISO 8601, set at module-load time relative to "now"
  reason: string;
  resolution: string;
  status: "delivered" | "pending" | "shipped" | "cancelled";
  channel: "web" | "store" | "phone";
  amount: number;
  currency: string;
}

export interface Customer {
  name: string;
  surname: string;
  phone?: string;      // E.164
  email?: string;
  interactions: Interaction[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

const CUSTOMERS: Customer[] = [
  {
    name: "Dana",
    surname: "Demo",
    phone: "+15551239999",
    interactions: [
      {
        orderId: "ord_dana_1",
        date: daysAgo(12),
        reason: "online purchase",
        resolution: "delivered to address",
        status: "delivered",
        channel: "web",
        amount: 89.50,
        currency: "USD",
      },
      {
        orderId: "ord_dana_2",
        date: daysAgo(3),
        reason: "online purchase",
        resolution: "in transit",
        status: "shipped",
        channel: "web",
        amount: 145.00,
        currency: "USD",
      },
      {
        orderId: "ord_dana_3",
        date: daysAgo(1),
        reason: "online purchase",
        resolution: "awaiting fulfillment",
        status: "pending",
        channel: "web",
        amount: 34.99,
        currency: "USD",
      },
    ],
  },
  {
    name: "Alice",
    surname: "Anderson",
    phone: "+14155550101",
    interactions: [{
      orderId: "ord_42",
      date: daysAgo(16),
      reason: "online purchase",
      resolution: "delivered to address",
      status: "delivered",
      channel: "web",
      amount: 42.10,
      currency: "USD",
    }],
  },
  {
    name: "Bob",
    surname: "Brown",
    phone: "+14155550102",
    interactions: [{
      orderId: "ord_77",
      date: daysAgo(47),
      reason: "in-store purchase",
      resolution: "delivered at counter",
      status: "delivered",
      channel: "store",
      amount: 128.99,
      currency: "USD",
    }],
  },
  {
    name: "Carol",
    surname: "Chen",
    phone: "+14155550103",
    interactions: [{
      orderId: "ord_91",
      date: daysAgo(8),
      reason: "online purchase",
      resolution: "awaiting fulfillment",
      status: "pending",
      channel: "web",
      amount: 19.50,
      currency: "USD",
    }],
  },
  {
    name: "Pat",
    surname: "Purchaser",
    email: "purchaser@example.com",
    interactions: [{
      orderId: "ord_gift_5",
      date: daysAgo(12),
      reason: "gift order",
      resolution: "delivered to recipient",
      status: "delivered",
      channel: "web",
      amount: 65.00,
      currency: "USD",
    }],
  },
];

function normalizePhone(raw: string): string {
  return raw.replace(/[\s()-]/g, "");
}

export function lookupByPhone(phone: string): Customer | undefined {
  const target = normalizePhone(phone);
  return CUSTOMERS.find(c => c.phone === target);
}

export function lookupByEmail(email: string): Customer | undefined {
  const target = email.trim().toLowerCase();
  return CUSTOMERS.find(c => c.email?.toLowerCase() === target);
}

export function lookupOrder(orderId: string): { customer: Customer; interaction: Interaction } | undefined {
  for (const customer of CUSTOMERS) {
    const interaction = customer.interactions.find(i => i.orderId === orderId);
    if (interaction) return { customer, interaction };
  }
  return undefined;
}

export function mostRecent(customer: Customer): Interaction | undefined {
  if (customer.interactions.length === 0) return undefined;
  return [...customer.interactions].sort((a, b) => b.date.localeCompare(a.date))[0];
}
