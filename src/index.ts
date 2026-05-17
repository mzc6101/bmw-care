import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";
import { Smartcar, type Connection, type Snapshot, kmToMi } from "./smartcar.js";
import {
	MAINTENANCE_RULES,
	aggregateHealth,
	detectPowertrain,
	findLatestServiceForRule,
	projectMaintenance,
	rulesFor,
	type CompletedService,
	type Powertrain,
} from "./maintenance.js";

const worker = new Worker();
export default worker;

const smartcarApi = worker.pacer("smartcarApi", {
	allowedRequests: 5,
	intervalMs: 1000,
});

async function client(): Promise<Smartcar> {
	const id = process.env.SMARTCAR_CLIENT_ID ?? "";
	const secret = process.env.SMARTCAR_CLIENT_SECRET ?? "";
	if (!id || !secret) {
		throw new Error("SMARTCAR_CLIENT_ID and SMARTCAR_CLIENT_SECRET must be set");
	}
	return Smartcar.create(id, secret);
}

async function paced<T>(fn: () => Promise<T>): Promise<T> {
	await smartcarApi.wait();
	return fn();
}

async function gatherFleet(
	usePacer: boolean = true,
): Promise<Array<{ conn: Connection; snap: Snapshot }>> {
	const sc = await client();
	const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
		if (usePacer) return paced(fn);
		return fn();
	};
	const conns = await wrap(() => sc.connections());
	const out: Array<{ conn: Connection; snap: Snapshot }> = [];
	for (const conn of conns) {
		const snap = await wrap(() => sc.snapshot(conn.vehicleId, conn.userId));
		out.push({ conn, snap });
	}
	return out;
}

function recordsFor(snap: Snapshot): CompletedService[] {
	return snap.serviceRecords.map((r) => ({
		timeMs: r.time,
		odometerMi: Math.round(kmToMi(r.odometer)),
		taskDescriptions: r.tasks.map((t) => t.description),
	}));
}

const vehicles = worker.database("vehicles", {
	type: "managed",
	initialTitle: "Vehicles",
	primaryKeyProperty: "VIN",
	schema: {
		properties: {
			VIN: Schema.title(),
			Nickname: Schema.richText(),
			"Make/Model": Schema.richText(),
			Year: Schema.number(),
			Powertrain: Schema.select([
				{ name: "ICE", color: "gray" },
				{ name: "EV", color: "green" },
				{ name: "PHEV", color: "purple" },
			]),
			Mode: Schema.select([
				{ name: "live", color: "green" },
				{ name: "simulated", color: "blue" },
				{ name: "test", color: "yellow" },
			]),
			"Mileage (mi)": Schema.number(),
			"Fuel %": Schema.number(),
			"Fuel Range (mi)": Schema.number(),
			"Oil Life %": Schema.number(),
			"Battery %": Schema.number(),
			"Battery Range (mi)": Schema.number(),
			"Plugged In": Schema.checkbox(),
			Charging: Schema.checkbox(),
			"Is Locked": Schema.checkbox(),
			Latitude: Schema.number(),
			Longitude: Schema.number(),
			"Last Updated": Schema.date(),
		},
	},
});

const tires = worker.database("tires", {
	type: "managed",
	initialTitle: "Tire Pressure",
	primaryKeyProperty: "Wheel",
	schema: {
		properties: {
			Wheel: Schema.title(),
			VIN: Schema.richText(),
			Position: Schema.select([
				{ name: "FL", color: "default" },
				{ name: "FR", color: "default" },
				{ name: "RL", color: "default" },
				{ name: "RR", color: "default" },
			]),
			"Pressure (kPa)": Schema.number(),
			"Pressure (psi)": Schema.number(),
			"Last Updated": Schema.date(),
		},
	},
});

const alerts = worker.database("alerts", {
	type: "managed",
	initialTitle: "Alerts",
	primaryKeyProperty: "Alert ID",
	schema: {
		properties: {
			"Alert ID": Schema.title(),
			Severity: Schema.select([
				{ name: "info", color: "blue" },
				{ name: "warning", color: "yellow" },
				{ name: "critical", color: "red" },
			]),
			Headline: Schema.richText(),
			Detail: Schema.richText(),
			Source: Schema.select([
				{ name: "sync", color: "gray" },
				{ name: "webhook", color: "purple" },
			]),
			VIN: Schema.richText(),
			Created: Schema.date(),
		},
	},
});

