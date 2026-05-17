const TOKEN_URL = "https://iam.smartcar.com/oauth2/token";
const API_BASE = "https://vehicle.api.smartcar.com/v3";

const KM_PER_MILE = 1.609344;
const MI_PER_KM = 1 / KM_PER_MILE;

export type Connection = {
	id: string;
	vehicleId: string;
	userId: string;
	make: string;
	model: string;
	year: number;
	mode: "live" | "simulated" | "test";
	powertrainType: "ICE" | "EV" | "PHEV" | string;
	createdAt: string;
};
export type SignalEnvelope = {
	id: string;
	type: "signal";
	attributes: {
		code: string;
		name: string;
		group: string;
		status: { value: "SUCCESS" | "ERROR" | string };
		body?: Record<string, unknown>;
	};
	meta: {
		ingestedAt?: string;
		retrievedAt?: string;
		oemUpdatedAt?: string;
	};
};
export type ServiceRecord = {
	id: string;
	time: number;
	odometer: number;
	tasks: Array<{ id: string; description: string }>;
	details?: Array<{ id: string; description: string }>;
	cost?: { currency: string; amount: number };
};
export type Snapshot = {
	vin: string;
	nickname: string;
	make: string;
	model: string;
	year: number;
	powertrain: "ICE" | "EV" | "PHEV";
	mileageMi: number;
	fuelPct: number | null;
	fuelRangeMi: number | null;
	oilLifePct: number | null;
	batteryPct: number | null;
	batteryRangeMi: number | null;
	isCharging: boolean | null;
	isPluggedIn: boolean | null;
	latitude: number | null;
	longitude: number | null;
	speedKmh: number | null;
	isLocked: boolean | null;
	exteriorColor: string | null;
	trim: string | null;
	tires: Array<{ position: "FL" | "FR" | "RL" | "RR"; pressureKpa: number }>;
	diagnostics: Array<{ code: string; status: string }>;
	serviceRecords: ServiceRecord[];
	signalsAt: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getM2MToken(
	clientId: string,
	clientSecret: string,
): Promise<string> {
	const now = Date.now();
	if (cachedToken && now < cachedToken.expiresAt - 60_000) {
		return cachedToken.token;
	}
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: clientId,
		client_secret: clientSecret,
	});
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!res.ok) {
		throw new Error(
			`Smartcar M2M token ${res.status}: ${await res.text()}`,
		);
	}
	const data = (await res.json()) as {
		access_token: string;
		expires_in: number;
	};
	cachedToken = {
		token: data.access_token,
		expiresAt: Date.now() + data.expires_in * 1000,
	};
	return data.access_token;
}

export class Smartcar {
	private constructor(private readonly bearer: string) {}

	static async create(
		clientId: string,
		clientSecret: string,
	): Promise<Smartcar> {
		const bearer = await getM2MToken(clientId, clientSecret);
		return new Smartcar(bearer);
	}

