// Fictional technician calendar for the appointment-reschedule flow.
//
// One technician (Sam Reyes) holds 1-hour slots Mon-Fri 09:00–17:00 UTC.
// State (which slots are booked) lives in the appointments table on
// Postgres as of the MOCK-BACKEND-DB plan — retired the in-memory
// APPOINTMENTS[] array along with the boot-time focal-customer seed.
// The business logic (working-hours model, availability computation,
// nearby-slot suggestions, reschedule state machine) is unchanged.
//
// Times are UTC across the wire — the controller-side procedure formats
// them for the customer at SMS-render time. Keeping the tool surface in
// UTC means no TZ ambiguity in the appointmentId/start/end fields the
// procedure quotes.

import { query } from "./db.js";

export interface Appointment {
  appointmentId: string;
  customerPhone: string;
  customerName: string;
  agentName: string;
  start: string;       // ISO 8601 UTC
  end: string;         // start + 1h
  status: "scheduled" | "rescheduled" | "cancelled";
  rescheduledAt?: string;
  rescheduledFrom?: string;
}

interface AppointmentRow {
  id: string;
  customer_id: string;
  slot_start: Date;
  slot_end: Date;
  status: string;
  rescheduled_at: Date | null;
  rescheduled_from: Date | null;
  phone: string | null;
  name: string;
  surname: string;
}

const HOUR_MS = 60 * 60 * 1000;
const SLOT_LENGTH_MS = HOUR_MS;
const WORKDAY_START_HOUR = 9;   // inclusive
const WORKDAY_END_HOUR = 17;    // exclusive (last slot starts 16:00)
const HORIZON_DAYS = 60;
const TECHNICIAN = "Sam Reyes";