const maintenanceSchedule = worker.database("maintenanceSchedule", {
	type: "managed",
	initialTitle: "Maintenance Schedule (BMW)",
	primaryKeyProperty: "Rule",
	schema: {
		properties: {
			Rule: Schema.title(),
			"Rule ID": Schema.richText(),
			Category: Schema.select([
				{ name: "Fluid", color: "blue" },
				{ name: "Filter", color: "yellow" },
				{ name: "Wear", color: "orange" },
				{ name: "Inspection", color: "green" },
			]),
			Powertrain: Schema.select([
				{ name: "ICE", color: "gray" },
				{ name: "EV", color: "green" },
				{ name: "Both", color: "default" },
			]),
			"Interval (mi)": Schema.number(),
			"Interval (months)": Schema.number(),
			"Extends to (mi)": Schema.number(),
			Description: Schema.richText(),
			Source: Schema.richText(),
		},
	},
});

const serviceRecords = worker.database("serviceRecords", {
	type: "managed",
	initialTitle: "Service Records",
	primaryKeyProperty: "Record ID",
	schema: {
		properties: {
			"Record ID": Schema.title(),
			VIN: Schema.richText(),
			Service: Schema.richText(),
			"Rule ID": Schema.richText(),
			"Mileage at Service": Schema.number(),
			"Service Date": Schema.date(),
			Cost: Schema.number(),
			"Performed By": Schema.richText(),
			Notes: Schema.richText(),
		},
	},
});

const vehicleHealth = worker.database("vehicleHealth", {
	type: "managed",
	initialTitle: "Vehicle Health",
	primaryKeyProperty: "Health ID",
	schema: {
		properties: {
			"Health ID": Schema.title(),
			VIN: Schema.richText(),
			Service: Schema.richText(),
			Category: Schema.select([
				{ name: "Fluid", color: "blue" },
				{ name: "Filter", color: "yellow" },
				{ name: "Wear", color: "orange" },
				{ name: "Inspection", color: "green" },
			]),
			Powertrain: Schema.select([
				{ name: "ICE", color: "gray" },
				{ name: "EV", color: "green" },
				{ name: "Both", color: "default" },
			]),
			Status: Schema.select([
				{ name: "OK", color: "green" },
				{ name: "SOON", color: "yellow" },
				{ name: "DUE", color: "orange" },
				{ name: "OVERDUE", color: "red" },
			]),
			"Current Mileage": Schema.number(),
			"Last Service Mileage": Schema.number(),
			"Last Service Date": Schema.date(),
			"Projected Next Due (mi)": Schema.number(),
			"Projected Next Due Date": Schema.date(),
			"Miles Until Due": Schema.number(),
			"Overdue by (mi)": Schema.number(),
			"Overdue by (days)": Schema.number(),
			"Last Updated": Schema.date(),
		},
	},
});

const vehicleHealthSummary = worker.database("vehicleHealthSummary", {
	type: "managed",
	initialTitle: "Vehicle Health Summary",
	primaryKeyProperty: "VIN",
	schema: {
		properties: {
			VIN: Schema.title(),
			"Overall Health": Schema.select([
				{ name: "green", color: "green" },
				{ name: "yellow", color: "yellow" },
				{ name: "red", color: "red" },
			]),
			Powertrain: Schema.select([
				{ name: "ICE", color: "gray" },
				{ name: "EV", color: "green" },
				{ name: "PHEV", color: "purple" },
			]),
			"Items OK": Schema.number(),
			"Items SOON": Schema.number(),
			"Items DUE": Schema.number(),
			"Items OVERDUE": Schema.number(),
			"Current Mileage": Schema.number(),
			"Last Updated": Schema.date(),
		},
	},
});