	private async get<T>(
		path: string,
		userId?: string,
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.bearer}`,
		};
		if (userId) headers["sc-user-id"] = userId;
		const res = await fetch(`${API_BASE}${path}`, { headers });
		if (!res.ok) {
			throw new Error(
				`Smartcar GET ${path} ${res.status}: ${await res.text()}`,
			);
		}
		return res.json() as Promise<T>;
	}

	async connections(): Promise<Connection[]> {
		const r = await this.get<{ data: any[] }>("/connections");
		return r.data.map((c) => ({
			id: c.id,
			vehicleId: c.relationships?.vehicle?.data?.id ?? "",
			userId: c.relationships?.user?.data?.id ?? "",
			make: c.attributes?.vehicle?.make ?? "",
			model: c.attributes?.vehicle?.model ?? "",
			year: c.attributes?.vehicle?.year ?? 0,
			mode: c.attributes?.vehicle?.mode ?? "live",
			powertrainType: c.attributes?.vehicle?.powertrainType ?? "",
			createdAt: c.meta?.createdAt ?? "",
		}));
	}

	async signals(vehicleId: string, userId: string): Promise<SignalEnvelope[]> {
		const r = await this.get<{ data: SignalEnvelope[] }>(
			`/vehicles/${vehicleId}/signals`,
			userId,
		);
		return r.data;
	}

	async snapshot(vehicleId: string, userId: string): Promise<Snapshot> {
		const signals = await this.signals(vehicleId, userId);
		const map = new Map<string, SignalEnvelope>();
		for (const s of signals) {
			map.set(s.attributes.code, s);
		}
		const val = <T = unknown>(code: string, key = "value"): T | null => {
			const sig = map.get(code);
			if (!sig || sig.attributes.status.value !== "SUCCESS") return null;
			const body = sig.attributes.body ?? {};
			return (body as Record<string, unknown>)[key] as T;
		};
		const body = <T = unknown>(code: string): T | null => {
			const sig = map.get(code);
			if (!sig || sig.attributes.status.value !== "SUCCESS") return null;
			return (sig.attributes.body ?? null) as T | null;
		};

		const mileageKm = (val<number>("odometer-traveleddistance") ?? 0);
		const fuelPct = val<number>("internalcombustionengine-fuellevel");
		const fuelRangeKm = val<number>("internalcombustionengine-range");
		const oilLifePct = val<number>("internalcombustionengine-oillife");
		const batteryPct = val<number>("highvoltagebattery-stateofcharge");
		const batteryRangeKm = val<number>("highvoltagebattery-range");
		const isCharging = val<boolean>("highvoltagebattery-ischarging");
		const isPluggedIn = val<boolean>("highvoltagebattery-ispluggedin");
		const locBody = body<{
			latitude?: number;
			longitude?: number;
		}>("location-preciselocation");
		const speedKmh = val<number>("motion-currentspeed");
		const isLocked = val<boolean>("closure-islocked");

		const tiresBody = body<{
			values?: Array<{
				row: number;
				column: number;
				tirePressure: number;
			}>;
		}>("wheel-tires");
		const tires: Array<{
			position: "FL" | "FR" | "RL" | "RR";
			pressureKpa: number;
		}> = [];
		if (tiresBody?.values) {
			for (const t of tiresBody.values) {
				const pos = (
					t.row === 0 && t.column === 0
						? "FL"
						: t.row === 0 && t.column === 1
							? "FR"
							: t.row === 1 && t.column === 0
								? "RL"
								: "RR"
				) as "FL" | "FR" | "RL" | "RR";
				tires.push({ position: pos, pressureKpa: t.tirePressure });
			}
		}

		const serviceRecordsBody = body<{ values?: ServiceRecord[] }>(
			"service-records",
		);
		const serviceRecords = serviceRecordsBody?.values ?? [];

		const diagnostics: Array<{ code: string; status: string }> = [];
		for (const s of signals) {
			if (
				s.attributes.code.startsWith("diagnostics-") &&
				s.attributes.status.value === "SUCCESS"
			) {
				const b = s.attributes.body as
					| { status?: string }
					| undefined;
				diagnostics.push({
					code: s.attributes.code,
					status: b?.status ?? "UNKNOWN",
				});
			}
		}

		const powertrain = (
			batteryPct != null && fuelPct == null
				? "EV"
				: fuelPct != null && batteryPct != null
					? "PHEV"
					: "ICE"
		) as "EV" | "PHEV" | "ICE";

		const mileageMi = Math.round(mileageKm * MI_PER_KM);
		const fuelRangeMi =
			fuelRangeKm != null ? Math.round(fuelRangeKm * MI_PER_KM) : null;
		const batteryRangeMi =
			batteryRangeKm != null
				? Math.round(batteryRangeKm * MI_PER_KM)
				: null;

		return {
			vin: (val<string>("vehicleidentification-vin") ?? "") as string,
			nickname:
				(val<string>("vehicleidentification-nickname") ?? "BMW") as string,
			make: "BMW",
			model:
				(val<string>("vehicleidentification-trim") ?? "Simulated") as string,
			year: 2026,
			powertrain,
			mileageMi,
			fuelPct,
			fuelRangeMi,
			oilLifePct,
			batteryPct,
			batteryRangeMi,
			isCharging,
			isPluggedIn,
			latitude: locBody?.latitude ?? null,
			longitude: locBody?.longitude ?? null,
			speedKmh,
			isLocked,
			exteriorColor: val<string>("vehicleidentification-exteriorcolor"),
			trim: val<string>("vehicleidentification-trim"),
			tires,
			diagnostics,
			serviceRecords,
			signalsAt: signals[0]?.meta.ingestedAt ?? new Date().toISOString(),
		};
	}
}

export function kmToMi(km: number): number {
	return km * MI_PER_KM;
}
export function miToKm(mi: number): number {
	return mi * KM_PER_MILE;
}
