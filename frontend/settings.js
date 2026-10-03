import { api } from "./api.js";

export function createSettings({ onRouteChange }) {
  const captureView = document.getElementById("captureView");
  const settingsView = document.getElementById("settingsView");
  const openButton = document.getElementById("openSettings");
  const briefingToggle = document.getElementById("briefingToggle");
  const briefingStatus = document.getElementById("briefingStatus");
  const telegramStatus = document.getElementById("telegramStatus");
  const telegramCode = document.getElementById("telegramCode");
  const telegramButton = document.getElementById("linkTelegram");

  function renderRoute() {
    const settings = location.hash === "#settings";
    captureView.hidden = settings;
    settingsView.hidden = !settings;
    openButton.setAttribute("aria-current", settings ? "page" : "false");
    onRouteChange?.(settings);
  }

  openButton.addEventListener("click", () => { location.hash = "settings"; });
  document.getElementById("closeSettings").addEventListener("click", () => {
    history.replaceState(null, "", location.pathname + location.search);
    renderRoute();
  });
  addEventListener("hashchange", renderRoute);

  function describeBriefing(settings) {
    const zone = settings.timezone.replaceAll("_", " ");
    const sent = settings.lastSentAt ? ` Last sent ${new Date(settings.lastSentAt).toLocaleDateString()}.` : "";
    briefingStatus.textContent = settings.enabled
      ? `Delivered to your email around ${settings.hour}:00 in ${zone}.${sent}`
      : `Off. When enabled, it arrives around 8:00 in ${zone}.`;
    briefingStatus.className = "";
  }

  async function loadBriefing() {
    briefingToggle.disabled = true;
    try {
      const settings = await api("/api/settings/briefing");
      briefingToggle.checked = settings.enabled;
      describeBriefing(settings);
      briefingToggle.disabled = false;
    } catch {
      briefingStatus.textContent = "Could not load briefing settings.";
      briefingStatus.className = "error";
    }
  }

  briefingToggle.addEventListener("change", async () => {
    const enabled = briefingToggle.checked;
    briefingToggle.disabled = true;
    briefingStatus.textContent = enabled ? "Turning on your morning briefing…" : "Turning off your morning briefing…";
    try {
      const settings = await api("/api/settings/briefing", {
        enabled,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      briefingToggle.checked = settings.enabled;
      describeBriefing(settings);
    } catch (error) {
      briefingToggle.checked = !enabled;
      briefingStatus.textContent = error.message;
      briefingStatus.className = "error";
    } finally {
      briefingToggle.disabled = false;
    }
  });

  telegramButton.addEventListener("click", async () => {
    telegramButton.disabled = true;
    telegramStatus.textContent = "Generating a secure link code…";
    telegramCode.textContent = "";
    try {
      const link = await api("/api/settings/telegram/link-code", {});
      telegramStatus.textContent = "Send this command to your Noter bot within 10 minutes:";
      telegramCode.textContent = `/link ${link.code}`;
    } catch (error) {
      telegramStatus.textContent = error.message;
    } finally {
      telegramButton.disabled = false;
    }
  });

  async function loadTelegram() {
    try {
      const settings = await api("/api/settings/telegram");
      if (settings.linked) telegramStatus.textContent = "Linked. Telegram messages use this account's memory.";
    } catch {
      telegramStatus.textContent = "Could not load Telegram settings.";
    }
  }

  function showUser(user) {
    const identity = user.email || user.name;
    document.getElementById("accountName").textContent = identity;
    document.getElementById("accountAvatar").textContent = (identity[0] || "N").toUpperCase();
    document.getElementById("settingsEmail").textContent = user.email || "Not available for this account";
    document.getElementById("settingsId").textContent = user.id;
    renderRoute();
    loadBriefing();
    loadTelegram();
  }

  return { renderRoute, showUser };
}
