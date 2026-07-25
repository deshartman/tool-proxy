// Seed data for the mock customer service. In-memory only — restarting the
// service wipes any state (there is none today; all reads).
//
// The FOCAL customer (first entry, used by the calendar fixture and by the
// "calling to check on my orders" demo path) is env-driven:
//
//   DEMO_CUSTOMER_NAME       given name           default "Dana"
//   DEMO_CUSTOMER_SURNAME    family name          default "Demo"
//   DEMO_CUSTOMER_PHONE      E.164 phone          default "+15551239999"
//
// Set these in examples/mock-backend/.env (gitignored) when you want live calls
// or SMS from your own phone to route through the demo. With nothing set,
// the mock still boots — falls back to Dana Demo on a 555 reserved-range
// number that can't collide with a real subscriber.
//
// The refund-eligibility demo fixtures (Alice/Bob/Carol on +1415555010{1,2,3}
// and the gift-order email purchaser@example.com) stay hardcoded — their
// orderId / age / status combinations exercise the three procedure branches
// (eligible / >30d / not-delivered), so they're behavior fixtures, not seed
// data an operator would want to swap out.

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

const FOCAL_NAME = process.env.DEMO_CUSTOMER_NAME ?? "Dana";
const FOCAL_SURNAME = process.env.DEMO_CUSTOMER_SURNAME ?? "Demo";
const FOCAL_PHONE = process.env.DEMO_CUSTOMER_PHONE ?? "+15551239999";

const CUSTOMERS: Customer[] = [
  {
    name: FOCAL_NAME,
    surname: FOCAL_SURNAME,
    phone: FOCAL_PHONE,
    interactions: [
      {
        orderId: "ord_focal_1",
        date: daysAgo(12),
        reason: "online purchase",
        resolution: "delivered to address",
        status: "delivered",
        channel: "web",
        amount: 89.50,
        currency: "USD",
      },
      {
        orderId: "ord_focal_2",
        date: daysAgo(3),
        reason: "online purchase",
        resolution: "in transit",
        status: "shipped",
        channel: "web",
        amount: 145.00,
        currency: "USD",
      },
      {
        orderId: "ord_focal_3",
        date: daysAgo(1),
        reason: "online purchase",
        resolution: "awaiting fulfillment",
        status: "pending",
        channel: "web",
        amount: 34.99,
        currency: "USD",
      },
      {
        orderId: "ord_focal_4",
        date: daysAgo(35),
        reason: "online purchase",
        resolution: "delivered to address",
        status: "delivered",
        channel: "web",
        amount: 59.95,
        currency: "USD",
      },
      {
        orderId: "ord_focal_5",
        date: daysAgo(62),
        reason: "online purchase",
        resolution: "delivered to address",
        status: "delivered",
        channel: "web",
        amount: 219.00,
        currency: "USD",
      },
      {
        orderId: "ord_focal_6",
        date: daysAgo(95),
        reason: "in-store purchase",
        resolution: "delivered at counter",
        status: "delivered",
        channel: "store",
        amount: 412.50,
        currency: "USD",
      },
      {
        orderId: "ord_focal_7",
        date: daysAgo(180),
        reason: "online purchase",
        resolution: "delivered to address",
        status: "delivered",
        channel: "web",
        amount: 78.40,
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

// The "focal" customer — first entry in CUSTOMERS — is the one calendar.ts
// seeds an appointment against for the reschedule demo. Exporting via this
// accessor (instead of hardcoding the phone in calendar.ts) means the env
// override for DEMO_CUSTOMER_PHONE also wires the calendar fixture to that
// same number automatically.
export function focalCustomer(): Customer {
  return CUSTOMERS[0];
}

export function mostRecent(customer: Customer): Interaction | undefined {
  if (customer.interactions.length === 0) return undefined;
  return [...customer.interactions].sort((a, b) => b.date.localeCompare(a.date))[0];
}