worker.sync("vehicleStatus", {
	database: vehicles,
	mode: "replace",
	schedule: "15m",
	execute: async () => {
		const fleet = await gatherFleet();
		const now = new Date().toISOString();
		const changes = fleet.map(({ conn, snap }) => ({
			type: "upsert" as const,
			key: snap.vin,
			properties: {
				VIN: Builder.title(snap.vin),
				Nickname: Builder.richText(snap.nickname),
				"Make/Model": Builder.richText(
					`${snap.make} ${snap.trim ?? snap.model}`,
				),
				Year: Builder.number(snap.year),
				Powertrain: Builder.select(snap.powertrain),
				Mode: Builder.select(conn.mode),
				"Mileage (mi)": Builder.number(snap.mileageMi),
				"Fuel %": Builder.number(snap.fuelPct ?? 0),
				"Fuel Range (mi)": Builder.number(snap.fuelRangeMi ?? 0),
				"Oil Life %": Builder.number(snap.oilLifePct ?? 0),
				"Battery %": Builder.number(snap.batteryPct ?? 0),
				"Battery Range (mi)": Builder.number(snap.batteryRangeMi ?? 0),
				"Plugged In": Builder.checkbox(!!snap.isPluggedIn),
				Charging: Builder.checkbox(!!snap.isCharging),
				"Is Locked": Builder.checkbox(!!snap.isLocked),
				Latitude: Builder.number(snap.latitude ?? 0),
				Longitude: Builder.number(snap.longitude ?? 0),
				"Last Updated": Builder.dateTime(now),
			},
		}));
		return { changes, hasMore: false };
	},
});

worker.sync("tiresSync", {
	database: tires,
	mode: "replace",
	schedule: "1h",
	execute: async () => {
		const fleet = await gatherFleet();
		const now = new Date().toISOString();
		const changes = [];
		for (const { snap } of fleet) {
			for (const t of snap.tires) {
				changes.push({
					type: "upsert" as const,
					key: `${snap.vin}_${t.position}`,
					properties: {
						Wheel: Builder.title(`${snap.vin} ${t.position}`),
						VIN: Builder.richText(snap.vin),
						Position: Builder.select(t.position),
						"Pressure (kPa)": Builder.number(Math.round(t.pressureKpa)),
						"Pressure (psi)": Builder.number(
							Math.round(t.pressureKpa * 0.1450377),
						),
						"Last Updated": Builder.dateTime(now),
					},
				});
			}
		}
		return { changes, hasMore: false };
	},
});

function makeAlertChange(o: {
	vin: string;
	severity: "info" | "warning" | "critical";
	id: string;
	headline: string;
	detail: string;
	now: string;
	source: "sync" | "webhook";
}) {
	return {
		type: "upsert" as const,
		key: o.id,
		properties: {
			"Alert ID": Builder.title(o.id),
			Severity: Builder.select(o.severity),
			Headline: Builder.richText(o.headline),
			Detail: Builder.richText(o.detail),
			Source: Builder.select(o.source),
			VIN: Builder.richText(o.vin),
			Created: Builder.dateTime(o.now),
		},
	};
}

worker.sync("alertsDerived", {
	database: alerts,
	mode: "replace",
	schedule: "15m",
	execute: async () => {
		const fleet = await gatherFleet();
		const now = new Date().toISOString();
		const changes = [];
		for (const { snap } of fleet) {
			if (snap.powertrain === "EV" && snap.batteryPct != null && snap.batteryPct < 20 && !snap.isPluggedIn) {
				changes.push(
					makeAlertChange({
						vin: snap.vin,
						severity: "warning",
						id: `${snap.vin}_lowSoc`,
						headline: "Low battery, not plugged in",
						detail: `Battery at ${snap.batteryPct}%. Plug in to recover overnight.`,
						now,
						source: "sync",
					}),
				);
			}
			if (snap.powertrain === "ICE" && snap.fuelPct != null && snap.fuelPct < 20) {
				changes.push(
					makeAlertChange({
						vin: snap.vin,
						severity: "warning",
						id: `${snap.vin}_lowFuel`,
						headline: "Low fuel level",
						detail: `Fuel at ${snap.fuelPct}% (~${snap.fuelRangeMi ?? 0} mi). Refuel soon.`,
						now,
						source: "sync",
					}),
				);
			}
			if (snap.oilLifePct != null && snap.oilLifePct < 15) {
				changes.push(
					makeAlertChange({
						vin: snap.vin,
						severity: "warning",
						id: `${snap.vin}_oilLife`,
						headline: "Oil life is low",
						detail: `Oil life remaining: ${snap.oilLifePct}%. Schedule an oil change.`,
						now,
						source: "sync",
					}),
				);
			}
			for (const d of snap.diagnostics) {
				if (d.status !== "OK") {
					changes.push(
						makeAlertChange({
							vin: snap.vin,
							severity: "warning",
							id: `${snap.vin}_diag_${d.code}`,
							headline: `Diagnostic: ${d.code.replace("diagnostics-", "")} = ${d.status}`,
							detail: `${d.code} reported status ${d.status}. Inspect at next opportunity.`,
							now,
							source: "sync",
						}),
					);
				}
			}
			for (const t of snap.tires) {
				if (t.pressureKpa < 220) {
					changes.push(
						makeAlertChange({
							vin: snap.vin,
							severity: "warning",
							id: `${snap.vin}_tire_${t.position}`,
							headline: `Tire pressure low (${t.position})`,
							detail: `${t.position} tire at ${t.pressureKpa.toFixed(0)} kPa (~${Math.round(t.pressureKpa * 0.1450377)} psi).`,
							now,
							source: "sync",
						}),
					);
				}
			}
		}
		return { changes, hasMore: false };
	},
});

