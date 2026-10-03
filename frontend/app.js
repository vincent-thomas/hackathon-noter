import { createAuth } from "./auth.js";
import { createSettings } from "./settings.js";
import { createVoiceController } from "./voice.js";

const authView = document.getElementById("auth");
const appView = document.getElementById("app");
const voice = createVoiceController();
const settings = createSettings({ onRouteChange: (open) => open && voice.cancel() });

function showApp(user) {
  authView.hidden = true;
  appView.hidden = false;
  settings.showUser(user);
}

function showAuth(message = "") {
  voice.cancel();
  appView.hidden = true;
  auth.show(message);
}

const auth = createAuth({ onAuthenticated: showApp, onSignedOut: showAuth });
auth.restore();
