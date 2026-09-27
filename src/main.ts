import { mount } from "svelte";
import App from "./ui/App.svelte";
import "./ui/theme.css";
import { startMeterLoop } from "./state/store";
import { initTheme } from "./ui/themeStore";

const target = document.getElementById("app");
if (!target) throw new Error("#app mount point missing");

initTheme(); // before mount: no flash of the default colours
const app = mount(App, { target });
startMeterLoop();

export default app;