function isWorkingDayUTC(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

function isWithinWorkingHoursUTC(d: Date): boolean {
  if (!isWorkingDayUTC(d)) return false;
  const h = d.getUTCHours();
  if (h < WORKDAY_START_HOUR || h >= WORKDAY_END_HOUR) return false;
  // Slot must start exactly on the hour.
  return d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

function alignToHourUTC(d: Date): Date {
  const aligned = new Date(d);
  aligned.setUTCMinutes(0, 0, 0);
  return aligned;
}

function rowToAppointment(r: AppointmentRow): Appointment {
  return {
    appointmentId: r.id,
    customerPhone: r.phone ?? "",
    customerName: `${r.name} ${r.surname}`.trim(),
    agentName: TECHNICIAN,
    start: r.slot_start.toISOString(),
    end: r.slot_end.toISOString(),
    status: r.status as Appointment["status"],
    ...(r.rescheduled_at ? { rescheduledAt: r.rescheduled_at.toISOString() } : {}),
    ...(r.rescheduled_from ? { rescheduledFrom: r.rescheduled_from.toISOString() } : {}),
  };
}

const APPOINTMENT_JOIN_SELECT = `
  SELECT a.id, a.customer_id, a.slot_start, a.slot_end, a.status,
         a.rescheduled_at, a.rescheduled_from,
         c.phone, c.name, c.surname
    FROM appointments a JOIN customers c ON c.id = a.customer_id
`;

export async function findAppointmentByPhone(phone: string): Promise<Appointment | undefined> {
  const now = new Date();
  const { rows } = await query<AppointmentRow>(
    `${APPOINTMENT_JOIN_SELECT}
      WHERE c.phone = $1 AND a.status != 'cancelled' AND a.slot_start >= $2
      ORDER BY a.slot_start ASC LIMIT 1`,
    [phone, now],
  );
  return rows.length > 0 ? rowToAppointment(rows[0]) : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findAppointmentById(id: string): Promise<Appointment | undefined> {
  // A caller passing a non-UUID id (a stale tool-schema example, a wrong field
  // pulled from another response) must see "not found," not a raw Postgres
  // 22P02 surfaced as a 500 — treating this as a plain query miss.
  if (!UUID_RE.test(id)) return undefined;
  const { rows } = await query<AppointmentRow>(
    `${APPOINTMENT_JOIN_SELECT} WHERE a.id = $1 LIMIT 1`,
    [id],
  );
  return rows.length > 0 ? rowToAppointment(rows[0]) : undefined;
}

// Batch-load booked slots in the near horizon. checkAvailability's
// findNearbySlots walks 3 working days of hourly slots (up to 24 slots)
// and asks isSlotBooked for each. Doing 24 SELECTs per availability
// check is silly; one range query gives us a Set for O(1) lookup.
async function bookedSlotsInRange(from: Date, toExclusive: Date): Promise<Set<string>> {
  const { rows } = await query<{ slot_start: Date }>(
    `SELECT slot_start FROM appointments
      WHERE status != 'cancelled' AND slot_start >= $1 AND slot_start < $2`,
    [from, toExclusive],
  );
  return new Set(rows.map((r) => r.slot_start.toISOString()));
}

async function isSlotBooked(startISO: string): Promise<boolean> {
  const { rowCount } = await query(
    "SELECT 1 FROM appointments WHERE slot_start = $1 AND status != 'cancelled' LIMIT 1",
    [new Date(startISO)],
  );
  return (rowCount ?? 0) > 0;
}

export interface AvailabilityResult {
  requested: string;
  available: boolean;
  reason?: "outside_working_hours" | "in_the_past" | "slot_taken";
  daysFromNow: number;
  isSameDay: boolean;
  technician: string;
  suggestions: string[];
}

export async function checkAvailability(startISO: string): Promise<AvailabilityResult> {
  const requested = new Date(startISO);
  const aligned = alignToHourUTC(requested);
  const now = new Date();
  const daysFromNow = Math.floor(
    (Date.UTC(aligned.getUTCFullYear(), aligned.getUTCMonth(), aligned.getUTCDate())
      - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / (24 * HOUR_MS),
  );
  const isSameDay = daysFromNow === 0;

  let available = true;
  let reason: AvailabilityResult["reason"] | undefined;

  if (aligned.getTime() < now.getTime()) {
    available = false;
    reason = "in_the_past";
  } else if (!isWithinWorkingHoursUTC(aligned)) {
    available = false;
    reason = "outside_working_hours";
  } else if (await isSlotBooked(aligned.toISOString())) {
    available = false;
    reason = "slot_taken";
  }

  const suggestions = available ? [] : await findNearbySlots(aligned, 0);

  return {
    requested: startISO,
    available,
    reason,
    daysFromNow,
    isSameDay,
    technician: TECHNICIAN,
    suggestions,
  };
}

export interface RescheduleResult {
  ok: boolean;
  error?: "not_found" | "slot_taken" | "outside_working_hours" | "in_the_past";
  appointment?: Appointment;
}

export async function rescheduleAppointment(
  appointmentId: string,
  newStartISO: string,
): Promise<RescheduleResult> {
  const existing = await findAppointmentById(appointmentId);
  if (!existing) return { ok: false, error: "not_found" };

  const aligned = alignToHourUTC(new Date(newStartISO));
  if (aligned.getTime() < Date.now()) return { ok: false, error: "in_the_past" };
  if (!isWithinWorkingHoursUTC(aligned)) return { ok: false, error: "outside_working_hours" };
  if (await isSlotBooked(aligned.toISOString())) return { ok: false, error: "slot_taken" };

  const alignedEnd = new Date(aligned.getTime() + SLOT_LENGTH_MS);
  await query(
    `UPDATE appointments
        SET rescheduled_from = slot_start,
            slot_start = $2, slot_end = $3,
            status = 'rescheduled',
            rescheduled_at = now()
      WHERE id = $1`,
    [appointmentId, aligned, alignedEnd],
  );
  const updated = await findAppointmentById(appointmentId);
  if (!updated) return { ok: false, error: "not_found" };
  return { ok: true, appointment: updated };
}

// Walks every working-hour slot in the next HORIZON_DAYS, in calendar order,
// starting from the requested day. In-memory generator — no DB hop per slot.
export function* iterateWorkingSlotsFrom(start: Date): Generator<Date> {
  const horizon = new Date(start);
  horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);

  const anchor = new Date(start);
  anchor.setUTCHours(WORKDAY_START_HOUR, 0, 0, 0);

  for (let day = new Date(anchor); day < horizon; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!isWorkingDayUTC(day)) continue;
    for (let h = WORKDAY_START_HOUR; h < WORKDAY_END_HOUR; h++) {
      const slot = new Date(day);
      slot.setUTCHours(h, 0, 0, 0);
      yield slot;
    }
  }
}

// Returns every free hour across the next 3 working days from `requested`,
// skipping past slots, the requested slot itself, and anything already
// booked. Same algorithm as the pre-Postgres version — only the isSlotBooked
// check is now a Set lookup fed by one range query up front (bookedSlotsInRange)
// instead of a DB hop per slot.
export async function findNearbySlots(requested: Date, count: number): Promise<string[]> {
  const now = Date.now();
  const requestedISO = alignToHourUTC(requested).toISOString();
  const seenDays = new Set<string>();
  const slots: string[] = [];

  const horizon = new Date(requested);
  horizon.setUTCDate(horizon.getUTCDate() + 4);   // 3 working days + weekend buffer
  const booked = await bookedSlotsInRange(requested, horizon);

  for (const slot of iterateWorkingSlotsFrom(requested)) {
    if (slot.getTime() < now) continue;
    const slotISO = slot.toISOString();
    const dayKey = slotISO.slice(0, 10);
    if (!seenDays.has(dayKey) && seenDays.size >= 3) break;
    seenDays.add(dayKey);
    if (slotISO === requestedISO) continue;
    if (booked.has(slotISO)) continue;
    slots.push(slotISO);
  }

  return count > 0 ? slots.slice(0, count) : slots;
}

// ─────────────────────────────────────────────────────────────────────────
// Write path — used by server.ts's POST /appointments.
// ─────────────────────────────────────────────────────────────────────────

export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; error: "no_customer" | "slot_taken" | "outside_working_hours" | "in_the_past" };

export async function createAppointment(
  customerPhone: string,
  startISO: string,
): Promise<CreateAppointmentResult> {
  const aligned = alignToHourUTC(new Date(startISO));
  if (aligned.getTime() < Date.now()) return { ok: false, error: "in_the_past" };
  if (!isWithinWorkingHoursUTC(aligned)) return { ok: false, error: "outside_working_hours" };

  const { rows: customerRows } = await query<{ id: string }>(
    "SELECT id FROM customers WHERE phone = $1 LIMIT 1",
    [customerPhone],
  );
  if (customerRows.length === 0) return { ok: false, error: "no_customer" };
  const customerId = customerRows[0].id;

  const alignedEnd = new Date(aligned.getTime() + SLOT_LENGTH_MS);
  try {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO appointments (customer_id, slot_start, slot_end, status)
       VALUES ($1, $2, $3, 'scheduled') RETURNING id`,
      [customerId, aligned, alignedEnd],
    );
    const appt = await findAppointmentById(rows[0].id);
    if (!appt) throw new Error("appointment disappeared after insert");
    return { ok: true, appointment: appt };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { ok: false, error: "slot_taken" };
    throw err;
  }
}

export async function listAllAppointments(): Promise<Appointment[]> {
  const { rows } = await query<AppointmentRow>(
    `${APPOINTMENT_JOIN_SELECT} ORDER BY a.slot_start ASC`,
  );
  return rows.map(rowToAppointment);
}
