import { api } from "./api.js";

export function createAuth({ onAuthenticated, onSignedOut }) {
  const view = document.getElementById("auth");
  const email = document.getElementById("email");
  const button = document.getElementById("continueAuth");
  const status = document.getElementById("authStatus");
  const { startRegistration, startAuthentication, browserSupportsWebAuthn } = window.SimpleWebAuthnBrowser;

  function show(message = "") {
    view.hidden = false;
    status.textContent = message;
  }

  function hide() {
    view.hidden = true;
    status.textContent = "";
  }

  async function authenticate() {
    status.textContent = "";
    if (!email.reportValidity()) return;
    button.disabled = true;
    button.textContent = "Checking your passkey…";
    try {
      const ceremony = await api("/api/auth/options", { email: email.value });
      button.textContent = ceremony.mode === "register" ? "Creating your passkey…" : "Waiting for your passkey…";
      const response = ceremony.mode === "register"
        ? await startRegistration({ optionsJSON: ceremony.options })
        : await startAuthentication({ optionsJSON: ceremony.options });
      const result = await api(`/api/auth/${ceremony.mode}/verify`, { ceremonyId: ceremony.ceremonyId, response });
      onAuthenticated(result.user);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Continue with passkey";
    }
  }

  button.addEventListener("click", authenticate);
  email.addEventListener("keydown", (event) => {
    if (event.key === "Enter") authenticate();
  });
  document.getElementById("logout").addEventListener("click", async () => {
    await api("/api/auth/logout", {});
    history.replaceState(null, "", location.pathname + location.search);
    onSignedOut();
  });

  async function restore() {
    if (!browserSupportsWebAuthn()) {
      show("This browser does not support passkeys.");
      button.disabled = true;
      return;
    }
    try {
      const { user } = await api("/api/auth/me");
      onAuthenticated(user);
    } catch {
      onSignedOut();
    }
  }

  return { hide, restore, show };
}