worker.sync("maintenanceRules", {
	database: maintenanceSchedule,
	mode: "replace",
	schedule: "1d",
	execute: async () => {
		const changes = MAINTENANCE_RULES.map((rule) => ({
			type: "upsert" as const,
			key: rule.id,
			properties: {
				Rule: Builder.title(rule.name),
				"Rule ID": Builder.richText(rule.id),
				Category: Builder.select(rule.category),
				Powertrain: Builder.select(rule.powertrain),
				"Interval (mi)": Builder.number(rule.intervalMiles ?? 0),
				"Interval (months)": Builder.number(rule.intervalMonths ?? 0),
				"Extends to (mi)": Builder.number(rule.extendsToMiles ?? 0),
				Description: Builder.richText(rule.description),
				Source: Builder.richText(rule.source),
			},
		}));
		return { changes, hasMore: false };
	},
});

worker.sync("serviceRecordsSync", {
	database: serviceRecords,
	mode: "replace",
	schedule: "1h",
	execute: async () => {
		const fleet = await gatherFleet();
		const changes = [];
		for (const { snap } of fleet) {
			for (const r of snap.serviceRecords) {
				const date = new Date(r.time).toISOString().slice(0, 10);
				const taskDesc = r.tasks.map((t) => t.description).join("; ");
				const ruleMatch = MAINTENANCE_RULES.find((rule) => {
					const keywords = rule.name.toLowerCase().split(" ");
					return r.tasks.some((t) =>
						keywords.some((k) =>
							t.description.toLowerCase().includes(k),
						),
					);
				});
				changes.push({
					type: "upsert" as const,
					key: `${snap.vin}_${r.id}`,
					properties: {
						"Record ID": Builder.title(`${snap.vin} — ${r.id}`),
						VIN: Builder.richText(snap.vin),
						Service: Builder.richText(taskDesc),
						"Rule ID": Builder.richText(ruleMatch?.id ?? ""),
						"Mileage at Service": Builder.number(
							Math.round(kmToMi(r.odometer)),
						),
						"Service Date": Builder.date(date),
						Cost: Builder.number(r.cost?.amount ?? 0),
						"Performed By": Builder.richText(""),
						Notes: Builder.richText(
							r.details?.map((d) => d.description).join("; ") ?? "",
						),
					},
				});
			}
		}
		return { changes, hasMore: false };
	},
});

