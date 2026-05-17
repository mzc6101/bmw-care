import { chromium, type Page } from "playwright";

const APPLICATION_ID =
	process.env.SMARTCAR_APPLICATION_ID ??
	"5622ee0c-aead-479b-9c96-13a433bb48e5";
const REDIRECT_URI =
	process.env.SMARTCAR_REDIRECT_URI ??
	"https://www.notion.so/workers/oauth/callback";
const MODE = process.env.SMARTCAR_MODE ?? "simulated";
const SCOPE = [
	"read_vehicle_info",
	"read_odometer",
	"read_battery",
	"read_charge",
	"read_location",
	"read_tires",
	"read_security",
	"control_security",
].join(" ");

const TEST_EMAIL = process.env.SMARTCAR_TEST_EMAIL ?? "bmw-care@example.com";
const TEST_PASSWORD = process.env.SMARTCAR_TEST_PASSWORD ?? "password";
const VEHICLE_BRAND = "BMW";

function authUrl(): string {
	const params = new URLSearchParams({
		response_type: "code",
		application_id: APPLICATION_ID,
		redirect_uri: REDIRECT_URI,
		mode: MODE,
		state: `bmw-care-${Date.now()}`,
		scope: SCOPE,
	});
	return `https://connect.smartcar.com/oauth/authorize?${params.toString()}`;
}

async function step(page: Page, label: string, fn: () => Promise<void>) {
	console.log(`\n▸ ${label}`);
	try {
		await fn();
		console.log(`  ✓ ${label}`);
	} catch (err) {
		console.log(`  ✗ ${label}: ${(err as Error).message}`);
		throw err;
	}
}

async function safeClick(page: Page, candidates: Array<string>) {
	for (const selector of candidates) {
		const el = page.locator(selector).first();
		if (await el.count()) {
			await el.click({ timeout: 5_000 });
			return selector;
		}
	}
	throw new Error(
		`None of these selectors matched: ${candidates.join(", ")}`,
	);
}

async function dumpVisibleText(page: Page) {
	const text = await page.evaluate(() => document.body.innerText.slice(0, 600));
	console.log("--- visible text snippet ---");
	console.log(text);
	console.log("---");
}

