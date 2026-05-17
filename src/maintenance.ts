export type Powertrain = "ICE" | "EV" | "Both";

export type MaintenanceRule = {
	id: string;
	name: string;
	category: "Fluid" | "Filter" | "Wear" | "Inspection";
	powertrain: Powertrain;
	intervalMiles?: number;
	intervalMonths?: number;
	extendsToMiles?: number;
	extendsToMonths?: number;
	description: string;
	source: string;
};

export const MAINTENANCE_RULES: MaintenanceRule[] = [
	{
		id: "oil-and-filter",
		name: "Engine Oil & Filter",
		category: "Fluid",
		powertrain: "ICE",
		intervalMiles: 10_000,
		intervalMonths: 12,
		extendsToMiles: 12_000,
		description:
			"BMW recommends synthetic engine oil and filter replacement every ~10,000 mi or annually under the standard service schedule.",
		source: "BMW USA Maintenance Schedule",
	},
	{
		id: "cabin-air-filter",
		name: "Cabin Air Filter (microfilter)",
		category: "Filter",
		powertrain: "Both",
		intervalMiles: 22_500,
		intervalMonths: 24,
		extendsToMiles: 30_000,
		description:
			"Cabin microfilter affects HVAC airflow and window fogging. Replace every ~22.5k mi or every 2 years.",
		source: "BMW recommended schedule (i4/iX guides)",
	},
	{
		id: "engine-air-filter",
		name: "Engine Air Filter",
		category: "Filter",
		powertrain: "ICE",
		intervalMiles: 30_000,
		extendsToMiles: 45_000,
		description: "Replace at ~30k mi (sooner in dusty climates).",
		source: "BMW USA Maintenance Schedule",
	},
	{
		id: "brake-fluid",
		name: "Brake Fluid Flush",
		category: "Fluid",
		powertrain: "Both",
		intervalMonths: 24,
		description:
			"Brake fluid absorbs moisture; flush every 2 years regardless of mileage. Same on EVs.",
		source: "BMW Condition Based Service (CBS)",
	},
	{
		id: "spark-plugs",
		name: "Spark Plugs",
		category: "Wear",
		powertrain: "ICE",
		intervalMiles: 60_000,
		extendsToMiles: 75_000,
		description:
			"BMW iridium-tipped plugs typically last 60k–75k mi. Replace as a set.",
		source: "BMW USA Maintenance Schedule + dealer guidance",
	},
	{
		id: "auto-transmission-fluid",
		name: "Automatic Transmission Fluid",
		category: "Fluid",
		powertrain: "ICE",
		intervalMiles: 60_000,
		extendsToMiles: 100_000,
		description:
			"BMW labels ATF 'lifetime' but specialists recommend flushing every 60k–100k mi to extend transmission life.",
		source: "BMW factory guidance + independent specialist consensus",
	},
	{
		id: "hv-battery-coolant",
		name: "HV Battery Coolant",
		category: "Fluid",
		powertrain: "EV",
		intervalMiles: 75_000,
		intervalMonths: 60,
		extendsToMiles: 100_000,
		description:
			"High-voltage battery loop coolant; replace at ~75k mi or every 5 years (whichever first).",
		source: "BMW i4/iX maintenance guides",
	},
	{
		id: "engine-coolant",
		name: "Engine Coolant",
		category: "Fluid",
		powertrain: "ICE",
		intervalMiles: 60_000,
		intervalMonths: 48,
		description:
			"Drain and replace the engine coolant at ~60k mi or every 4 years.",
		source: "BMW USA Maintenance Schedule",
	},
	{
		id: "tire-rotation",
		name: "Tire Rotation",
		category: "Wear",
		powertrain: "Both",
		intervalMiles: 7_500,
		description:
			"Rotate tires every 7.5k mi to even out wear (skip if staggered fitment).",
		source: "BMW recommended practice",
	},
	{
		id: "wipers",
		name: "Wiper Blades",
		category: "Wear",
		powertrain: "Both",
		intervalMonths: 12,
		description: "Replace annually or when streaking is observed.",
		source: "BMW CBS",
	},
	{
		id: "annual-inspection",
		name: "Annual Inspection",
		category: "Inspection",
		powertrain: "Both",
		intervalMonths: 12,
		intervalMiles: 10_000,
		description:
			"Yearly check: brakes, suspension, lights, fluid levels, error codes.",
		source: "BMW USA Maintenance Schedule",
	},
];

export function rulesFor(powertrain: Powertrain): MaintenanceRule[] {
	if (powertrain === "Both") return MAINTENANCE_RULES;
	return MAINTENANCE_RULES.filter(
		(r) => r.powertrain === powertrain || r.powertrain === "Both",
	);
}

export function detectPowertrain(opts: {
	batteryRangeMi: number | null;
	batteryPct: number | null;
}): Powertrain {
	if (opts.batteryRangeMi != null && opts.batteryRangeMi > 0) return "EV";
	if (opts.batteryPct != null && opts.batteryPct > 0) return "EV";
	return "ICE";
}