worker.sync("vehicleHealthOutlook", {
	database: vehicleHealth,
	mode: "replace",
	schedule: "30m",
	execute: async () => {
		const fleet = await gatherFleet();
		const now = new Date();
		const nowIso = now.toISOString();
		const changes = [];
		for (const { snap } of fleet) {
			const powertrain: Powertrain = snap.powertrain === "PHEV"
				? "Both"
				: snap.powertrain;
			const applicable = rulesFor(powertrain);
			const records = recordsFor(snap);
			for (const rule of applicable) {
				const last = findLatestServiceForRule(rule, records);
				const projection = projectMaintenance(
					rule,
					snap.mileageMi,
					now,
					last?.odometerMi ?? null,
					last ? new Date(last.timeMs).toISOString().slice(0, 10) : null,
				);
				const milesUntil =
					projection.projectedNextDueMileage != null
						? Math.max(
								0,
								projection.projectedNextDueMileage -
									projection.currentMileage,
							)
						: 0;
				changes.push({
					type: "upsert" as const,
					key: `${snap.vin}_${rule.id}`,
					properties: {
						"Health ID": Builder.title(`${snap.vin} — ${rule.name}`),
						VIN: Builder.richText(snap.vin),
						Service: Builder.richText(rule.name),
						Category: Builder.select(rule.category),
						Powertrain: Builder.select(rule.powertrain),
						Status: Builder.select(projection.status),
						"Current Mileage": Builder.number(
							Math.round(projection.currentMileage),
						),
						"Last Service Mileage": Builder.number(
							projection.lastServiceMileage ?? 0,
						),
						"Last Service Date": projection.lastServiceDate
							? Builder.date(projection.lastServiceDate)
							: Builder.richText(""),
						"Projected Next Due (mi)": Builder.number(
							projection.projectedNextDueMileage ?? 0,
						),
						"Projected Next Due Date": projection.projectedNextDueDate
							? Builder.date(projection.projectedNextDueDate)
							: Builder.richText(""),
						"Miles Until Due": Builder.number(milesUntil),
						"Overdue by (mi)": Builder.number(projection.overdueByMiles),
						"Overdue by (days)": Builder.number(projection.overdueByDays),
						"Last Updated": Builder.dateTime(nowIso),
					},
				});
			}
		}
		return { changes, hasMore: false };
	},
});

worker.sync("vehicleHealthRollup", {
	database: vehicleHealthSummary,
	mode: "replace",
	schedule: "30m",
	execute: async () => {
		const fleet = await gatherFleet();
		const now = new Date();
		const changes = [];
		for (const { snap } of fleet) {
			const powertrain: Powertrain = snap.powertrain === "PHEV"
				? "Both"
				: snap.powertrain;
			const applicable = rulesFor(powertrain);
			const records = recordsFor(snap);
			const projections = applicable.map((rule) => {
				const last = findLatestServiceForRule(rule, records);
				return projectMaintenance(
					rule,
					snap.mileageMi,
					now,
					last?.odometerMi ?? null,
					last ? new Date(last.timeMs).toISOString().slice(0, 10) : null,
				);
			});
			const overall = aggregateHealth(projections);
			const counts = projections.reduce(
				(acc, p) => {
					acc[p.status] += 1;
					return acc;
				},
				{ OK: 0, SOON: 0, DUE: 0, OVERDUE: 0 } as Record<
					"OK" | "SOON" | "DUE" | "OVERDUE",
					number
				>,
			);
			changes.push({
				type: "upsert" as const,
				key: snap.vin,
				properties: {
					VIN: Builder.title(snap.vin),
					"Overall Health": Builder.select(overall),
					Powertrain: Builder.select(snap.powertrain),
					"Items OK": Builder.number(counts.OK),
					"Items SOON": Builder.number(counts.SOON),
					"Items DUE": Builder.number(counts.DUE),
					"Items OVERDUE": Builder.number(counts.OVERDUE),
					"Current Mileage": Builder.number(snap.mileageMi),
					"Last Updated": Builder.dateTime(now.toISOString()),
				},
			});
		}
		return { changes, hasMore: false };
	},
});

