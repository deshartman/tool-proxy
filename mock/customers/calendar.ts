// Fictional technician calendar for the appointment-reschedule demo.
//
// One technician (Sam Reyes) holds 1-hour slots Mon-Fri 09:00–17:00 UTC for
// the next 60 days from service-startup time. A handful of slots are
// pre-booked against seeded customer phones so `get_appointment` returns
// something real and `check_availability` has both available and unavailable
// cases to exercise.
//
// Times are UTC across the wire — the controller-side procedure formats them
// for the customer at SMS-render time. Keeping the tool surface in UTC means
// no TZ ambiguity in the appointmentId/start/end fields the procedure quotes.

import { randomBytes } from "node:crypto";

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

const HOUR_MS = 60 * 60 * 1000;
const SLOT_LENGTH_MS = HOUR_MS;
const WORKDAY_START_HOUR = 9;   // inclusive
const WORKDAY_END_HOUR = 17;    // exclusive (last slot starts 16:00)
const HORIZON_DAYS = 60;
const TECHNICIAN = "Sam Reyes";

function newAppointmentId(): string {
  return `apt_${randomBytes(5).toString("hex")}`;
}

function isWorkingDayUTC(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow >= 1 && dow <= 5;
}

function workingDayAtUTC(daysFromNow: number, hour: number): Date {
  const base = new Date();
  base.setUTCHours(hour, 0, 0, 0);
  base.setUTCDate(base.getUTCDate() + daysFromNow);
  // If we land on a weekend, walk forward to Monday.
  while (!isWorkingDayUTC(base)) {
    base.setUTCDate(base.getUTCDate() + 1);
  }
  return base;
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

// State is live in this module. The mock-customers process owns it; restart
// wipes it.
const APPOINTMENTS: Appointment[] = [];

function makeAppointment(
  customerPhone: string,
  customerName: string,
  start: Date,
): Appointment {
  return {
    appointmentId: newAppointmentId(),
    customerPhone,
    customerName,
    agentName: TECHNICIAN,
    start: start.toISOString(),
    end: new Date(start.getTime() + SLOT_LENGTH_MS).toISOString(),
    status: "scheduled",
  };
}

// Seed: Des is the focal customer (his is the appointment about to be
// rescheduled). Alice and Bob also have upcoming bookings so the calendar
// has realistic congestion.
APPOINTMENTS.push(
  makeAppointment("+61401277115", "Des Hartman",   workingDayAtUTC(14, 10)),
  makeAppointment("+14155550101", "Alice Anderson", workingDayAtUTC(2, 14)),
  makeAppointment("+14155550102", "Bob Brown",      workingDayAtUTC(7, 11)),
);

export function findAppointmentByPhone(phone: string): Appointment | undefined {
  const now = Date.now();
  return APPOINTMENTS
    .filter(a => a.customerPhone === phone && a.status !== "cancelled" && Date.parse(a.start) >= now)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
}

export function findAppointmentById(id: string): Appointment | undefined {
  return APPOINTMENTS.find(a => a.appointmentId === id);
}

function isSlotBooked(startISO: string): boolean {
  return APPOINTMENTS.some(
    a => a.status !== "cancelled" && a.start === startISO,
  );
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

export function checkAvailability(startISO: string): AvailabilityResult {
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
  } else if (isSlotBooked(aligned.toISOString())) {
    available = false;
    reason = "slot_taken";
  }

  const suggestions = available ? [] : findNearbySlots(aligned, 0);

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

export function rescheduleAppointment(
  appointmentId: string,
  newStartISO: string,
): RescheduleResult {
  const appt = findAppointmentById(appointmentId);
  if (!appt) return { ok: false, error: "not_found" };

  const aligned = alignToHourUTC(new Date(newStartISO));
  if (aligned.getTime() < Date.now()) return { ok: false, error: "in_the_past" };
  if (!isWithinWorkingHoursUTC(aligned)) return { ok: false, error: "outside_working_hours" };
  if (isSlotBooked(aligned.toISOString())) return { ok: false, error: "slot_taken" };

  appt.rescheduledFrom = appt.start;
  appt.start = aligned.toISOString();
  appt.end = new Date(aligned.getTime() + SLOT_LENGTH_MS).toISOString();
  appt.status = "rescheduled";
  appt.rescheduledAt = new Date().toISOString();
  return { ok: true, appointment: appt };
}

// Walks every working-hour slot in the next HORIZON_DAYS, in calendar order,
// starting from the requested day. Used by findNearbySlots to know which
// candidates to consider.
export function* iterateWorkingSlotsFrom(start: Date): Generator<Date> {
  const horizon = new Date(start);
  horizon.setUTCDate(horizon.getUTCDate() + HORIZON_DAYS);

  // Anchor at the requested day's first working slot (09:00 UTC).
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

// ──────────────────────────────────────────────────────────────────────────
// USER CONTRIBUTION POINT
// ──────────────────────────────────────────────────────────────────────────
// Implement findNearbySlots to drive the "Offer 3 nearby slots if they are
// flexible" step of the reschedule procedure.
//
// Strategy (already chosen in chat): "same day first, then next days".
//   1. Same calendar date as `requested`: offer the other free hourly slots
//      on that day (later first, then earlier — humans usually accept "a bit
//      later today" before "a bit earlier today", but feel free to invert).
//   2. If we still need more, walk forward through subsequent working days
//      and pick the earliest free slot on each.
//   3. Stop once we have `count` results, or when we run out of horizon.
//
// Available helpers (above):
//   - iterateWorkingSlotsFrom(date)      → Generator<Date>, calendar order
//   - isSlotBooked(slotISO)              → boolean
//   - alignToHourUTC(date)               → Date snapped to top of the hour
//
// Skip slots that are in the past (Date.now() comparison) and slots that
// equal `requested` itself (no point offering the slot we know is taken).
// Return ISO strings.
//
// Returns every free hour across the next 3 working days from `requested`,
// skipping past slots, the requested slot itself, and anything already
// booked. Walks the calendar in order; weekends are skipped by the iterator
// (the technician doesn't work weekends), so a Friday seed naturally spans
// across the weekend onto Mon/Tue. The `count` arg is the upper-bound cap
// the caller is willing to receive — applied last so we don't truncate
// before covering the 3-day window.
export function findNearbySlots(requested: Date, count: number): string[] {
  const now = Date.now();
  const requestedISO = alignToHourUTC(requested).toISOString();
  const seenDays = new Set<string>();
  const slots: string[] = [];

  for (const slot of iterateWorkingSlotsFrom(requested)) {
    if (slot.getTime() < now) continue;
    const slotISO = slot.toISOString();
    const dayKey = slotISO.slice(0, 10);
    if (!seenDays.has(dayKey) && seenDays.size >= 3) break;
    seenDays.add(dayKey);
    if (slotISO === requestedISO) continue;
    if (isSlotBooked(slotISO)) continue;
    slots.push(slotISO);
  }

  return count > 0 ? slots.slice(0, count) : slots;
}

export function listAllAppointments(): Appointment[] {
  return [...APPOINTMENTS];
}