export type Projection = {
	rule: MaintenanceRule;
	currentMileage: number;
	lastServiceMileage: number | null;
	lastServiceDate: string | null;
	projectedNextDueMileage: number | null;
	projectedNextDueDate: string | null;
	overdueByMiles: number;
	overdueByDays: number;
	status: "OK" | "SOON" | "DUE" | "OVERDUE";
};

const SOON_BUFFER_FRACTION = 0.1;
const DUE_BUFFER_MILES = 1_000;
const DUE_BUFFER_DAYS = 30;

export function projectMaintenance(
	rule: MaintenanceRule,
	currentMileage: number,
	now: Date,
	lastServiceMileage: number | null,
	lastServiceDate: string | null,
): Projection {
	let projectedNextDueMileage: number | null = null;
	let overdueByMiles = 0;
	if (rule.intervalMiles != null) {
		const baseMi = lastServiceMileage ?? currentMileage;
		projectedNextDueMileage = baseMi + rule.intervalMiles;
		overdueByMiles = Math.max(0, currentMileage - projectedNextDueMileage);
	}

	let projectedNextDueDate: string | null = null;
	let overdueByDays = 0;
	if (rule.intervalMonths != null) {
		const baseDate = lastServiceDate ? new Date(lastServiceDate) : now;
		const next = new Date(baseDate);
		next.setMonth(next.getMonth() + rule.intervalMonths);
		projectedNextDueDate = next.toISOString().slice(0, 10);
		const diffMs = now.getTime() - next.getTime();
		overdueByDays = Math.max(0, Math.floor(diffMs / 86_400_000));
	}

	const milesStatus = statusFromMiles(rule, currentMileage, projectedNextDueMileage);
	const timeStatus = statusFromDate(now, projectedNextDueDate);
	const status = mostSevere(milesStatus, timeStatus);

	return {
		rule,
		currentMileage,
		lastServiceMileage,
		lastServiceDate,
		projectedNextDueMileage,
		projectedNextDueDate,
		overdueByMiles,
		overdueByDays,
		status,
	};
}

function statusFromMiles(
	rule: MaintenanceRule,
	current: number,
	nextDue: number | null,
): "OK" | "SOON" | "DUE" | "OVERDUE" {
	if (nextDue == null || rule.intervalMiles == null) return "OK";
	const remaining = nextDue - current;
	const soonThreshold = rule.intervalMiles * SOON_BUFFER_FRACTION;
	if (remaining <= -DUE_BUFFER_MILES) return "OVERDUE";
	if (remaining <= 0) return "DUE";
	if (remaining <= soonThreshold) return "SOON";
	return "OK";
}

function statusFromDate(
	now: Date,
	nextDue: string | null,
): "OK" | "SOON" | "DUE" | "OVERDUE" {
	if (!nextDue) return "OK";
	const next = new Date(nextDue);
	const diffDays = (next.getTime() - now.getTime()) / 86_400_000;
	if (diffDays <= -DUE_BUFFER_DAYS) return "OVERDUE";
	if (diffDays <= 0) return "DUE";
	if (diffDays <= 30) return "SOON";
	return "OK";
}

const SEVERITY: Record<"OK" | "SOON" | "DUE" | "OVERDUE", number> = {
	OK: 0,
	SOON: 1,
	DUE: 2,
	OVERDUE: 3,
};

function mostSevere(
	a: "OK" | "SOON" | "DUE" | "OVERDUE",
	b: "OK" | "SOON" | "DUE" | "OVERDUE",
): "OK" | "SOON" | "DUE" | "OVERDUE" {
	return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function aggregateHealth(
	projections: Projection[],
): "green" | "yellow" | "red" {
	const worst = projections.reduce<"OK" | "SOON" | "DUE" | "OVERDUE">(
		(acc, p) => mostSevere(acc, p.status),
		"OK",
	);
	if (worst === "OVERDUE" || worst === "DUE") return "red";
	if (worst === "SOON") return "yellow";
	return "green";
}

const RULE_KEYWORDS: Record<string, string[]> = {
	"oil-and-filter": ["oil change", "oil and filter", "engine oil"],
	"cabin-air-filter": ["cabin", "microfilter"],
	"engine-air-filter": ["engine air filter", "air filter"],
	"brake-fluid": ["brake fluid"],
	"spark-plugs": ["spark plug"],
	"auto-transmission-fluid": ["transmission"],
	"hv-battery-coolant": ["battery coolant", "hv coolant"],
	"engine-coolant": ["coolant"],
	"tire-rotation": ["tire rotation", "rotate tires"],
	wipers: ["wiper"],
	"annual-inspection": ["inspection", "annual"],
};

export type CompletedService = {
	timeMs: number;
	odometerMi: number;
	taskDescriptions: string[];
};

export function findLatestServiceForRule(
	rule: MaintenanceRule,
	records: CompletedService[],
): CompletedService | null {
	const keywords = RULE_KEYWORDS[rule.id] ?? [rule.name.toLowerCase()];
	const matching = records.filter((r) =>
		r.taskDescriptions.some((d) =>
			keywords.some((k) => d.toLowerCase().includes(k.toLowerCase())),
		),
	);
	if (!matching.length) return null;
	return matching.reduce((latest, r) =>
		r.timeMs > latest.timeMs ? r : latest,
	);
}
