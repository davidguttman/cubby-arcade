/* Consent and signup only. Subscriber addresses never enter analytics. */
(function () {
  "use strict";
  const form = document.querySelector(".waitlist");
  if (!form) return;
  const status = document.querySelector(".waitlist-status");
  const button = form.querySelector('button[type="submit"]');
  let submitting = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    submitting = true;
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    status.textContent = "Joining the waitlist…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(form.action, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "strict-origin",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams(new FormData(form)),
        signal: controller.signal
      });
      if (response.status !== 202) throw new Error("Signup not accepted");
      form.reset();
      form.hidden = true;
      status.textContent = "Check your email to confirm.";
      status.classList.add("joined");
    } catch (_) {
      status.textContent = "Unable to join right now. Please try again.";
    } finally {
      clearTimeout(timeout);
      submitting = false;
      button.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
}());
