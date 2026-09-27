import { mount } from "svelte";
import App from "./ui/App.svelte";
import "./ui/theme.css";
import { startMeterLoop } from "./state/store";
import { initTheme } from "./ui/themeStore";
import { logError } from "./state/platform";

// Anything uncaught goes to the crash log (desktop app), not just the console.
window.addEventListener("error", (e) => logError(e.error?.stack ?? e.message, `${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logError(String(e.reason?.stack ?? e.reason), "promise"));

const target = document.getElementById("app");
if (!target) throw new Error("#app mount point missing");

initTheme(); // before mount: no flash of the default colours
const app = mount(App, { target });
startMeterLoop();

export default app;
