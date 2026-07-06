const TO_ADDRESS = "hello@magnoliamadecookies.com";
const FROM_ADDRESS = "Magnolia Made Cookies <hello@magnoliamadecookies.com>";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return Response.json({ ok: false, error: "Invalid form submission." }, { status: 400 });
  }

  // Honeypot: bots tend to fill every field, humans never see or fill this one.
  if (form.get("company")) {
    return Response.json({ ok: true });
  }

  const name = (form.get("name") || "").toString().trim();
  const email = (form.get("email") || "").toString().trim();
  const occasion = (form.get("occasion") || "").toString().trim();
  const details = (form.get("details") || "").toString().trim();

  if (!name || !email || !details) {
    return Response.json({ ok: false, error: "Please fill in your name, email, and a few details." }, { status: 400 });
  }

  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return Response.json({ ok: false, error: "That email address doesn't look right." }, { status: 400 });
  }

  const html = `
    <h2>New enquiry from magnoliamadecookies.com</h2>
    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
    <p><strong>Occasion &amp; date:</strong> ${escapeHtml(occasion || "—")}</p>
    <p><strong>Details:</strong></p>
    <p>${escapeHtml(details).replace(/\n/g, "<br>")}</p>
  `;

  const resendResp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [TO_ADDRESS],
      reply_to: email,
      subject: `New enquiry from ${name}`,
      html,
    }),
  });

  if (!resendResp.ok) {
    const errBody = await resendResp.text();
    console.error("Resend error:", resendResp.status, errBody);
    return Response.json({ ok: false, error: "Something went wrong sending your message. Please try again." }, { status: 502 });
  }

  return Response.json({ ok: true });
}