worker.tool("getVehicleStatus", {
	title: "Get vehicle status",
	description:
		"Returns the current vehicle snapshot for the user's first connected vehicle: VIN, mileage, fuel/battery, range, oil life, location, locked state, tire pressures.",
	schema: j.object({}),
	execute: async (): Promise<any> => {
		const fleet = await gatherFleet(false);
		if (!fleet.length) {
			return {
				ok: false,
				message: "No vehicles connected via Smartcar.",
				vin: "",
				nickname: "",
				make: "",
				model: "",
				year: 0,
				powertrain: "Unknown",
				mileage_mi: 0,
				fuel_pct: 0,
				fuel_range_mi: 0,
				oil_life_pct: 0,
				battery_pct: 0,
				battery_range_mi: 0,
				is_locked: false,
				plugged_in: false,
				charging: false,
				latitude: 0,
				longitude: 0,
				tires: [],
			};
		}
		const { snap } = fleet[0];
		return {
			ok: true,
			message: "ok",
			vin: snap.vin,
			nickname: snap.nickname,
			make: snap.make,
			model: snap.model,
			year: snap.year,
			powertrain: snap.powertrain,
			mileage_mi: snap.mileageMi,
			fuel_pct: snap.fuelPct ?? 0,
			fuel_range_mi: snap.fuelRangeMi ?? 0,
			oil_life_pct: snap.oilLifePct ?? 0,
			battery_pct: snap.batteryPct ?? 0,
			battery_range_mi: snap.batteryRangeMi ?? 0,
			is_locked: !!snap.isLocked,
			plugged_in: !!snap.isPluggedIn,
			charging: !!snap.isCharging,
			latitude: snap.latitude ?? 0,
			longitude: snap.longitude ?? 0,
			tires: snap.tires.map((t) => ({
				position: t.position,
				pressure_kpa: Math.round(t.pressureKpa),
				pressure_psi: Math.round(t.pressureKpa * 0.1450377),
			})),
		};
	},
});

worker.tool("canIMakeIt", {
	title: "Can I make it?",
	description:
		"Given a one-way trip distance in miles, decides if the current fuel/charge covers it with a 15% safety reserve.",
	schema: j.object({
		destination_miles: j
			.number()
			.describe("One-way trip distance in miles."),
	}),
	execute: async ({ destination_miles }): Promise<any> => {
		const fleet = await gatherFleet(false);
		if (!fleet.length) {
			return {
				ok: false,
				destination_miles,
				range_mi: 0,
				safe_range_mi: 0,
				short_by_mi: 0,
				powertrain: "Unknown",
				reasoning: "No vehicles connected via Smartcar.",
			};
		}
		const { snap } = fleet[0];
		const rangeMi =
			snap.powertrain === "EV"
				? snap.batteryRangeMi ?? 0
				: snap.fuelRangeMi ?? 0;
		const reserve = 0.15;
		const safeRange = rangeMi * (1 - reserve);
		const fits = safeRange >= destination_miles;
		const shortBy = Math.max(0, destination_miles - safeRange);
		return {
			ok: fits,
			destination_miles,
			range_mi: Math.round(rangeMi),
			safe_range_mi: Math.round(safeRange),
			short_by_mi: Math.ceil(shortBy),
			powertrain: snap.powertrain,
			reasoning: fits
				? `Current ${snap.powertrain === "EV" ? "battery" : "fuel"} range ${Math.round(rangeMi)} mi covers ${destination_miles} mi with a 15% reserve.`
				: `Range ${Math.round(rangeMi)} mi short by ~${Math.ceil(shortBy)} mi (with 15% reserve). ${snap.powertrain === "EV" ? "Plan a charge stop." : "Plan a fuel stop."}`,
		};
	},
});