async function main() {
	console.log("Auth URL:", authUrl());
	const browser = await chromium.launch({
		headless: false,
		slowMo: 250,
	});
	const context = await browser.newContext();
	let page = await context.newPage();

	try {
		await step(page, "Open Smartcar Connect", async () => {
			await page.goto(authUrl(), { waitUntil: "domcontentloaded" });
			await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
		});

		await page.waitForTimeout(1500);

		const url = page.url();
		console.log("Current URL:", url);
		await dumpVisibleText(page);

		await step(page, "Click 'Continue' / 'Get started' if shown", async () => {
			const candidates = [
				"button:has-text('Continue')",
				"button:has-text('Get started')",
				"button:has-text('Connect')",
				"[data-testid='continue']",
			];
			try {
				await safeClick(page, candidates);
				await page.waitForTimeout(1500);
			} catch {
				console.log("    (no continue button found, skipping)");
			}
		});

		await step(page, `Pick brand: ${VEHICLE_BRAND}`, async () => {
			const candidates = [
				`button:has-text('${VEHICLE_BRAND}')`,
				`[data-testid='brand-${VEHICLE_BRAND.toLowerCase()}']`,
				`text=${VEHICLE_BRAND}`,
				`a:has-text('${VEHICLE_BRAND}')`,
				`li:has-text('${VEHICLE_BRAND}')`,
			];
			try {
				await safeClick(page, candidates);
			} catch {
				const search = page.locator("input[placeholder*='Search'], input[type='search']").first();
				if (await search.count()) {
					await search.fill(VEHICLE_BRAND);
					await page.waitForTimeout(500);
					await safeClick(page, candidates);
				} else {
					throw new Error(`Cannot find ${VEHICLE_BRAND} brand selector`);
				}
			}
			await page.waitForTimeout(2000);
		});

		await dumpVisibleText(page);

		let loginPage: Page = page;
		await step(page, `Click 'Continue to ${VEHICLE_BRAND}'`, async () => {
			const candidates = [
				`button:has-text('Continue to ${VEHICLE_BRAND}')`,
				`a:has-text('Continue to ${VEHICLE_BRAND}')`,
				`button:has-text('Continue')`,
				`a:has-text('Continue')`,
				`button:has-text('Log in with ${VEHICLE_BRAND}')`,
			];

			const popupPromise = context.waitForEvent("page", { timeout: 8_000 }).catch(() => null);
			await safeClick(page, candidates);
			const popup = await popupPromise;
			if (popup) {
				console.log("    (popup detected)");
				loginPage = popup;
				await loginPage.waitForLoadState("domcontentloaded");
			} else {
				await page.waitForTimeout(3000);
			}
			await loginPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
		});

		console.log("Login page URL:", loginPage.url());
		await dumpVisibleText(loginPage);

		await step(loginPage, "Fill email", async () => {
			const emailInput = loginPage
				.locator(
					"input[type='email'], input[name='email'], input[placeholder*='email' i], input[name='username'], input[autocomplete='username'], input[name='login']",
				)
				.first();
			await emailInput.waitFor({ timeout: 20_000 });
			await emailInput.fill(TEST_EMAIL);
		});

		await step(loginPage, "Fill password", async () => {
			const pwInput = loginPage
				.locator("input[type='password'], input[name='password']")
				.first();
			await pwInput.waitFor({ timeout: 10_000 });
			await pwInput.fill(TEST_PASSWORD);
		});

		await step(loginPage, "Submit login", async () => {
			await safeClick(loginPage, [
				"button[type='submit']",
				"button:has-text('Sign in')",
				"button:has-text('Continue')",
				"button:has-text('Log in')",
				"input[type='submit']",
			]);
			await loginPage.waitForTimeout(4000);
			await loginPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
		});

		page = loginPage;

		await dumpVisibleText(page);

		await step(page, "Select vehicle (if multi-vehicle picker shown)", async () => {
			const candidates = [
				"button:has-text('Continue')",
				"button:has-text('Allow')",
				"button:has-text('Approve')",
				"button:has-text('Grant')",
				"input[type='checkbox']",
			];
			try {
				const checkbox = page.locator("input[type='checkbox']").first();
				if (await checkbox.count()) {
					await checkbox.check();
				}
				await safeClick(page, [
					"button:has-text('Continue')",
					"button:has-text('Allow')",
					"button:has-text('Approve')",
				]);
				await page.waitForTimeout(2000);
			} catch {
				console.log("    (no selector matched, skipping)");
			}
		});

		await step(page, "Final consent / grant", async () => {
			const candidates = [
				"button:has-text('Allow')",
				"button:has-text('Approve')",
				"button:has-text('Authorize')",
				"button:has-text('Grant')",
				"button:has-text('Continue')",
			];
			try {
				await safeClick(page, candidates);
				await page.waitForTimeout(3000);
			} catch {
				console.log("    (no consent button found)");
			}
		});

		const finalUrl = page.url();
		console.log("\nFinal URL:", finalUrl);
		await dumpVisibleText(page);

		if (
			finalUrl.startsWith(REDIRECT_URI) ||
			finalUrl.includes("code=") ||
			finalUrl.includes("success")
		) {
			console.log("\n✓ Connect flow completed; vehicle should be attached to the org.");
		} else {
			console.log(
				"\n? Flow ended at an unexpected URL — leaving the browser open for 60s so you can inspect/finish manually.",
			);
			await page.waitForTimeout(60_000);
		}
	} catch (err) {
		console.error("\n✗ Connect flow failed:", (err as Error).message);
		console.log("Leaving browser open for 90s so you can finish manually...");
		await page.waitForTimeout(90_000);
	} finally {
		await browser.close();
	}
}

main();
