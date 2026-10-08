import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

/**
 * Inbound email forwarder.
 *
 * Resend receives mail at onethingfocus@phkelli.resend.app (managed
 * receiving domain, catch-all) and POSTs an `email.received` webhook here.
 * This route verifies the webhook signature and forwards the original
 * message as-is (passthrough, attachments preserved) to Gmail via
 * Resend's native receiving-forward API.
 *
 * Env vars (Vercel):
 * - RESEND_INBOUND_KEY: Resend API key with "Full access" (the Receiving
 *   API requires full access; the sending-scoped app key is not enough).
 * - RESEND_WEBHOOK_SECRET: signing secret from the Resend webhook config.
 *
 * Note: the Resend account has no verified sending domains, so the account
 * runs in test mode: mail can only be sent from onboarding@resend.dev and
 * only delivered to the account owner's address — which is exactly the
 * forward target below, so test mode is sufficient.
 */
const LISTEN_ADDRESS = "onethingfocus@phkelli.resend.app";
const FORWARD_TO = "sande.rana5@gmail.com";
const FORWARD_FROM = "onethingfocus <onboarding@resend.dev>";

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  const apiKey = process.env.RESEND_INBOUND_KEY;

  if (!webhookSecret || !apiKey) {
    return NextResponse.json(
      { ok: false, error: "inbound forwarder not configured" },
      { status: 500 }
    );
  }

  const rawBody = await request.text();
  const resend = new Resend(apiKey);

  let event;
  try {
    event = resend.webhooks.verify({
      payload: rawBody,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid signature" },
      { status: 400 }
    );
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  const recipients = event.data.to.map((address) => address.toLowerCase());
  if (!recipients.includes(LISTEN_ADDRESS)) {
    // The managed domain is catch-all; only forward the chosen address.
    return NextResponse.json({ ok: true, skipped: true });
  }

  const { data, error } = await resend.emails.receiving.forward({
    emailId: event.data.email_id,
    to: FORWARD_TO,
    from: FORWARD_FROM,
    passthrough: true,
  });

  if (error) {
    // Non-2xx so Resend retries the webhook delivery.
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, id: data?.id });
}