worker.tool("getMaintenanceStatus", {
	title: "Get maintenance status",
	description:
		"Returns BMW preventative-maintenance projections for the user's first connected vehicle: per-service status (OK/SOON/DUE/OVERDUE) using the built-in service history, overall health (green/yellow/red), current mileage, and the next services sorted by miles-until-due. Powertrain (ICE/EV) is auto-detected.",
	schema: j.object({
		horizon_miles: j
			.number()
			.describe("Optional miles-ahead window for 'next up' list. Default 10000.")
			.nullable(),
	}),
	execute: async ({ horizon_miles }): Promise<any> => {
		const horizon = horizon_miles ?? 10_000;
		const fleet = await gatherFleet(false);
		if (!fleet.length) {
			return {
				ok: false,
				message: "No vehicles connected via Smartcar.",
				vin: "",
				current_mileage: 0,
				powertrain: "Unknown",
				overall_health: "unknown",
				counts: { OK: 0, SOON: 0, DUE: 0, OVERDUE: 0 },
				items: [],
				next_up: [],
			};
		}
		const { snap } = fleet[0];
		const powertrain: Powertrain =
			snap.powertrain === "PHEV" ? "Both" : snap.powertrain;
		const applicable = rulesFor(powertrain);
		const records = recordsFor(snap);
		const now = new Date();
		const projections = applicable.map((rule) => {
			const last = findLatestServiceForRule(rule, records);
			return {
				rule,
				last,
				projection: projectMaintenance(
					rule,
					snap.mileageMi,
					now,
					last?.odometerMi ?? null,
					last ? new Date(last.timeMs).toISOString().slice(0, 10) : null,
				),
			};
		});
		const overall = aggregateHealth(projections.map((p) => p.projection));
		const items = projections.map(({ rule, last, projection }) => ({
			service: rule.name,
			rule_id: rule.id,
			category: rule.category,
			interval_mi: rule.intervalMiles ?? 0,
			interval_months: rule.intervalMonths ?? 0,
			extends_to_mi: rule.extendsToMiles ?? 0,
			last_service_mi: last?.odometerMi ?? 0,
			last_service_date: last
				? new Date(last.timeMs).toISOString().slice(0, 10)
				: "",
			projected_next_due_mi: projection.projectedNextDueMileage ?? 0,
			projected_next_due_date: projection.projectedNextDueDate ?? "",
			miles_until_due:
				projection.projectedNextDueMileage != null
					? Math.max(
							0,
							projection.projectedNextDueMileage -
								projection.currentMileage,
						)
					: 0,
			overdue_by_mi: projection.overdueByMiles,
			overdue_by_days: projection.overdueByDays,
			status: projection.status,
			description: rule.description,
		}));
		const next_up = items
			.filter((i) => i.miles_until_due > 0 && i.miles_until_due <= horizon)
			.sort(
				(a, b) =>
					(a.miles_until_due as number) - (b.miles_until_due as number),
			)
			.slice(0, 5);
		return {
			ok: true,
			message: "Maintenance projection computed.",
			vin: snap.vin,
			current_mileage: snap.mileageMi,
			powertrain: snap.powertrain,
			overall_health: overall,
			counts: projections.reduce(
				(acc, p) => {
					acc[p.projection.status] += 1;
					return acc;
				},
				{ OK: 0, SOON: 0, DUE: 0, OVERDUE: 0 } as Record<string, number>,
			),
			items,
			next_up,
		};
	},
});

worker.tool("logService", {
	title: "Log a service record",
	description:
		"Records that a maintenance item was performed on the user's vehicle. Returns the structured record; the user should add it to the Service Records database in Notion.",
	schema: j.object({
		service: j
			.string()
			.describe("Service name, e.g., 'Engine Oil & Filter', 'Brake Fluid Flush'."),
		mileage_at_service: j
			.number()
			.describe("Odometer reading at the time of service, in miles."),
		service_date: j
			.string()
			.describe("ISO date of the service (YYYY-MM-DD).")
			.nullable(),
		cost: j.number().describe("Service cost in USD.").nullable(),
		notes: j.string().describe("Free-form notes.").nullable(),
	}),
	execute: async ({
		service,
		mileage_at_service,
		service_date,
		cost,
		notes,
	}) => {
		const fleet = await gatherFleet(false);
		const vin = fleet[0]?.snap.vin ?? "";
		const date = service_date ?? new Date().toISOString().slice(0, 10);
		const ruleMatch = MAINTENANCE_RULES.find(
			(r) => r.name.toLowerCase() === service.toLowerCase(),
		);
		return {
			ok: true,
			vin,
			record_id: `${vin || "unknown"}_${service.replace(/\W+/g, "-").toLowerCase()}_${date}`,
			service,
			rule_id: ruleMatch?.id ?? "",
			mileage_at_service: Math.round(mileage_at_service),
			service_date: date,
			cost: cost ?? 0,
			notes: notes ?? "",
			next_action:
				"Add this row to the Service Records database in Notion. The vehicleHealthOutlook sync will reflect it on the next run.",
		};
	},
});

worker.webhook("smartcarEvents", {
	title: "Smartcar Events",
	description:
		"Receives vehicle state-change events from Smartcar. Note: Smartcar verification requires an HMAC challenge response which Notion Workers cannot produce; proxy via Cloudflare Worker for full verification.",
	execute: async (events) => {
		for (const event of events) {
			console.log(
				"Smartcar event:",
				JSON.stringify(event.body).slice(0, 800),
			);
		}
	},
});
