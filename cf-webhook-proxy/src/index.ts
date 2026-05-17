export interface Env {
	APPLICATION_MANAGEMENT_TOKEN: string;
	NOTION_WEBHOOK_URL: string;
}

type SmartcarVerifyEvent = {
	eventType: "VERIFY";
	data: { challenge: string };
};

async function hmacHex(secret: string, message: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
	return [...new Uint8Array(sig)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "GET") {
			return new Response(
				"BMW Care webhook proxy. POST Smartcar events here; VERIFY handled inline, others forwarded to Notion.",
				{ status: 200 },
			);
		}
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const rawBody = await request.text();
		let body: unknown = {};
		try {
			body = JSON.parse(rawBody);
		} catch {
			// non-JSON body — forward as-is
		}

		// Smartcar VERIFY handshake
		if (
			body &&
			typeof body === "object" &&
			(body as SmartcarVerifyEvent).eventType === "VERIFY"
		) {
			const challenge = (body as SmartcarVerifyEvent).data?.challenge;
			if (!challenge) {
				return new Response(
					JSON.stringify({ error: "Missing data.challenge" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (!env.APPLICATION_MANAGEMENT_TOKEN) {
				return new Response(
					JSON.stringify({
						error:
							"APPLICATION_MANAGEMENT_TOKEN is not configured on the worker.",
					}),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			const hex = await hmacHex(
				env.APPLICATION_MANAGEMENT_TOKEN,
				challenge,
			);
			return new Response(JSON.stringify({ challenge: hex }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Forward everything else to Notion
		if (!env.NOTION_WEBHOOK_URL) {
			return new Response(
				JSON.stringify({
					error: "NOTION_WEBHOOK_URL is not configured on the worker.",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		const forwardHeaders = new Headers();
		for (const [k, v] of request.headers.entries()) {
			const lk = k.toLowerCase();
			if (lk === "host" || lk === "content-length" || lk.startsWith("cf-"))
				continue;
			forwardHeaders.set(k, v);
		}
		forwardHeaders.set("Content-Type", "application/json");

		const downstream = await fetch(env.NOTION_WEBHOOK_URL, {
			method: "POST",
			headers: forwardHeaders,
			body: rawBody,
		});
		const downstreamBody = await downstream.text();
		return new Response(downstreamBody, {
			status: downstream.status,
			headers: { "Content-Type": "application/json" },
		});
	},
};
